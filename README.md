# WiFi Site Survey — Mission Control

A self-contained local web tool for professional Wi‑Fi and cellular site
surveys on a Mac. Build a coverage heatmap, aim a cellular gateway/antenna, walk
a property by phone GPS, and print a client-ready PDF — all on your machine, no
cloud or login, nothing to install but Python 3.

> **Full walkthrough:** see **[USER_GUIDE.md](USER_GUIDE.md)** — how to run a
> clean survey end to end, page by page. This README is just the quick start.

## Start it

**Easiest:** double-click **`start.command`** — it launches the server and opens
the dashboard.

**Or from a terminal:**
```bash
cd path/to/SigFeed-and-Survey
python3 survey_server.py
```
Then open <http://127.0.0.1:8765>. Press `Ctrl+C` to stop.

macOS may offer to install Apple's Command Line Tools the first time. Accept it,
or run `xcode-select --install` first.

**From your phone:** on the same Wi‑Fi, open `http://<your-mac's-IP>:8765` — this
is what powers the walk-the-property GPS feature. macOS will ask once whether to
allow incoming connections; that's the phone link, so allow it.

## What it does

| Page | Purpose |
|------|---------|
| **Live** | Instant signal gauge + one-tap speed test (download / upload / responsiveness) where you're standing. |
| **Coverage** | Pick a survey type, build a base map (draw / upload / auto-layout / aerial from an address — see **Base maps** below), walk and tap readings, and get a live heatmap with gradient, pass/fail, and labeled contour lines. |
| **Cellular** | Aim a home cellular gateway / antenna by RSRP / SINR, with live bars and a speed test. |
| **GPS** | Stream your phone's GPS to the Mac, drop points and property corners as you walk, export the survey to Google Earth (`.kmz`), or watch it fill in live in Google Earth as you walk. |
| **Report** | Client details, a 0–100 coverage score with automated findings, site photos, and a one-click PDF. Save / export / re-open surveys here. |
| **Advanced** | Live network internals, NetSpot / WiFi Explorer launchers, nearby-networks table. |
| **Guide** | "Which tool when" + a plain-English glossary. |

## Base maps

Type a property address on the **Coverage** page, then pick a source. All three
give the map true scale, so square footage, distances and GPS placement work
without calibrating anything.

| Source | Best for | Notes |
|--------|----------|-------|
| **🔎 Find** (Esri) | Most jobs | The default. Fast, works anywhere. |
| **🌾 NAIP** | US rural land | Public domain, sharper, and it prints a real capture date. Flown in summer, so tree canopy can hide a driveway or an outbuilding. US only. |
| **🌍 Google Earth** | When you want Google's picture | Moves the copy of Google Earth Pro on this Mac to the property and uses what it shows. Takes about 30 seconds. |

Use **−** and **＋** to go wider or closer. Readings you have already dropped
keep their real position when you change the view.

### About the Google Earth option

It needs Google Earth Pro installed on this Mac. The first time you use it,
macOS asks permission to control Google Earth — **that prompt appears on the
Mac itself**, not on your phone, so someone has to be at the keyboard once.

Every capture measures how accurate it is and tells you, because the answer
varies enormously with the site. Tall trees and buildings lean outward from the
middle of an overhead photo, so a reading taken right under a big tree near the
edge of the picture can sit several feet from where it really is. Readings on
open ground are near-exact. Typical figures:

| Site | Measured | What happens |
|------|----------|--------------|
| Open, flat (farmland, mown lot, desert) | under 1 ft | Used without comment — your phone's GPS is the bigger error |
| Suburban with mature trees | around 25 ft | The figure is shown and stamped on the map |
| Rolling or hilly | around 50 ft | You're asked to confirm before it's used |
| Steep wooded hillside | 100 ft or more | A second confirm — at that point a reading can land on the neighbour's property |

Those are real measurements, not estimates: flat Missouri farmland came out at
0.6 ft, a wooded Florida suburb at 24 ft, and a Colorado mountainside at 50 ft.

Capturing a smaller area reduces the error. The figure is printed in the report
alongside the surveyed area, so the number in a client's hands is honest about
its own tolerance.

## Watch it live in Google Earth

On the **Report** page, **🛰 Live in Google Earth** opens Google Earth Pro and
keeps it updated every 3 seconds while you walk — readings, boundary, routers
and the coverage colour appear as you take them.

Two things worth knowing:

- **Colour looking patchy under trees?** Google Earth draws its own 3D trees on
  top of the coverage layer. In Google Earth's **Layers** panel (bottom left),
  untick **3D Buildings** and it fills in. There is no way to fix this from our
  side.
- **Seeing everything twice?** Google Earth is still holding a survey from an
  earlier session. In **Temporary Places**, delete the older *WiFi Survey — live
  coverage* entries.

## Exports

- **`.json`** — the full raw survey; re-open to resume or re-print (your master copy).
- **`.csv`** — every reading as a spreadsheet row.
- **`.kmz`** — coverage heatmap overlay, readings, boundary and routers for Google Earth.
- **PDF** — the formatted client report.

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
./check.sh        # syntax, dangling DOM ids, dead inline handlers
./test.sh         # coordinate maths, KMZ writer, export contents, server logic, auth
./test.sh --net   # also re-verifies Esri and NAIP against the live services
```

No install and no dependencies — both use the `node` and `python3` already on
the Mac. `check.sh` catches broken syntax and dead references; `test.sh` catches
wrong answers, which is the failure mode that actually reaches a client report.

## Notes

- Runs on macOS built-in tools: `system_profiler` (live Wi‑Fi), `networkQuality`
  (speed), `ping`. No `sudo` required.
- Address lookup uses the US Census geocoder (rural-accurate) with a general
  geocoder fallback. Imagery sources are credited in the report by name.
- The live Google Earth view stores a small key at `~/.wifi-survey-live-token`
  (readable only by you) so Google Earth keeps working after the server
  restarts. It lives outside this folder and is not removed by deleting the
  project. Deleting it is harmless — a new one is made on the next start.
- The live view is reachable only from this Mac. The dashboard and the phone GPS
  bridge still work from your phone as normal.
- If **Make the report** does nothing, allow pop-ups for `127.0.0.1`.
- The external **Alfa AWUS036ACM** adapter has no Apple-Silicon driver and isn't
  used — the built-in Wi‑Fi does everything this survey needs.
