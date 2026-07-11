# WiFi Site Survey — Field User Guide

Everything this tool does and how to run a clean survey with it. Keep this open
on your phone or a second window while you work. There's also a short glossary
built into the app on the **Guide** page.

- **What it is:** a self-contained web app that runs on your Mac. It maps Wi‑Fi
  coverage, aims a cellular gateway/antenna, walks a property by GPS, and prints
  a client-ready PDF — with no cloud, no login, and no install beyond the Python
  that already ships with macOS.
- **Who it's for:** you, on-site, doing a paid survey. Everything stays on your
  machine.

---

## 1. Start & stop

**Start (easiest):** double-click **`start.command`** in `~/wifi-survey/`. It
launches the server and opens your browser to the dashboard.

**Start (terminal):**
```bash
cd ~/wifi-survey
python3 survey_server.py
```
Then open <http://127.0.0.1:8765>. Press **Ctrl+C** in the terminal to stop.

**On your phone too:** the server listens on your whole network, so from a phone
on the **same Wi‑Fi** you can open `http://<your-mac's-IP>:8765`. Find the IP in
**System Settings → Wi‑Fi → Details → IP address** (looks like `192.168.1.20`).
This is what makes the walk-the-property GPS feature work (section 8).

---

## 2. The seven pages

The left nav has seven pages. Each answers one question:

| Page | What it's for |
|------|---------------|
| **Live** | Stand somewhere and read the signal *right now* — a big signal gauge plus a one-tap speed test (download / upload / responsiveness). |
| **Coverage** | The main event: build a map, walk the space, tap where you stand, and watch the heatmap fill in. Your deliverable comes from here. |
| **Cellular** | Aim a home cellular gateway / Waveform antenna — find the window or wall with the best tower signal (RSRP / SINR). |
| **GPS** | Walk a property outdoors with your phone's GPS, drop points and corners, trace a boundary, export to Google Earth. |
| **Report** | Fill in the client details, review the auto-analysis + coverage score, add photos, and make the PDF. Also where you save/export/re-open a survey. |
| **Advanced** | Live network internals, launch buttons for NetSpot / WiFi Explorer, a nearby-networks table, and a manual capture. |
| **Guide** | Which external tool to reach for, the recommended workflow, and a plain-English glossary. |

---

## 3. Start a survey — pick a survey type

Open **Coverage**. The first thing it asks is **what you're surveying**. This is
just a filter that keeps the screen simple — it shows the tools that job needs
and hides the rest. You can switch types any time from the pill at the top, and
switching never deletes anything.

| Type | Use it for | What it shows |
|------|-----------|---------------|
| 🏠 **In-house** | Indoor coverage, room by room | Draw or upload a floor plan, then take readings |
| 🏡 **Around the house** | Outside, close to the building | Aerial photo + walk with your phone's GPS |
| 🌍 **Property / land** | The whole lot or acreage | Aerial photo, walk the boundary, export to Google Earth |
| 🗺️ **All together** | Mixed jobs — inside *and* out | Every tool available at once |

---

## 4. Build your base map

You need something to lay readings on. Four ways to get one — pick whichever
matches the site:

- **✏️ Draw a schematic** — sketch the rooms right here with your mouse/finger.
  No floor plan needed. Best when you have no drawing and it's a simple layout.
- **📐 Upload a photo / sketch** — drop in a photo of a floor plan, a hand
  sketch, or a satellite screenshot from Google Earth. Best when the client
  hands you a plan.
- **✨ Auto-layout from a list** — type your rooms one per line (add sizes like
  `Kitchen 12x14` or `Office 120` sq ft if you know them) and it arranges a
  rough draft you then drag into place. Fast starting point for a whole-house
  job. It can't know which room sits next to which, so expect to nudge them.
- **🛰 Aerial from address** — type an address and it pulls a satellite image to
  use as the base map. Best for outdoor / property jobs.

### Address format (for the aerial)

Type it as **street number + street, city, state, ZIP**:

> `1600 Amphitheatre Pkwy, Mountain View, CA 94043`

Always include the **city and state** (and ZIP if you have it) — a bare street
name often won't match. A place name works too: `Lincoln High School, Portland
OR`. Tap **🔎 Find**, the image loads, and you use **−／＋** to zoom out/in.

> **Rural addresses:** the tool checks the US Census address database *first*
> (it lands on the actual parcel), then falls back to a general geocoder. That's
> why a country address like `590 W Egg and I Rd, Chimacum, WA 98325` lands on
> the right house instead of the nearest town center.

---

## 5. Run the survey (Coverage page)

Once you have a base map, a small toolbar of **modes** appears. The important
one is the first:

- **📍 Take readings** — the survey itself. Walk to where you're standing, tap
  that spot on the map, and it records the live signal there. Repeat around the
  space. The heatmap builds as you go. **Take a reading roughly every 10–15 ft
  and in every corner** — the map is only as honest as the spots you actually
  stood on.
- **✏️ Arrange rooms** — drag auto-laid-out or drawn rooms to match reality.
- **▱ Draw perimeter** — trace the outer wall / property edge. This is what
  keeps the color map *inside* the building and off the neighbor's yard.
- **📡 Mark router** — drop a pin where the router / access point actually sits,
  so you can see whether coverage lines up with it.
- **＋ Add room / ◇ Shape room** — add or reshape rooms on a drawn schematic.

Every reading is graded on the spot: **🟢 strong · 🟡 weak · 🔴 dead**. The
floating dBm chip (bottom corner) always shows the signal where you last stood.

---

## 6. Read the heatmap

The heat controls (top of the Coverage map) let you look at the same walk in
different ways:

**Show —** which number the colors represent:
- **Signal** (dBm) — raw strength. The default.
- **Signal-to-noise (SNR)** — how clearly the device hears Wi‑Fi over static.
  Use this to catch a spot that "has signal" but is still flaky.
- **Data rate** — the speed the device and router *agreed to try for*.
- **Throughput** — the real measured speed (only on points where you ran a
  speed test).

**As —** how to color it:
- **Gradient** — a smooth warm-to-cool map. Warm = strong, cool = weak.
- **Pass / Fail** — green where it's good enough and red where it isn't, judged
  against a use-case bar you pick: **Web browsing**, **Video**, or **IoT / Smart
  home**. Great for showing a client exactly where 4K streaming will and won't
  work.

**Contour lines** (checkbox) — overlays labeled iso-signal lines, like a
topographic map: each line marks a constant signal level (e.g. a line labeled
`−67`) so you can see exactly where "Good" turns into "Fair." Turn this on for a
professional-looking report; the lines print into the PDF too.

**Pixelate** — sharpens the color blocks for low-resolution floor plans so
straight lines keep hard edges.

> The color map only fills the area you actually walked (bounded by your
> readings, or by the perimeter if you drew one). It won't invent coverage in a
> wing you never entered — a dead area on the map means *"no data here,"* which
> is honest and what a client should see.

---

## 7. The Live page — quick reads & speed test

Use **Live** when you just want to know "how's the Wi‑Fi right *here*" without
running a whole survey.

- **Signal gauge** — a live needle of Wi‑Fi strength. Walk around and watch it
  rise and fall. Good for hunting a dead spot or finding the best router shelf.
- **Big speed test button** — one tap runs a real speed test and sweeps the
  needle through **download, upload, and responsiveness (throughput)**. Uses
  macOS's built-in `networkQuality`, so it measures your actual internet path.
  It can take 20–45 seconds; the button restores itself when done.

---

## 8. Walk a property with your phone's GPS

This lets you survey **outdoors** by physically walking — no Google Earth Pro
needed. Your phone streams its location to the Mac, a live dot moves on the
aerial, and you drop points and corners as you walk.

### One-time phone setup

1. Make sure the Mac's server is running and your **phone is on the same
   Wi‑Fi**.
2. On the phone, install a free location-sender app:
   - **OwnTracks** (iOS/Android) — set it to **HTTP** mode, POST to
     `http://<mac-ip>:8765/api/gps`. *(Recommended — it pushes automatically.)*
   - **GPSLogger** (Android) — set a custom URL log to the same address.
3. Point either app at `http://<your-mac's-IP>:8765/api/gps` (the IP from
   section 1).
4. Open the **GPS** page on the Mac. When a fix arrives you'll see the accuracy
   in meters and a live dot on the map.

### Then, on-site

- **📍 Mark my GPS spot** — drops a reading at your exact location as you walk.
  (You can also just tap the map.)
- **Corners** — drop the property corners as you reach them; connect them to
  trace the boundary.
- **🌍 Export KML** — saves the boundary + points as a `.kml` you can open in
  **Google Earth** or hand to the client.

> Smaller GPS accuracy (in meters) = more exact. If accuracy is poor, step into
> the open away from the building and give it a few seconds to settle.

---

## 9. Cellular — aim a gateway / antenna

For jobs with a home cellular gateway (e.g. a T‑Mobile gateway + Waveform
antenna), open **Cellular** to find the best mounting spot.

- Live **signal bars** plus the raw numbers: **RSRP** (tower signal strength —
  closer to zero is stronger), **RSRQ**, and **SINR** (how clean the signal is
  over interference — higher is faster and steadier).
- A **connection badge** confirms when you're associated to the gateway.
- A **cellular speed test** for throughput at the current spot.

Move the antenna to a window or wall, watch RSRP and SINR, and settle on the
spot that reads best. Aim the gateway *first*, then survey the Wi‑Fi it puts out.

---

## 10. Advanced — internals & external tools

The **Advanced** page is for digging in and for launching the specialist apps:

- **Network details** — live RSSI, SNR, channel, PHY (Wi‑Fi generation), TX
  rate, security, and the gateway you're on.
- **Tools** — one-tap launch of **NetSpot** and **WiFi Explorer** (see the Guide
  page for when to use each), plus **Ping gateway** and a manual **Capture
  point**.
- **Nearby Networks** — every SSID in earshot with its channel and signal — use
  it to spot co-channel crowding before you retune a router.

---

## 11. Make the report (Report page)

1. **Client & Site** — client/owner name, property address, technician. These
   print on the report.
2. **AI Insights** — as soon as you have readings, this shows a **0–100 Wi‑Fi
   signal score** (coverage + reliability + speed + interference + cellular
   rolled into one grade) plus plain-English findings and recommendations.
3. **📥 Ingest tool data** — pull in extra evidence: a saved survey `.json`, a
   Wi‑Fi scan `.csv` from WiFi Explorer, a `.pcap` capture, or a heatmap image
   from NetSpot.
4. **📸 Site Photos & Screenshots** — add photos; they appear in the PDF.
5. **📄 Make the report** — opens the formatted report. Use your browser's
   **Print → Save as PDF** to produce the client file.

> If "Make the report" seems to do nothing, allow pop-ups for `127.0.0.1`.

---

## 12. Save, export & re-open

Everything you can hand off, from the Report page:

| Button | File | Use it for |
|--------|------|-----------|
| ⬇︎ **Save survey** | `.json` | The complete raw survey. Re-open it later to resume or re-print — this is your master copy. |
| 📊 **Export data** | `.csv` | Every reading as a spreadsheet row (room, floor, band, channel, RSSI, SNR, rate, rating, GPS coords…) for your own records or a client who wants the raw numbers. |
| 🌍 **Google Earth** | `.kml` | The GPS boundary + points, opens in Google Earth. |
| 🖨 **Field run sheet** | print | A printable on-site checklist. |
| ⬆︎ **Open survey file** | — | Load a saved `.json` back in to continue or re-report. |
| 🗑 **Start over** | — | Clear everything and begin fresh. |

**Your work is also auto-saved** in the browser as you go, so a refresh won't
lose it — but **Save survey (.json)** is what you keep between jobs and between
machines.

---

## 13. Multi-floor & multiple jobs

- **Floors / levels** — a house with a basement, main floor, and upstairs gets a
  tab per level, each with its own map and heatmap. Add levels from the Coverage
  page.
- **Survey profiles** — each job is kept separate, so last week's survey doesn't
  bleed into today's. Start-over clears only the current one.

---

## 14. Rating scale (reference)

Wi‑Fi signal (RSSI), the same grades the map and report use:

| Rating | RSSI | Meaning |
|--------|------|---------|
| **Excellent** | ≥ −55 dBm | Full speed, anywhere |
| **Good** | −56 to −67 dBm | Reliable video / VoIP |
| **Fair** | −68 to −75 dBm | Usable, borderline for 4K / calls |
| **Poor** | < −75 dBm | Dead-spot risk |

−67 dBm is the standard "reliable connectivity" line. **SNR below ~15 dB** flags
a noisy link even when the RSSI looks fine — that's what the SNR heatmap catches.

---

## 15. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Dashboard won't open | Is the server running? Re-run `python3 survey_server.py` and open <http://127.0.0.1:8765>. |
| "Make the report" does nothing | Allow pop-ups for `127.0.0.1` in the browser. |
| Phone GPS not showing | Phone and Mac on the **same Wi‑Fi**? URL points at the **Mac's IP** (not 127.0.0.1) with `:8765/api/gps`? Server running? |
| Aerial finds the wrong place | Add city + state + ZIP. For rural spots the Census lookup usually nails it; a place name (`… High School, City ST`) also helps. |
| Speed test "hangs" | `networkQuality` can take 20–45 s on a slow link — give it time; the button resets itself. |
| Heatmap has blank areas | That's correct — it only colors where you took readings. Walk those spots and re-read. |
| Live signal shows "not associated" | The Mac isn't on Wi‑Fi, or is on Ethernet. Join the client's SSID. |

---

## 16. Under the hood (for reference)

- **Server:** `survey_server.py`, Python 3 standard library only, port **8765**,
  listens on all interfaces so a phone can reach it.
- **Live Wi‑Fi data:** macOS `system_profiler SPAirPortDataType` (RSSI, SNR,
  channel, rate, PHY, security). No `sudo` needed.
- **Speed test:** macOS `networkQuality`.
- **Aerial imagery:** Esri World Imagery, fetched through the local server so
  there's no cross-site issue. Address lookup: US Census geocoder, then a
  general geocoder as fallback.
- **The Alfa AWUS036ACM** external adapter has no Apple-Silicon driver and isn't
  used — the built-in Wi‑Fi does everything a coverage survey needs.

---

*Short glossary and a "which tool when" cheat-sheet live on the in-app **Guide**
page. This file is the deep reference.*
