# UGC Rejection Dashboard — Setup Guide (Windows)

## First-time setup (do this once)

### Step 1 — Install Node.js
1. Go to https://nodejs.org
2. Click the "LTS" download button (the left one)
3. Run the installer — click Next through all the defaults
4. When it finishes, restart your computer

### Step 2 — Put the project folder somewhere convenient
Move the `ugc-dashboard` folder to wherever you want it to live,
e.g. your Desktop or Documents folder.

### Step 3 — Run the setup script
Double-click `start.bat` inside the `ugc-dashboard` folder.

The first time you run it, it will download the required packages
(this takes about 30 seconds). Your browser will open automatically
at http://localhost:5173

---

## Every week after that

Just double-click `start.bat` — it opens straight away in your browser.
The terminal window that opens needs to stay open while you use the app.
Close it when you're done.

---

## Using the dashboard

1. Open the weekly UGC rejection CSV in Explorer
2. Drag it onto the drop zone in the browser
3. The dashboard updates immediately
4. Drop it again next week — the history accumulates automatically
5. Data is saved in your browser, so it persists between sessions

---

## Sharing with a colleague on the same computer

They just double-click `start.bat` and open http://localhost:5173
The data is stored in the browser's localStorage, so it's per-browser.

## Notes

- The terminal window that opens when you run start.bat must stay open
- If the browser doesn't open automatically, go to http://localhost:5173
- To stop the app, close the terminal window or press Ctrl+C inside it
