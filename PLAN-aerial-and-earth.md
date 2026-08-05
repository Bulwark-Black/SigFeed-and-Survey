# Aerial imagery + Google Earth integration — plan

Decided 2026-08-04. Four phases. Each phase ships and gets verified before the next starts.

## Project context

This ships as a **free, open-source, non-commercial** tool. That is the governing assumption for
everything below and it was the owner's explicit decision, recorded here so nobody has to re-derive
it later.

It matters because the Google Earth restriction that would otherwise block the capture feature is
specifically a bar on *commercial or promotional* use. A free non-commercial tool is a different
case from the billed client deliverable the earlier analysis assumed. Both Google Earth capture and
the live-overlay work are in scope.

For the record, and without changing the decision: the software being free does not by itself say
anything about what an individual contractor does with its output on a paid job. That's downstream
of this repo and outside what the code can control.

Attribution is kept correct throughout regardless — crediting Esri's licensors is accuracy, costs
nothing, and is not a commercial-use question. Same for stating imagery dates and positional
tolerance in the report: those are honesty about the measurement, not licensing.

## Verified: what Google Earth Pro can actually be driven to do

Measured on GE Pro 7.3.7.1155, macOS 15.6, 1920x1080 non-Retina. Every number below is empirical,
not a documented API contract — Google can change any of it in a point release.

- `GetPointOnTerrain` takes **normalized device coordinates in [-1,+1]**, +Y up, (0,0) = viewport
  centre. Returns **[latitude, longitude, elevation]** — lat FIRST, opposite of KML order.
- The NDC square maps to the **full screenshot rectangle**. hFOV is fixed at exactly 60 degrees
  regardless of window shape, so `ground_width = 1.1547005 * requested_distance`.
- A Mercator `LatLonBox` fit from the four NDC corners is accurate to **~0.001 m** of projection
  error. Do not warp. Measured end-to-end worst residual on flat farmland: **0.27 m** over a 13x13
  grid.
- **Relief displacement is the entire practical error budget** and no 2D warp can remove it — it is
  radial from nadir and proportional to each object's own height. Worst residuals at 350 m: flat
  farmland 0.51 m, coastal with canopy 9.43 m, wooded mountainside 32.39 m. Rule of thumb:
  `worst_error ~= 0.25..0.68 x elevation spread in view`.
- The elevation returned is the **rendered surface**, including tree canopy and buildings — so it
  cannot be repurposed as a DEM to orthorectify this properly later.

## Esri (separate, unchanged by the above)

World Imagery is Living Atlas content and its terms say it "is not intended to be used to export
tiles for offline," which is close to what `composeAerial()` does. Public-domain USDA NAIP (Phase 3)
removes the question entirely and is worth doing on its own merits — it is sharper, orthorectified,
and carries a real capture date.

---

## Status — all phases done

- **Phase 1.** Aerial pipeline defects fixed.
- **Phase 2.** `adoptAerial()` seam, heat-aspect fix, Google Earth capture end to end.
- **Phase 3.** USDA NAIP as a selectable source.
- **Phase 4.** KMZ export with the heatmap as a GroundOverlay.
- **Phase 5.** Live NetworkLink feed into Google Earth.

## Things that only turned up by rendering, not by reading specs

**Google Earth's 3D trees always draw OVER a GroundOverlay.** On a wooded lot the coverage wash
shows through canopy gaps and nowhere else. This is render order, not depth: raising the overlay to
250 m with `relativeToGround` changes nothing, and neither does fixing the KML element order. There
is no KML-side fix. The technician unticks **3D Buildings** in Earth's Layers panel; the UI says so.

**Re-opening the same loader `.kml` path is a silent no-op.** Earth keeps the NetworkLink it made
the first time and never re-reads the file, so the button appeared to do nothing. Verified: a used
path produced zero polls, a fresh filename produced one every 3 s immediately. `action_live_open()`
now writes a uniquely-named loader each time.

**The API key had to stop being the live feed's credential.** `API_KEY` is per-run by design, but
Earth holds its NetworkLink across restarts — so after a restart it 403s and just keeps drawing its
last good frame. A silently stale coverage map is the worst possible failure here. `LIVE_TOKEN` now
persists (0600, `~/.wifi-survey-live-token`) and only the two read-only live routes accept it;
`API_KEY` is unchanged for everything else.

**NAIP answers out-of-coverage with a fully transparent PNG at HTTP 200** — the same silent-empty
trap as Esri's placeholder. Detected exactly by decompressing IDAT and checking for all-zero bytes,
not by a size heuristic.

**Duplicate NetworkLinks render the whole survey twice.** There is no way to remove one from here,
so the client refuses to open a second link once this session has opened one.

## Tests

`./check.sh` catches syntax and dangling references. `./test.sh` (198 assertions, no dependencies)
catches wrong ANSWERS — coordinate maths judged in ground metres, the KMZ writer at the byte level,
export contents, server logic and auth. `./test.sh --net` additionally re-verifies Esri and NAIP
against the live services, including that Esri's placeholder digest still matches.

## Defects found by the tests and the adversarial review

Twelve confirmed out of twenty-two candidates. The ones worth remembering:

- **`hmac.compare_digest` raises on non-ASCII.** Pre-existing: `/api/scan?k=é` had always thrown a
  500 rather than returning 403. Both call sites now compare UTF-8 bytes via `secret_eq()`.
- **`toggleLiveEarth()` recursed forever.** `liveOn = false; toggleLiveEarth()` flipped it straight
  back to true and re-fired `/api/live/open`. Measured 40 POSTs before the harness capped it.
- **A busy capture answered `ok: True` and dropped the new coordinates.** Copied from the speed
  test, where re-attaching is harmless; here the caller would adopt another property's base map.
- **`committed` is not `saved`.** `adoptAerial()` swaps `geoBounds` and the image BEFORE it tries to
  persist, so a quota failure left the frame live while `zoomAerial` skipped the rebase — every pin
  then described different ground. The compose functions now report both.
- **`LIVE_TOKEN` was reachable from the LAN.** It outlives the process by design, so the two live
  routes are now loopback-only. Google Earth is unaffected (its href is hardcoded to 127.0.0.1) and
  the phone workflow is unaffected (the dashboard and `/api/*` still answer on the LAN). The loader
  in `$TMPDIR` is written 0600, and the token file is re-chmodded on every read.
- **A too-large live push was silently swallowed.** The transport capped bodies at 1 MiB while
  `action_live_push` advertised 4 MB, and the client discarded the 413 — so Earth kept redrawing a
  frozen frame. The cap is now per-route, and a stalled push says so once.

Verified on the Google Earth capture: absolute georeference cross-checked against Esri imagery
rendered at the same computed bounds — the same fixed structure landed within **2.3 m** on a
229x145 m frame. Frame centre 1.78 m from the requested point. Fraction round-trip exact to 1.3e-9 m.
Derived ground width 731 ft against 732 expected.

**Do NOT crop the burned-in Google Earth chrome.** The plan originally called for cropping the
bottom status strip. Measured pixel rows across two captures at the same y: mean colour differs
(suburb `(81,89,86)`, mountainside `(57,67,47)`), i.e. the ground shows THROUGH the overlay text.
It is composited, not opaque. Cropping would discard real imagery. The overlays are disclosed in
the UI instead.

## Phase 1 — fix the aerial pipeline (DONE)

Confirmed defects in code that already ships to clients. Files: `survey_server.py`, `app.js`,
`dashboard.html`.

1. **Esri serves blank tiles as HTTP 200.** A 2521-byte "no data" JPEG, md5
   `f27d9de7f80c13501f470595e327aa6d`, byte-identical everywhere. `action_tile()` only checks
   `status != 200 or not body`, so these composite into client reports as blank squares, silently.

   Verified directly, and two corrections to the original research:
   - **Do not clamp zoom to 19.** Rural Montana returns real imagery at z20 (13.6 KB) and z21
     (10.5 KB). Coverage is per-area, not a global ceiling. Urban SF, meanwhile, is placeholder at
     z21. Clamping would discard imagery we legitimately have.
   - **Do not use a size threshold.** A real mid-Pacific ocean tile at z12 is 1660 bytes — smaller
     than the placeholder. "Under 3 KB means no data" would blank out waterfront properties. Exact
     hash match only; it fails open if Esri ever changes the tile, which is the safe direction.

2. **`composeAerial()` claims success when the save failed.** It calls `saveLevels()` at app.js:1958
   and discards the boolean, then toasts "Aerial ready" regardless. `saveLevels()` returns false on
   quota failure and `store()` only warns. The most expensive artifact in a survey can exist in
   memory only while the surveyor is told it saved.

3. **No storage feedback on the largest write in the app.** `renderStorageBar()` runs only from
   `showPage('report')` and the photo-add path.

4. **Zooming an aerial silently relocates every reading.** `zoomAerial()` recomposes with new
   `geoBounds`, but readings keep plain [0,1] `mapX/mapY` fractions, so each one lands at a different
   real-world spot. Nothing warns.

5. **The +/- zoom buttons die on reload.** `lastAerial` is in-memory only, so after any reload the
   level has valid `geo` but zoom is dead.

6. **Attribution is incomplete.** Says "Imagery © Esri"; the service's own `copyrightText` is
   "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community" (verified live against
   the MapServer JSON). Dropping licensors is its own violation.

## Phase 2 — KMZ export with the heatmap as a GroundOverlay

`buildHeatCanvas()` (app.js:1269) already renders the coverage wash with per-pixel alpha in
normalized [0,1] map space — the same space `geoBounds` spans and `mapToLatLonIn()` inverts. So it
maps onto a KML `<GroundOverlay><LatLonBox>` directly. KML color is `aabbggrr`, not rgba.

Also fixes two live bugs in `exportKML()`: AP markers (app.js:3417) and the perimeter (app.js:3429)
are both gated on the *active* level's global `geoBounds`, so on a multi-level survey every other
floor's routers and boundary are silently dropped. And readings carry no `<Style>` at all — they all
render as identical default pushpins, so signal quality isn't visible.

Client-side only. No server changes, no API key problem. KMZ is a zip; stored entries only.

## Phase 3 — USDA NAIP as a selectable second imagery source

Public domain, no key, no commercial bar. Served by the USGSNAIPPlus ImageServer `exportImage`
endpoint — one bbox request, not z/x/y tiles, so it needs a sibling `action_aerial()` rather than a
change to `action_tile()`. Geometry lines up: the current z19 4x4 grid spans 305.7 m, which at
1024 px is 0.299 m/px against NAIPPlus's declared 0.3 m.

**Must be tested before committing.** NAIP flies leaf-on, May–September. On wooded parcels the canopy
hides structures and driveways, which for this work may be worse than Esri despite being sharper.
Needs 3–5 real survey addresses run both ways and eyeballed. Ship as a picker, never a replacement.

## Phase 4 — live NetworkLink feed into Google Earth Pro

Earth Pro desktop honours `refreshMode onInterval`; Earth *web* does not. `_host_ok()` already
accepts `127.0.0.1`, so no security changes needed.

Real work is that `survey_server.py` holds no survey data — only a single last-write-wins GPS fix.
Everything lives in browser localStorage, so this needs a browser-to-server push path that has never
existed, debounced off `savePoints()` and `saveLevels()`.

Known traps: Earth caches NetworkLink responses at the HTTP layer (clone the no-store header block
from `_send_file`); the GroundOverlay PNG is a separate URL-keyed fetch needing its own cache
headers; set `flyToView 0` and `refreshVisibility 0` or it seizes the camera and resets the
technician's checkboxes every refresh; no TimePrimitive in a live document or features vanish behind
the time slider.

**Open decision before any code:** `API_KEY` regenerates every server start, and Earth can't send a
custom header, so the key must sit in the query string — meaning a saved `.kml` 403s after a restart
and shows as a stale layer, not an error. Options: regenerate the loader `.kml` on server start, or
persist the key to a dotfile. Do not exempt the KML route from `_key_ok` — that regresses commit
47beaea and puts client survey data on the LAN unauthenticated.
