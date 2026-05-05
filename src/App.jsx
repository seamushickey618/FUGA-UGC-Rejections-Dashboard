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
  const { data: wdRows } = await supabase.from("weekly_data").select("week_start")
  const { data: pfRows } = await supabase.from("processed_files").select("sig")
  if (wdRows?.length) await supabase.from("weekly_data").delete().in("week_start", wdRows.map(r => r.week_start))
  if (pfRows?.length) await supabase.from("processed_files").delete().in("sig", pfRows.map(r => r.sig))
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

// Weeks with unreliable/missing dispute data — omitted from dispute analysis
const OMIT_DISPUTE_WEEKS = ["2026-01-23", "2026-01-30", "2026-02-27", "2026-03-06"]
const OMIT_DISPUTE_LABELS = ["Jan 23", "Jan 30", "Feb 27", "Mar 6"]

const ISRC_RE = /^[a-zA-Z]{2}[a-zA-Z0-9]{3}\d{7}$/i
const PASSCODE = "L&R*uGc"

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
  const w = new Date(d); w.setDate(d.getDate() + diff)
  return w.toISOString().split("T")[0]
}
function fmtWeek(wk) {
  return new Date(wk + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
function fmtDate(s) {
  return new Date(s + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
function fmtN(n) { return n?.toLocaleString() ?? "—" }
function fmtPct(n) { return n == null ? "—" : `${n.toFixed(1)}%` }
function lastFriday() {
  const day = new Date()
  const back = (day.getDay() + 2) % 7
  day.setDate(day.getDate() - back)
  return day.toISOString().split("T")[0]
}

// ── Categorisation ────────────────────────────────────────────────────────
function categorizeIssue(issue) {
  const t = issue.toLowerCase()
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
    const isRedelivered = String(findColVal(row, ["Redelivered"]) ?? "").trim().toLowerCase() === "true"
    if (isDisputed)    entry.disputed++
    if (isAccepted)    entry.accepted++
    if (isRedelivered) entry.redelivered++

    const noteVal = String(findColVal(row, ["Dispute Notes", "Notes"]) ?? "").trim()
    if (isDisputed || isAccepted || noteVal) {
      entry.disputes.push({ upc, artist, title, disputed:isDisputed, accepted:isAccepted, redelivered:isRedelivered, note:noteVal })
    }
  }
  return result
}

// ── DateModal ─────────────────────────────────────────────────────────────
function DateModal({ files, existingDates, onConfirm, onCancel }) {
  const [date, setDate]       = useState(lastFriday)
  const [conflict, setConflict] = useState(false)
  const inputRef              = useRef(null)
  useEffect(() => { inputRef.current?.focus() }, [])

  function handleLoad() {
    if (!date) return
    if (existingDates.includes(date)) setConflict(true)
    else onConfirm(date, false)
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
              border:"none", color:date?"#fff":"#475569" }}>Load files</button>
          </div>
        </>) : (<>
          <p style={{ fontSize:15, fontWeight:700, color:"#f1f5f9", marginBottom:8 }}>Report already uploaded</p>
          <p style={{ fontSize:13, color:"#64748b", marginBottom:24, lineHeight:1.6 }}>
            A report for <span style={{ color:"#f1f5f9", fontFamily:"'DM Mono',monospace" }}>{fmtDate(date)}</span> already exists.
            Replace it?
          </p>
          <div style={{ display:"flex", gap:10 }}>
            <button onClick={onCancel} style={{ flex:1, padding:"10px 0", borderRadius:8, fontSize:13,
              fontWeight:600, cursor:"pointer", fontFamily:"'DM Sans',sans-serif",
              background:"transparent", border:"1px solid #1e293b", color:"#64748b" }}>Cancel</button>
            <button onClick={() => onConfirm(date, true)} style={{ flex:2, padding:"10px 0",
              borderRadius:8, fontSize:13, fontWeight:600, cursor:"pointer",
              fontFamily:"'DM Sans',sans-serif", background:"#dc2626", border:"none", color:"#fff" }}>Replace</button>
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

function DisputeTable({ rows }) {
  const monoStyle = { fontFamily:"'DM Mono',monospace" }
  const labelStyle = { fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#475569" }
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ width:"100%", borderCollapse:"collapse", minWidth:600 }}>
        <thead>
          <tr style={{ borderBottom:"1px solid #1e293b" }}>
            {["UPC","Date","Artist / Title","Status","Notes"].map(h => (
              <th key={h} style={{ ...labelStyle, textAlign:"left", padding:"0 12px 10px",
                fontWeight:600, whiteSpace:"nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ upc, weekLabel, artist, title, disputed, accepted, redelivered, note }, i) => (
            <tr key={i} className="row-hover" style={{ borderBottom:"1px solid #0f172a" }}>
              <td style={{ padding:"10px 12px", fontSize:12, ...monoStyle, color:"#94a3b8",
                whiteSpace:"nowrap", verticalAlign:"top" }}>{upc || "—"}</td>
              <td style={{ padding:"10px 12px", fontSize:11, ...monoStyle, color:"#64748b",
                whiteSpace:"nowrap", verticalAlign:"top" }}>{weekLabel}</td>
              <td style={{ padding:"10px 12px", verticalAlign:"top", maxWidth:200 }}>
                <p style={{ fontSize:13, color:"#cbd5e1", fontWeight:500 }}>{artist || "—"}</p>
                {title && <p style={{ fontSize:11, color:"#475569", ...monoStyle, marginTop:2 }}>{title}</p>}
              </td>
              <td style={{ padding:"10px 12px", verticalAlign:"top", whiteSpace:"nowrap" }}>
                <div style={{ display:"flex", gap:4 }}>
                  {disputed    && <span style={{ fontSize:11, fontWeight:600, padding:"2px 7px", borderRadius:4,
                    background:"rgba(245,158,11,0.12)", color:"#F59E0B", border:"1px solid rgba(245,158,11,0.3)" }}>Disputed</span>}
                  {accepted    && <span style={{ fontSize:11, fontWeight:600, padding:"2px 7px", borderRadius:4,
                    background:"rgba(34,197,94,0.12)",  color:"#22C55E", border:"1px solid rgba(34,197,94,0.3)"  }}>Accepted</span>}
                  {redelivered && <span style={{ fontSize:11, fontWeight:600, padding:"2px 7px", borderRadius:4,
                    background:"rgba(59,130,246,0.12)", color:"#3B82F6", border:"1px solid rgba(59,130,246,0.3)" }}>Redelivered</span>}
                </div>
              </td>
              <td style={{ padding:"10px 12px", fontSize:12, color:"#94a3b8",
                verticalAlign:"top", lineHeight:1.6, maxWidth:300 }}>
                {note || <span style={{ color:"#334155" }}>—</span>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={5} style={{ padding:"28px 12px", fontSize:12, color:"#334155", textAlign:"center" }}>None</td></tr>
          )}
        </tbody>
      </table>
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
  const [authed,         setAuthed]         = useState(() => sessionStorage.getItem("ugc_auth") === "1")
  const [pwd,            setPwd]            = useState("")
  const [pwdErr,         setPwdErr]         = useState(false)
  const [weeklyData,     setWeeklyData]     = useState({})
  const [processedFiles, setProcessedFiles] = useState([])
  const [isDragging,     setIsDragging]     = useState(false)
  const [isProcessing,   setIsProcessing]   = useState(false)
  const [isLoading,      setIsLoading]      = useState(true)
  const [toasts,         setToasts]         = useState([])
  const [pendingModal,   setPendingModal]   = useState(null)
  const [selectedWk,     setSelectedWk]     = useState(null)
  const [page,           setPage]           = useState("dashboard")

  useEffect(() => {
    if (!authed) { setIsLoading(false); return }
    Promise.all([dbLoadData(), dbLoadFiles()]).then(([data, files]) => {
      setWeeklyData(data)
      setProcessedFiles(files)
      setIsLoading(false)
    })
  }, [authed])

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
      const sig     = dateKey
      if (replace) {
        updFiles = updFiles.filter(f => f.sig !== sig)
        await supabase.from("processed_files").delete().eq("sig", sig)
      }
      const rec = {
        sig, name: file.name, uploaded_at: new Date().toISOString(),
        rows: rows.length, weeks: weeks.length,
        date_range: weeks.length ? `${fmtWeek(weeks[0])} – ${fmtWeek(weeks[weeks.length-1])}` : "—",
        manual_date: fallbackDate ?? null, csv_content: rawText,
      }
      await dbSaveFile(rec)
      updFiles.push(rec)
      addToast(`Loaded "${file.name}" — ${fmtN(rows.length)} rows, ${weeks.length} week${weeks.length !== 1 ? "s" : ""}` +
        (fallbackDate ? ` (${fmtDate(fallbackDate)} report)` : ` (${rec.date_range})`))
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
          Papa.parse(rawText, { header: true, skipEmptyLines: true,
            complete: r => res({ file, rows: r.data, rawText }), error: rej })
        }
        reader.onerror = rej
        reader.readAsText(file)
      })
    ))
    setIsProcessing(false)
    const datedFiles    = parsed.filter(({ rows }) => rows.length && ("Date" in rows[0] || "date" in rows[0]))
    const datelessFiles = parsed.filter(({ rows }) => !rows.length || !("Date" in rows[0] || "date" in rows[0]))
    if (datelessFiles.length > 0) setPendingModal({ datelessFiles, datedFiles })
    else await ingest(datedFiles)
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
    const a    = document.createElement("a"); a.href = url; a.download = f.name; a.click()
    URL.revokeObjectURL(url)
  }

  const handleDeleteFile = async (f) => {
    if (!window.confirm(`Remove "${f.name}"? This cannot be undone.`)) return
    await supabase.from("processed_files").delete().eq("sig", f.sig)
    const remaining = processedFiles.filter(pf => pf.sig !== f.sig)
    const rebuilt   = {}
    for (const pf of remaining) {
      if (!pf.csv_content) continue
      const rows = await new Promise(res =>
        Papa.parse(pf.csv_content, { header:true, skipEmptyLines:true, complete: r => res(r.data) })
      )
      Object.assign(rebuilt, processRows(rows, pf.manual_date ?? null))
    }
    await dbSaveData(rebuilt)
    await supabase.from("weekly_data").delete().neq("week_start", "")
    for (const wk of Object.keys(rebuilt))
      await supabase.from("weekly_data").upsert({ week_start: wk, stats: rebuilt[wk] })
    setWeeklyData({ ...rebuilt })
    setProcessedFiles(remaining)
    addToast(`"${f.name}" removed`)
  }

  const handleClear = async () => {
    if (!window.confirm("Clear all stored data and upload history?")) return
    await dbClearAll()
    const [data, files] = await Promise.all([dbLoadData(), dbLoadFiles()])
    setWeeklyData(data); setProcessedFiles(files)
    addToast("All data cleared")
  }

  // ── Derived ───────────────────────────────────────────────────────────
  const sortedWeeks  = Object.keys(weeklyData).sort()
  const hasData      = sortedWeeks.length > 0
  const latestWk     = sortedWeeks.at(-1)
  const tableWk      = selectedWk ?? latestWk
  const tableWkIdx   = sortedWeeks.indexOf(tableWk)
  const prevTableWk  = tableWkIdx > 0 ? sortedWeeks[tableWkIdx - 1] : null
  const tableWkStats = tableWk ? weeklyData[tableWk] : null
  const prevTableStats = prevTableWk ? weeklyData[prevTableWk] : null
  const totalRej     = sortedWeeks.reduce((s, w) => s + weeklyData[w].totalRejections, 0)

  const allDisputeStats = useMemo(() => {
    const combined = {}
    for (const pf of processedFiles) {
      if (!pf.csv_content) continue
      const stats = parseDisputeStats(pf.csv_content, pf.manual_date ?? null)
      for (const [wk, s] of Object.entries(stats)) {
        if (!combined[wk]) combined[wk] = { contentIdCount:0, verifiedArtists:0, disputed:0, accepted:0, redelivered:0, disputes:[] }
        const c = combined[wk]
        c.contentIdCount  += s.contentIdCount
        c.verifiedArtists += s.verifiedArtists
        c.disputed        += s.disputed
        c.accepted        += s.accepted
        c.redelivered     += s.redelivered
        c.disputes.push(...s.disputes)
      }
    }
    return combined
  }, [processedFiles])

  // Dispute stats with omitted weeks excluded
  const filteredDisputeStats = useMemo(() =>
    Object.fromEntries(Object.entries(allDisputeStats).filter(([wk]) => !OMIT_DISPUTE_WEEKS.includes(wk))),
    [allDisputeStats]
  )

  const disputeWeekStats = useMemo(() => {
    const s = filteredDisputeStats[tableWk]
    if (!s) return null
    const has = s.contentIdCount > 0 || s.disputed > 0 || s.accepted > 0 || s.redelivered > 0
    return has ? s : null
  }, [filteredDisputeStats, tableWk])

  // Category data for selected week
  const categoryTableData = useMemo(() =>
    CATEGORIES.map(c => {
      const allVals = sortedWeeks.map(wk => weeklyData[wk]?.categories[c]?.rejections ?? 0)
      const total   = allVals.reduce((s, v) => s + v, 0)
      if (total === 0) return null
      const avg    = total / sortedWeeks.length
      const maxVal = Math.max(...allVals)
      const maxWk  = sortedWeeks[allVals.indexOf(maxVal)]
      const thisWk = weeklyData[tableWk]?.categories[c]?.rejections ?? 0
      const prevVal = prevTableWk != null ? (weeklyData[prevTableWk]?.categories[c]?.rejections ?? 0) : null
      const pct    = prevVal != null && prevVal > 0 ? (thisWk - prevVal) / prevVal * 100 : null
      return { c, total, avg, maxVal, maxWk, thisWk, prevVal, pct }
    }).filter(Boolean).sort((a, b) => b.total - a.total),
    [weeklyData, sortedWeeks, tableWk, prevTableWk]
  )

  // Combined time series: rejections + disputes + accepted
  const combinedChartData = useMemo(() =>
    sortedWeeks.map(wk => {
      const d = filteredDisputeStats[wk]
      return {
        week: fmtWeek(wk),
        Rejections: weeklyData[wk]?.totalRejections ?? 0,
        Disputes:   d ? d.disputed : null,
        Accepted:   d ? d.accepted : null,
      }
    }),
    [weeklyData, filteredDisputeStats, sortedWeeks]
  )

  // Summary: weekly / monthly / total
  const summaryData = useMemo(() => {
    const calc = (rej, disp, acc, redel) => ({
      rej,
      pctDisp:  rej > 0 ? disp  / rej * 100 : null,
      pctAcc:   rej > 0 ? acc   / rej * 100 : null,
      pctRedel: rej > 0 ? redel / rej * 100 : null,
    })
    // Weekly
    const wRej   = tableWkStats?.totalRejections ?? 0
    const wDisp  = filteredDisputeStats[tableWk]?.disputed  ?? 0
    const wAcc   = filteredDisputeStats[tableWk]?.accepted  ?? 0
    const wRedel = filteredDisputeStats[tableWk]?.redelivered ?? 0
    // Monthly
    const wkDate = tableWk ? new Date(tableWk + "T00:00:00") : null
    const monthWeeks = wkDate
      ? sortedWeeks.filter(wk => {
          const d = new Date(wk + "T00:00:00")
          return d.getMonth() === wkDate.getMonth() && d.getFullYear() === wkDate.getFullYear()
        })
      : []
    const mRej   = monthWeeks.reduce((s, wk) => s + (weeklyData[wk]?.totalRejections ?? 0), 0)
    const mDisp  = monthWeeks.reduce((s, wk) => s + (filteredDisputeStats[wk]?.disputed  ?? 0), 0)
    const mAcc   = monthWeeks.reduce((s, wk) => s + (filteredDisputeStats[wk]?.accepted  ?? 0), 0)
    const mRedel = monthWeeks.reduce((s, wk) => s + (filteredDisputeStats[wk]?.redelivered ?? 0), 0)
    // Total
    const tRej   = sortedWeeks.reduce((s, wk) => s + (weeklyData[wk]?.totalRejections ?? 0), 0)
    const tDisp  = Object.values(filteredDisputeStats).reduce((s, v) => s + v.disputed,   0)
    const tAcc   = Object.values(filteredDisputeStats).reduce((s, v) => s + v.accepted,   0)
    const tRedel = Object.values(filteredDisputeStats).reduce((s, v) => s + v.redelivered, 0)
    return {
      weekly:  calc(wRej,  wDisp,  wAcc,  wRedel),
      monthly: calc(mRej,  mDisp,  mAcc,  mRedel),
      total:   calc(tRej,  tDisp,  tAcc,  tRedel),
    }
  }, [tableWk, tableWkStats, filteredDisputeStats, weeklyData, sortedWeeks])

  // All dispute rows for master list (UPC + week attached)
  const allDisputeRows = useMemo(() => {
    const rows = []
    for (const [wk, s] of Object.entries(filteredDisputeStats)) {
      for (const d of s.disputes) rows.push({ ...d, wk, weekLabel: fmtWeek(wk) })
    }
    return rows.sort((a, b) => a.wk.localeCompare(b.wk))
  }, [filteredDisputeStats])

  const S = {
    app:   { minHeight:"100vh", background:"#080d17", fontFamily:"'DM Sans',sans-serif", color:"#e2e8f0" },
    card:  { background:"#0f172a", border:"1px solid #1e293b", borderRadius:12, padding:20 },
    label: { fontSize:11, fontWeight:700, letterSpacing:"0.08em", textTransform:"uppercase", color:"#475569" },
    mono:  { fontFamily:"'DM Mono',monospace" },
  }

  const globalStyle = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500;600&display=swap');
    * { box-sizing:border-box; margin:0; padding:0 }
    ::-webkit-scrollbar { width:6px } ::-webkit-scrollbar-track { background:#0f172a }
    ::-webkit-scrollbar-thumb { background:#1e293b; border-radius:3px }
    @keyframes spin   { to { transform:rotate(360deg) } }
    @keyframes fadeUp { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
    .row-hover:hover  { background:rgba(255,255,255,0.03) !important }
    .dl-btn:hover     { background:rgba(59,130,246,0.15) !important; border-color:rgba(59,130,246,0.4) !important }
    input[type="date"]:focus { border-color:#2563EB !important }
    input[type="password"]:focus { outline:none; border-color:#3B82F6 !important }
  `

  // ── Passcode gate ─────────────────────────────────────────────────────
  if (!authed) return (
    <div style={{ ...S.app, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{globalStyle}</style>
      <div style={{ background:"#0f172a", border:"1px solid #1e293b", borderRadius:16,
        padding:"40px 44px", width:360, boxShadow:"0 24px 60px rgba(0,0,0,0.6)",
        display:"flex", flexDirection:"column", gap:20 }}>
        <div>
          <p style={{ fontSize:16, fontWeight:700, color:"#f1f5f9", marginBottom:4 }}>UGC Rejections</p>
          <p style={{ fontSize:12, color:"#475569" }}>Enter passcode to continue</p>
        </div>
        <div>
          <input
            type="password"
            value={pwd}
            onChange={e => { setPwd(e.target.value); setPwdErr(false) }}
            onKeyDown={e => {
              if (e.key === "Enter") {
                if (pwd === PASSCODE) { sessionStorage.setItem("ugc_auth","1"); setAuthed(true) }
                else setPwdErr(true)
              }
            }}
            placeholder="Passcode"
            style={{ width:"100%", background:"#0a1120",
              border:`1px solid ${pwdErr ? "#ef4444" : "#1e293b"}`, borderRadius:8,
              padding:"10px 14px", fontSize:14, color:"#f1f5f9", fontFamily:"'DM Mono',monospace",
              transition:"border-color 0.15s" }}
          />
          {pwdErr && <p style={{ fontSize:11, color:"#ef4444", marginTop:6 }}>Incorrect passcode</p>}
        </div>
        <button
          onClick={() => {
            if (pwd === PASSCODE) { sessionStorage.setItem("ugc_auth","1"); setAuthed(true) }
            else setPwdErr(true)
          }}
          style={{ background:"#2563EB", border:"none", borderRadius:8, padding:"11px 0",
            fontSize:13, fontWeight:600, color:"#fff", cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif" }}>
          Enter
        </button>
      </div>
    </div>
  )

  if (isLoading) return (
    <div style={{ ...S.app, display:"flex", alignItems:"center", justifyContent:"center" }}>
      <style>{globalStyle}</style>
      <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
        <div style={{ width:32, height:32, border:"2px solid #3B82F6", borderTopColor:"transparent",
          borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
        <span style={{ color:"#475569", fontSize:13 }}>Loading…</span>
      </div>
    </div>
  )

  return (
    <div style={S.app}>
      <style>{globalStyle}</style>

      {pendingModal && (
        <DateModal files={pendingModal.datelessFiles.map(f => f.file)}
          existingDates={processedFiles.map(f => f.manual_date).filter(Boolean)}
          onConfirm={handleModalConfirm}
          onCancel={() => { setPendingModal(null); addToast("Upload cancelled","error") }} />
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
      <div style={{ borderBottom:"1px solid #1e293b", padding:"13px 32px",
        display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          {page !== "dashboard" && (
            <button onClick={() => setPage("dashboard")}
              style={{ fontSize:12, color:"#64748b", background:"transparent",
                border:"1px solid #1e293b", padding:"4px 10px", borderRadius:6, cursor:"pointer",
                fontFamily:"'DM Sans',sans-serif" }}>
              ← Dashboard
            </button>
          )}
          <span style={{ fontSize:15, fontWeight:700, letterSpacing:"-0.02em", color:"#f1f5f9" }}>UGC Rejections</span>
          {page !== "dashboard" && (
            <span style={{ fontSize:12, color:"#475569" }}>
              / {page === "disputes" ? "All Disputes" : "History"}
            </span>
          )}
          {page === "dashboard" && hasData && (
            <span style={{ fontSize:12, color:"#334155", ...S.mono }}>
              {sortedWeeks.length} wks · {fmtWeek(sortedWeeks[0])} – {fmtWeek(latestWk)} · {fmtN(totalRej)} total
            </span>
          )}
        </div>
        {hasData && page === "dashboard" && (
          <button onClick={handleClear} style={{ fontSize:11, color:"#ef4444",
            background:"rgba(239,68,68,.08)", border:"1px solid rgba(239,68,68,.2)",
            padding:"5px 12px", borderRadius:6, cursor:"pointer",
            fontFamily:"'DM Sans',sans-serif" }}>CLEAR ALL</button>
        )}
      </div>

      <div style={{ maxWidth:1100, margin:"0 auto", padding:"16px 32px 32px",
        display:"flex", flexDirection:"column", gap:12 }}>

        {/* ════ DASHBOARD ════ */}
        {page === "dashboard" && (<>

          {/* Drop zone */}
          <div onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            style={{ border:`1.5px dashed ${isDragging?"#3B82F6":"#1e293b"}`,
              background:isDragging?"rgba(59,130,246,0.06)":"#0a1120",
              borderRadius:10, padding:hasData?"12px 20px":"36px 20px",
              textAlign:"center", transition:"all 0.2s ease" }}>
            {isProcessing ? (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}>
                <div style={{ width:16, height:16, border:"2px solid #3B82F6", borderTopColor:"transparent",
                  borderRadius:"50%", animation:"spin 0.7s linear infinite" }} />
                <span style={{ color:"#64748b", fontSize:12 }}>Processing…</span>
              </div>
            ) : (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                <svg width="16" height="16" fill="none" stroke={isDragging?"#3B82F6":"#334155"}
                  strokeWidth="1.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                </svg>
                <span style={{ color:isDragging?"#93c5fd":"#475569", fontSize:12 }}>
                  {isDragging ? "Drop to load" : hasData ? "Drop another CSV to append" : "Drop a UGC rejection CSV to get started"}
                </span>
              </div>
            )}
          </div>

          {!hasData && (
            <p style={{ fontSize:13, color:"#334155", textAlign:"center", padding:"40px 0" }}>No data yet — drop a CSV above</p>
          )}

          {hasData && tableWkStats && (<>

            {/* Week selector + nav */}
            <div style={{ ...S.card, padding:"11px 18px", display:"flex", alignItems:"center", gap:16, flexWrap:"wrap" }}>
              <div style={{ display:"flex", alignItems:"center", gap:10 }}>
                <span style={S.label}>Week</span>
                <select value={tableWk ?? ""} onChange={e => setSelectedWk(e.target.value)}
                  style={{ background:"#0a1120", border:"1px solid #1e293b", borderRadius:7,
                    padding:"5px 10px", fontSize:12, color:"#cbd5e1", cursor:"pointer",
                    fontFamily:"'DM Mono',monospace", outline:"none", colorScheme:"dark" }}>
                  {[...sortedWeeks].reverse().map(wk => (
                    <option key={wk} value={wk}>{fmtWeek(wk)}{wk === latestWk ? " (latest)" : ""}</option>
                  ))}
                </select>
              </div>
              <div style={{ width:1, height:22, background:"#1e293b", flexShrink:0 }} />
              <div style={{ display:"flex", alignItems:"baseline", gap:7 }}>
                <span style={{ fontSize:20, fontWeight:700, ...S.mono, color:"#f1f5f9", letterSpacing:"-0.02em" }}>
                  {fmtN(tableWkStats.totalRejections)}
                </span>
                <span style={{ fontSize:12, color:"#475569" }}>rejections</span>
                <Delta curr={tableWkStats.totalRejections} prev={prevTableStats?.totalRejections} invert />
              </div>
              <button onClick={() => setPage("history")}
                style={{ marginLeft:"auto", fontSize:11, color:"#64748b", background:"#0a1120",
                  border:"1px solid #1e293b", padding:"5px 12px", borderRadius:6, cursor:"pointer",
                  fontFamily:"'DM Sans',sans-serif" }}>
                Upload History →
              </button>
            </div>

            {/* Summary table */}
            <div style={S.card}>
              <p style={{ ...S.label, marginBottom:14 }}>Summary</p>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #1e293b" }}>
                    <th style={{ ...S.label, textAlign:"left", padding:"0 12px 10px 0", width:"40%" }}></th>
                    {[
                      ["Weekly", fmtWeek(tableWk)],
                      ["Monthly", tableWk ? new Date(tableWk+"T00:00:00").toLocaleDateString("en-US",{month:"long"}) : ""],
                      ["Total", "all time"],
                    ].map(([col, sub]) => (
                      <th key={col} style={{ textAlign:"right", padding:"0 0 10px 12px" }}>
                        <span style={{ ...S.label, display:"block" }}>{col}</span>
                        <span style={{ fontSize:10, color:"#334155", fontWeight:400, textTransform:"none",
                          letterSpacing:0 }}>{sub}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label:"Rejections", fn: d => fmtN(d.rej), note:null },
                    { label:"% Disputed", fn: d => fmtPct(d.pctDisp), note:null },
                    { label:"% Accepted", fn: d => fmtPct(d.pctAcc), note:null },
                    { label:"% Redelivered", fn: d => fmtPct(d.pctRedel), note:null },
                  ].map(({ label, fn }) => (
                    <tr key={label} className="row-hover" style={{ borderBottom:"1px solid #0f172a" }}>
                      <td style={{ padding:"9px 12px 9px 0", fontSize:12, color:"#94a3b8" }}>{label}</td>
                      {[summaryData.weekly, summaryData.monthly, summaryData.total].map((d, i) => (
                        <td key={i} style={{ textAlign:"right", padding:"9px 0 9px 12px",
                          fontSize:13, fontWeight:600, ...S.mono, color:"#f1f5f9" }}>
                          {fn(d)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Bar chart + Time series — side by side */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>

              {/* Horizontal bar chart */}
              <div style={S.card}>
                <p style={{ ...S.label, marginBottom:14 }}>Issue breakdown — {fmtWeek(tableWk)}</p>
                {(() => {
                  const maxVal = Math.max(
                    ...categoryTableData.map(d => d.thisWk),
                    disputeWeekStats?.disputed ?? 0,
                    1
                  )
                  return (
                    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                      {categoryTableData.map(({ c, thisWk }) => (
                        <div key={c} style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ fontSize:11, color:"#94a3b8", width:78, flexShrink:0,
                            overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{CAT_SHORT[c]}</span>
                          <div style={{ flex:1, height:5, background:"#1e293b", borderRadius:2, overflow:"hidden" }}>
                            <div style={{ width:`${thisWk/maxVal*100}%`, height:"100%",
                              background:CAT_COLORS[c], borderRadius:2 }} />
                          </div>
                          <span style={{ fontSize:12, fontWeight:600, ...S.mono, color:"#f1f5f9",
                            width:22, textAlign:"right", flexShrink:0 }}>{thisWk}</span>
                        </div>
                      ))}
                      {disputeWeekStats && disputeWeekStats.disputed > 0 && (<>
                        <div style={{ height:1, background:"#1e293b", margin:"4px 0" }} />
                        {[
                          { label:"Disputed",   value:disputeWeekStats.disputed,   color:"#F59E0B" },
                          { label:"Accepted",   value:disputeWeekStats.accepted,   color:"#22C55E" },
                          { label:"Redelivered",value:disputeWeekStats.redelivered,color:"#3B82F6" },
                        ].filter(d => d.value > 0).map(({ label, value, color }) => (
                          <div key={label} style={{ display:"flex", alignItems:"center", gap:8 }}>
                            <span style={{ fontSize:11, color:"#64748b", width:78, flexShrink:0 }}>{label}</span>
                            <div style={{ flex:1, height:5, background:"#1e293b", borderRadius:2, overflow:"hidden" }}>
                              <div style={{ width:`${value/maxVal*100}%`, height:"100%",
                                background:color, borderRadius:2, opacity:0.7 }} />
                            </div>
                            <span style={{ fontSize:12, fontWeight:600, ...S.mono, color:"#94a3b8",
                              width:22, textAlign:"right", flexShrink:0 }}>{value}</span>
                          </div>
                        ))}
                      </>)}
                    </div>
                  )
                })()}
              </div>

              {/* Combined time series */}
              <div style={S.card}>
                <p style={{ ...S.label, marginBottom:14 }}>Rejections, disputes & accepted</p>
                {sortedWeeks.length > 1 ? (
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart data={combinedChartData} margin={{ top:0, right:8, left:-20, bottom:0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                      <XAxis dataKey="week" tick={{ fontSize:9, fill:"#475569", fontFamily:"DM Mono" }} />
                      <YAxis tick={{ fontSize:9, fill:"#475569", fontFamily:"DM Mono" }} />
                      <Tooltip content={<ChartTooltip />} />
                      <Legend iconSize={8} wrapperStyle={{ fontSize:10, color:"#64748b", fontFamily:"DM Sans" }} />
                      <Line type="monotone" dataKey="Rejections" stroke="#3B82F6" strokeWidth={2}
                        dot={{ r:2, fill:"#3B82F6" }} connectNulls />
                      <Line type="monotone" dataKey="Disputes"   stroke="#F59E0B" strokeWidth={2}
                        dot={{ r:2, fill:"#F59E0B" }} connectNulls />
                      <Line type="monotone" dataKey="Accepted"   stroke="#22C55E" strokeWidth={2}
                        dot={{ r:2, fill:"#22C55E" }} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <p style={{ fontSize:12, color:"#334155", textAlign:"center", padding:"40px 0" }}>
                    Load more weeks to see trends
                  </p>
                )}
                {OMIT_DISPUTE_WEEKS.some(wk => sortedWeeks.includes(wk)) && (
                  <p style={{ fontSize:10, color:"#334155", marginTop:10 }}>
                    * Dispute data unavailable for {OMIT_DISPUTE_LABELS.filter((_, i) => sortedWeeks.includes(OMIT_DISPUTE_WEEKS[i])).join(", ")} — excluded from dispute analysis
                  </p>
                )}
              </div>
            </div>

            {/* Disputes this week */}
            <div style={{ ...S.card, borderColor:"rgba(245,158,11,0.2)" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:14 }}>
                <p style={{ ...S.label }}>Disputes this week — {fmtWeek(tableWk)}</p>
                <button onClick={() => setPage("disputes")}
                  style={{ fontSize:11, color:"#F59E0B", background:"rgba(245,158,11,0.08)",
                    border:"1px solid rgba(245,158,11,0.25)", padding:"4px 12px", borderRadius:6,
                    cursor:"pointer", fontFamily:"'DM Sans',sans-serif", fontWeight:600 }}>
                  See all disputes →
                </button>
              </div>

              {disputeWeekStats ? (<>
                {/* KPI mini-row */}
                <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:8, marginBottom:16 }}>
                  {[
                    { label:"Rejections",  value:tableWkStats?.totalRejections ?? 0 },
                    { label:"Disputed",    value:disputeWeekStats.disputed },
                    { label:"Accepted",    value:disputeWeekStats.accepted },
                    { label:"Redelivered", value:disputeWeekStats.redelivered },
                    { label:"Verified",    value:disputeWeekStats.verifiedArtists },
                    { label:"Accept Rate",
                      value: disputeWeekStats.disputed > 0
                        ? `${(disputeWeekStats.accepted/disputeWeekStats.disputed*100).toFixed(0)}%` : "—",
                      isText:true },
                    { label:"Accepted Disputes / Rejections",
                      value: (tableWkStats?.totalRejections ?? 0) > 0
                        ? `${(disputeWeekStats.accepted/(tableWkStats.totalRejections)*100).toFixed(0)}%` : "—",
                      isText:true },
                  ].map(({ label, value, isText }) => (
                    <div key={label} style={{ background:"#0a1120", borderRadius:7, padding:"8px 10px" }}>
                      <p style={{ fontSize:9, fontWeight:700, letterSpacing:"0.07em", textTransform:"uppercase",
                        color:"#475569", marginBottom:3 }}>{label}</p>
                      <p style={{ fontSize:17, fontWeight:700, ...S.mono, color:"#f1f5f9",
                        letterSpacing:"-0.02em" }}>{isText ? value : fmtN(value)}</p>
                    </div>
                  ))}
                </div>

                {/* Dispute detail rows */}
                {disputeWeekStats.disputes.length > 0 && (
                  <DisputeTable rows={disputeWeekStats.disputes.map(d => ({
                    ...d, wk: tableWk, weekLabel: fmtWeek(tableWk)
                  }))} />
                )}
              </>) : (
                <p style={{ fontSize:12, color:"#334155" }}>
                  {OMIT_DISPUTE_WEEKS.includes(tableWk)
                    ? `Dispute data unavailable for ${fmtWeek(tableWk)}`
                    : `No dispute data for ${fmtWeek(tableWk)}`}
                </p>
              )}
            </div>

          </>)}
        </>)}

        {/* ════ ALL DISPUTES PAGE ════ */}
        {page === "disputes" && (() => {
          const redelivered = allDisputeRows.filter(r => r.redelivered)
          const accepted   = allDisputeRows.filter(r => r.accepted && !r.redelivered)
          const disputed   = allDisputeRows.filter(r => r.disputed && !r.accepted && !r.redelivered)

          return (<>
            {[
              { title:"Disputed", color:"#F59E0B", rows:disputed },
              { title:"Accepted Disputes", color:"#22C55E", rows:accepted },
              { title:"Redelivered", color:"#3B82F6", rows:redelivered },
            ].map(({ title, color, rows }) => (
              <div key={title} style={{ ...S.card, borderColor:`${color}22` }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:16 }}>
                  <div style={{ width:3, height:14, borderRadius:2, background:color, flexShrink:0 }} />
                  <span style={{ fontSize:13, fontWeight:700, color:"#f1f5f9" }}>{title}</span>
                  <span style={{ fontSize:11, color:"#475569", ...S.mono }}>({rows.length})</span>
                </div>
                <DisputeTable rows={rows} />
              </div>
            ))}
          </>)
        })()}

        {/* ════ HISTORY PAGE ════ */}
        {page === "history" && (<>
          <div onDrop={handleDrop}
            onDragOver={e => { e.preventDefault(); setIsDragging(true) }}
            onDragLeave={() => setIsDragging(false)}
            style={{ border:`1.5px dashed ${isDragging?"#3B82F6":"#1e293b"}`,
              background:isDragging?"rgba(59,130,246,0.06)":"#0a1120",
              borderRadius:10, padding:"14px 20px", textAlign:"center", transition:"all 0.2s ease" }}>
            <span style={{ color:isDragging?"#93c5fd":"#475569", fontSize:12 }}>
              {isDragging ? "Drop to load" : "Drop a CSV to add"}
            </span>
          </div>
          <div style={S.card}>
            <p style={{ ...S.label, marginBottom:14 }}>Upload history</p>
            {processedFiles.length === 0 ? (
              <p style={{ fontSize:12, color:"#334155", textAlign:"center", padding:"20px 0" }}>No files yet</p>
            ) : (
              <div style={{ display:"flex", flexDirection:"column" }}>
                {[...processedFiles].reverse().map((f, i) => (
                  <div key={i} className="row-hover" style={{ display:"flex", alignItems:"center",
                    justifyContent:"space-between", padding:"9px 8px", borderBottom:"1px solid #0f172a" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:10, minWidth:0 }}>
                      <span style={{ fontSize:12, color:"#94a3b8", fontWeight:500,
                        overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{f.name}</span>
                      <span style={{ fontSize:11, color:"#334155", ...S.mono, flexShrink:0 }}>
                        {f.manual_date ? `${fmtDate(f.manual_date)} report` : f.date_range}
                        {" · "}{fmtN(f.rows)} rows
                      </span>
                    </div>
                    <div style={{ display:"flex", gap:6, flexShrink:0 }}>
                      {f.csv_content && (
                        <button className="dl-btn" onClick={() => handleDownload(f)} style={{
                          display:"flex", alignItems:"center", gap:4, fontSize:11, color:"#3B82F6",
                          background:"rgba(59,130,246,0.08)", border:"1px solid rgba(59,130,246,0.2)",
                          padding:"3px 9px", borderRadius:5, cursor:"pointer",
                          fontFamily:"'DM Sans',sans-serif", transition:"all 0.15s" }}>
                          <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                          </svg>
                          Download
                        </button>
                      )}
                      <button onClick={() => handleDeleteFile(f)} style={{
                        display:"flex", alignItems:"center", gap:4, fontSize:11, color:"#ef4444",
                        background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)",
                        padding:"3px 9px", borderRadius:5, cursor:"pointer",
                        fontFamily:"'DM Sans',sans-serif", transition:"all 0.15s" }}>
                        <svg width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                        </svg>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>)}

      </div>
    </div>
  )
}
