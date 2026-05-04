import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import Papa from "papaparse"
import { createClient } from "@supabase/supabase-js"

// ── Supabase ──────────────────────────────────────────────────────────────
const supabase = createClient(
  "https://iydtvzkpqmkbmnicpncd.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5ZHR2emtwcW1rYm1uaWNwbmNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MDM3ODcsImV4cCI6MjA4ODk3OTc4N30.iA5kLb5vGssJYvlwDMATQFI9no5Cv8OBdiugn_t9QFg"
)

async function dbLoadData() {
  const { data, error } = await supabase.from("weekly_data").select("*")
  if (error || !data) return {}
  return Object.fromEntries(data.map(r => [r.week_start, r.stats]))
}

async function dbSaveData(weeklyData) {
  const rows = Object.entries(weeklyData).map(([week_start, stats]) => ({ week_start, stats }))
  await supabase.from("weekly_data").upsert(rows, { onConflict: "week_start" })
}

async function dbLoadFiles() {
  const { data, error } = await supabase.from("processed_files").select("*").order("uploaded_at", { ascending: true })
  if (error || !data) return []
  return data
}

async function dbSaveFile(rec) {
  await supabase.from("processed_files").upsert(rec, { onConflict: "sig" })
}

async function dbClearAll() {
  // Load all keys first, then delete them explicitly
  const { data: wdRows } = await supabase.from("weekly_data").select("week_start")
  const { data: pfRows } = await supabase.from("processed_files").select("sig")
  if (wdRows?.length) {
    await supabase.from("weekly_data").delete().in("week_start", wdRows.map(r => r.week_start))
  }
  if (pfRows?.length) {
    await supabase.from("processed_files").delete().in("sig", pfRows.map(r => r.sig))
  }
}

// ── Constants ─────────────────────────────────────────────────────────────
const CATEGORIES = [
  "generic", "fingerprint match", "watchlist", "verify remix",
  "several songs included in one asset", "public domain / traditional",
  "exceeds 20 minutes", "other"
]
const CAT_COLORS = {
  "generic":                              "#3B82F6",
  "fingerprint match":                    "#22C55E",
  "watchlist":                            "#EF4444",
  "verify remix":                         "#F59E0B",
  "several songs included in one asset":  "#8B5CF6",
  "public domain / traditional":          "#06B6D4",
  "exceeds 20 minutes":                   "#EC4899",
  "other":                                "#94A3B8"
}
const CAT_SHORT = {
  "generic":                              "Generic",
  "fingerprint match":                    "Fingerprint",
  "watchlist":                            "Watchlist",
  "verify remix":                         "Verify Remix",
  "several songs included in one asset":  "Multi-song",
  "public domain / traditional":          "PD / Traditional",
  "exceeds 20 minutes":                   ">20 min",
  "other":                                "Other"
}

const ISRC_RE = /^[a-zA-Z]{2}[a-zA-Z0-9]{3}\d{7}$/i


// ── Date helpers ──────────────────────────────────────────────────────────
function parseDate(s) {
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3])
  const m = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (m) { let y = m[3]; if (y.length === 2) y = "20" + y; return new Date(+y, +m[1] - 1, +m[2]) }
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

function weekStart(d) {
  const diff = (5 - d.getDay() + 7) % 7
  const w    = new Date(d); w.setDate(d.getDate() + diff)
  return w.toISOString().split("T")[0]
}

function fmtWeek(wk) {
  return new Date(wk + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function fmtDate(s) {
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function fmtN(n) { return n?.toLocaleString() ?? "—" }

function lastFriday() {
  const d    = new Date()
  const diff = (5 - d.getDay() + 7) % 7
  d.setDate(d.getDate() - (diff === 0 ? 0 : 7 - diff))
  // simpler: go back to most recent Friday
  const day  = new Date()
  const back = (day.getDay() + 2) % 7   // days since last Friday (Fri=0)
  day.setDate(day.getDate() - back)
  return day.toISOString().split("T")[0]
}

// ── Categorisation ────────────────────────────────────────────────────────
function categorizeIssue(issue) {
  const t    = issue.toLowerCase()
  const cats = new Set()
  if (t.includes("fingerprint match with another track"))           cats.add("fingerprint match")
  if (t.includes("watchlist"))                                      cats.add("watchlist")
  if (t.includes("exceeds 20 minutes"))                             cats.add("exceeds 20 minutes")
  if (t.includes("several songs included in one asset"))            cats.add("several songs included in one asset")
  if (["public domain","traditional","in the public domain","classical content"].some(p => t.includes(p)))
    cats.add("public domain / traditional")
  if (["generic","background music","non-musical work","non-musical content","ai-generated",
       "ambient sounds","binaural beats","nature sounds","nature noises","foley",
       "relaxation purposes","spoken word"].some(p => t.includes(p)))
    cats.add("generic")
  else if (t.includes("asmr") || t.includes("a.s.m.r"))
    cats.add("generic")
  if (["unofficial remix","unofficial soundtrack","slowed down or sped up","is a cover version",
       "cover or tribute","reinterpretation","karaoke","third party audio","soundalike",
       "type beat","samples, beats, loops","non-exclusive","mechanical license",
       "mashup","flagged for being a soundtrack"].some(p => t.includes(p)))
    cats.add("verify remix")
  if (cats.size === 0) cats.add("other")
  return [...cats].sort()
}

// ── CSV → weekly stats ────────────────────────────────────────────────────
function processRows(rows, fallbackDate = null) {
  const ws = {}
  for (const row of rows) {
    const monetizedKey = Object.keys(row).find(k => ["content id monetized isrcs","content id monetised isrcs"].includes(k.trim().toLowerCase()))
    if (monetizedKey !== undefined && !String(row[monetizedKey]).trim()) continue
    const rawDate = row["Date"] || row["date"] || fallbackDate
    if (!rawDate) continue
    const d = parseDate(rawDate)
    if (!d) continue
    const text = row["Asset ISRC & Reasons"] || row["asset isrc & reasons"]
    if (!text?.trim()) continue
    const wk = weekStart(d)
    if (!ws[wk]) {
      ws[wk] = {
        totalRejections: 0,
        totalIssueLines: 0,
        categories: Object.fromEntries(CATEGORIES.map(c => [c, { rejections: 0, issueLines: 0 }]))
      }
    }
    const entry   = ws[wk]
    const bullets = [...text.matchAll(/[•\-]\s+(.*)/g)].map(m => m[1].trim().toLowerCase())
    const seen    = new Set()
    const rowCats = new Set()
    for (const b of bullets) {
      if (ISRC_RE.test(b) || b === "multiple" || seen.has(b)) continue
      seen.add(b)
      entry.totalIssueLines++
      for (const c of categorizeIssue(b)) { rowCats.add(c); entry.categories[c].issueLines++ }
    }
    entry.totalRejections++
    for (const c of rowCats) entry.categories[c].rejections++
  }
  return ws
}

// ── CSV → per-row detail (for UPC/ISRC table) ────────────────────────────
function parseLevelCats(block) {
  const bullets = [...block.matchAll(/[•\-]\s+(.*)/g)].map(m => m[1].trim().toLowerCase())
  const cats = new Set()
  const seen = new Set()
  for (const b of bullets) {
    if (ISRC_RE.test(b) || b === "multiple" || seen.has(b)) continue
    seen.add(b)
    for (const c of categorizeIssue(b)) cats.add(c)
  }
  return [...cats].sort()
}

function parseRowsDetail(csvText, fallbackDate = null) {
  let rows = []
  Papa.parse(csvText, { header: true, skipEmptyLines: true, complete: r => { rows = r.data } })
  const result = {}
  for (const row of rows) {
    const monetizedKey = Object.keys(row).find(k => ["content id monetized isrcs","content id monetised isrcs"].includes(k.trim().toLowerCase()))
    if (monetizedKey !== undefined && !String(row[monetizedKey]).trim()) continue
    const rawDate = row["Date"] || row["date"] || fallbackDate
    if (!rawDate) continue
    const d = parseDate(rawDate)
    if (!d) continue
    const text = row["Asset ISRC & Reasons"] || row["asset isrc & reasons"]
    if (!text?.trim()) continue
    const upc = String(row["Product UPC"] || row["product upc"] || "").trim()
    const wk  = weekStart(d)
    if (!result[wk]) result[wk] = []

    // Extract ISRCs: from bullet points, or from monetised column if "Multiple" is used
    const bulletIsrcs = [...text.matchAll(/[•]\s+([A-Z]{2}[A-Z0-9]{3}\d{7})/gi)]
      .map(m => m[1].toUpperCase())
      .filter((v, i, a) => a.indexOf(v) === i)
    const monetisedVal = monetizedKey ? String(row[monetizedKey]).trim() : ""
    const monetisedIsrcs = monetisedVal
      ? monetisedVal.split("|").map(s => s.trim().toUpperCase()).filter(s => ISRC_RE.test(s))
      : []
    const isrcs = bulletIsrcs.length > 0 ? bulletIsrcs : monetisedIsrcs

    // Split into product-level and asset-level sections
    const prodMatch  = text.match(/Product-level issues?:([\s\S]*?)(?=Asset-level issues?:|$)/i)
    const assetMatch = text.match(/Asset-level issues?:([\s\S]*)/i)
    const prodCats  = prodMatch  ? parseLevelCats(prodMatch[1])  : []
    const assetCats = assetMatch ? parseLevelCats(assetMatch[1]) : []
    const hasSections = prodMatch || assetMatch
    const allCats = parseLevelCats(text)

    result[wk].push({
      upc, isrcs,
      prodCats:  hasSections ? prodCats  : [],
      assetCats: hasSections ? assetCats : allCats,
    })
  }
  return result
}
// ── Dispute & Content ID parsing ─────────────────────────────────────────
function findColVal(row, names) {
  const keys = Object.keys(row)
  for (const name of names) {
    const found = keys.find(k => k.trim().toLowerCase() === name.toLowerCase())
    if (found !== undefined) return row[found]
  }
  return undefined
}

function parseDisputeStats(csvText, fallbackDate = null) {
  let rows = []
  Papa.parse(csvText, { header: true, skipEmptyLines: true, complete: r => { rows = r.data } })
  const result = {}
  for (const row of rows) {
    const rawDate = row["Date"] || row["date"] || fallbackDate
    if (!rawDate) continue
    const d = parseDate(rawDate)
    if (!d) continue
    const upc    = String(row["Product UPC"]            || row["product upc"]            || "").trim()
    const artist = String(row["Product Primary Artists"] || row["product primary artists"] || "").trim()
    const title  = String(row["Product Title"]           || row["product title"]           || "").trim()
    if (!upc && !artist && !title) continue
    const wk = weekStart(d)
    if (!result[wk]) result[wk] = { contentIdCount:0, verifiedArtists:0, disputed:0, accepted:0, redelivered:0, disputes:[] }
    const entry = result[wk]

    const monetisedVal = String(findColVal(row, ["Content ID Monetised ISRCs","Content ID Monetized ISRCs"]) ?? "").trim()
    if (monetisedVal && monetisedVal !== "#N/A") {
      const isrcs = monetisedVal.split("|").map(s => s.trim()).filter(s => ISRC_RE.test(s))
      if (isrcs.length) entry.contentIdCount++
    }

    const verifiedVal = String(findColVal(row, ["Artists Verified by LANDR vLookup"]) ?? "").trim()
    if (verifiedVal && verifiedVal !== "#N/A") entry.verifiedArtists++

    const disputedRaw   = String(findColVal(row, ["Disputed by LANDR"])        ?? "").trim().toLowerCase()
    const acceptedRaw   = String(findColVal(row, ["Dispute accepted by FUGA"]) ?? "").trim().toLowerCase()
    const isDisputed    = disputedRaw === "yes" || disputedRaw === "true"
    const isAccepted    = acceptedRaw === "yes" || acceptedRaw === "true"
    const isRedelivered = String(findColVal(row, ["Redelivered"])              ?? "").trim().toLowerCase() === "true"
    if (isDisputed)   entry.disputed++
    if (isAccepted)   entry.accepted++
    if (isRedelivered) entry.redelivered++

    const noteVal = String(findColVal(row, ["Dispute Notes", "Notes"]) ?? "").trim()
    if (isDisputed || isAccepted || noteVal) {
      entry.disputes.push({ upc, artist, title, disputed:isDisputed, accepted:isAccepted, redelivered:isRedelivered, note:noteVal })
    }
  }
  return result
}

function DateModal({ files, existingDates, onConfirm, onCancel }) {
  const [date,    setDate]    = useState(lastFriday)
  const [conflict, setConflict] = useState(false)
  const inputRef              = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  function handleLoad() {
    if (!date) return
    if (existingDates.includes(date)) {
      setConflict(true)
    } else {
      onConfirm(date, false)
    }
  }

  return (
    <div style={{ position:"fixed", inset:0, zIndex:1000, background:"rgba(0,0,0,0.7)",
      backdropFilter:"blur(4px)", display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:16,
        padding:"32px 36px", width:440, boxShadow:"0 24px 60px rgba(0,0,0,0.6)" }}>
        <div style={{ width:44, height:44, borderRadius:12, background:"rgba(59,130,246,0.12)",
          border:"1px solid rgba(59,130,246,0.2)", display:"flex", alignItems:"center",
          justifyContent:"center", marginBottom:20 }}>
          <svg width="20" height="20" fill="none" stroke="#3B82F6" strokeWidth="1.8" viewBox="0 0 24 24">
            <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
        </div>

        {!conflict ? (<>
          <p style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:8 }}>No date column found</p>
          <p style={{ fontSize:13, color:"#64748b", marginBottom:6, lineHeight:1.6 }}>
            Enter the date of the report — all rows will be assigned to that week.
          </p>
          <p style={{ fontSize:12, color:"#334155", marginBottom:24, fontFamily:"'DM Mono',monospace", wordBreak:"break-all" }}>
            {files.map(f => f.name).join(", ")}
          </p>
          <label style={{ fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase",
            color:"#475569", display:"block", marginBottom:8 }}>Date of report</label>
          <input ref={inputRef} type="date" value={date} onChange={e => { setDate(e.target.value); setConflict(false) }}
            onKeyDown={e => e.key === "Enter" && handleLoad()}
            style={{ width:"100%", background:"#0a1120", border:"1px solid #1e293b", borderRadius:8,
              padding:"10px 14px", fontSize:14, color:"#f1f5f9", fontFamily:"'DM Mono',monospace",
              outline:"none", marginBottom:24, colorScheme:"dark" }} />
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onCancel} style={{ flex:1, padding:"10px 0", borderRadius:8, fontSize:13,
              fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif",
              background:"transparent", border:"1px solid #1e293b", color:"#64748b" }}>Cancel</button>
            <button onClick={handleLoad} disabled={!date} style={{ flex:2, padding:"10px 0",
              borderRadius:8, fontSize:13, fontWeight:600, cursor:date?"pointer":"not-allowed",
              fontFamily:"'DM Sans',sans-serif", background:date?"#2563EB":"#1e293b",
              border:"none", color:date?"#fff":"#475569", transition:"background 0.15s" }}>Load files</button>
          </div>
        </>) : (<>
          <p style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:8 }}>Report already uploaded</p>
          <p style={{ fontSize:13, color:"#64748b", marginBottom:24, lineHeight:1.6 }}>
            A report for <span style={{ color:"#f1f5f9", fontFamily:"'DM Mono',monospace" }}>
              {fmtDate(date)}
            </span> has already been uploaded. Would you like to replace it with this file, or cancel?
          </p>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onCancel} style={{ flex:1, padding:"10px 0", borderRadius:8, fontSize:13,
              fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif",
              background:"transparent", border:"1px solid #1e293b", color:"#64748b" }}>Cancel</button>
            <button onClick={() => onConfirm(date, true)} style={{ flex:2, padding:"10px 0",
              borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif", background:"#dc2626",
              border:"none", color:"#fff" }}>Replace</button>
          </div>
        </>)}
      </div>
    </div>
  )
}

// ── Subcomponents ─────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:8,
      padding:"10px 14px", fontFamily:"'DM Mono',monospace" }}>
      <p style={{ color:"#94a3b8", fontSize:11, marginBottom:6 }}>{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:p.color, flexShrink:0 }} />
          <span style={{ color:"#cbd5e1", fontSize:11 }}>{p.name}</span>
          <span style={{ color:"#f1f5f9", fontSize:12, fontWeight:600, marginLeft:"auto", paddingLeft:16 }}>
            {fmtN(p.value)}
          </span>
        </div>
      ))}
    </div>
  )
}

function Delta({ curr, prev, invert = false }) {
  if (prev == null || prev === 0) return null
  const pct  = (curr - prev) / prev * 100
  const up   = pct > 0
  const good = invert ? !up : up
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:3, fontSize:11, fontWeight:600,
      color:good?"#4ade80":"#f87171", background:good?"rgba(74,222,128,.12)":"rgba(248,113,113,.12)",
      padding:"2px 7px", borderRadius:4, fontFamily:"'DM Mono',monospace" }}>
      {up ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

// ── App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [weeklyData,     setWeeklyData]     = useState({})
  const [processedFiles, setProcessedFiles] = useState([])
  const [isDragging,     setIsDragging]     = useState(false)
  const [isProcessing,   setIsProcessing]   = useState(false)
  const [isLoading,      setIsLoading]      = useState(true)
  const [toasts,         setToasts]         = useState([])
  const [pendingModal,   setPendingModal]   = useState(null)
  const [selectedWk,     setSelectedWk]     = useState(null)

  useEffect(() => {
    Promise.all([dbLoadData(), dbLoadFiles()]).then(([data, files]) => {
      setWeeklyData(data)
      setProcessedFiles(files)
      setIsLoading(false)
    })
  }, [])

  const addToast = (msg, type = "success") => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, msg, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 6000)
  }

  const ingest = useCallback(async (items) => {
    let updated  = await dbLoadData()
    let updFiles = await dbLoadFiles()

    for (const { file, rows, rawText, fallbackDate, replace } of items) {
      const newStats = processRows(rows, fallbackDate ?? null)
      Object.assign(updated, newStats)

      const weeks   = Object.keys(newStats).sort()
      const dateKey = fallbackDate ?? (weeks[0] ?? "unknown")
      const sig     = dateKey   // use report date as unique key

      // Remove old record if replacing
      if (replace) {
        updFiles = updFiles.filter(f => f.sig !== sig)
        await supabase.from("processed_files").delete().eq("sig", sig)
      }

      const rec = {
        sig,
        name:        file.name,
        uploaded_at: new Date().toISOString(),
        rows:        rows.length,
        weeks:       weeks.length,
        date_range:  weeks.length ? `${fmtWeek(weeks[0])} – ${fmtWeek(weeks[weeks.length-1])}` : "—",
        manual_date: fallbackDate ?? null,
        csv_content: rawText,
      }

      await dbSaveFile(rec)
      updFiles.push(rec)

      addToast(
        `Loaded "${file.name}" — ${fmtN(rows.length)} rows, ${weeks.length} week${weeks.length !== 1 ? "s" : ""}` +
        (fallbackDate ? ` (${fmtDate(fallbackDate)} report)` : ` (${rec.date_range})`)
      )
    }

    await dbSaveData(updated)
    setWeeklyData({ ...updated })
    setProcessedFiles([...updFiles])
  }, [])

  const handleDrop = useCallback(async (e) => {
    e.preventDefault()
    setIsDragging(false)
    const files = [...e.dataTransfer.files].filter(f => f.name.endsWith(".csv"))
    if (!files.length) { addToast("Please drop a CSV file", "error"); return }
    setIsProcessing(true)

    const parsed = await Promise.all(files.map(file =>
      new Promise((res, rej) => {
        const reader = new FileReader()
        reader.onload = e => {
          const rawText = e.target.result
          Papa.parse(rawText, {
            header: true, skipEmptyLines: true,
            complete: r => res({ file, rows: r.data, rawText }),
            error: rej
          })
        }
        reader.onerror = rej
        reader.readAsText(file)
      })
    ))

    setIsProcessing(false)

    const datedFiles    = parsed.filter(({ rows }) => rows.length && ("Date" in rows[0] || "date" in rows[0]))
    const datelessFiles = parsed.filter(({ rows }) => !rows.length || !("Date" in rows[0] || "date" in rows[0]))

    if (datelessFiles.length > 0) {
      setPendingModal({ datelessFiles, datedFiles })
    } else {
      await ingest(datedFiles)
    }
  }, [ingest])

  const handleModalConfirm = useCallback(async (dateStr, replace) => {
    const { datelessFiles, datedFiles } = pendingModal
    setPendingModal(null)
    await ingest([
      ...datedFiles.map(f => ({ ...f, fallbackDate: null, replace: false })),
      ...datelessFiles.map(f => ({ ...f, fallbackDate: dateStr, replace })),
    ])
  }, [pendingModal, ingest])

  const handleDownload = (f) => {
    if (!f.csv_content) { addToast("No CSV data stored for this file", "error"); return }
    const blob = new Blob([f.csv_content], { type: "text/csv" })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement("a")
    a.href     = url
    a.download = f.name
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleDeleteFile = async (f) => {
    if (!window.confirm(`Remove "${f.name}" from the analysis? This cannot be undone.`)) return
    // Delete from Supabase
    await supabase.from("processed_files").delete().eq("sig", f.sig)
    // Rebuild weekly_data from remaining files
    const remaining = processedFiles.filter(pf => pf.sig !== f.sig)
    const rebuilt   = {}
    for (const pf of remaining) {
      if (!pf.csv_content) continue
      const rows = await new Promise(res =>
        Papa.parse(pf.csv_content, { header:true, skipEmptyLines:true, complete: r => res(r.data) })
      )
      const stats = processRows(rows, pf.manual_date ?? null)
      Object.assign(rebuilt, stats)
    }
    await dbSaveData(rebuilt)
    // Re-save remaining files (clear all then re-upsert to keep it clean)
    await supabase.from("weekly_data").delete().neq("week_start", "")
    for (const wk of Object.keys(rebuilt)) {
      await supabase.from("weekly_data").upsert({ week_start: wk, stats: rebuilt[wk] })
    }
    setWeeklyData({ ...rebuilt })
    setProcessedFiles(remaining)
    addToast(`"${f.name}" removed from analysis`)
  }

  const handleClear = async () => {
    if (!window.confirm("Clear all stored data and upload history?")) return
    await dbClearAll()
    // Re-read from DB to confirm everything is gone
    const [data, files] = await Promise.all([dbLoadData(), dbLoadFiles()])
    setWeeklyData(data)
    setProcessedFiles(files)
    addToast("All data cleared")
  }

  // ── Derived ───────────────────────────────────────────────────────────
  const sortedWeeks = Object.keys(weeklyData).sort()
  const hasData     = sortedWeeks.length > 0
  const latestWk    = sortedWeeks.at(-1)
  const prevWk      = sortedWeeks.at(-2)
  const latestStats = latestWk ? weeklyData[latestWk] : null
  const prevStats   = prevWk   ? weeklyData[prevWk]   : null
  const totalRej    = sortedWeeks.reduce((s, w) => s + weeklyData[w].totalRejections, 0)
  const totalLines  = sortedWeeks.reduce((s, w) => s + weeklyData[w].totalIssueLines, 0)

  const chartData = sortedWeeks.map(wk => {
    const ws  = weeklyData[wk]
    const row = { week: fmtWeek(wk), rejections: ws.totalRejections, issueLines: ws.totalIssueLines,
      linesPerRej: ws.totalRejections > 0 ? +(ws.totalIssueLines / ws.totalRejections).toFixed(2) : 0 }
    CATEGORIES.forEach(c => { row[c] = ws.categories[c]?.rejections ?? 0 })
    return row
  })

  const catTotals = CATEGORIES.map(c => ({
    c, color: CAT_COLORS[c],
    rejections: sortedWeeks.reduce((s, w) => s + (weeklyData[w].categories[c]?.rejections ?? 0), 0),
    issueLines: sortedWeeks.reduce((s, w) => s + (weeklyData[w].categories[c]?.issueLines  ?? 0), 0),
  })).filter(x => x.rejections > 0).sort((a, b) => b.rejections - a.rejections)

  const recent4   = sortedWeeks.slice(-4)
  const previous4 = sortedWeeks.slice(-8, -4)
  const sumCat = (weeks, c) => weeks.reduce((s, w) => s + (weeklyData[w]?.categories[c]?.rejections ?? 0), 0)
  const periodComparison = CATEGORIES.map(c => {
    const curr = sumCat(recent4, c)
    const prev = sumCat(previous4, c)
    const pct  = prev === 0 ? null : (curr - prev) / prev * 100
    return { c, color: CAT_COLORS[c], curr, prev, pct }
  }).filter(x => x.curr > 0 || x.prev > 0).sort((a, b) => b.curr - a.curr)

  const TOP3 = ["generic", "watchlist", "fingerprint match"]

  const tableWk = selectedWk ?? latestWk

  const latestWeekRows = useMemo(() => {
    if (!tableWk || !processedFiles.length) return []
    const all = []
    for (const pf of processedFiles) {
      if (!pf.csv_content) continue
      const detail = parseRowsDetail(pf.csv_content, pf.manual_date ?? null)
      if (detail[tableWk]) all.push(...detail[tableWk])
    }
    return all
  }, [processedFiles, tableWk])

  const disputeWeekStats = useMemo(() => {
    if (!tableWk || !processedFiles.length) return null
    const combined = { contentIdCount:0, verifiedArtists:0, disputed:0, accepted:0, redelivered:0, disputes:[] }
    for (const pf of processedFiles) {
      if (!pf.csv_content) continue
      const stats = parseDisputeStats(pf.csv_content, pf.manual_date ?? null)
      if (!stats[tableWk]) continue
      const s = stats[tableWk]
      combined.contentIdCount  += s.contentIdCount
      combined.verifiedArtists += s.verifiedArtists
      combined.disputed        += s.disputed
      combined.accepted        += s.accepted
      combined.redelivered     += s.redelivered
      combined.disputes.push(...s.disputes)
    }
    const hasData = combined.contentIdCount > 0 || combined.verifiedArtists > 0 ||
                    combined.disputed > 0 || combined.accepted > 0 || combined.redelivered > 0
    return hasData ? combined : null
  }, [processedFiles, tableWk])

  const S = {
    app:   { minHeight:"100vh", background:"#080d17", fontFamily:"'DM Sans',sans-serif", color:"#e2e8f0" },
    card:  { background:"#0f172a", border:"1px solid #1e293b", borderRadius:12, padding:24 },
    label: { fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#475569" },
    mono:  { fontFamily:"'DM Mono',monospace" },
  }

  if (isLoading) return (
    <div style={{ ...S.app, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ width:32, height:32, border:"2px solid #3B82F6", borderTopColor:"transparent",
          borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
        <span style={{ color:"#475569", fontSize:13 }}>Loading from database…</span>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500;600&display=swap');
        * { box-sizing:border-box; margin:0; padding:0 }
        ::-webkit-scrollbar { width:6px } ::-webkit-scrollbar-track { background:#0f172a }
        ::-webkit-scrollbar-thumb { background:#1e293b; border-radius:3px }
        @keyframes spin    { to { transform:rotate(360deg) } }
        @keyframes fadeUp  { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        .row-hover:hover   { background:rgba(255,255,255,0.03) !important }
        .dl-btn:hover      { background:rgba(59,130,246,0.15) !important; border-color:rgba(59,130,246,0.4) !important }
        input[type="date"]:focus { border-color:#2563EB !important }
      `}</style>

      {pendingModal && (
        <DateModal files={pendingModal.datelessFiles.map(f => f.file)}
          existingDates={processedFiles.map(f => f.manual_date).filter(Boolean)}
          onConfirm={handleModalConfirm} onCancel={() => { setPendingModal(null); addToast("Upload cancelled","error") }} />
      )}

      {/* Toasts */}
      <div style={{ position:"fixed", top:20, right:20, zIndex:999,
        display:"flex", flexDirection:"column", gap:8, pointerEvents:"none" }}>
        {toasts.map(t => (
          <div key={t.id} style={{
            background: t.type==="error"?"#450a0a":"#052e16",
            border:`1px solid ${t.type==="error"?"#991b1b":"#166534"}`,
            color: t.type==="error"?"#fca5a5":"#86efac",
            padding:"12px 18px", borderRadius:10, fontSize:13, maxWidth:460,
            animation:"fadeUp 0.2s ease", boxShadow:"0 8px 30px rgba(0,0,0,0.5)", lineHeight:1.5
          }}>{t.msg}</div>
        ))}
      </div>

      {/* Header */}
      <div style={{ borderBottom:"1px solid #1e293b", padding:"18px 32px",
        display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:16 }}>
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:"-0.02em", color:"#f1f5f9" }}>UGC Rejections</span>
          {hasData && <span style={{ fontSize:12, color:"#475569", ...S.mono }}>
            {sortedWeeks.length} wks · {fmtWeek(sortedWeeks[0])} – {fmtWeek(latestWk)} · {fmtN(totalRej)} total rejections
          </span>}
        </div>
        {hasData && (
          <button onClick={handleClear} style={{ fontSize:11, color:"#ef4444",
            background:"rgba(239,68,68,.08)", border:"1px solid rgba(239,68,68,.2)",
            padding:"5px 12px", borderRadius:6, cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif", letterSpacing:"0.03em" }}>CLEAR ALL</button>
        )}
      </div>

      <div style={{ maxWidth:1200, margin:"0 auto", padding:"28px 32px",
        display:"flex", flexDirection:"column", gap:24 }}>

        {/* Drop zone */}
        <div onDrop={handleDrop}
          onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
          onDragLeave={() => setIsDragging(false)}
          style={{ border:`1.5px dashed ${isDragging?"#3B82F6":"#1e293b"}`,
            background:isDragging?"rgba(59,130,246,0.06)":"#0a1120",
            borderRadius:12, padding:hasData?"20px 28px":"52px 28px",
            textAlign:"center", transition:"all 0.2s ease" }}>
          {isProcessing ? (
            <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:12 }}>
              <div style={{ width:20, height:20, border:"2px solid #3B82F6",
                borderTopColor:"transparent", borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />
              <span style={{ color:"#64748b", fontSize:13 }}>Processing CSV…</span>
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:8 }}>
              <svg width="28" height="28" fill="none" stroke={isDragging?"#3B82F6":"#334155"}
                strokeWidth="1.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round"
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
              </svg>
              <span style={{ color:isDragging?"#93c5fd":"#64748b", fontSize:13, fontWeight:500 }}>
                {isDragging ? "Drop to load" : hasData ? "Drop another CSV to append" : "Drop a UGC rejection CSV to get started"}
              </span>
              {!hasData && <span style={{ color:"#334155", fontSize:12 }}>
                Files without a Date column will prompt you to enter the report date
              </span>}
            </div>
          )}
        </div>

        {!hasData && (
          <div style={{ textAlign:"center", padding:"60px 0" }}>
            <p style={{ fontSize:48, marginBottom:12 }}>📋</p>
            <p style={{ fontSize:15, color:"#334155" }}>No data yet — drop a CSV above</p>
          </div>
        )}

        {hasData && latestStats && (<>

          {/* KPIs */}
          <div>
            <p style={{ ...S.label, marginBottom:12 }}>Latest week — {fmtWeek(latestWk)}</p>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12 }}>
              {[
                { label:"Rejections",       value:latestStats.totalRejections, prev:prevStats?.totalRejections, invert:true },
                { label:"Issue Lines",      value:latestStats.totalIssueLines, prev:prevStats?.totalIssueLines, invert:true },
                { label:"Lines / Rejection",
                  value:(latestStats.totalIssueLines/latestStats.totalRejections).toFixed(2),
                  prevNum:prevStats?prevStats.totalIssueLines/prevStats.totalRejections:null, isRatio:true },
                { label:"Top Category",
                  value:CAT_SHORT[Object.entries(latestStats.categories)
                    .sort((a,b)=>b[1].rejections-a[1].rejections)[0][0]], isText:true },
              ].map(({ label, value, prev, prevNum, isText, isRatio, invert }) => (
                <div key={label} style={{ ...S.card, padding:20 }}>
                  <p style={S.label}>{label}</p>
                  <p style={{ fontSize:28, fontWeight:700, color:"#f1f5f9", marginTop:8, marginBottom:6,
                    ...S.mono, letterSpacing:"-0.02em" }}>{isText ? value : fmtN(value)}</p>
                  {!isText && (prev!=null||prevNum!=null) && (
                    <Delta curr={isRatio?parseFloat(value):value} prev={isRatio?prevNum:prev} invert={invert} />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Category tiles */}
          <div style={S.card}>
            <p style={{ ...S.label, marginBottom:16 }}>Latest week — by category</p>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10 }}>
              {CATEGORIES.filter(c=>latestStats.categories[c]?.rejections>0)
                .sort((a,b)=>latestStats.categories[b].rejections-latestStats.categories[a].rejections)
                .map(c => {
                  const { rejections } = latestStats.categories[c]
                  const pct = (rejections/latestStats.totalRejections*100).toFixed(1)
                  return (
                    <div key={c} style={{ background:"#0a1120", borderRadius:10, padding:"14px 16px",
                      borderLeft:`3px solid ${CAT_COLORS[c]}` }}>
                      <p style={{ ...S.label, color:CAT_COLORS[c], marginBottom:6 }}>{CAT_SHORT[c]}</p>
                      <p style={{ fontSize:26, fontWeight:700, ...S.mono, color:"#f1f5f9", letterSpacing:"-0.02em" }}>
                        {rejections}
                      </p>
                      <p style={{ fontSize:11, color:"#475569", marginTop:2, ...S.mono }}>{pct}%</p>
                    </div>
                  )
                })}
            </div>
          </div>

          {sortedWeeks.length > 1 && (<>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
              <div style={S.card}>
                <p style={{ ...S.label, marginBottom:4 }}>Rejections per week</p>
                <p style={{ fontSize:12, color:"#334155", marginBottom:20 }}>Distinct products rejected</p>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={chartData} margin={{ top:0, right:8, left:-20, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="week" tick={{ fontSize:10, fill:"#475569", fontFamily:"DM Mono" }} />
                    <YAxis tick={{ fontSize:10, fill:"#475569", fontFamily:"DM Mono" }} />
                    <Tooltip content={<ChartTooltip />} />
                    <Line type="monotone" dataKey="rejections" stroke="#3B82F6" strokeWidth={2}
                      dot={{ r:2, fill:"#3B82F6" }} name="Rejections" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={S.card}>
                <p style={{ ...S.label, marginBottom:4 }}>Issue lines per rejection</p>
                <p style={{ fontSize:12, color:"#334155", marginBottom:20 }}>Average issues per rejected product</p>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={chartData} margin={{ top:0, right:8, left:-20, bottom:0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="week" tick={{ fontSize:10, fill:"#475569", fontFamily:"DM Mono" }} />
                    <YAxis tick={{ fontSize:10, fill:"#475569", fontFamily:"DM Mono" }} tickFormatter={v => v.toFixed(1)} />
                    <Tooltip content={<ChartTooltip />} />
                    <Line type="monotone" dataKey="linesPerRej" stroke="#8B5CF6" strokeWidth={2}
                      dot={{ r:2, fill:"#8B5CF6" }} name="Lines / Rejection" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={S.card}>
              <p style={{ ...S.label, marginBottom:4 }}>All issue types over time</p>
              <p style={{ fontSize:12, color:"#334155", marginBottom:20 }}>Rejections per category per week</p>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData} margin={{ top:0, right:8, left:-20, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                  <XAxis dataKey="week" tick={{ fontSize:10, fill:"#475569", fontFamily:"DM Mono" }} />
                  <YAxis tick={{ fontSize:10, fill:"#475569", fontFamily:"DM Mono" }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend iconSize={8} wrapperStyle={{ fontSize:11, color:"#64748b", fontFamily:"DM Sans" }} />
                  {CATEGORIES.map(c => (
                    <Line key={c} type="monotone" dataKey={c} stroke={CAT_COLORS[c]} strokeWidth={2}
                      dot={{ r:2, fill:CAT_COLORS[c] }} name={CAT_SHORT[c]}
                      connectNulls={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

          </>)}

          {/* UPC / ISRC / Issue types table */}
          {hasData && (
            <div style={S.card}>
              <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", marginBottom:20, flexWrap:"wrap", gap:12 }}>
                <div>
                  <p style={{ ...S.label, marginBottom:4 }}>UPC / ISRC breakdown</p>
                  <p style={{ fontSize:12, color:"#334155" }}>
                    {fmtWeek(tableWk)} · {latestWeekRows.length} rejected products
                  </p>
                </div>
                <select
                  value={tableWk ?? ""}
                  onChange={e => setSelectedWk(e.target.value)}
                  style={{ background:"#0a1120", border:"1px solid #1e293b", borderRadius:8,
                    padding:"7px 12px", fontSize:12, color:"#cbd5e1", cursor:"pointer",
                    fontFamily:"'DM Mono',monospace", outline:"none", colorScheme:"dark" }}>
                  {[...sortedWeeks].reverse().map(wk => (
                    <option key={wk} value={wk}>
                      {fmtWeek(wk)}{wk === latestWk ? " (latest)" : wk === prevWk ? " (prev)" : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", minWidth:560 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid #1e293b" }}>
                      {["UPC","ISRC(s)","Issue Types (Product / Asset)"].map(h => (
                        <th key={h} style={{ ...S.label, textAlign:"left", padding:"0 10px 12px",
                          fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {latestWeekRows.map(({ upc, isrcs, prodCats, assetCats }, i) => (
                      <tr key={i} className="row-hover" style={{ borderBottom:"1px solid #0f172a" }}>
                        <td style={{ padding:"11px 10px", fontSize:12, ...S.mono, color:"#94a3b8",
                          whiteSpace:"nowrap", verticalAlign:"top" }}>{upc || "—"}</td>
                        <td style={{ padding:"11px 10px", verticalAlign:"top", maxWidth:220 }}>
                          {isrcs.length
                            ? <span style={{ fontSize:11, ...S.mono, color:"#64748b", lineHeight:1.7 }}>
                                {isrcs.join(", ")}
                              </span>
                            : <span style={{ fontSize:11, color:"#334155" }}>—</span>}
                        </td>
                        <td style={{ padding:"11px 10px", verticalAlign:"top" }}>
                          <div style={{ display:"flex", flexDirection:"column", gap:7 }}>
                            {prodCats.length > 0 && (
                              <div style={{ display:"flex", alignItems:"flex-start", gap:6, flexWrap:"wrap" }}>
                                <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em",
                                  textTransform:"uppercase", color:"#475569", paddingTop:3,
                                  whiteSpace:"nowrap", flexShrink:0 }}>Product</span>
                                <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                                  {prodCats.map(c => (
                                    <span key={c} style={{
                                      fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:5,
                                      background:`${CAT_COLORS[c]}18`, color:CAT_COLORS[c],
                                      border:`1px solid ${CAT_COLORS[c]}40`,
                                      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"
                                    }}>{CAT_SHORT[c]}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                            {assetCats.length > 0 && (
                              <div style={{ display:"flex", alignItems:"flex-start", gap:6, flexWrap:"wrap" }}>
                                <span style={{ fontSize:10, fontWeight:700, letterSpacing:"0.06em",
                                  textTransform:"uppercase", color:"#475569", paddingTop:3,
                                  whiteSpace:"nowrap", flexShrink:0 }}>Asset</span>
                                <div style={{ display:"flex", flexWrap:"wrap", gap:4 }}>
                                  {assetCats.map(c => (
                                    <span key={c} style={{
                                      fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:5,
                                      background:`${CAT_COLORS[c]}18`, color:CAT_COLORS[c],
                                      border:`1px solid ${CAT_COLORS[c]}40`,
                                      fontFamily:"'DM Sans',sans-serif", whiteSpace:"nowrap"
                                    }}>{CAT_SHORT[c]}</span>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {latestWeekRows.length === 0 && (
                <p style={{ fontSize:13, color:"#334155", textAlign:"center", padding:"32px 0" }}>
                  No data for {fmtWeek(tableWk)}
                </p>
              )}
            </div>
          )}

          {/* Disputes & Content ID */}
          {disputeWeekStats && (
            <div style={S.card}>
              <div style={{ marginBottom:20 }}>
                <p style={{ ...S.label, marginBottom:4 }}>Disputes & Content ID — {fmtWeek(tableWk)}</p>
                <p style={{ fontSize:12, color:"#334155" }}>
                  Dispute workflow and Content ID monetisation summary for this week
                </p>
              </div>

              <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:10, marginBottom:24 }}>
                {[
                  { label:"Content ID Monetised", value:disputeWeekStats.contentIdCount,
                    hint:"Products with monetised ISRCs" },
                  { label:"Artists Verified",      value:disputeWeekStats.verifiedArtists,
                    hint:"Verified by LANDR vLookup" },
                  { label:"Disputed by LANDR",     value:disputeWeekStats.disputed,
                    hint:"Disputes raised this week" },
                  { label:"Accepted by FUGA",      value:disputeWeekStats.accepted,
                    hint:"Disputes accepted by FUGA" },
                  { label:"Redelivered",           value:disputeWeekStats.redelivered,
                    hint:"Products redelivered after dispute" },
                  { label:"Acceptance Rate",
                    value: disputeWeekStats.disputed > 0
                      ? `${(disputeWeekStats.accepted / disputeWeekStats.disputed * 100).toFixed(0)}%`
                      : "—",
                    isText:true,
                    hint:"Accepted ÷ disputed" },
                ].map(({ label, value, isText, hint }) => (
                  <div key={label} style={{ background:"#0a1120", borderRadius:10, padding:"14px 16px" }}>
                    <p style={S.label}>{label}</p>
                    <p style={{ fontSize:26, fontWeight:700, ...S.mono, color:"#f1f5f9",
                      letterSpacing:"-0.02em", marginTop:6, marginBottom:4 }}>
                      {isText ? value : fmtN(value)}
                    </p>
                    <p style={{ fontSize:11, color:"#334155" }}>{hint}</p>
                  </div>
                ))}
              </div>

              {disputeWeekStats.disputes.length > 0 && (<>
                <p style={{ ...S.label, marginBottom:12 }}>Dispute details</p>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", minWidth:560 }}>
                    <thead>
                      <tr style={{ borderBottom:"1px solid #1e293b" }}>
                        {["UPC","Artist / Title","Status","Notes"].map(h => (
                          <th key={h} style={{ ...S.label, textAlign:"left", padding:"0 10px 12px",
                            fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {disputeWeekStats.disputes.map(({ upc, artist, title, disputed, accepted, redelivered, note }, i) => (
                        <tr key={i} className="row-hover" style={{ borderBottom:"1px solid #0f172a" }}>
                          <td style={{ padding:"11px 10px", fontSize:12, ...S.mono, color:"#94a3b8",
                            whiteSpace:"nowrap", verticalAlign:"top" }}>{upc || "—"}</td>
                          <td style={{ padding:"11px 10px", verticalAlign:"top", maxWidth:200 }}>
                            <p style={{ fontSize:13, color:"#cbd5e1", fontWeight:500 }}>{artist || "—"}</p>
                            {title && <p style={{ fontSize:11, color:"#475569", ...S.mono, marginTop:2 }}>{title}</p>}
                          </td>
                          <td style={{ padding:"11px 10px", verticalAlign:"top", whiteSpace:"nowrap" }}>
                            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                              {disputed && (
                                <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:4,
                                  background:"rgba(245,158,11,0.12)", color:"#F59E0B",
                                  border:"1px solid rgba(245,158,11,0.3)" }}>Disputed</span>
                              )}
                              {accepted && (
                                <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:4,
                                  background:"rgba(34,197,94,0.12)", color:"#22C55E",
                                  border:"1px solid rgba(34,197,94,0.3)" }}>Accepted</span>
                              )}
                              {redelivered && (
                                <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:4,
                                  background:"rgba(59,130,246,0.12)", color:"#3B82F6",
                                  border:"1px solid rgba(59,130,246,0.3)" }}>Redelivered</span>
                              )}
                            </div>
                          </td>
                          <td style={{ padding:"11px 10px", fontSize:12, color:"#94a3b8",
                            verticalAlign:"top", lineHeight:1.6, maxWidth:300 }}>
                            {note || <span style={{ color:"#334155" }}>—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>)}
            </div>
          )}

          {/* 4-week comparison table */}
          <div style={S.card}>
            <p style={{ ...S.label, marginBottom:4 }}>Last 4 weeks vs previous 4 weeks</p>
            <p style={{ fontSize:12, color:"#334155", marginBottom:20 }}>
              {recent4.length > 0 && previous4.length > 0
                ? `${fmtWeek(recent4[0])} – ${fmtWeek(recent4.at(-1))} vs ${fmtWeek(previous4[0])} – ${fmtWeek(previous4.at(-1))}`
                : recent4.length > 0
                  ? `${fmtWeek(recent4[0])} – ${fmtWeek(recent4.at(-1))} · not enough history to compare`
                  : "Not enough data"}
            </p>
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ borderBottom:"1px solid #1e293b" }}>
                  {["Category", "Last 4 wks", "Prev 4 wks", "Change"].map((h, i) => (
                    <th key={h} style={{ ...S.label, textAlign: i === 0 ? "left" : "right",
                      padding:"0 8px 12px", fontWeight:600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {periodComparison.map(({ c, color, curr, prev, pct }) => (
                  <tr key={c} className="row-hover" style={{ borderBottom:"1px solid #0f172a", transition:"background 0.15s" }}>
                    <td style={{ padding:"12px 8px" }}>
                      <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                        <div style={{ width:8, height:8, borderRadius:"50%", background:color, flexShrink:0 }} />
                        <span style={{ fontSize:13, color:"#cbd5e1" }}>{c}</span>
                      </div>
                    </td>
                    <td style={{ textAlign:"right", padding:"12px 8px", fontSize:13, fontWeight:600, ...S.mono, color:"#f1f5f9" }}>
                      {fmtN(curr)}
                    </td>
                    <td style={{ textAlign:"right", padding:"12px 8px", fontSize:13, ...S.mono, color:"#64748b" }}>
                      {fmtN(prev)}
                    </td>
                    <td style={{ textAlign:"right", padding:"12px 8px" }}>
                      {pct === null
                        ? <span style={{ fontSize:12, color:"#334155", ...S.mono }}>new</span>
                        : <span style={{ display:"inline-flex", alignItems:"center", gap:3, fontSize:11,
                            fontWeight:600, ...S.mono,
                            color: pct > 0 ? "#f87171" : pct < 0 ? "#4ade80" : "#64748b",
                            background: pct > 0 ? "rgba(248,113,113,.12)" : pct < 0 ? "rgba(74,222,128,.12)" : "transparent",
                            padding:"2px 7px", borderRadius:4 }}>
                            {pct > 0 ? "↑" : pct < 0 ? "↓" : ""} {Math.abs(pct).toFixed(1)}%
                          </span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Upload history */}
          {processedFiles.length > 0 && (
            <div style={S.card}>
              <p style={{ ...S.label, marginBottom:16 }}>Upload history</p>
              <div style={{ display:"flex", flexDirection:"column" }}>
                {[...processedFiles].reverse().map((f, i) => (
                  <div key={i} className="row-hover" style={{ display:"flex", alignItems:"center",
                    justifyContent:"space-between", padding:"11px 8px", borderBottom:"1px solid #0f172a" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10, minWidth:0 }}>
                      <svg width="14" height="14" fill="none" stroke="#334155" strokeWidth="1.5" viewBox="0 0 24 24" style={{ flexShrink:0 }}>
                        <path strokeLinecap="round" strokeLinejoin="round"
                          d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                      </svg>
                      <span style={{ fontSize:13, color:"#94a3b8", fontWeight:500, overflow:"hidden",
                        textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                      <span style={{ fontSize:12, color:"#334155", ...S.mono, flexShrink:0 }}>
                        {f.manual_date ? `${fmtDate(f.manual_date)} report` : f.date_range}
                      </span>
                    </div>
                    <div style={{ display:"flex", alignItems:"center", gap:12, flexShrink:0 }}>
                      <span style={{ fontSize:11, color:"#334155", ...S.mono }}>
                        {fmtN(f.rows)} rows · {new Date(f.uploaded_at).toLocaleDateString()}
                      </span>
                      <div style={{ display:"flex", gap:6 }}>
                        {f.csv_content && (
                          <button className="dl-btn" onClick={() => handleDownload(f)} style={{
                            display:"flex", alignItems:"center", gap:5, fontSize:11, color:"#3B82F6",
                            background:"rgba(59,130,246,0.08)", border:"1px solid rgba(59,130,246,0.2)",
                            padding:"4px 10px", borderRadius:6, cursor:"pointer",
                            fontFamily:"'DM Sans',sans-serif", transition:"all 0.15s", whiteSpace:"nowrap"
                          }}>
                            <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                            </svg>
                            Download
                          </button>
                        )}
                        <button onClick={() => handleDeleteFile(f)} style={{
                          display:"flex", alignItems:"center", gap:5, fontSize:11, color:"#ef4444",
                          background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)",
                          padding:"4px 10px", borderRadius:6, cursor:"pointer",
                          fontFamily:"'DM Sans',sans-serif", transition:"all 0.15s", whiteSpace:"nowrap"
                        }}>
                          <svg width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                          </svg>
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </>)}
      </div>
    </div>
  )
}
