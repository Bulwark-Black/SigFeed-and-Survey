# WiFi Site Survey: Mission Control

A self-contained local web tool for professional Wi‑Fi and cellular site
surveys on a Mac. Build a coverage heatmap, aim a cellular gateway/antenna, walk
a property by phone GPS, and print a client-ready PDF. All on your machine, no
cloud or login, nothing to install but Python 3.

> **Full walkthrough:** see **[USER_GUIDE.md](USER_GUIDE.md)**, how to run a
> clean survey end to end, page by page. This README is just the quick start.

## Start it

**Easiest:** double-click **`start.command`**. It launches the server and opens
the dashboard. That leaves a Terminal window running; close it or press `Ctrl+C`
to stop. Double-clicking it again while it's already running just reopens the
dashboard instead of starting a second copy.

**Or from a terminal:**
```bash
python3 survey_server.py
```
Then open <http://127.0.0.1:8765>. Press `Ctrl+C` to stop.

macOS may offer to install Apple's Command Line Tools the first time. Accept it,
or run `xcode-select --install` first.

**From your phone:** on the same Wi‑Fi, open `http://<your-mac's-IP>:8765`. This
is what powers the walk-the-property GPS feature. macOS will ask once whether to
allow incoming connections; that's the phone link, so allow it.

## What it does

| Page | Purpose |
|------|---------|
| **Mission Control** | The hub, and where the app opens. Score ring, survey vitals, a progress checklist, top findings, and one-tap report / `.json` / `.csv` / `.kmz`. |
| **Live Signal** | Instant signal gauge + one-tap speed test (download, upload, latency, responsiveness) where you're standing. |
| **Coverage** | Pick a survey type, build a base map (draw / upload / auto-layout / aerial from an address, see **Base maps** below), walk and tap readings, and get a live heatmap with gradient, pass/fail, target scoring and labeled contour lines. |
| **Site Plan** | Walk a yard boundary by GPS, draw the house footprint, and place it inside the lot. |
| **Cellular** | Aim a home cellular gateway / antenna by RSRP / SINR, with live 5G and LTE panels, logged candidate mount spots, and a speed test. |
| **GPS Walk** | Connect your phone as a GPS source: paste-ready OwnTracks / GPSLogger URLs, a live accuracy badge, and the switch that tags each reading with your coordinates. You drop points and corners on **Coverage** and **Site Plan**. |
| **Report** | Client details, a 0–100 Wi‑Fi signal score with automated findings, site photos, and a one-click PDF. Save / export / re-open surveys here, plus both Google Earth outputs. |
| **Advanced** | Live network internals, NetSpot / WiFi Explorer / Wireless Diagnostics launchers, nearby-networks table, a full survey-points table, and the fields that print on the report. |
| **Guide** | "Which tool when" + a plain-English glossary. |

## Base maps

Type a property address on the **Coverage** page, then pick a source. All three
give the map true scale, so square footage, distances and GPS placement work
without calibrating anything.

| Source | Best for | Notes |
|--------|----------|-------|
| **🔎 Find** (Esri) | Most jobs | The default. Fast, works anywhere. |
| **🌾 NAIP** | US rural land | USDA public domain, and georeferenced by construction: the server renders exactly the ground box it asked for, so there is nothing to fit. Flown in summer, so tree canopy can hide a driveway or an outbuilding. US only. |
| **🌍 Google Earth** | When you want Google's picture | Moves the copy of Google Earth Pro on this Mac to the property and uses what it shows. Takes 30 to 70 seconds, longer at a cold site. |

Use **−** and **＋** to go wider or closer. They're on the 🔎 Find and 🌾 NAIP
maps only; to change a Google Earth capture's area, pick a different size from
the dropdown beside it and capture again.

Readings you have already dropped keep their real position when you change the
view. If a closer view would push some off the edge of the map, it counts them
and asks first.

### About the Google Earth option

It needs Google Earth Pro installed on this Mac. The first time you use it,
macOS asks permission to control Google Earth. **That prompt appears on the
Mac itself**, not on your phone, so someone has to be at the keyboard once.

Every capture measures how accurate it is and tells you, because the answer
varies enormously with the site. The figure is **measured per capture, not
estimated**: Google Earth is probed on a 9×9 grid, 81 terrain points across the
frame, a map projection is fitted to the corners, and the number reported is the
worst gap between a probe's true position and where that fit predicts it.

Tall trees and buildings lean outward from the middle of an overhead photo, so a
reading taken right under a big tree near the edge of the picture can sit several
feet from where it really is. Readings on open ground are near-exact.

| Measured accuracy | What happens |
|-------------------|--------------|
| Under 5 ft | Used with no prompt, and reported as a bound rather than a number: below that your phone's GPS is the bigger error |
| 5 to 25 ft | Used with no prompt, and the measured figure is shown and stamped on the map |
| 25 to 82 ft | One confirm before it's used |
| Above 82 ft | A single, stronger confirm instead: at that point a reading could land on the neighbouring property. Cancelling discards the capture |

There is never more than one accuracy dialog per capture. Capturing a smaller
area reduces the error, which is what both warnings ask you to do. The figure is
printed in the report alongside the surveyed area, so the number in a client's
hands is honest about its own tolerance.

Note that the "(captured …)" date beside it is when **you ran the capture**, from
this Mac's clock. It is not when Google flew the imagery, which the tool has no
way to read.

## Watch it live in Google Earth

On the **Report** page, **🛰 Live in Google Earth** opens Google Earth Pro and
keeps it updated every 3 seconds while you walk. Readings, boundary, routers, the
coverage colour and a moving **You are here** marker appear as you take them. The
button becomes **🛑 Stop live view**; stopping leaves the last picture in Google
Earth rather than clearing it.

Four things worth knowing:

- **Only the level whose tab is open** gets its coverage colour pushed. Readings,
  boundaries and routers from every level are drawn, but the colour wash is one
  level at a time, so the other floor of a two-storey job looks empty. The
  exported `.kmz` has no such limit.
- **Colour looking patchy under trees?** Google Earth draws its own 3D trees on
  top of the coverage layer. In Google Earth's **Layers** panel (bottom left),
  untick **3D Buildings** and it fills in. There is no way to fix this from our
  side.
- **A frozen feed looks exactly like a working one.** Google Earth keeps
  redrawing the last frame it accepted. The only signal is a toast on the
  dashboard, so keep it where you can see it.
- **Seeing everything twice?** Google Earth is still holding a survey from an
  earlier session. In **Temporary Places**, delete the older **WiFi Survey live
  coverage** entries.

## Exports

- **`.json`**: the full raw survey; re-open to resume or re-print (your master copy).
- **`.csv`**: every reading as a spreadsheet row.
- **`.kmz`**: coverage heatmap overlay, readings, boundary and routers for Google
  Earth. Needs coordinates to place, so at least one aerial base map or one
  GPS-tagged reading.
- **PDF**: the formatted client report.

## Rating scale (RSSI)

| Rating | RSSI | Meaning |
|--------|------|---------|
| Excellent | ≥ −55 dBm | Full speed, anywhere |
| Good | −56 to −67 dBm | Reliable video / VoIP |
| Fair | −68 to −75 dBm | Usable, borderline for 4K / calls |
| Poor | < −75 dBm | Dead-spot risk |

−67 dBm is the standard "reliable connectivity" line. SNR below ~15 dB flags a
noisy link even when RSSI looks fine.

## Checks

```bash
./check.sh        # 7 checks: js syntax, import graph, shared-state misuse, python syntax, dangling DOM ids, dead inline handlers, orphan CSS
./test.sh         # 223 assertions: coordinate maths, KMZ writer, export contents, imagery credit, server logic and auth
./test.sh --net   # 237 assertions: also re-verifies Esri and NAIP against the live services
```

In `check.sh` the first six set the exit code and the CSS report is advisory. The
two Node checks are skipped when Node isn't installed.

## Layout

```
survey_server.py   entry point: the HTTP handler and main()
wifisurvey/        the back end, split by concern
  config.py        bind address, per-run API key, what may be served or launched
  util.py          subprocess and HTTP helpers
  wifi.py          scan, link quality, speed test, ping, app launching
  cellular.py      gateway polling for antenna aiming
  gps.py           phone GPS bridge
  imagery.py       geocoding, the Esri tile proxy, USDA NAIP
  earth.py         driving Google Earth Pro over AppleScript
  live.py          the live coverage feed Google Earth polls; the persistent
                   live token and the constant-time key compare
dashboard.html     the main UI
run-sheet.html     the printable on-site checklist, opened by 🖨 Field run sheet
js/                the front end, as ES modules
  state.js         shared survey state; reads are plain, writes go through set.*
  core.js          ratings, gauges, toasts, the backend call wrapper, page switching
  live.js          live signal page, capturing readings, speed test
  cellular.js      gateway aiming, placement spots, site photos
  heatmap.js       the coverage engine: IDW grid, contours, map rendering
  basemap.js       Esri aerial, Google Earth capture, NAIP, reprojection
  planner.js       levels, schematic editor, rooms, AP marks, calibration, perimeter
  gps.js           phone GPS bridge, profile switcher, persistence
  earth.js         KMZ export and the live Google Earth feed
  report.js        the client report and findings engine
  ingest.js        importing surveys, scan CSVs, packet captures
  pages.js         guide, Site Plan, Mission Control home
  main.js          entry point: exposes inline-handler functions, then boots
```

Running the app needs only the `python3` macOS already provides. The four
JavaScript test suites need Node, which macOS does not include: `check.sh` skips
its two Node checks and says so, but `test.sh` has no such guard and will fail
without it. `check.sh` catches broken syntax and dead references; `test.sh`
catches wrong answers, which is the failure mode that actually reaches a client
report.

## Notes

- Runs on macOS built-in tools: `system_profiler` (live Wi‑Fi), `networkQuality`
  (speed), `ping`. No `sudo` required.
- **Restarting the server logs an open tab out.** Every `/api/` route needs a key
  the page picks up once at load, and the server issues a new one each start, so
  a tab left open across a restart reports "Backend offline" against a healthy
  server. Reload the page, and re-copy the phone's GPS URL, which carries the
  same key.
- Address lookup uses the US Census geocoder (rural-accurate) with a general
  geocoder fallback. Imagery sources are credited in the report by name.
- The live Google Earth view stores a small key at `~/.wifi-survey-live-token`
  (readable only by you) so Google Earth keeps working after the server restarts.
  It lives outside this folder and is not removed by deleting the project.
  Deleting it costs nothing, provided Google Earth isn't still holding a live
  entry from an earlier run: that entry keeps polling with the dead token, gets
  refused, and goes on displaying the previous survey. Press **🛰 Live in Google
  Earth** again to hand Earth a fresh link, or remove the old **WiFi Survey live
  coverage** entry from its Temporary Places.
- The live view is reachable only from this Mac. The dashboard and the phone GPS
  bridge still work from your phone as normal.
- If **Make the report** does nothing, allow pop-ups for `127.0.0.1`.
- The external **Alfa AWUS036ACM** adapter has no Apple-Silicon driver and isn't
  used. The built-in Wi‑Fi does everything this survey needs.
