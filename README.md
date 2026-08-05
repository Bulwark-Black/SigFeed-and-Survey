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

## Checks

```bash
./check.sh    # syntax, dangling DOM ids, dead inline handlers
./test.sh     # coordinate maths, KMZ writer, server logic, auth
./test.sh --net   # also re-verifies Esri and NAIP against the live services
```

**From your phone:** on the same Wi‑Fi, open `http://<your-mac's-IP>:8765` — this
is what powers the walk-the-property GPS feature. macOS will ask once whether to
allow incoming connections; that's the phone link, so allow it.

## What it does

| Page | Purpose |
|------|---------|
| **Live** | Instant signal gauge + one-tap speed test (download / upload / responsiveness) where you're standing. |
| **Coverage** | Pick a survey type, build a base map (draw / upload / auto-layout / aerial-from-address), walk and tap readings, and get a live heatmap with gradient, pass/fail, and labeled contour lines. |
| **Cellular** | Aim a home cellular gateway / antenna by RSRP / SINR, with live bars and a speed test. |
| **GPS** | Stream your phone's GPS to the Mac, drop points and property corners as you walk, export the survey to Google Earth (`.kmz`). |
| **Report** | Client details, a 0–100 coverage score with automated findings, site photos, and a one-click PDF. Save / export / re-open surveys here. |
| **Advanced** | Live network internals, NetSpot / WiFi Explorer launchers, nearby-networks table. |
| **Guide** | "Which tool when" + a plain-English glossary. |

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

## Notes

- Runs on macOS built-in tools: `system_profiler` (live Wi‑Fi), `networkQuality`
  (speed), `ping`. No `sudo` required.
- Aerial imagery is Esri World Imagery; address lookup uses the US Census
  geocoder (rural-accurate) with a general geocoder fallback.
- If **Make the report** does nothing, allow pop-ups for `127.0.0.1`.
- The external **Alfa AWUS036ACM** adapter has no Apple-Silicon driver and isn't
  used — the built-in Wi‑Fi does everything this survey needs.
