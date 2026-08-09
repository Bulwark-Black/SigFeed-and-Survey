# WiFi Site Survey: Field User Guide

Everything this tool does and how to run a clean survey with it. Keep this open
on your phone or a second window while you work. There's also a short glossary
built into the app on the **Guide** page.

- **What it is:** a self-contained web app that runs on your Mac. It maps Wi‑Fi
  coverage, aims a cellular gateway/antenna, walks a property by GPS, and prints
  a client-ready PDF, with no cloud, no login, and nothing to install but
  Python 3. The first run may ask to install Apple's Command Line Tools; accept
  it, or run `xcode-select --install` beforehand.
- **Who it's for:** you, on-site, doing a paid survey. Everything stays on your
  machine.

---

## 1. Start & stop

**Start (easiest):** double-click **`start.command`** in the app folder. It
launches the server and opens your browser to the dashboard.

That opens a Terminal window and leaves the server running in it. To stop, close
that window or press **Ctrl+C** in it. Double-clicking `start.command` again
while it's already running won't start a second copy: it notices the server on
port 8765, prints "Already running. Opening the dashboard." and just reopens the
dashboard.

**Start (terminal):**
```bash
python3 survey_server.py
```
Then open <http://127.0.0.1:8765>. Press **Ctrl+C** in the terminal to stop.

**On your phone too:** the server listens on your whole network, so from a phone
on the **same Wi‑Fi** you can open `http://<your-mac's-IP>:8765`. Find the IP in
**System Settings → Wi‑Fi → Details → IP address** (looks like `192.168.1.20`).
This is what makes the walk-the-property GPS feature work (section 9).

> **Restarting the server logs the page out.** The dashboard picks up a key from
> the server once, when the page loads, and the server issues a brand new key
> every time it starts. A tab left open across a restart is holding a key the
> server no longer accepts, and every panel will read "Backend offline" even
> though the server is fine. Reload the page (**Cmd+R**). Your phone's GPS URL
> carries the same key, so re-copy that too (section 9).

---

## 2. The pages

The left nav opens on **Mission Control**, then groups the rest into **Survey**,
**Deliver** and **Tools**. Each page answers one question:

| Page | What it's for |
|------|---------------|
| **Mission Control** | The hub, and where the app opens. Your score ring, survey vitals (rooms, best, worst, dead spots, % passing, area, cellular), a progress checklist, the top three findings, and quick links. It can also finish the job on its own: **📄 Generate report**, **⬇︎ .json**, **📊 .csv** and **🌍 .kmz** are all here. |
| **Live Signal** | Stand somewhere and read the signal *right now*: a big signal gauge plus a one-tap speed test. |
| **Coverage** | The main event: build a map, walk the space, tap where you stand, and watch the heatmap fill in. Your deliverable comes from here. |
| **Site Plan** | Walk a yard by GPS and place a hand-drawn house inside it. |
| **Cellular** | Aim a home cellular gateway / Waveform antenna. Find the window or wall with the best tower signal. |
| **GPS Walk** | Connect your phone as a GPS source: paste-ready OwnTracks / GPSLogger URLs, a live fix-and-accuracy badge, and the switch that stamps coordinates onto each reading. You drop the points and corners themselves on **Coverage** and **Site Plan**. |
| **Report** | Client details, the auto-analysis and score, photos, and the PDF. Also where you save/export/re-open a survey, and where the Google Earth exports live. |
| **Advanced** | Live network internals, three tool launchers, a nearby-networks table, a manual capture, and three fields that print on the report. |
| **Guide** | Which external tool to reach for, the recommended workflow, and a plain-English glossary. |

---

## 3. Start a survey: pick a survey type

Open **Coverage**. The first thing it asks is **what you're surveying**. This is
just a filter that keeps the screen simple. It shows the tools that job needs
and hides the rest. You can switch types any time from the pill at the top, and
switching never deletes anything.

| Type | Use it for | What it shows |
|------|-----------|---------------|
| 🏠 **In-house** | Indoor coverage, room by room | Draw or upload a floor plan, then take readings |
| 🏡 **Around the house** | Outside, close to the building | Aerial photo + walk with your phone's GPS |
| 🌍 **Property / land** | The whole lot or acreage | Aerial photo or an uploaded image only (Draw and Auto-layout are hidden). Opens straight into **▱ Draw perimeter** so you trace the boundary first, then switch to **📍 Take readings**. Room tools and **📡 Mark router** are unavailable on this type; switch to 🗺️ All together if you need to mark the router |
| 🗺️ **All together** | Mixed jobs, inside *and* out | Every tool available at once |

---

## 4. Build your base map

You need something to lay readings on. Four buttons, and the last one holds
three different imagery sources. Pick whichever matches the site:

- **✏️ Draw a schematic**: sketch the rooms right here with your mouse/finger.
  No floor plan needed. Best when you have no drawing and it's a simple layout.
- **📐 Upload a photo / sketch**: drop in a photo of a floor plan, a hand
  sketch, or a satellite screenshot. Best when the client hands you a plan.
  Set the scale afterwards (section 6) or square footage won't work.
- **✨ Auto-layout from a list**: type your rooms one per line (add sizes like
  `Kitchen 12x14` or `Office 120` sq ft if you know them) and it arranges a
  rough draft you then drag into place. Fast starting point for a whole-house
  job. It can't know which room sits next to which, so expect to nudge them.
- **🛰 Aerial from address**: opens an address box with **three** imagery
  sources, plus a size dropdown that applies to the Google Earth capture only.
  Best for outdoor / property jobs.

### The three aerial sources

Type the address, then pick a source. All three give the map true scale, so
square footage, distances and GPS placement work without calibrating anything.

| Source | Best for | What to know |
|--------|----------|--------------|
| **🔎 Find** (Esri) | Most jobs | The default, and pressing Enter in the address box does the same thing. Fast, works anywhere. |
| **🌾 NAIP** | US rural land | USDA public-domain imagery, georeferenced by construction: the server renders exactly the ground box it asked for, so there is nothing to fit. Flown in summer, so tree canopy can hide a driveway or an outbuilding. US only. |
| **🌍 Google Earth** | When you want Google's picture | Drives the copy of Google Earth Pro on this Mac and uses what it shows. Measures and reports its own accuracy (section 5). |

**Zooming.** **−** and **＋** go wider or closer, and they appear on the **🔎
Find** and **🌾 NAIP** maps only. A Google Earth capture has no zoom buttons; to
change the area, pick a different size from the dropdown next to the 🌍 Google
Earth button and capture again.

Readings you've already dropped keep their real position when you change the
view. If a closer view would push some off the edge, it counts them and asks
first: they stay in the survey and the readings list but won't show on the map
or in the heatmap. Same for perimeter corners and router marks.

**Capture size** (the dropdown beside 🌍 Google Earth) sets how much ground the
capture covers: **~300 ft**, **~750 ft** (default), **~1300 ft** or **~2300 ft**
across. It affects the Google Earth capture only. Picking a smaller size is the
fix both accuracy warnings ask for, because the error scales with how much
relief is in frame.

**No address? Google Earth can use your phone.** It's the only source that works
with the address box empty. If the phone GPS bridge is connected and the last
fix is under 120 seconds old, leave the address blank and tap **🌍 Google
Earth**: it captures where you're standing and says "Using your current GPS
position". That's how an unaddressed parcel, a new build or raw acreage gets a
base map. With no address and no fresh fix it stops and asks for one. 🔎 Find
and 🌾 NAIP always need an address.

### Address format

Type it as **street number + street, city, state, ZIP**:

> `1600 Amphitheatre Pkwy, Mountain View, CA 94043`

Always include the **city and state** (and ZIP if you have it). A bare street
name often won't match. A place name works too: `Lincoln High School, Portland
OR`.

> **Rural addresses:** the tool checks the US Census address database *first*
> (it lands on the actual parcel), then falls back to a general geocoder. That's
> why a country address like `590 W Egg and I Rd, Chimacum, WA 98325` lands on
> the right house instead of the nearest town center.

### Three warnings worth reading

**"Found only the area."** The address resolved to a town or area, not a
building. The aerial loads anyway, centred on the wrong ground, so every reading
you place by tapping will be in the wrong spot until you zoom in with **＋** and
re-centre by eye. This warning appears on **🔎 Find** only. NAIP and Google
Earth use the same lookup but stay quiet when it's imprecise, so check the
picture before you trust it.

**Missing imagery.** Esri's coverage depth varies by location, so a view can come
back with blank squares. With none at all you get "No satellite imagery here at
this zoom. Tap − for a wider view." and nothing loads. With a partial grid you
get a count of how many tiles exist, and it **loads the frame anyway, gaps and
all**, which will carry straight through to the client report if you ignore it.
Tap **−** to rebuild one step wider. NAIP answers a miss differently: "No NAIP
imagery here. It covers the United States only."

**"Browser storage is full."** An aerial is the largest single thing the app
saves, so it's where the browser's roughly 5 MB budget runs out. When it does,
the map is on screen and looks completely normal **but was never saved, and a
refresh loses it**. All three sources say so. Act on it immediately: Report page
→ **⬇︎ Save survey (.json)**, before you reload anything. This is the one
exception to "your work is auto-saved" in section 15.

---

## 5. How accurate is a Google Earth base map?

Every Google Earth capture measures its own accuracy and tells you, because the
answer varies enormously with the site. The figure is **measured per capture,
not estimated**: Google Earth is probed on a 9×9 grid, 81 terrain points across
the frame, a map projection is fitted to the corners, and the number reported is
the worst gap between a probe's true position and where that fit predicts it.

Tall trees and buildings lean outward from the middle of an overhead photo, so a
reading taken right under a big tree near the edge of the picture can sit
several feet from where it really is. Readings on open ground are near-exact.

| Measured accuracy | What happens |
|-------------------|--------------|
| **Under 5 ft** | Used with no prompt. Reported as a bound, "positions accurate to under 5 ft", rather than a number: below that your phone's GPS is the bigger error |
| **5 to 25 ft** | Used with no prompt, and the measured figure is shown in the toast, under the map, and in the report |
| **25 to 82 ft** | One confirm before it's used, telling you the figure and that capturing a smaller area reduces it |
| **Above 82 ft** | A single, stronger confirm instead: at that point a reading could land on the neighbouring property. Cancelling discards the capture |

There is never more than one accuracy dialog per capture. If you cancel the
strong one, the base map is not adopted at all.

Capturing a smaller area reduces the error. The figure is printed in the report
alongside the surveyed area, so the number in a client's hands is honest about
its own tolerance.

> **The "captured" date is not the photo's age.** A Google Earth base map prints
> "(captured YYYY-MM-DD)" under the map and in the report. That's when *you* ran
> the capture, from this Mac's clock. It is **not** when Google flew the imagery,
> which the tool has no way to read. Say so if a client asks how old the picture
> is. No other source records a date at all.

> **It takes 30 to 70 seconds**, longer at a cold site while Google Earth streams
> the imagery in. Leave Google Earth alone while it runs. If it stalls you'll get
> "Google Earth is taking too long. Is it stuck on a dialog?"

---

## 6. Run the survey (Coverage page)

Once you have a base map, a mode toolbar appears **if you picked 🏠 In-house, 🏡
Around the house or 🌍 Property / land**. On 🗺️ All together there's no mode
toolbar: the same tools live under **🛠 Tools ▾** in the button row below the
map. Tapping the map to drop readings works either way.

- **📍 Take readings**: the survey itself. Walk to where you're standing, tap
  that spot on the map, and it records the live signal there. Repeat around the
  space. The heatmap builds as you go. **Take a reading roughly every 10–15 ft
  and in every corner**. The map is only as honest as the spots you stood on.
- **✏️ Arrange rooms**: drag auto-laid-out or drawn rooms to match reality.
- **▱ Draw perimeter**: trace the outer wall / property edge. This is what
  keeps the color map *inside* the building and off the neighbor's yard.
- **📡 Mark router**: drop a pin where the router / access point actually sits.
- **＋ Add room / ◇ Shape room**: add or reshape rooms on a drawn schematic.
- **📏 Set scale**: only on an uploaded photo or sketch. Tap the two ends of a
  distance you know for real (a wall, a door, a car), type the feet, tap **✓ Set
  scale**. Until you do, the app has no idea how big the plan is, so square
  footage, the ft² in the % passing pill, and 🔮 Predict coverage are all
  unavailable. Aerials already carry true scale; drawn schematics have none.
  Once set, a **📐 ≈ 1,234 ft² surveyed** pill appears beside the map.
- **🔮 Predict coverage**: a design mode that models AP coverage before you walk
  anything. Needs a scale first. Tap the plan wherever you'd mount an access
  point and it paints the modelled coverage. Set **Walls** to Open plan, Typical
  home (default) or Dense / brick; at −67 dBm one AP reaches roughly 91 ft, 48 ft
  or 24 ft respectively. The map is stamped **"PREDICTED: modeled, not
  measured"** so it can never be mistaken for a real survey.

Every reading is graded on the spot on the same four-step scale as section 17:
**Excellent** (≥ −55 dBm), **Good** (−56 to −67), **Fair**, shown in the list as
**WEAK** (−68 to −75), and **Poor**, shown as **DEAD ZONE** (< −75). If SNR is
under 15 dB the rating gains a "low SNR" tag. On the map each dot carries its
grade as a letter: **E**, **G**, **W**, **D** (a **?** means no signal reading).

> The letter is the grade. The dot's **colour is not**: that follows whichever
> "Show" metric and colour scheme you've selected, so on SNR or Viridis a dot can
> be purple or blue and still be graded Excellent.

### Readings that aren't on the map

A reading saved with **✓ SAVE**, or taken from the Live Signal page, has **no
position on the map**. It's in the readings list, the table and the CSV, but the
heatmap, surveyed area, % passing, dead-zone square footage and the map in the
PDF all skip it.

While any reading is unplaced, a bar at the top of the Coverage Map card says how
many and offers **Place <name>**: tap it, then tap the map where you took that
reading, and it walks you through the rest one at a time. Clear this bar before
you make the report. (**📄 Make the report** will warn you if you don't.)

---

## 7. Read the heatmap

The heat controls (top of the Coverage map) let you look at the same walk in
different ways:

**Show:** which number the colors represent.
- **Signal (RSSI)**: raw strength. The default.
- **Signal-to-noise (SNR)**: how clearly the device hears Wi‑Fi over static.
  Use this to catch a spot that "has signal" but is still flaky.
- **Data rate (PHY)**: the speed the device and router *agreed to try for*.
- **Throughput**: the real measured speed. Only readings captured from
  **Advanced → ＋ Capture point** with **Also run throughput + ping** ticked
  carry this. Tapping the map, ✓ SAVE and 📍 Mark my GPS spot all save a reading
  with no throughput, and the Live Signal speed test writes only to its own
  readout. So this view stays empty unless you deliberately captured throughput
  points.

**as:** how to color it.
- **Gradient**: a smooth ramp from the metric's low end to its high end.
- **Pass / Fail**: **three** bands, not two. Green where the spot clears the pass
  threshold, **amber where it's marginal**, red where it fails, judged against a
  use-case bar you pick: **Web browsing**, **Voice & Video** (the default), or
  **IoT / Smart home**. On Signal those thresholds are pass ≥ −72 / fail < −78,
  pass ≥ −67 / fail < −73, and pass ≥ −80 / fail < −86 dBm respectively.

**Colour scheme** (the dropdown right of "as", on Gradient only): **Red → Green**
(default, red weak to green strong), **Turbo** (dark blue weak to red strong,
the opposite direction), or **Viridis (colour-blind safe)** (purple weak to
yellow strong). Use Viridis whenever a red-green colour-blind client will read
the map. Always read the legend bar rather than assuming red means bad. The
choice resets to Red → Green when you reload.

**target:** scores the survey against a named requirement: **Voice / VoIP**,
**Data / Web**, **Video / Streaming** or **High-density**. Each spot must clear
**both** a signal and an SNR gate:

| Target | Signal | SNR |
|--------|--------|-----|
| Voice / VoIP | −67 dBm | 25 dB |
| Data / Web | −72 dBm | 20 dB |
| Video / Streaming | −67 dBm | 22 dB |
| High-density | −65 dBm | 25 dB |

Pick one and a pill appears reading something like "87% area passing ≈ 1,940 ft²".
Failing areas grey out on the map. It needs at least three readings placed on the
map, and the ft² figure needs a scale. The percentage and the grey-out both carry
into the PDF, and the figure shows as "% Passing" on Mission Control.

**Contour lines** (checkbox): labelled iso-value lines over the heatmap, like a
topographic map. The levels are picked automatically as round numbers spanning
the range **your own readings** produced, not at the rating boundaries, so on a
typical survey the step is 5 dB and there's normally no −67 line. They follow
whatever "Show" is set to, so on Throughput they're Mbps lines. Turn this on for
a professional-looking report; the lines print into the PDF too.

**Crisp (low-res plan)** (checkbox under **🛠 Tools ▾**): stops the browser
smoothing a low-resolution or hand-drawn plan photo so its lines stay hard. It
affects the uploaded plan image only, not the heatmap colours, and does nothing
on a drawn schematic.

> The color map only fills the area you walked: inside your drawn perimeter if
> you traced one, otherwise the outline of that level's placed readings,
> feathered slightly outward so the wash reads as continuous. It won't invent
> coverage in a wing you never entered. The area and % figures printed beside the
> map use the tight, un-feathered outline, so they're slightly more conservative
> than the picture. A dead area on the map means *"no data here,"* which is
> honest and what a client should see.

---

## 8. The Live Signal page: quick reads & speed test

Use **Live Signal** when you just want to know "how's the Wi‑Fi right *here*"
without running a whole survey.

- **Signal gauge**: a live needle of Wi‑Fi strength. Walk around and watch it
  rise and fall. Good for hunting a dead spot or finding the best router shelf.
- **⚡ Speed Test**: one tap drives its own dial (the second gauge, under the
  button) and fills in **four** numbers: **Download** (Mbps), **Upload** (Mbps),
  **Latency** (base round-trip in ms, the number clients care about for calls and
  gaming) and **Responsiveness** (RPM, a measure of lag under load, not a speed).

This test measures download first and upload after, so it takes roughly twice as
long as a both-directions-at-once test. **Budget about 45 seconds.** The button
restores itself when done. The quicker both-at-once test is **⚡ Throughput** on
the Advanced page, at about 15 to 25 seconds.

---

## 9. Walk a property with your phone's GPS

This lets you survey **outdoors** by physically walking. Your phone streams its
location to the Mac, a live dot moves on the aerial, and you drop points and
corners as you walk. No Google Earth Pro needed for any of this: build the aerial
with 🔎 Find or 🌾 NAIP and it all works over the web.

### One-time phone setup

1. Make sure the Mac's server is running and your **phone is on the same
   Wi‑Fi**.
2. Install a free location-sender app on the phone:
   - **OwnTracks** (iOS/Android). Recommended: it pushes automatically.
   - **GPSLogger** (Android).
3. **Open the GPS Walk page on the Mac and press Copy.** It prints a ready-made
   URL for each app, OwnTracks first and GPSLogger second, already carrying the
   Mac's IP, the port and this run's key. Copy the one for your app.
4. Paste it in. In **OwnTracks**: ⓘ → Settings → set **Mode = HTTP**, paste into
   the **URL** field. In **GPSLogger**: Logging details → **Log to custom URL**,
   paste the whole thing, set the interval to about 2 s, then **Start logging**.
5. Tap **🔄 Check now** on the GPS Walk page to test it straight away.

> **Do not type the URL by hand.** It ends in `?k=<key>`, and without that the
> server refuses every fix and nothing is ever recorded. The GPSLogger URL also
> carries `&lat=%LAT&lon=%LON&acc=%ACC&time=%TIME`; those placeholders are what
> GPSLogger fills in with your position, and dropping them makes the request
> useless. The two apps get **different** URLs. Don't reuse one for the other.

> **The key changes every time the server restarts.** A URL saved in OwnTracks or
> GPSLogger stops working after a restart, and the phone gives no sign of it: the
> fixes are silently refused and the badge just sits at "Waiting for your phone".
> After every restart, re-open the GPS Walk page, press **Copy** and paste the
> new URL into the app.

**What you'll see.** The GPS Walk page shows a badge, not a map: ✅ **Connected:
±N m, updated Xs ago** with your latitude and longitude underneath, turning to
⚠️ **stale** past 20 seconds. **🔄 Check now** answers one of three ways: a fix in
the last 20 seconds, "Is the phone app running?" if the phone connected earlier
and stopped (your URL is right), or "No fix yet" if nothing has ever arrived
(your URL or network is wrong). The moving dot is on the **Coverage** page.

### Then, on-site

**Build the aerial base map before you start walking.** Both drop buttons need
one, and both need a fix **under 25 seconds old**.

- **📍 Mark my GPS spot** (Coverage): drops a reading at your exact location as
  you walk. Only appears once the level has an aerial, and the Mac has to be on
  Wi‑Fi or it answers "No Wi-Fi signal. Are you connected?".
- **＋ Corner at my GPS** (Coverage → **🛠 Tools → ▱ Draw perimeter**): stand on
  each lot corner and tap it, or tap the map to place by eye. Tap **✓ Done** when
  you're back at the start. **You don't join the corners up yourself**; the ring
  closes automatically once there are three or more. This is the boundary that
  clips the heatmap and lands in the `.kmz`.
- **Tag each reading with my phone's GPS** (GPS Walk page): tick this **before**
  you start walking. It's **off by default and resets to off on every page
  reload**, so re-check it after a refresh. With it off, readings you save the
  normal way carry no coordinates: the CSV's GPS columns come out blank, the
  `.kmz`'s GPS readings folder is empty, and on a job with no aerial the `.kmz`
  export refuses altogether. Readings dropped with 📍 Mark my GPS spot are
  stamped either way.

> The **＋ Corner at my GPS** on the **Site Plan** page has the same name but is
> a different control: it traces the yard outline for the site plan only and is
> never exported to Google Earth.

> Smaller GPS accuracy (in meters) = more exact. If accuracy is poor, step into
> the open away from the building and give it a few seconds to settle.

---

## 10. Watch it live in Google Earth

On the **Report** page, **🛰 Live in Google Earth** opens Google Earth Pro and
keeps it updated every 3 seconds while you walk. Readings, boundary, routers and
the coverage colour appear as you take them, along with a **You are here** marker
that moves with you.

It needs Google Earth Pro installed in `/Applications`. The first time, macOS
asks permission to control it, and **that prompt appears on the Mac itself**, not
on your phone, so someone has to be at the keyboard once.

The button is a **toggle**. Once running it reads **🛑 Stop live view**; pressing
it stops pushing updates but leaves Google Earth showing the last picture rather
than clearing it. Pressing it again resumes on the link Earth already has, so
restarting doesn't duplicate the survey.

Four things worth knowing:

- **Only the level whose tab is open** has its coverage colour pushed to Google
  Earth. Readings, boundaries and routers from every level are drawn, but the
  colour wash is one level at a time, so on a two-storey job the other floor will
  look empty. Switch tabs to see it. The exported `.kmz` has no such limit.
- **Colour looking patchy under trees?** Google Earth draws its own 3D trees on
  top of the coverage layer. In Google Earth's **Layers** panel (bottom left),
  untick **3D Buildings** and it fills in. There is no way to fix this from our
  side.
- **A frozen feed looks exactly like a working one.** If an update fails to
  reach Google Earth, the window silently keeps redrawing the last frame it
  accepted. The only signal is a toast on the dashboard reading "Google Earth is
  showing an older picture", so keep the dashboard where you can see it. A stall
  caused by the survey outgrowing the update won't fix itself; stop and restart
  the live view.
- **Seeing everything twice?** Google Earth is still holding a survey from an
  earlier session. In **Temporary Places**, delete the older **WiFi Survey live
  coverage** entries.

The **You are here** marker is dropped whenever the last fix is more than 60
seconds old, so if it vanishes your phone has stopped reporting. The live view
itself is still fine.

---

## 11. Site Plan

Draw the house footprint, walk the yard boundary with your phone's GPS, then
place the house inside it. Three modes:

- **▱ Property / yard**: walk the boundary and tap **＋ Corner at my GPS** at
  each corner (needs a live fix under 25 seconds old), or tap the canvas to place
  corners by eye.
- **🏠 Draw house**: tap round the corners of the house footprint.
- **✥ Place house**: drag the house where it sits on the lot, with the **Rotate**
  and **Size** sliders to line it up.

**↩︎ Undo** removes the last point and **✕ Clear** wipes whatever the current
mode owns. Corners dropped by GPS give the plan true scale and the measured area
prints on the canvas as "Property · ≈ N ft²". Corners tapped by eye give a sketch
with no area.

---

## 12. Cellular: aim a gateway / antenna

For jobs with a home cellular gateway (e.g. a T‑Mobile gateway + Waveform
antenna), open **Cellular** to find the best mounting spot.

**Connect first. Nothing on the page appears until you do.** Join the gateway's
Wi‑Fi, check the **Gateway address** (prefilled `192.168.12.1`, right for a
T‑Mobile gateway), type the **Admin password** printed on the gateway's label,
and tap **Connect**. The panels, bars, speed test and mount-spot list all stay
hidden until that read succeeds. The address and password are remembered.

Tick **keep updating** next to Connect and the page re-reads the gateway about
every 6 seconds, so you can rotate an antenna and watch the numbers move instead
of tapping Connect after each nudge. A failed read leaves the last numbers on
screen marked stale; after five failures in a row it stops and says so.

**Two panels, 5G and LTE.** Each has five signal bars, a large **SINR** figure,
then **RSRP**, **RSRQ**, **RSSI** and the serving **Band**, plus a one-word
verdict: **Excellent / Good / Fair / Poor**. That verdict is the **worse** of the
RSRP grade (coverage) and the SINR grade (quality), so a strong but noisy signal
is never rated good. It's the thing to compare between spots.

The **connection badge** reports whether the tool successfully read the gateway,
not merely whether you're on its Wi‑Fi. Green shows the model and serving band;
amber means a read failed and the numbers on screen are stale.

**Candidate mount spots.** Carry the gateway to a spot, wait about 15 seconds for
the numbers to settle, type a name ("attic", "SE wall", "upstairs window") and
tap **＋ LOG**. Each spot keeps the 5G and LTE SINR, RSRP and band at that
position, and the list stars the best SINR as **★ best**. This list prints in the
PDF as an antenna-placement table and feeds the score: the best spot supplies the
Cellular WAN component, and a best SINR below 0 dB caps the whole score at 49.

Aim the gateway *first*, then survey the Wi‑Fi it puts out.

---

## 13. Advanced: internals & external tools

- **Live Signal** card: current RSSI in large type with the SSID and rating, then
  SNR, Channel, PHY, TX rate, Security and Gateway.
- **Network details** card: three things **you type in** that print on the
  report. **Gateway model**, **Plan speed (Mbps)** and **Target SSID**. Plan
  speed does more than print: it's what turns measured speeds into the report's
  "vs Plan" percentages, flags any room under half the plan speed as a finding,
  and supplies the throughput part of the score. Leave it blank and the report
  shows a dash and skips that analysis entirely.
- **Tools**: three one-tap launchers, **🗺️ NetSpot**, **📡 WiFi Explorer** and
  **🩺 Wireless Diag** (Apple's built-in Wireless Diagnostics, the one that works
  on any Mac without buying anything). Plus **⚡ Throughput** (both directions at
  once, about 15 to 25 s) and **📍 Ping gateway**.
- **＋ Capture point**: tick **Also run throughput + ping (~20s)** before
  capturing. This is **the only way to attach a measured speed to an individual
  reading**. Those points are the only ones the Coverage **Throughput** heatmap
  can colour and the only ones in the report's "vs Plan" table.
- **Nearby Networks**: every SSID in earshot with its channel and signal. Use it
  to spot co-channel crowding before you retune a router.
- **Survey Points**: every reading you've taken, with number, location, SSID,
  band, channel, RSSI, SNR, PHY, rate, download/upload, latency and rating. The
  only place that shows all of it at once, and each row has a **✕** to delete a
  bad reading. Worth a look before you generate the PDF.

---

## 14. Make the report (Report page)

1. **Client & Site**: client/owner name, property address, technician. These
   print on the report. Note that **Gateway model**, **Plan speed** and **Target
   SSID** are on the **Advanced** page, and **Home size: total sq ft** is at the
   top of the **Coverage** page.
2. **Findings**: a **0–100 Wi‑Fi signal score** plus plain-English findings and
   recommendations. See below for what feeds it.
3. **📥 Ingest tool data**: a saved survey `.json`, a Wi‑Fi scan `.csv` or `.txt`
   from WiFi Explorer / NetSpot / inSSIDer, a monitor-mode packet capture
   (`.pcap`, `.pcapng`, `.cap`), or any heatmap image. The capture **must** be
   monitor-mode (`sudo tcpdump -I -i en0 -w cap.pcap`), because an ordinary
   capture has no beacon frames.
4. **📸 Site Photos & Screenshots**: wiring closet, router placement, speed-test
   screenshots, damage. **Type a caption under each thumbnail.** Captions print
   beneath the photo in the PDF, which is the difference between a page of
   unlabelled pictures and a page of evidence.
5. **📎 Attach NetSpot heatmap image**: only used as a fallback. If this app has
   a coverage picture of its own for any level, that's what prints and the
   attached image never appears.
6. **Rooms checked (N)**: every reading with its dot, rating and dBm. **✕**
   deletes one, and this is the only place to remove a bad read. A reading with a
   **not on map** button isn't in the heatmap yet (section 6).
7. **📄 Make the report**: opens the formatted report. Use your browser's
   **Print → Save as PDF** to produce the client file.

> If any readings aren't on the map, **Make the report** asks first and tells you
> how many. **Cancel takes you straight to the Coverage page** to place them.

> If "Make the report" seems to do nothing, allow pop-ups for `127.0.0.1`.

### What the score actually measures

A weighted blend of up to five parts, each counting **only when the data for it
exists**, with the weights rebalanced across whichever are present:

| Part | Weight | Needs |
|------|--------|-------|
| Coverage | 0.4 | Signal readings |
| Reliability | 0.2 | SNR |
| Throughput | 0.2 | **Plan speed** filled in on Advanced *and* at least one Capture point with throughput |
| Interference | 0.1 | Readings carrying a band (so, almost always on) |
| Cellular WAN | 0.1 | Logged candidate spots on the Cellular page |

A plain walk-and-tap survey is therefore scored on Coverage, Reliability and
Interference. Two hard caps override the blend: **any** reading below −75 dBm
caps the score at 69, and 25% or more of readings below −75 dBm (or a best
cellular SINR below 0) caps it at 49. Grades: 90+ Excellent, 75+ Good, 60+ Fair,
40+ Poor, below 40 Critical.

The findings come from a fixed set of rules that run entirely on your Mac, with
no randomness and nothing sent anywhere. They read your readings *and* a snapshot
of the Wi‑Fi environment taken on the survey's first reading, which is where the
co-channel crowding and security findings come from. So re-printing a survey
later gives exactly the same findings.

Findings that point at a specific spot carry a **📍 Locate** button: it switches
to the Coverage page and highlights that exact reading, which is the fastest way
to walk a client from a finding to the place it describes. **The on-screen list
shows the top five (Mission Control shows three); the PDF prints all of them**,
so a longer list in the report is expected, not a bug.

An imported scan or capture makes the evidence richer, not the verdict: it
replaces the nearby-networks table with the imported one and marks it as
imported, but it does **not** move the score or change any finding. Importing a
survey `.json` is the exception. That replaces everything on screen.

---

## 15. Save, export & re-open

Everything you can hand off, from the Report page. **⬇︎ .json**, **📊 .csv**,
**🌍 .kmz** and **📄 Generate report** are also one tap away on Mission Control.

| Button | File | Use it for |
|--------|------|-----------|
| ⬇︎ **Save survey** | `.json` | The complete raw survey. Re-open it later to resume or re-print. This is your master copy. |
| 📊 **Export data** | `.csv` | Every reading as a spreadsheet row for your own records or a client who wants the raw numbers. |
| 🌍 **Google Earth** | `.kmz` | Coverage heatmap overlay, readings, boundary and routers. **Needs coordinates to place:** at least one level built from an aerial, or at least one GPS-tagged reading. On a drawn or uploaded plan with no GPS tagging, nothing is saved. |
| 🛰 **Live in Google Earth** | live | Opens Google Earth Pro and pushes the survey to it every 3 seconds as you walk (section 10). Becomes **🛑 Stop live view**. |
| 🖨 **Field run sheet** | print | A printable on-site checklist. |
| ⬆︎ **Open survey file** | none | Load a saved `.json` back in to continue or re-report. |
| 🗑 **Start over** | none | Clears **this** survey's readings, cellular spots, site photos, imported scan and attached heatmap. **Keeps** the client details and every level's base map, rooms, perimeter and router marks. Other saved surveys are untouched. |

To clear the map itself, use **🖼 Change plan** on the Coverage page (current
level only). To start a genuinely separate job, use **＋ New survey**, not Start
over.

**Watch the storage meter.** Auto-save uses the browser's own storage, roughly
**5 MB** total, and photos, floor plans and aerials are what fill it. The
**Browser storage** meter in the Save & export block shows how much you've used.
Past about 65% it tells you to save the survey file now; past 85% it warns that
storage is nearly full. Once full, writes fail and a refresh **will** lose the
unsaved work. **⬇︎ Save survey (.json)** is the real backup. Auto-save is a
convenience, not insurance.

---

## 16. Multi-floor & multiple jobs

**Floors / levels.** The tabs above the map are one per level, each with its own
base map, rooms, perimeter, router marks and heatmap. **＋ Level** adds one; the
first is "Main floor" and new ones are "Floor 2", "Floor 3", dropping straight
into rename so you can type "Basement". **✎** renames the level **you're
currently on**, so switch to its tab first (Enter keeps it, Escape cancels). **🗑**
appears once you have more than one, and deleting a level **permanently deletes
every reading taken on it**.

**Survey profiles.** The **🗂** button in the top-right of the header on every
page. It shows the current survey's name (a new slot starts as "Survey 2" and
renames itself to the client name as soon as you type one). Open it for the list:
click a row to switch, **✎** to rename, **✕** to delete. **＋ New survey** starts
the next job on a clean slate and saves your current one to its own slot first.

Use **＋ New survey** between jobs. **🗑 Start over** is for clearing the survey
you're on, not for starting the next one.

---

## 17. Rating scale (reference)

Wi‑Fi signal (RSSI), the same grades the map and report use:

| Rating | RSSI | Shown as | Meaning |
|--------|------|----------|---------|
| **Excellent** | ≥ −55 dBm | E | Full speed, anywhere |
| **Good** | −56 to −67 dBm | G | Reliable video / VoIP |
| **Fair** | −68 to −75 dBm | W (weak) | Usable, borderline for 4K / calls |
| **Poor** | < −75 dBm | D (dead zone) | Dead-spot risk |

−67 dBm is the standard "reliable connectivity" line. **SNR below ~15 dB** flags
a noisy link even when the RSSI looks fine. That's what the SNR heatmap catches.

---

## 18. Troubleshooting

| Symptom | Fix |
|---------|-----|
| Everything says "Backend offline" but the server is running | Reload the dashboard (**Cmd+R**). The page picks up the server's key once when it loads, and the server issues a new one every start, so a tab left open across a restart is using a key that's no longer valid. Re-copy the GPS URL too. |
| Dashboard won't open | Is the server running? Re-run `python3 survey_server.py` and open <http://127.0.0.1:8765>. |
| "Make the report" does nothing | Allow pop-ups for `127.0.0.1` in the browser. |
| Phone GPS not showing | **Did you restart the server since setting the phone up?** The URL carries a key that's regenerated every start, and the phone gives no sign it's being refused. Re-open the GPS Walk page, press **Copy**, paste again. Then: phone and Mac on the **same Wi‑Fi**? URL uses the **Mac's IP**, not 127.0.0.1? Ends in `/api/gps?k=…`? Was macOS's "Allow incoming connections" prompt accepted? |
| Google Earth base map or live view won't start | Google Earth Pro must be installed in `/Applications`, and the first run needs the macOS automation prompt approved **at the Mac's keyboard**, not from your phone. |
| Google Earth colour patchy under trees, or everything appears twice | Untick **3D Buildings** in Google Earth's **Layers** panel (bottom left). Delete older **WiFi Survey live coverage** entries from **Temporary Places**. |
| Aerial finds the wrong place | Add city + state + ZIP. Watch for the "Found only the area" warning: that means it centred on a town, not the property. |
| Aerial has blank squares | No imagery at that zoom. Tap **−** for a wider view. The frame loads gaps and all if you don't. |
| Speed test "hangs" | The Live Signal test runs download then upload, so budget ~45 s. The button resets itself. |
| Heatmap has blank areas | That's correct. It only colors where you took readings. Walk those spots and re-read. |
| Readings missing from the heatmap | They were saved without a map position. See the bar at the top of the Coverage Map card, or the **not on map** buttons in the Report page's Rooms checked list. |
| Live Signal says "Not connected. Join the home's Wi-Fi" | The Mac isn't on Wi‑Fi, or is on Ethernet. Join the client's SSID. |
| Cellular page is empty | You haven't connected to the gateway yet. Gateway address + admin password + **Connect**. |
| "Storage full" or an aerial vanishes on refresh | The browser's ~5 MB is exhausted. **⬇︎ Save survey (.json)** immediately, before reloading. |

---

## 19. Under the hood (for reference)

- **Server:** `survey_server.py` is the entry point (the HTTP handler and
  `main()`); the rest of the back end is the `wifisurvey/` package: `config`,
  `util`, `wifi`, `cellular`, `gps`, `imagery`, `earth`, `live`. Python 3
  standard library only, no third-party imports anywhere. Binds `0.0.0.0` on port
  **8765** so a phone on the same Wi‑Fi can reach it.
- **Front end:** `dashboard.html` plus ES modules under `js/`. No build step.
- **Access:** every `/api/` route needs a key that's generated fresh on each
  server start. The two live Google Earth routes are the exception: they carry a
  separate persistent token *and* are refused from anything but this Mac, so the
  live feed can't be reached from the LAN even though the dashboard can.
- **Live Wi‑Fi data:** macOS `system_profiler SPAirPortDataType` (RSSI, SNR,
  channel, rate, PHY, security). No `sudo` needed.
- **Speed test:** macOS `networkQuality`.
- **Aerial imagery:** three sources. Esri World Imagery and USDA NAIP are both
  fetched through the local server so there's no cross-site issue. The Google
  Earth option drives the copy of Google Earth Pro on this Mac over AppleScript
  and screenshots it, touching no remote service. Each source is credited by name
  in the report, and a Google Earth base map also carries its measured tolerance.
  Address lookup: US Census geocoder, then a general geocoder as fallback.
- **The Alfa AWUS036ACM** external adapter has no Apple-Silicon driver and isn't
  used. The built-in Wi‑Fi does everything a coverage survey needs.

---

*Short glossary and a "which tool when" cheat-sheet live on the in-app **Guide**
page. This file is the deep reference.*
