/* WiFi Site Survey — front-end logic (vanilla JS, no deps) */
"use strict";

const $ = (id) => document.getElementById(id);
const LS_POINTS = "wifisurvey.points";
const LS_SITE = "wifisurvey.site";
const LS_PAGE = "wifisurvey.page";
const LS_CELL = "wifisurvey.cell";
const LS_CELLPTS = "wifisurvey.cellpoints";
const LS_HEATMAP = "wifisurvey.heatmap";
const LS_PHOTOS = "wifisurvey.photos";
const LS_LEVELS = "wifisurvey.levels";
const LS_ACTIVELEVEL = "wifisurvey.activelevel";
const LS_PROFILES = "wifisurvey.profiles";            // JSON [{id,name,updated}] — the profile registry
const LS_ACTIVEPROFILE = "wifisurvey.activeprofile";  // id of the active profile
const LS_IMPORTEDSCAN = "wifisurvey.importedscan";    // (existing literal key, now named)
const LS_SITEPLAN = "wifisurvey.siteplan";            // { yard:[{x,y,lat?,lon?}], house:[{x,y}], houseT:{tx,ty,rot,scale} }
const LS_SURVEYENV = "wifisurvey.surveyenv";          // { current, nearby, ts } RF environment at survey time
const PROFILE_PREFIX = "wifisurvey.profile.";         // per-profile bundle key = PROFILE_PREFIX + id
const SITE_FIELDS = ["f_client", "f_address", "f_tech", "f_gw", "f_plan", "f_ssid", "f_sqft"];

let points = [];
let cellPoints = [];
let lastScan = null;
let lastCell = null;
let cellTimer = null;
let heatmapDataUrl = null;
let importedScan = [];   // external Wi-Fi scan (WiFi Explorer / NetSpot CSV) for the report's RF analysis
// {current, nearby, ts} — the RF environment as it was WHEN THE SURVEY WAS WALKED, captured on
// the first reading. The report reads this, not lastScan, so reopening a survey somewhere else
// later can't rewrite the client's interference and security findings from a different network.
let surveyEnv = null;
let reportPhotos = [];   // [{url,caption}] site photos/screenshots embedded in the report
let floorPlanUrl = null;
let floorPlanImg = null;
let showHeatmap = true;
let showContours = false;  // labeled iso-signal contour lines over the heatmap (pro RF-report style)
let heatMetric = "signal";   // signal | snr | rate | download
let heatMode = "gradient";   // gradient | passfail
let heatPreset = "video";    // web | video | iot
let reqProfile = "none";      // active requirement profile → drives live % area passing + fail grey-out
let planMode = null;   // 'image' | 'schematic' | null
let mapMode = "edit";  // 'edit' (arrange rooms) | 'survey' (tap readings) | 'roomshape' (draw polygon room)
let rooms = [];        // rect rooms {id,name,x,y,w,h} or polygon rooms {id,name,poly:[{x,y}]}
let shapeVerts = [];   // in-progress polygon vertices while drawing a shape room
let perimeter = [];    // [{x,y}] relative property-boundary vertices for the active level
let apMarks = [];      // [{x,y,label}] router/AP reference markers for the active level
let dragState = null;
let levels = [];       // [{id, name, planMode, floorPlanUrl, rooms, perimeter, snapshot}]
let activeLevel = null;
let editingLevel = false;
let gpsEnabled = false;
let lastGpsFix = null;
let gpsTimer = null;
let geoBounds = null;  // {west,east,north,south,z} Web-Mercator bounds of the active level's aerial base map (mirrors curLevel().geo)
let calibration = null;  // {a:{x,y},b:{x,y},feet} manual scale ref for an uploaded image plan (mirrors curLevel().cal). Aerial levels derive scale from geoBounds instead.
let calTemp = { a: null, b: null };  // in-progress two-tap calibration line
let predictAPs = [];       // predicted AP placements for design mode (mirrors curLevel().predictAPs)
let showPredict = false;   // predict-coverage view active
const PL_ENV = { open: 2.4, typical: 2.8, dense: 3.4 };   // log-distance path-loss exponent by environment
let plExponent = 2.8;
const PL_TXREF = -20;      // modeled RSSI (dBm) at 1 ft from a predicted AP
function emptySitePlan() { return { yard: [], house: [], houseT: { tx: 0, ty: 0, rot: 0, scale: 1 } }; }
let sitePlan = emptySitePlan();       // Site Plan page: GPS-walked yard + hand-drawn house placed inside
let siteMode = "yard";                // yard | house | place
let siteDrag = null;                  // in-progress house drag
// a GPS-walked yard boundary is an hour on foot — a failed write here has to be visible
function saveSitePlan() { return store(LS_SITEPLAN, JSON.stringify(sitePlan)); }
let surveyType = "all";  // 'inhouse'|'around'|'property'|'all' — WHAT is being surveyed (mirrors curLevel().surveyType; default 'all' = show everything = back-compat)
let profiles = [];        // [{id,name,updated}] registry — mirrors LS_PROFILES
let activeProfile = null; // id of the currently-loaded profile — its live data is in the working keys

/* ---------- ratings ---------- */
function rate(signal, snr) {
  if (signal == null) return { label: "—", cls: "na", word: "—", color: "#7c8aa6" };   // = --na
  let r;
  if (signal >= -55) r = { label: "Excellent", cls: "exc", word: "EXCELLENT", color: "#34d399" };
  else if (signal >= -67) r = { label: "Good", cls: "good", word: "GOOD", color: "#a3e635" };
  else if (signal >= -75) r = { label: "Fair", cls: "fair", word: "WEAK", color: "#fbbf24" };
  else r = { label: "Poor", cls: "poor", word: "DEAD ZONE", color: "#f87171" };
  if (snr != null && snr < 15 && r.cls !== "poor") r = { ...r, label: r.label + " · low SNR" };
  return r;
}

/* ---------- gauge ---------- */
function gaugePoint(f) {
  const th = ((180 - 180 * f) * Math.PI) / 180;
  return [160 + 110 * Math.cos(th), 160 - 110 * Math.sin(th)];
}
function gaugeArc(f1, f2) {
  const a = gaugePoint(f1), b = gaugePoint(f2);
  return `M${a[0].toFixed(1)} ${a[1].toFixed(1)} A110 110 0 0 1 ${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
}
function buildZones() {
  const zones = [[0, 0.25, "#f87171"], [0.25, 0.383, "#fbbf24"], [0.383, 0.583, "#a3e635"], [0.583, 1, "#34d399"]];
  $("gaugeZones").innerHTML = zones
    .map((z) => `<path d="${gaugeArc(z[0], z[1])}" fill="none" stroke="${z[2]}" stroke-width="20"/>`)
    .join("");
}
function updateGauge(signal, r) {
  const f = signal == null ? 0 : Math.max(0, Math.min(1, (signal + 90) / 60));
  // Draw the needle straight to its computed tip — avoids the rotate()/transform-origin conflict.
  const th = ((180 - 180 * f) * Math.PI) / 180;
  const needle = $("needle");
  needle.setAttribute("x2", (160 + 92 * Math.cos(th)).toFixed(1));
  needle.setAttribute("y2", (160 - 92 * Math.sin(th)).toFixed(1));
  needle.setAttribute("stroke", "#ffffff"); // always white so it never blends into a same-color zone
  const w = $("gaugeWord");
  w.textContent = r.word;
  w.style.color = r.color;
  $("gaugeDbm").style.color = signal == null ? "var(--muted)" : r.color;
}

/* ---------- speed gauge (Live page) ---------- */
// Reuses the SAME arc geometry as the signal gauge: center (160,160), arc radius 110,
// needle tip radius 92, f=0 -> left/180deg, f=1 -> right/0deg. Direct-tip needle (NO rotate).
let speedMax = 500; // current dial full-scale (Mbps); auto-scaled per run via niceMax()

// smallest "nice" full-scale >= v*1.1, so the needle never pegs and the dial stays readable
function niceMax(v) {
  const steps = [50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000];
  const target = (v || 0) * 1.1;
  for (const s of steps) if (s >= target) return s;
  return steps[steps.length - 1];
}

// colored speed zones red->amber->lime->green by fraction (slow->fast). Mirrors buildZones().
function buildSpeedZones() {
  const zones = [[0, 0.25, "#f87171"], [0.25, 0.5, "#fbbf24"], [0.5, 0.75, "#a3e635"], [0.75, 1, "#34d399"]];
  const el = $("speedZones");
  if (!el) return;
  el.innerHTML = zones
    .map((z) => `<path d="${gaugeArc(z[0], z[1])}" fill="none" stroke="${z[2]}" stroke-width="20"/>`)
    .join("");
}

// 3 tick labels (0, max/2, max) at the arc ends + top. Placed on the r110 arc via gaugePoint().
function buildSpeedTicks(max) {
  const el = $("speedTicks");
  if (!el) return;
  const fmt = (v) => (v >= 1000 ? (v / 1000) + "k" : "" + v);
  // f, value, text-anchor — nudge labels just outside the arc so they don't overlap the zones
  const ticks = [
    [0, 0, "start", 6, 16],
    [0.5, max / 2, "middle", 0, -8],
    [1, max, "end", -6, 16],
  ];
  el.innerHTML = ticks
    .map(([f, v, anchor, dx, dy]) => {
      const [x, y] = gaugePoint(f);
      return `<text x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(1)}" text-anchor="${anchor}" fill="var(--muted)" font-size="13" font-family="var(--font-num)" font-weight="700">${fmt(v)}</text>`;
    })
    .join("");
}

// position the speed needle to fraction f (0..1) of the current dial (clamped/pegged at 1).
function updateSpeedGauge(mbps, max) {
  const m = max || speedMax;
  const f = mbps == null ? 0 : Math.max(0, Math.min(1, mbps / m));
  // Draw needle straight to its computed tip at r92 — same direct-tip technique as updateGauge().
  const th = ((180 - 180 * f) * Math.PI) / 180;
  const needle = $("speedNeedle");
  if (!needle) return;
  needle.setAttribute("x2", (160 + 92 * Math.cos(th)).toFixed(1));
  needle.setAttribute("y2", (160 - 92 * Math.sin(th)).toFixed(1));
  needle.setAttribute("stroke", "#ffffff"); // always white so it never blends into a same-color zone
}

// smooth ease-out needle sweep from 0 to the download fraction over ~700ms (rAF + performance.now()).
let speedAnimRAF = null;
function animateSpeedNeedle(mbps, max) {
  const m = max || speedMax;
  const targetF = mbps == null ? 0 : Math.max(0, Math.min(1, mbps / m));
  if (speedAnimRAF) cancelAnimationFrame(speedAnimRAF);
  const dur = 700, t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    const f = targetF * eased;
    const th = ((180 - 180 * f) * Math.PI) / 180;
    const needle = $("speedNeedle");
    if (needle) {
      needle.setAttribute("x2", (160 + 92 * Math.cos(th)).toFixed(1));
      needle.setAttribute("y2", (160 - 92 * Math.sin(th)).toFixed(1));
    }
    if (p < 1) speedAnimRAF = requestAnimationFrame(step);
    else speedAnimRAF = null;
  };
  speedAnimRAF = requestAnimationFrame(step);
}

// Live-page speed test — SAME /api/quality endpoint as runQuality()/runCellSpeed(), own button+readout.
// Needle points to DOWNLOAD (the headline). Auto-scales the dial, then sweeps the needle.
async function runSpeedTest() {
  const b = $("btnSpeedTest");
  if (!b) return;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>&nbsp; Testing… (~20s)';
  // reset to a testing state: needle at 0, dashes on all readouts
  updateSpeedGauge(0, speedMax);
  $("speedBig").textContent = "…";
  ["stDown", "stUp", "stLat", "stRpm"].forEach((i) => { if ($(i)) $(i).textContent = "…"; });
  try {
    const d = await api("/api/quality");
    if (d.ok) {
      const dl = d.download_mbps;
      speedMax = niceMax(dl != null ? dl : 0);
      buildSpeedTicks(speedMax);
      animateSpeedNeedle(dl, speedMax);
      $("speedBig").textContent = (dl != null ? Math.round(dl) : "—") + " Mbps";
      $("stDown").textContent = (dl ?? "—") + " Mbps";
      $("stUp").textContent = (d.upload_mbps ?? "—") + " Mbps";
      $("stLat").textContent = d.base_rtt_ms != null ? d.base_rtt_ms + " ms" : "—";
      $("stRpm").textContent = d.responsiveness_rpm != null ? Math.round(d.responsiveness_rpm) + " RPM" : "—";
      toast(`↓${dl} / ↑${d.upload_mbps} Mbps`);
    } else {
      updateSpeedGauge(0, speedMax);
      $("speedBig").textContent = "—";
      ["stDown", "stUp", "stLat", "stRpm"].forEach((i) => { if ($(i)) $(i).textContent = "—"; });
      toast("Speed test failed: " + (d.error || ""));
    }
  } catch (e) {
    updateSpeedGauge(0, speedMax);
    $("speedBig").textContent = "—";
    ["stDown", "stUp", "stLat", "stRpm"].forEach((i) => { if ($(i)) $(i).textContent = "—"; });
    toast("Speed test failed");
  }
  b.disabled = false;
  b.innerHTML = "⚡ Speed Test";
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("warn");
  if (kind === "warn") t.classList.add("warn");
  t.classList.add("show");
  clearTimeout(toastTimer);
  // a warning is something the surveyor has to act on — hold it long enough to be read mid-walk
  toastTimer = setTimeout(() => t.classList.remove("show"), kind === "warn" ? 7000 : 2800);
}
// Something went wrong that costs the user data or work. Never silent.
function warn(msg) { toast(msg, "warn"); }

// Every localStorage write goes through here. A write that fails must be loud:
// out in the field a silent quota error looks exactly like "the save button stopped working".
function store(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (e) { warn("Storage full — that didn't save. Export the survey now to avoid losing it."); return false; }
}

/* ---------- backend calls ---------- */
// The server injects this run's key into the page it serves; a cross-origin page can't read
// that response, so it can't call the API on the technician's behalf.
const API_KEY = (document.querySelector('meta[name="survey-key"]') || {}).content || "";

function apiUrl(path) {
  if (!API_KEY) return path;
  return path + (path.indexOf("?") >= 0 ? "&" : "?") + "k=" + encodeURIComponent(API_KEY);
}

// One place for every backend call. Nothing used to check response.ok, so a 500 from the
// server surfaced as "Speed test failed" and sent the tech looking at the Wi-Fi instead.
async function api(path, opts) {
  const r = await fetch(apiUrl(path), opts);
  if (!r.ok) {
    let detail = r.status === 403 ? "the dashboard needs reloading" : "server error " + r.status;
    try { const j = await r.json(); if (j && j.error) detail = j.error; } catch (e) {}
    throw new Error(detail);
  }
  return r.json();
}

/* ---------- mode ---------- */
function showPage(name) {
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  const pg = $("page-" + name);
  if (pg) pg.classList.remove("hidden");
  document.querySelectorAll(".navitem").forEach((n) => n.classList.remove("on"));
  const nv = $("nav-" + name);
  if (nv) nv.classList.add("on");
  try { localStorage.setItem(LS_PAGE, name); } catch (e) {}
  if ($("topTitle")) $("topTitle").textContent = PAGE_TITLES[name] || "";
  window.scrollTo(0, 0);
  // floating live-dBm readout is a map-page-only affordance
  if ($("floatDbm") && name !== "map") $("floatDbm").classList.remove("show");
  if (name === "home") renderHome();
  if (name === "map") renderCoverageMap(); // canvas must size after the page becomes visible
  if (name === "siteplan") setSiteMode(siteMode); // sizes the canvas + restores mode UI
  if (name === "guide") renderGuide();
  if (name === "report") renderReportInsights();
  // the gateway poll is a cellular-page affordance; it used to keep hammering the gateway
  // for the rest of the session once started
  if (name !== "cellular") stopCellAuto();
  // poll GPS while the GPS or Site Plan page is open, OR on the map page when there's an aerial to place onto
  if (name === "gps" || name === "siteplan" || (name === "map" && geoBounds)) startGpsPoll(); else stopGpsPoll();
  if (name === "map") renderYouAreHere(); // reflect the current fix immediately on arrival
  // Last, because window.scrollTo above cancels an in-flight smooth scroll. On a phone the nav
  // is a strip ~3x wider than the screen, so pulling the active item into view both answers
  // "where am I" and reveals that the strip scrolls at all.
  const navBar = $("sidebar");
  if (nv && navBar && navBar.scrollWidth > navBar.clientWidth) {
    // instant, not smooth: the page has just changed under it, and a smooth scroll here is
    // both cancelled by the window.scrollTo above and unreliable inside a masked container
    navBar.scrollLeft = nv.offsetLeft - navBar.clientWidth / 2 + nv.offsetWidth / 2;
  }
}

/* ---------- live poll ---------- */
async function poll() {
  try {
    const d = await api("/api/scan");
    if (!d.ok) throw new Error();
    lastScan = d;
    const c = d.current;
    const r = rate(c ? c.signal : null, c ? c.snr : null);
    updateGauge(c ? c.signal : null, r);
    $("gaugeDbm").textContent = c ? `${c.signal} dBm` : "—";
    $("gaugeNet").textContent = c ? `${c.ssid}${c.phy_friendly ? " · " + c.phy_friendly : ""}` : "Not connected";
    if ($("miniDbm")) {
      $("miniDbm").textContent = c ? `${c.signal} dBm` : "—";
      $("miniDbm").style.color = c ? r.color : "var(--muted)";
      $("miniWord").textContent = c ? r.word : "—";
      $("miniWord").style.color = c ? r.color : "var(--muted)";
      $("miniNet").textContent = c ? c.ssid : "not connected";
    }
    updateFloatDbm(c, r);
    const band = $("easyStatus");
    if (c) {
      band.className = "statusband ok";
      band.querySelector(".big-dot").textContent = "✅";
      $("easyStatusText").textContent = "Connected to " + c.ssid;
    } else {
      band.className = "statusband bad";
      band.querySelector(".big-dot").textContent = "⚠️";
      $("easyStatusText").textContent = "Not connected — join the home's Wi-Fi";
    }
    renderAdvLive(d);
    renderNearby(d.nearby, c);
  } catch (e) {
    $("easyStatusText").textContent = "Backend offline — is the server running?";
    $("gaugeWord").textContent = "—";
  }
}

// keep the fixed floating dBm readout (Coverage page) in sync with the live scan.
// c = lastScan.current (or null); r = rate(c.signal, c.snr). Hidden when there is no signal.
function updateFloatDbm(c, r) {
  const box = $("floatDbm");
  if (!box) return;
  const onMap = $("page-map") && !$("page-map").classList.contains("hidden");
  if (!onMap || !c || c.signal == null) {
    box.classList.remove("show");
    return;
  }
  box.classList.add("show");
  box.style.setProperty("--floatc", r.color);
  $("floatDbmVal").textContent = `${c.signal} dBm`;
  $("floatDbmWord").textContent = r.word;
  $("floatDbmNet").textContent = c.ssid || "—";
}

function renderAdvLive(d) {
  if (!$("liveRssi")) return;
  $("liveTs").textContent = d.ts ? "· " + d.ts.split("T")[1] : "";
  $("liveGw").textContent = d.default_gateway || "—";
  const c = d.current;
  if (!c) {
    $("liveRssi").textContent = "—";
    $("liveSsid").textContent = "not associated";
    ["liveSnr", "liveChan", "livePhy", "liveTx", "liveSec"].forEach((i) => ($(i).textContent = "—"));
    $("liveRating").innerHTML = "";
    $("liveRate").textContent = "";
    return;
  }
  const r = rate(c.signal, c.snr);
  $("liveRssi").textContent = (c.signal ?? "—") + " dBm";
  $("liveSsid").textContent = c.ssid || "—";
  $("liveRate").textContent = c.phy_friendly || "";
  $("liveRating").innerHTML = `<span class="tag t-${r.cls}">${r.label}</span>`;
  $("liveSnr").textContent = c.snr != null ? c.snr + " dB" : "—";
  $("liveChan").textContent = c.channel ? `${c.channel} · ${c.band || ""} ${c.width || ""}`.trim() : "—";
  $("livePhy").textContent = c.phy || "—";
  $("liveTx").textContent = c.rate ? c.rate + " Mbps" + (c.mcs != null ? ` (MCS ${c.mcs})` : "") : "—";
  $("liveSec").textContent = c.security || "—";
}

function renderNearby(list, current) {
  const el = $("nearbyList");
  if (!el) return;
  if (!list || !list.length) return void (el.innerHTML = '<li class="muted">none detected</li>');
  const curCh = current && current.channel;
  el.innerHTML = list
    .slice()
    .sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999))
    .map((n) => {
      const co = n.channel && n.channel === curCh ? ' <span class="tag t-fair">co-channel</span>' : "";
      const sig = n.signal != null ? n.signal + " dBm" : "—";
      return `<li><span>${esc(n.ssid || "(hidden)")}${co}</span>
        <span class="muted">ch ${n.channel ?? "?"} · ${n.band || "?"} · ${sig}</span></li>`;
    })
    .join("");
}

async function launch(app) {
  try {
    const d = await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app }),
    });
    if (!d.ok) toast("Couldn't open " + app + " — is it installed?");
  } catch (e) {
    toast("Launch failed");
  }
}

/* ---------- capture ---------- */
// Record the RF environment once, on the first reading of a survey — that is the moment the
// tech is standing in the client's building on the client's network. Later readings don't
// overwrite it: the first one is the honest answer to "what was the air like during the survey".
function captureSurveyEnv() {
  if (surveyEnv || !lastScan || !lastScan.current) return;
  surveyEnv = {
    current: lastScan.current,
    nearby: lastScan.nearby || [],
    ts: new Date().toISOString(),
  };
  store(LS_SURVEYENV, JSON.stringify(surveyEnv));
}

function addPoint(loc, c, extras) {
  const pt = {
    id: Date.now(), location: loc, ts: new Date().toISOString(), level: activeLevel,
    ssid: c.ssid, signal: c.signal, noise: c.noise, snr: c.snr,
    channel: c.channel, band: c.band, width: c.width,
    phy: c.phy, phy_friendly: c.phy_friendly, rate: c.rate, mcs: c.mcs, security: c.security,
    download_mbps: null, upload_mbps: null, responsiveness_rpm: null, ping_avg_ms: null, ping_loss_pct: null,
  };
  if (extras) Object.assign(pt, extras);
  if (gpsEnabled && lastGpsFix && lastGpsFix.age_sec != null && lastGpsFix.age_sec < 25) {
    pt.gps = { lat: lastGpsFix.lat, lon: lastGpsFix.lon, acc: lastGpsFix.acc };
  }
  points.push(pt);
  // If the write failed the reading only exists in memory — it will not survive a reload.
  // store() has already warned; roll it back so the list can't show a reading that isn't saved.
  if (!savePoints()) { points.pop(); return null; }
  captureSurveyEnv();
  renderPoints();
  return pt;
}

function saveEasy() {
  const loc = $("easyRoom").value.trim();
  if (!loc) return toast("Type the room name first");
  if (!lastScan || !lastScan.current) return toast("No Wi-Fi signal — are you connected?");
  if (!addPoint(loc, lastScan.current, null)) return;   // storage failed — keep the typed name so it can be retried
  $("easyRoom").value = "";
  $("easyRoom").focus();
  toast(`Saved “${loc}”  ·  ${lastScan.current.signal} dBm`);
}

async function captureAdv() {
  const loc = $("capLoc").value.trim();
  if (!loc) return toast("Enter a location label first");
  if (!lastScan || !lastScan.current) return toast("No live signal — is Wi-Fi connected?");
  const extras = {};
  if ($("capThroughput").checked) {
    toast("Measuring throughput…");
    try {
      const q = await api("/api/quality");
      if (q.ok) { extras.download_mbps = q.download_mbps; extras.upload_mbps = q.upload_mbps; extras.responsiveness_rpm = q.responsiveness_rpm; }
      const host = (lastScan && lastScan.default_gateway) || "1.1.1.1";
      const p = await api("/api/ping?host=" + encodeURIComponent(host) + "&count=5");
      if (p.ok) { extras.ping_avg_ms = p.avg_ms; extras.ping_loss_pct = p.loss_pct; }
    } catch (e) {}
  }
  if (!addPoint(loc, lastScan.current, extras)) return;
  $("capLoc").value = "";
  toast(`Captured “${loc}”`);
}

function renderPoints() {
  $("easyCount").textContent = points.length;
  if ($("ptCount")) $("ptCount").textContent = points.length;
  renderSummary();
  renderReportInsights();
  const es = $("easySpots");
  if (!points.length) {
    es.innerHTML = '<div class="spot-empty">No rooms yet — walk to a room and tap <b>SAVE</b>.</div>';
  } else {
    es.innerHTML = points
      .map((p) => {
        const r = rate(p.signal, p.snr);
        return `<div class="spot"><span class="dot" style="background:${r.color}"></span>
          <span class="nm">${esc(p.location)}</span>
          <span class="rt" style="color:${r.color}">${r.word}</span>
          <span class="muted" style="font-size:14px">${p.signal ?? "—"} dBm</span>
          <button class="x" onclick="delPoint(${p.id})">✕</button></div>`;
      })
      .join("");
  }
  const tb = $("ptBody");
  if (tb) {
    if (!points.length) {
      tb.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:22px">No points yet.</td></tr>';
    } else {
      tb.innerHTML = points
        .map((p, i) => {
          const r = rate(p.signal, p.snr);
          const thr = p.download_mbps != null ? `${p.download_mbps}/${p.upload_mbps}` : "—";
          const lat = p.ping_avg_ms != null ? `${p.ping_avg_ms}ms` : "—";
          return `<tr><td>${i + 1}</td><td><b>${esc(p.location)}</b></td><td>${esc(p.ssid || "—")}</td>
            <td>${p.band || "?"} ch${p.channel ?? "?"}${p.width ? " " + p.width : ""}</td>
            <td>${p.signal ?? "—"}</td><td>${p.snr ?? "—"}</td>
            <td>${p.phy_friendly || p.phy || "—"}${p.rate ? " " + p.rate : ""}</td>
            <td>${thr}</td><td>${lat}</td>
            <td><span class="tag t-${r.cls}">${r.label}</span></td>
            <td><button class="x" style="border:0;background:transparent;color:var(--muted);cursor:pointer" onclick="delPoint(${p.id})">✕</button></td></tr>`;
        })
        .join("");
    }
  }
}

/* ---------- smart summary strip ---------- */
function renderSummary() {
  if (!$("sumRooms")) return;
  const sig = points.map((p) => p.signal).filter((s) => s != null);
  $("sumRooms").textContent = points.length ? distinctRooms(points) : 0;
  $("sumRoomsDot").style.background = points.length ? "var(--accent)" : "var(--na)";
  if (sig.length) {
    const best = Math.max(...sig), worst = Math.min(...sig);
    const bp = points.find((p) => p.signal === best), wp = points.find((p) => p.signal === worst);
    setSum("Best", best + " dBm", rate(best).color, bp ? bp.location : "");
    setSum("Worst", worst + " dBm", rate(worst).color, wp ? wp.location : "");
    const dead = points.filter((p) => p.signal != null && p.signal < -75).length;
    $("sumDead").textContent = dead;
    $("sumDead").style.color = dead ? "var(--poor)" : "var(--exc)";
    $("sumDeadDot").style.background = dead ? "var(--poor)" : "var(--exc)";
    const mapped = mappedPoints(points);
    const hole = dead ? holeAreaSqft(-75, mapped) : 0;
    if ($("sumDeadSub")) $("sumDeadSub").textContent = hole ? "≈ " + fmtSqft(hole) : "";
  } else {
    setSum("Best", "—", "na", "No readings yet");
    setSum("Worst", "—", "na", "");
    $("sumDead").textContent = "—";
    $("sumDead").style.color = "var(--faint)";
    $("sumDeadDot").style.background = "var(--na)";
    if ($("sumDeadSub")) $("sumDeadSub").textContent = "";
  }
  // % Passing (requirement profile) — surfaces the requirement-target feature
  if ($("sumPass")) {
    const mapped = mappedPoints(points);
    if (reqProfile === "none") {
      $("sumPass").textContent = "—"; $("sumPass").style.color = "var(--faint)";
      $("sumPassDot").style.background = "var(--na)";
      $("sumPassSub").textContent = "no target set";
    } else {
      const st = requirementStats(mapped);
      const prof = REQ_PROFILES[reqProfile];
      if (st.ok) {
        const c = st.pct >= 90 ? "var(--exc)" : st.pct >= 70 ? "var(--fair)" : "var(--poor)";
        $("sumPass").textContent = st.pct + "%"; $("sumPass").style.color = c;
        $("sumPassDot").style.background = c;
      } else {
        $("sumPass").textContent = "—"; $("sumPass").style.color = "var(--faint)";
        $("sumPassDot").style.background = "var(--na)";
      }
      $("sumPassSub").textContent = prof.label;
    }
  }
  // Area (scale) — surfaces the calibration feature
  if ($("sumArea")) {
    const mapped = mappedPoints(points);
    const area = surveyedSqft(mapped), sc = getScale();
    if (area) {
      $("sumArea").textContent = fmtSqft(area); $("sumArea").style.color = "var(--ink)";
      $("sumAreaDot").style.background = "var(--accent)";
      $("sumAreaSub").textContent = sc.source === "gps" ? "from GPS" : "calibrated";
    } else {
      $("sumArea").textContent = "—"; $("sumArea").style.color = "var(--faint)";
      $("sumAreaDot").style.background = "var(--na)";
      $("sumAreaSub").textContent = planMode === "image" && !geoBounds ? "set scale" : "";
    }
  }
  const connected = !!lastCell;
  const verdict = connected ? cellVerdict(lastCell.nr && (lastCell.nr.rsrp != null || lastCell.nr.sinr != null) ? lastCell.nr : lastCell.lte) : null;
  $("sumCell").textContent = verdict || (connected ? "Connected" : "—");
  $("sumCell").style.color = verdict ? GRADE_COLOR[verdict] : connected ? "var(--exc)" : "var(--faint)";
  $("sumCellDot").style.background = verdict ? GRADE_COLOR[verdict] : connected ? "var(--exc)" : "var(--na)";
  updateSideStatus();
}
function updateSideStatus() {
  const c = lastScan && lastScan.current;
  if ($("ssWifi")) { $("ssWifi").textContent = c ? "Wi-Fi · " + (c.ssid || "connected") : "Wi-Fi —"; $("ssWifiDot").style.background = c ? "var(--exc)" : "var(--na)"; }
  const on = lastGpsFix && lastGpsFix.lat != null;
  if ($("ssGps")) { $("ssGps").textContent = on ? "GPS · live" : "GPS off"; $("ssGpsDot").style.background = on ? "var(--exc)" : "var(--na)"; }
}
function setSum(which, val, color, sub) {
  const ids = which === "Best" ? ["sumBest", "sumBestDot", "sumBestRoom"] : ["sumWorst", "sumWorstDot", "sumWorstRoom"];
  $(ids[0]).textContent = val;
  $(ids[0]).style.color = color === "na" ? "var(--faint)" : color;
  $(ids[1]).style.background = color === "na" ? "var(--na)" : color;
  if ($(ids[2])) $(ids[2]).textContent = sub;
}

function delPoint(id) {
  points = points.filter((p) => p.id !== id);
  savePoints();
  renderPoints();
  renderCoverageMap();
}
// Clears the MEASUREMENTS for this job. Client details stay — they identify the job, and
// a different job is a different survey (use "New survey"). Photos and the imported scan are
// measurements of this property, so they go too: leaving them behind is how one client's
// premises photos and network list ended up in the next client's PDF.
function clearAll() {
  const n = (c, one, many) => (c ? `${c} ${c === 1 ? one : many || one + "s"}` : null);
  const bits = [
    n(points.length, "reading"),
    n(cellPoints.length, "candidate spot"),
    n(reportPhotos.length, "site photo"),
    importedScan.length ? "the imported scan" : null,
    heatmapDataUrl ? "the heatmap" : null,
  ].filter(Boolean);
  if (!bits.length) return toast("Nothing to clear.");
  const what = bits.length > 1 ? bits.slice(0, -1).join(", ") + " and " + bits[bits.length - 1] : bits[0];
  if (!confirm(`Start over?\n\nClears ${what}.\n\nClient and site details are kept. This can't be undone.`)) return;
  points = [];
  cellPoints = [];
  reportPhotos = [];
  importedScan = [];
  surveyEnv = null;                    // the next walk records its own environment
  try { localStorage.removeItem(LS_SURVEYENV); } catch (e) {}
  levels.forEach((l) => (l.snapshot = null));
  savePoints();
  saveCellPoints();
  savePhotos();
  store(LS_IMPORTEDSCAN, JSON.stringify(importedScan));
  saveLevels();
  removeHeatmap();
  renderPoints();
  renderCellSpots();
  renderReportPhotos();
  renderCoverageMap();
  renderReportInsights();
}

/* ---------- advanced tools ---------- */
async function runQuality() {
  const b = $("btnQuality");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> testing…';
  try {
    const d = await api("/api/quality");
    if (d.ok) {
      $("qDown").textContent = (d.download_mbps ?? "—") + " Mbps";
      $("qUp").textContent = (d.upload_mbps ?? "—") + " Mbps";
      $("qRpm").textContent = (d.responsiveness_rpm ?? "—") + " RPM";
      toast(`↓${d.download_mbps} / ↑${d.upload_mbps} Mbps`);
    } else toast("Throughput failed: " + (d.error || ""));
  } catch (e) { toast("Throughput failed"); }
  b.disabled = false;
  b.innerHTML = "⚡ Throughput";
}
// Cellular-page speed test — same /api/quality endpoint as runQuality(), separate button/readout.
// Measures the REAL internet speed through the gateway (the cellular data speed).
async function runCellSpeed() {
  const b = $("btnCellSpeed");
  if (!b) return;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> testing… (~20s)';
  $("csDown").textContent = "…";
  $("csUp").textContent = "…";
  $("csLat").textContent = "…";
  try {
    const d = await api("/api/quality");
    if (d.ok) {
      $("csDown").textContent = (d.download_mbps ?? "—") + " Mbps";
      $("csUp").textContent = (d.upload_mbps ?? "—") + " Mbps";
      $("csLat").textContent = d.base_rtt_ms != null ? d.base_rtt_ms + " ms" : "—";
      toast(`↓${d.download_mbps} / ↑${d.upload_mbps} Mbps through the gateway`);
    } else {
      $("csDown").textContent = "—"; $("csUp").textContent = "—"; $("csLat").textContent = "—";
      toast("Speed test failed: " + (d.error || ""));
    }
  } catch (e) {
    $("csDown").textContent = "—"; $("csUp").textContent = "—"; $("csLat").textContent = "—";
    toast("Speed test failed");
  }
  b.disabled = false;
  b.innerHTML = "⚡ Test connection speed";
}
async function runPing() {
  const host = (lastScan && lastScan.default_gateway) || "1.1.1.1";
  const b = $("btnPing");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> ping…';
  try {
    const d = await api("/api/ping?host=" + encodeURIComponent(host) + "&count=5");
    $("pLat").textContent = d.ok ? `${d.avg_ms} ms · ${d.loss_pct}% loss` : "unreachable";
    toast(d.ok ? `Ping ${host}: ${d.avg_ms} ms` : "Ping failed");
  } catch (e) { toast("Ping failed"); }
  b.disabled = false;
  b.innerHTML = "📍 Ping gateway";
}

/* ---------- cellular / antenna aiming ---------- */
let cellSeq = 0;        // newest request wins — a gateway read can take longer than one interval
let cellInFlight = false;
let cellFails = 0;

async function connectCell() {
  // A read can take up to 16s (login + fetch) against a 6s refresh, so without this the
  // requests pile up and can resolve out of order — showing an older reading as the newer one.
  if (cellInFlight) return;
  cellInFlight = true;
  const seq = ++cellSeq;
  const ip = $("cellIp").value.trim();
  const pass = $("cellPass").value;
  const b = $("btnCell");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>';
  // only show the "Connecting…" state on a manual connect, not on every auto-refresh tick
  if (!cellTimer) setCellBadge("wait", "📡", "Connecting to gateway…", "Reading signal from the gateway…");
  try {
    const d = await api("/api/cellular", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, password: pass }),
    });
    if (seq !== cellSeq) return;              // a newer read already landed
    if (!d.ok) {
      cellFails++;
      setCellBadge("stale", "⚠️", d.error || "Couldn't read the gateway.", "Check the address and admin password, and that you're on the gateway's Wi-Fi.");
      // Don't tear down the auto-refresh on one miss — moving the gateway is exactly what
      // this page is for, and that is precisely when a read drops. Keep the last numbers on
      // screen (marked stale) and give it a few tries before giving up.
      if (cellTimer && cellFails >= 5) {
        stopCellAuto();
        setCellBadge("stale", "⚠️", "Lost the gateway — auto-refresh stopped.", "Reconnect once it's back on the network.");
      }
      if (!lastCell) $("cellResults").classList.add("hidden");
    } else {
      cellFails = 0;
      lastCell = d;
      renderCell(d);
      renderCellSpots();
      $("cellResults").classList.remove("hidden");
      const band5g = (d.nr && d.nr.bands) ? " · 5G " + d.nr.bands : (d.lte && d.lte.bands ? " · LTE " + d.lte.bands : "");
      const when = d.ts ? d.ts.split("T")[1] : "";
      setCellBadge("ok", "✅", `Connected — ${d.model || "gateway"}${band5g}`, `Updated ${when} · let readings settle ~15s before comparing spots.`);
      store(LS_CELL, JSON.stringify({ ip, pass }));
    }
  } catch (e) {
    if (seq === cellSeq) setCellBadge("stale", "⚠️", "Could not reach the tool backend.", "Is the survey server running on this Mac?");
  } finally {
    cellInFlight = false;
    if (seq === cellSeq) {
      renderSummary();
      b.disabled = false;
      b.textContent = "Connect";
    }
  }
}
function renderCell(d) {
  setCell("nr", d.nr);
  setCell("lte", d.lte);
}
// drive the #cellStatus connection badge (reuses the .gpsbadge visual states: wait/ok/stale)
function setCellBadge(state, icon, text, sub) {
  const el = $("cellStatus");
  if (!el) return;
  el.className = "gpsbadge cellbadge " + state;
  if ($("cellBadgeIcon")) $("cellBadgeIcon").textContent = icon;
  if ($("cellBadgeText")) $("cellBadgeText").textContent = text;
  if ($("cellBadgeSub")) $("cellBadgeSub").textContent = sub || "";
}
// map RSRP (dBm) → phone signal-bar count 0..5; null/missing → 0 bars
function rsrpBars(rsrp) {
  if (rsrp == null || isNaN(rsrp)) return 0;
  if (rsrp >= -80) return 5;
  if (rsrp >= -90) return 4;
  if (rsrp >= -100) return 3;
  if (rsrp >= -110) return 2;
  return 1;
}
// render 5 increasing-height bars into a container: `filled` of them get `color`, rest are empty
function renderBars(container, filled, color) {
  if (!container) return;
  const bars = container.querySelectorAll("i");
  for (let i = 0; i < bars.length; i++) {
    bars[i].style.background = i < filled ? color : "var(--line-strong)";
  }
}
function setCellVerdict(pfx, word) {
  const v = $(pfx + "Verdict");
  if (!v) return;
  if (!word) { v.classList.add("hidden"); return; }
  v.textContent = word;
  v.style.color = GRADE_COLOR[word];
  v.style.borderColor = GRADE_COLOR[word];
  v.classList.remove("hidden");
}
function setCell(pfx, s) {
  const el = $(pfx + "Sinr");
  const color = rateCell(s ? s.sinr : null);
  if (!s) {
    el.textContent = "—";
    el.style.color = "var(--muted)";
    renderBars($(pfx + "Bars"), 0, color);
    $(pfx + "Rsrp").textContent = "—"; $(pfx + "Rsrp").style.color = "";
    $(pfx + "Rsrq").textContent = "—";
    $(pfx + "Rssi").textContent = "—";
    $(pfx + "Band").textContent = "—";
    setCellVerdict(pfx, null);
    return;
  }
  el.textContent = s.sinr != null ? s.sinr : "—";
  el.style.color = color;
  renderBars($(pfx + "Bars"), rsrpBars(s.rsrp), color);
  const rsG = cellGrade("rsrp", s.rsrp);
  $(pfx + "Rsrp").textContent = s.rsrp != null ? s.rsrp + " dBm" : "—";
  $(pfx + "Rsrp").style.color = rsG ? GRADE_COLOR[rsG] : "";
  $(pfx + "Rsrq").textContent = s.rsrq != null ? s.rsrq + " dB" : "—";
  $(pfx + "Rssi").textContent = s.rssi != null ? s.rssi + " dBm" : "—";
  $(pfx + "Band").textContent = s.bands ? s.bands : "—";
  setCellVerdict(pfx, cellVerdict(s));
}
function rateCell(sinr) {
  if (sinr == null) return "var(--muted)";
  if (sinr >= 20) return "#22c55e";
  if (sinr >= 13) return "#84cc16";
  if (sinr >= 0) return "#f59e0b";
  return "#ef4444";
}

/* ---------- signal interpretation: Wi-Fi generation, security posture, cellular grades ----------
   All derived from fields macOS already reports per AP (PHY mode, channel/band, security) — no
   extra tooling. PHY for a scanned AP is a capability list (e.g. 802.11a/n/ac/ax); we take the
   HIGHEST generation present, and use the 6 GHz band to tell Wi-Fi 6E from plain Wi-Fi 6. */
function is6GHz(ap) { return (ap.band || "").trim().charAt(0) === "6"; }
function wifiGen(ap) {
  const p = (ap.phy || "").toLowerCase();
  if (p.includes("be")) return { g: 7, label: "Wi-Fi 7" };
  if (p.includes("ax")) return is6GHz(ap) ? { g: 6.5, label: "Wi-Fi 6E" } : { g: 6, label: "Wi-Fi 6" };
  if (p.includes("ac")) return { g: 5, label: "Wi-Fi 5" };
  if (p.includes("n")) return { g: 4, label: "Wi-Fi 4" };
  if (p) return { g: 3, label: "Legacy a/b/g" };
  if (is6GHz(ap)) return { g: 6.4, label: "6 GHz (6E/7)" };   // no PHY (imported scan): 6 GHz band ⇒ 6E OR 7, can't tell which
  return { g: 0, label: "Unknown" };
}
function secGrade(sec) {
  const s = (sec || "").toLowerCase();
  if (s.includes("wpa3")) return { g: "wpa3", label: "WPA3", rank: 4, color: "#22c55e" };
  if (s.includes("wpa2")) return { g: "wpa2", label: "WPA2", rank: 3, color: "#84cc16" };
  if (s.includes("wpa")) return { g: "wpa", label: "WPA (legacy)", rank: 1, color: "#f59e0b" };
  if (s.includes("wep")) return { g: "wep", label: "WEP (insecure)", rank: 0, color: "#ef4444" };
  if (s.includes("open") || s.includes("none")) return { g: "open", label: "Open", rank: 0, color: "#ef4444" };
  return { g: "unknown", label: sec || "Unknown", rank: 2, color: "#94a3b8" };
}
// summarize the RF infrastructure across a set of APs (connected + neighbors)
function analyzeInfra(aps) {
  const gen = {}, band = { "2.4 GHz": 0, "5 GHz": 0, "6 GHz": 0 }, sec = {};
  let open = 0, legacy = 0, sixViolation = 0;
  aps.forEach((ap) => {
    gen[wifiGen(ap).label] = (gen[wifiGen(ap).label] || 0) + 1;
    const b = (ap.band || "").trim().charAt(0);
    if (b === "2") band["2.4 GHz"]++; else if (b === "5") band["5 GHz"]++; else if (b === "6") band["6 GHz"]++;
    const sg = secGrade(ap.security); sec[sg.label] = (sec[sg.label] || 0) + 1;
    if (sg.g === "open") open++;
    if (sg.g === "wep" || sg.g === "wpa") legacy++;
    // 6 GHz mandates WPA3/OWE: flag only EXPLICIT legacy security on 6 GHz (bare "Open" there may be OWE — indeterminate on macOS)
    if (is6GHz(ap) && (sg.g === "wep" || sg.g === "wpa" || sg.g === "wpa2")) sixViolation++;
  });
  return { gen, band, sec, total: aps.length, open, legacy, sixViolation };
}
// cellular interpretation bands (3GPP-aligned rules of thumb, NOT a normative pass/fail standard)
const CELL_BANDS = { rsrp: [[-80, "Excellent"], [-90, "Good"], [-100, "Fair"], [-110, "Poor"]], sinr: [[20, "Excellent"], [13, "Good"], [0, "Fair"]], rsrq: [[-10, "Excellent"], [-15, "Good"], [-20, "Fair"]] };
// One grade colour per surface. `print` is tuned for the PDF's white page; `screen` for the
// dark UI. These were the same set, so the print palette was rendering on the dashboard at
// 2.69:1 for Critical — the most prominent number in the product, least readable exactly when
// the news was worst. Both sets pass AA on the surface they are for.
// Poor and Critical share a red on screen deliberately: both are failing grades, the badge
// prints the word next to the number, and every second red that clears 4.5:1 on this
// background reads *lighter* than the first — i.e. less severe, which is backwards.
const GRADE_INK = {
  print:  { Excellent: "#15803d", Good: "#3f8f13", Fair: "#b45309", Poor: "#dc2626", Critical: "#b91c1c" },
  screen: { Excellent: "#34d399", Good: "#a3e635", Fair: "#fbbf24", Poor: "#f87171", Critical: "#f87171" },
};
// The signal ratings use the same four screen colours, so a chip on one page and a dot on
// another can't disagree about what "Good" looks like.
const GRADE_COLOR = { Excellent: "#34d399", Good: "#a3e635", Fair: "#fbbf24", Poor: "#f87171" };
// Finding severity, one definition for every renderer.
const SEVERITY_COLOR = { critical: "var(--poor)", warning: "var(--fair)", good: "var(--exc)", info: "var(--accent)" };
const GRADE_RANK = { Excellent: 3, Good: 2, Fair: 1, Poor: 0 };
function cellGrade(metric, v) {
  if (v == null || isNaN(v)) return null;
  for (const b of CELL_BANDS[metric]) if (v >= b[0]) return b[1];
  return "Poor";
}
// overall verdict = the WORSE of RSRP (coverage) and SINR (quality) — a strong-but-noisy signal isn't "good"
function cellVerdict(s) {
  if (!s) return null;
  const gs = [cellGrade("rsrp", s.rsrp), cellGrade("sinr", s.sinr)].filter(Boolean);
  return gs.length ? gs.reduce((a, b) => (GRADE_RANK[b] < GRADE_RANK[a] ? b : a)) : null;
}
function toggleCellAuto() {
  if ($("cellAuto").checked) {
    cellFails = 0;
    connectCell();
    // re-armed from each response rather than a fixed interval, so a slow gateway spaces the
    // reads out instead of queueing them up behind each other
    const tick = () => { connectCell().finally(() => { if (cellTimer) cellTimer = setTimeout(tick, 6000); }); };
    cellTimer = setTimeout(tick, 6000);
  } else stopCellAuto();
}
function stopCellAuto() {
  if (cellTimer) clearTimeout(cellTimer);
  cellTimer = null;
  cellFails = 0;
  if ($("cellAuto")) $("cellAuto").checked = false;
}

/* ---------- cellular placement spots ---------- */
function saveCellPoints() { return store(LS_CELLPTS, JSON.stringify(cellPoints)); }

function logCellSpot() {
  const label = $("cellSpotLabel").value.trim();
  if (!label) return toast("Name the spot first");
  if (!lastCell) return toast("Connect to the gateway first");
  const n = lastCell.nr || {}, l = lastCell.lte || {};
  cellPoints.push({
    id: Date.now(), location: label, ts: new Date().toISOString(), model: lastCell.model,
    nr_sinr: n.sinr, nr_rsrp: n.rsrp, nr_band: n.bands,
    lte_sinr: l.sinr, lte_rsrp: l.rsrp, lte_band: l.bands,
  });
  saveCellPoints();
  renderCellSpots();
  $("cellSpotLabel").value = "";
  $("cellSpotLabel").focus();
  toast(`Logged “${label}”  ·  5G SINR ${n.sinr ?? "—"}`);
}

function bestCellSpot() {
  return cellPoints.slice().sort((a, b) => (b.nr_sinr ?? b.lte_sinr ?? -999) - (a.nr_sinr ?? a.lte_sinr ?? -999))[0];
}

function renderCellSpots() {
  if ($("cellCount")) $("cellCount").textContent = cellPoints.length;
  const el = $("cellSpots");
  if (!el) return;
  if (!cellPoints.length) {
    el.innerHTML = '<div class="spot-empty">Move the gateway to a spot, let it settle, then LOG it.</div>';
    return;
  }
  const best = bestCellSpot();
  el.innerHTML = cellPoints
    .map((p) => {
      const isBest = best && p.id === best.id && (p.nr_sinr != null || p.lte_sinr != null);
      const star = isBest ? ' <span class="tag t-exc">★ best</span>' : "";
      return `<div class="spot"><span class="dot" style="background:${rateCell(p.nr_sinr)}"></span>
        <span class="nm">${esc(p.location)}${star}</span>
        <span class="rt" style="color:${rateCell(p.nr_sinr)}">5G ${p.nr_sinr ?? "—"}</span>
        <span class="muted" style="font-size:14px">RSRP ${p.nr_rsrp ?? "—"}</span>
        <button class="x" onclick="delCellSpot(${p.id})">✕</button></div>`;
    })
    .join("");
}

function delCellSpot(id) {
  cellPoints = cellPoints.filter((p) => p.id !== id);
  saveCellPoints();
  renderCellSpots();
}

/* ---------- heatmap image attach ---------- */
function attachHeatmap(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    heatmapDataUrl = r.result;
    renderHeatmapThumb();
    // Still usable this session if it won't fit, but the user has to know it won't survive a reload.
    try { localStorage.setItem(LS_HEATMAP, heatmapDataUrl); toast("Heatmap attached — it'll appear in the report"); }
    catch (e) { warn("Heatmap attached, but it's too big to save — make the report before reloading."); }
  };
  r.readAsDataURL(file);
  ev.target.value = "";
}

function removeHeatmap() {
  heatmapDataUrl = null;
  try { localStorage.removeItem(LS_HEATMAP); } catch (e) {}
  renderHeatmapThumb();
}

function renderHeatmapThumb() {
  const el = $("heatmapThumb");
  if (!el) return;
  el.innerHTML = heatmapDataUrl
    ? `<div style="margin-top:12px"><img src="${safeImgSrc(heatmapDataUrl)}" style="max-height:130px;border-radius:8px;border:1px solid var(--line)"><br>
       <button class="ghost" style="margin-top:8px;font-size:13px" onclick="removeHeatmap()">✕ Remove heatmap</button></div>`
    : "";
}

/* ---------- site photos & screenshots (embedded in the report) ---------- */
// Photos are the bulkiest thing in storage, so this is the write most likely to hit quota.
// It stays non-fatal (they're in memory and will still reach the PDF) but never silent.
function savePhotos() {
  try { localStorage.setItem(LS_PHOTOS, JSON.stringify(reportPhotos)); return true; }
  catch (e) { warn("Photos are too big to save — make the report before reloading, or remove a photo."); return false; }
}

// downscale each picked image to a ~1400px jpeg data URL (same approach as loadFloorPlan) and add it
function addReportPhotos(ev) {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  let pending = files.length;
  files.forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1400 / img.naturalWidth);
        const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        c.getContext("2d").drawImage(img, 0, 0, W, H);
        reportPhotos.push({ url: c.toDataURL("image/jpeg", 0.82), caption: "" });
        if (--pending === 0) { savePhotos(); renderReportPhotos(); toast(files.length + " photo" + (files.length > 1 ? "s" : "") + " added — they'll appear in the report"); }
      };
      img.onerror = () => { if (--pending === 0) { savePhotos(); renderReportPhotos(); } };
      img.src = reader.result;
    };
    reader.onerror = () => { if (--pending === 0) { savePhotos(); renderReportPhotos(); } };
    reader.readAsDataURL(f);
  });
  ev.target.value = "";
}

function removeReportPhoto(idx) {
  reportPhotos.splice(idx, 1);
  savePhotos();
  renderReportPhotos();
}

function setPhotoCaption(idx, val) {
  if (reportPhotos[idx]) { reportPhotos[idx].caption = val; savePhotos(); }
}

function renderReportPhotos() {
  const el = $("reportPhotoStrip");
  if (!el) return;
  if (!reportPhotos.length) { el.innerHTML = ""; return; }
  el.innerHTML = reportPhotos.map((p, i) =>
    `<div class="rpthumb">
       <button class="rpx" title="Remove" onclick="removeReportPhoto(${i})">✕</button>
       <img src="${safeImgSrc(p.url)}" alt="site photo ${i + 1}">
       <input type="text" value="${esc(p.caption || "")}" placeholder="Caption (optional)"
              oninput="setPhotoCaption(${i}, this.value)">
     </div>`).join("");
}

/* ---------- coverage heatmap (built-in, NetSpot-style) ---------- */
// color ramp from weak(red) -> strong(green), keyed by RSSI dBm
// metrics we can map — all "higher is better"; th = [pass, marginal] for pass/fail mode
const METRICS = {
  signal:   { label: "Signal (RSSI)",   unit: "dBm",  get: (p) => p.signal,        lo: -90, hi: -40,  th: { web: [-72, -78], video: [-67, -73], iot: [-80, -86] } },
  snr:      { label: "Signal-to-noise", unit: "dB",   get: (p) => p.snr,           lo: 5,   hi: 45,   th: { web: [20, 15], video: [25, 20], iot: [15, 10] } },
  rate:     { label: "Data rate (PHY)", unit: "Mbps", get: (p) => p.rate,          lo: 50,  hi: 1200, th: { web: [100, 50], video: [300, 150], iot: [50, 20] } },
  download: { label: "Throughput",      unit: "Mbps", get: (p) => p.download_mbps, lo: 5,   hi: 200,  th: { web: [25, 10], video: [50, 25], iot: [5, 2] } },
};
// perceptual gradient colormaps (low→high). "signal" keeps the familiar red=weak→green=strong
// convention (consistent with pass/fail); turbo/viridis are perceptually-uniform alternates.
const COLORMAPS = {
  signal:  [[248, 113, 113], [251, 146, 60], [251, 191, 36], [163, 230, 53], [52, 211, 153]],
  turbo:   [[48, 18, 59], [70, 107, 227], [35, 168, 234], [30, 213, 169], [94, 237, 79], [185, 232, 35], [245, 183, 32], [240, 106, 20], [165, 20, 3]],
  viridis: [[68, 1, 84], [72, 36, 117], [65, 68, 135], [52, 96, 141], [41, 121, 142], [33, 145, 140], [39, 173, 129], [92, 200, 99], [253, 231, 37]],
};
let heatColormap = "signal";   // active gradient colormap (pass/fail always stays its discrete 3-color scheme)
function rampColor(f, stops) {
  stops = stops || COLORMAPS[heatColormap] || COLORMAPS.signal;
  f = Math.max(0, Math.min(1, f));
  const seg = f * (stops.length - 1), i = Math.floor(seg), t = seg - i;
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  return [Math.round(a[0] + t * (b[0] - a[0])), Math.round(a[1] + t * (b[1] - a[1])), Math.round(a[2] + t * (b[2] - a[2]))];
}
// a CSS linear-gradient built from a colormap's stops — the legend bar is generated from the SAME
// stops the map paints with, so the legend can never drift out of sync with the heatmap.
function colormapCss(stops) {
  stops = stops || COLORMAPS[heatColormap] || COLORMAPS.signal;
  return "linear-gradient(90deg," + stops.map((c, i) => `rgb(${c[0]},${c[1]},${c[2]}) ${Math.round((100 * i) / (stops.length - 1))}%`).join(",") + ")";
}
// color a metric value under the current metric/mode/preset → [r,g,b] or null if no data
function heatRGB(value) {
  if (value == null || isNaN(value)) return null;
  const M = METRICS[heatMetric];
  if (heatMode === "passfail") {
    const t = M.th[heatPreset];
    if (value >= t[0]) return [52, 211, 153];
    if (value >= t[1]) return [251, 191, 36];
    return [248, 113, 113];
  }
  return rampColor((value - M.lo) / (M.hi - M.lo));
}
function pointColor(p) {
  const rgb = heatRGB(METRICS[heatMetric].get(p));
  return rgb ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : "#7c8aa6";
}
// inverse-distance-weighted color field with Gaussian alpha falloff around measured points
// Distances for the interpolation below are measured in fractions of the map's WIDTH (the
// vertical axis scaled by the map's true aspect) rather than in grid cells. That makes the
// field identical whatever resolution a caller picks. Measured in cells, the epsilon that stops
// a reading dividing by zero was one CELL, so its real size changed with the grid — the 100-,
// 120-, 200- and 220-wide grids in this file each produced a slightly different field, which is
// how the printed "% area passing" ended up disagreeing with the wash drawn right next to it.
const IDW_EPS = 1e-4;      // ~1% of the map width: a small plateau at each reading, not a spike
const HEAT_FADE = 0.16;    // readings stop tinting the map beyond ~this fraction of the width

// Readings that have a position on a level's map. Everything geometric — the heatmap, the
// hull, surveyed area, % passing, dead-zone square footage — is only meaningful for these.
// A reading saved from the Live page has no map position, and letting one into those figures
// is what made the report's dead-zone area disagree with the dashboard's dead-spot count.
function mappedPoints(pts, level) {
  const lv = level || activeLevel;
  return (pts || []).filter((p) => p.mapX != null && p.level === lv);
}

// Readings with no map position carry x/y of NaN and would poison every cell they touch,
// so they are dropped here rather than silently turning the whole grid into NaN.
function idwSamples(pts, get) {
  return pts
    .map((p) => ({ x: p.mapX, y: p.mapY, s: get(p) }))
    .filter((p) => p.s != null && !isNaN(p.s) && Number.isFinite(p.x) && Number.isFinite(p.y));
}

function buildHeatCanvas(pts, gw, gh) {
  const M = METRICS[heatMetric];
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  const ctx = c.getContext("2d");
  const im = ctx.createImageData(gw, gh), d = im.data;
  const P = idwSamples(pts, M.get);
  if (!P.length) { ctx.putImageData(im, 0, 0); return c; }
  const aspect = gh / gw;                       // map height as a fraction of its width
  const twoSig2 = 2 * HEAT_FADE * HEAT_FADE;
  for (let y = 0; y < gh; y++) {
    const fy = gh > 1 ? y / (gh - 1) : 0;
    for (let x = 0; x < gw; x++) {
      const fx = gw > 1 ? x / (gw - 1) : 0;
      let sw = 0, sv = 0, minD2 = Infinity;
      for (const p of P) {
        const dx = fx - p.x, dy = (fy - p.y) * aspect, d2 = dx * dx + dy * dy;
        if (d2 < minD2) minD2 = d2;
        const w = 1 / (d2 + IDW_EPS);
        sw += w; sv += w * p.s;
      }
      const rgb = heatRGB(sv / sw) || [124, 138, 166];
      const a = Math.round(190 * Math.exp(-minD2 / twoSig2));
      const idx = (y * gw + x) * 4;
      d[idx] = rgb[0]; d[idx + 1] = rgb[1]; d[idx + 2] = rgb[2]; d[idx + 3] = a;
    }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
// scalar IDW value grid (same field buildHeatCanvas colors) — used to trace contour lines
// and to score requirement pass/fail. metricKey defaults to the active heatMetric.
// `aspect` is the map's height as a fraction of its width. Callers that score a grid must pass
// the SAME aspect the map is drawn at, or the scored field and the drawn field disagree.
function buildHeatValueGrid(pts, gw, gh, metricKey, aspect) {
  const M = METRICS[metricKey || heatMetric];
  const P = idwSamples(pts, M.get);
  if (P.length < 3) return null;
  const ar = aspect != null ? aspect : gh / gw;
  const grid = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) {
    const fy = gh > 1 ? y / (gh - 1) : 0;
    for (let x = 0; x < gw; x++) {
      const fx = gw > 1 ? x / (gw - 1) : 0;
      let sw = 0, sv = 0;
      for (const p of P) {
        const dx = fx - p.x, dy = (fy - p.y) * ar;
        const w = 1 / (dx * dx + dy * dy + IDW_EPS);
        sw += w; sv += w * p.s;
      }
      grid[y * gw + x] = sv / sw;
    }
  }
  return grid;
}
// "nice" round contour levels spanning the value range
function contourLevels(grid) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < grid.length; i++) { const v = grid[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo) || hi - lo < 1e-6) return [];
  const raw = (hi - lo) / 5, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = (raw / mag >= 5 ? 5 : raw / mag >= 2 ? 2 : 1) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v < hi; v += step) out.push(+v.toFixed(4));
  return out;
}
// marching-squares iso-value contour lines with labels (like a pro RF report), drawn on ctx W×H
function drawContours(ctx, W, H, mapped) {
  const ar = mapAspect();
  const gw = 100, gh = Math.max(1, Math.round(100 * ar));
  const grid = buildHeatValueGrid(mapped, gw, gh, null, ar);
  if (!grid) return;
  const levels = contourLevels(grid);
  if (!levels.length) return;
  const sx = W / (gw - 1), sy = H / (gh - 1);
  const v = (x, y) => grid[y * gw + x];
  const f = (a, b, L) => (L - a) / (b - a);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  levels.forEach((L, li) => {
    ctx.beginPath();
    const labels = [];
    for (let y = 0; y < gh - 1; y++) {
      for (let x = 0; x < gw - 1; x++) {
        const tl = v(x, y), tr = v(x + 1, y), br = v(x + 1, y + 1), bl = v(x, y + 1);
        let ci = 0;
        if (tl > L) ci |= 8; if (tr > L) ci |= 4; if (br > L) ci |= 2; if (bl > L) ci |= 1;
        if (ci === 0 || ci === 15) continue;
        const top = () => [(x + f(tl, tr, L)) * sx, y * sy];
        const right = () => [(x + 1) * sx, (y + f(tr, br, L)) * sy];
        const bottom = () => [(x + f(bl, br, L)) * sx, (y + 1) * sy];
        const left = () => [x * sx, (y + f(tl, bl, L)) * sy];
        const seg = (a, b) => { ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); if (labels.length < 3 && (x + y + li) % 13 === 0) labels.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); };
        switch (ci) {
          case 1: case 14: seg(left(), bottom()); break;
          case 2: case 13: seg(bottom(), right()); break;
          case 3: case 12: seg(left(), right()); break;
          case 4: case 11: seg(top(), right()); break;
          case 6: case 9: seg(top(), bottom()); break;
          case 7: case 8: seg(left(), top()); break;
          // Saddle cells: two opposite corners straddle the level, so the pair of segments can
          // be joined two ways and only one of them is right. Sample the cell centre (the mean
          // of its corners) to see which pair the middle actually belongs to — a fixed pairing
          // draws contours that cross themselves through tight dead spots.
          case 5:  // top-right and bottom-left are above the level
            if ((tl + tr + br + bl) / 4 > L) { seg(left(), top()); seg(bottom(), right()); }
            else { seg(top(), right()); seg(left(), bottom()); }
            break;
          case 10: // top-left and bottom-right are above the level
            if ((tl + tr + br + bl) / 4 > L) { seg(top(), right()); seg(left(), bottom()); }
            else { seg(left(), top()); seg(bottom(), right()); }
            break;
        }
      }
    }
    ctx.strokeStyle = "rgba(12,18,28,.55)"; ctx.lineWidth = 1.2; ctx.stroke();
    const txt = Math.round(L) + "";
    labels.forEach((pt) => {
      ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.strokeText(txt, pt[0], pt[1]);
      ctx.fillStyle = "#0c121c"; ctx.fillText(txt, pt[0], pt[1]);
    });
  });
  ctx.restore();
}
/* ---------- Requirement profiles → live % area passing + fail grey-out ----------
   A spot "passes" a profile only if it clears EVERY gate (dual RSSI+SNR, etc.).
   Thresholds are field-standard rules of thumb (−67 dBm is the classic reliable line),
   so the deliverable is labeled an ESTIMATE over the surveyed area, never a certified guarantee. */
const REQ_PROFILES = {
  none:    { label: "No target",          gates: null },
  voice:   { label: "Voice / VoIP",       gates: { signal: -67, snr: 25 } },
  data:    { label: "Data / Web",         gates: { signal: -72, snr: 20 } },
  video:   { label: "Video / Streaming",  gates: { signal: -67, snr: 22 } },
  density: { label: "High-density",       gates: { signal: -65, snr: 25 } },
};
function reqGateText(prof) {
  return Object.keys(prof.gates).map((m) => `${METRICS[m].label.replace(/ \(.*/, "")} ≥ ${prof.gates[m]} ${METRICS[m].unit}`).join(" · ");
}
// even-odd ray cast, poly = [{x,y}] in [0,1] fraction space
function pointInPolyFrac(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// the coverage boundary used for scoring % + area + overlay: a drawn perimeter wins, else the
// TIGHT convex hull of the readings (margin 0). The heatmap paints to a 14%-expanded hull for a
// continuous look, but reported %/area use the honest walked region, never the cosmetic bleed.
function requirementHull(mapped) {
  if (perimeter.length >= 3) return perimeter.map((p) => ({ x: p.x, y: p.y }));
  return coverageHull(mapped, 0);
}
// build per-gate IDW grids + hull once; shared by the % readout and the map overlay
function evalRequirement(mapped, gw, gh, aspect) {
  const prof = REQ_PROFILES[reqProfile];
  if (!prof || !prof.gates) return { ok: false, msg: "" };
  if (mapped.length < 3) return { ok: false, msg: "Need ≥3 readings" };
  const metrics = Object.keys(prof.gates);
  const grids = {};
  for (const m of metrics) {
    const g = buildHeatValueGrid(mapped, gw, gh, m, aspect);
    if (!g) return { ok: false, msg: "Need ≥3 readings" };
    grids[m] = g;
  }
  const hull = requirementHull(mapped);
  if (!hull) return { ok: false, msg: "Need ≥3 readings" };
  return { ok: true, prof, metrics, grids, hull, gw, gh };
}
// % of the surveyed (hull-clipped) area that meets the active profile — an estimate.
// Scored on the map's own aspect ratio: a fixed 120x90 grid here meant that on any map that
// wasn't 4:3, this percentage described a differently-stretched field than the pass/fail wash
// drawn beside it, and the two contradicted each other in the same report.
function requirementStats(mapped) {
  const ar = mapAspect();
  const gw = 120, gh = Math.max(1, Math.round(120 * ar));
  const ev = evalRequirement(mapped, gw, gh, ar);
  if (!ev.ok) return ev;
  let inside = 0, pass = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!pointInPolyFrac((x + 0.5) / gw, (y + 0.5) / gh, ev.hull)) continue;
      inside++;
      let ok = true;
      for (const m of ev.metrics) { if (ev.grids[m][y * gw + x] < ev.prof.gates[m]) { ok = false; break; } }
      if (ok) pass++;
    }
  }
  if (!inside) return { ok: false, msg: "No surveyed area" };
  return { ok: true, pct: Math.round((100 * pass) / inside), prof: ev.prof };
}
// charcoal wash over cells that FAIL the profile (passing area keeps its heat color) — drawn W×H
function drawRequirementOverlay(ctx, W, H, mapped) {
  if (reqProfile === "none") return;
  const ar = mapAspect();
  const gw = 100, gh = Math.max(1, Math.round(100 * ar));
  const ev = evalRequirement(mapped, gw, gh, ar);
  if (!ev.ok) return;
  const off = document.createElement("canvas");
  off.width = gw; off.height = gh;
  const octx = off.getContext("2d");
  const im = octx.createImageData(gw, gh), d = im.data;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!pointInPolyFrac((x + 0.5) / gw, (y + 0.5) / gh, ev.hull)) continue;
      let ok = true;
      for (const m of ev.metrics) { if (ev.grids[m][y * gw + x] < ev.prof.gates[m]) { ok = false; break; } }
      if (ok) continue;
      const idx = (y * gw + x) * 4;
      d[idx] = 17; d[idx + 1] = 23; d[idx + 2] = 33; d[idx + 3] = 150;
    }
  }
  octx.putImageData(im, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(off, 0, 0, W, H);
  ctx.restore();
}
function setReqProfile(v) {
  reqProfile = v;
  renderCoverageMap();
  updateAreaPassing();
}
// live "% area passing" pill in the heat bar
function updateAreaPassing() {
  const el = $("areaPassing");
  if (!el) return;
  if (reqProfile === "none") { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const mapped = mappedPoints(points);
  const s = requirementStats(mapped);
  const prof = REQ_PROFILES[reqProfile];
  if (!s.ok) {
    el.className = "passpill wait";
    el.innerHTML = `<b>${esc(prof.label)}</b> · ${esc(s.msg || "—")}`;
    el.title = reqGateText(prof);
    return;
  }
  const cls = s.pct >= 90 ? "pass" : s.pct >= 70 ? "warn" : "fail";
  el.className = "passpill " + cls;
  const area = surveyedSqft(mapped);
  const sq = area ? ` <span class="ppe">≈ ${Math.round((area * s.pct) / 100).toLocaleString()} ft²</span>` : "";
  el.innerHTML = `<span class="ppn">${s.pct}%</span> area passing${sq} · <b>${esc(prof.label)}</b> <span class="ppe">est.</span>`;
  el.title = `${reqGateText(prof)} — estimated % of the surveyed area (interpolated, clipped to the walked area)`;
}
/* ---------- real-world scale (feet) → square footage ----------
   Aerial levels carry true geo scale for free (Web-Mercator geoBounds); uploaded plans get a
   manual two-point reference. All math is in the stored [0,1] image-fraction space × the image's
   real dimensions, so it never changes when the window or the PDF renders at a different pixel size. */
function haversineFt(lat1, lon1, lat2, lon2) {
  const R = 20902231, toR = Math.PI / 180;   // mean earth radius in feet
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
// real-world size of the active level's base map, in feet across the FULL image → {ftW,ftH,source} or null
// Real-world size of ANY level's base map. Takes the geo bounds / calibration off the level
// itself rather than the active-level globals, so the report can print each floor's own figures
// instead of repeating the selected floor's numbers under every floor's heatmap.
function scaleForLevel(geo, cal, imgAspect) {
  if (geo) {   // aerial: true scale for free — never ask the tech to calibrate these
    const midLat = (geo.north + geo.south) / 2, midLon = (geo.west + geo.east) / 2;
    return { ftW: haversineFt(midLat, geo.west, midLat, geo.east), ftH: haversineFt(geo.north, midLon, geo.south, midLon), source: "gps" };
  }
  if (cal && cal.feet > 0) {
    // ftW cancels out the image's pixel size and depends only on its proportions, so a stored
    // aspect is enough — no need for the image itself to be loaded.
    const ar = imgAspect != null ? imgAspect : cal.imgAspect;
    if (ar == null) return null;
    const d = Math.hypot(cal.b.x - cal.a.x, (cal.b.y - cal.a.y) * ar);
    if (!(d > 1e-4)) return null;    // a reference line that short can't set a believable scale
    const ftW = cal.feet / d;                 // isotropic for a manual ruler
    return { ftW, ftH: ftW * ar, source: "manual" };
  }
  return null;
}
// the active level's scale
function getScale() {
  const liveAspect = floorPlanImg && floorPlanImg.naturalWidth
    ? floorPlanImg.naturalHeight / floorPlanImg.naturalWidth : null;
  if (geoBounds) return scaleForLevel(geoBounds, null, null);
  if (planMode === "image" && calibration) return scaleForLevel(null, calibration, liveAspect);
  return null;
}
function scaleFor(l) {
  if (!l) return null;
  if (l.id === activeLevel) return getScale();
  return scaleForLevel(l.geo || null, l.cal || null, null);
}
// Height:width ratio of the base map, used so distance across it means the same thing in both
// axes. Readings are stored as [0,1] image fractions, which are only proportional to real
// distance once the map's own proportions are applied. Prefers the true scale in feet and falls
// back to the image's pixel proportions; every grid that gets scored must use this same number
// as the grid that gets drawn, or the two describe differently-stretched worlds.
function mapAspect() {
  const s = getScale();
  if (s && s.ftW > 0 && s.ftH > 0) return s.ftH / s.ftW;
  if (floorPlanImg && floorPlanImg.naturalWidth > 0) return floorPlanImg.naturalHeight / floorPlanImg.naturalWidth;
  const c = $("heatCanvas");
  if (c && c.width > 0 && c.height > 0) return c.height / c.width;
  return 1;
}
// |shoelace| area of a [0,1]-fraction polygon (fraction of the whole image, 0..1)
function polyFracArea(poly) {
  if (!poly || poly.length < 3) return 0;
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2);
}
// square footage of the surveyed (hull/perimeter-clipped) area, or null if no scale yet
function surveyedSqft(mapped) {
  const s = getScale();
  if (!s) return null;
  const hull = requirementHull(mapped) || coverageHull(mapped, 0.14);
  if (!hull) return null;
  return polyFracArea(hull) * s.ftW * s.ftH;
}
// square footage of the interpolated coverage that falls BELOW `threshold` dBm inside the walked hull
function holeAreaSqft(threshold, mapped) {
  const surveyed = surveyedSqft(mapped);
  if (surveyed == null) return null;
  const ar = mapAspect();
  const gw = 120, gh = Math.max(1, Math.round(120 * ar));
  const grid = buildHeatValueGrid(mapped, gw, gh, "signal", ar);
  const hull = requirementHull(mapped);
  if (!grid || !hull) return null;
  let inside = 0, below = 0;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    if (!pointInPolyFrac((x + 0.5) / gw, (y + 0.5) / gh, hull)) continue;
    inside++;
    if (grid[y * gw + x] < threshold) below++;
  }
  return inside ? (below / inside) * surveyed : null;
}
// pan to the coverage map and flash a ring at a finding's location (switches level if needed)
function locateOnMap(x, y, level) {
  if (level && level !== activeLevel && levels.some((L) => L.id === level)) switchLevel(level);
  showPage("map");
  setTimeout(() => {
    const wrap = $("mapWrap");
    if (!wrap) return;
    let f = $("locateFlash");
    if (!f) { f = document.createElement("div"); f.id = "locateFlash"; f.setAttribute("aria-hidden", "true"); wrap.appendChild(f); }
    f.style.left = (x * 100).toFixed(1) + "%";
    f.style.top = (y * 100).toFixed(1) + "%";
    f.style.display = "block";
    f.style.animation = "none"; void f.offsetWidth; f.style.animation = "locpulse 1s ease-out 3";
    clearTimeout(f._t); f._t = setTimeout(() => { f.style.display = "none"; }, 3300);
    wrap.scrollIntoView({ behavior: "smooth", block: "center" });
  }, 90);
}
/* ---------- predictive design mode: model coverage from AP placements, in real feet ----------
   One-slope log-distance path loss: RSSI(d) = TxRef − 10·n·log10(d_ft). The environment preset
   folds wall density into the exponent n. Requires a scale so distances are true feet. */
function predictedRSSI(dFt) { return PL_TXREF - 10 * plExponent * Math.log10(Math.max(dFt, 1)); }
function predictReachFt(threshold) { return Math.pow(10, (PL_TXREF - threshold) / (10 * plExponent)); }
function buildPredictCanvas(gw, gh) {
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  const ctx = c.getContext("2d");
  const s = getScale();
  if (!s || !predictAPs.length) return c;
  const im = ctx.createImageData(gw, gh), d = im.data, M = METRICS.signal;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      let best = -200;
      for (const ap of predictAPs) {
        const dx = (x / (gw - 1) - ap.x) * s.ftW, dy = (y / (gh - 1) - ap.y) * s.ftH;
        const r = predictedRSSI(Math.hypot(dx, dy));
        if (r > best) best = r;
      }
      const rgb = rampColor((best - M.lo) / (M.hi - M.lo));
      const idx = (y * gw + x) * 4;
      d[idx] = rgb[0]; d[idx + 1] = rgb[1]; d[idx + 2] = rgb[2]; d[idx + 3] = 205;
    }
  }
  ctx.putImageData(im, 0, 0);
  return c;
}
function drawPredictPins(ctx, W, H) {
  predictAPs.forEach((ap) => {
    const x = ap.x * W, y = ap.y * H, r = Math.max(8, W * 0.011);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "#37dccb"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#04140f"; ctx.stroke();
    ctx.fillStyle = "#04140f"; ctx.font = "bold " + Math.round(r * 1.1) + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("AP", x, y);
  });
}
function drawPredictBadge(ctx, W, H) {
  const t = "🔮 PREDICTED — modeled, not measured";
  ctx.save();
  ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const w = ctx.measureText(t).width + 18;
  ctx.fillStyle = "rgba(55,220,203,.92)";
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(12, 12, w, 26, 7); ctx.fill(); } else ctx.fillRect(12, 12, w, 26);
  ctx.fillStyle = "#04140f"; ctx.fillText(t, 21, 26);
  ctx.restore();
}
function setHeatMetric(v) { heatMetric = v; renderHeatUI(); renderCoverageMap(); }
function setHeatMode(v) {
  heatMode = v;
  if ($("heatPreset")) $("heatPreset").classList.toggle("hidden", v !== "passfail");
  if ($("heatCmapSel")) $("heatCmapSel").classList.toggle("hidden", v === "passfail");
  renderHeatUI();
  renderCoverageMap();
}
function setHeatPreset(v) { heatPreset = v; renderHeatUI(); renderCoverageMap(); }
function setHeatColormap(v) { heatColormap = v; renderHeatUI(); renderCoverageMap(); }
// What the letter inside each reading dot means. Spelling it out is what makes the marker's
// second channel usable rather than mysterious.
const DOT_KEY = `<span class="muted" style="display:block;margin-top:5px;font-size:11.5px">Dots: <b>E</b> excellent · <b>G</b> good · <b>W</b> weak · <b>D</b> dead zone</span>`;

function renderHeatUI() {
  const el = $("heatLegend");
  if (!el) return;
  const M = METRICS[heatMetric];
  if (heatMode === "passfail") {
    const t = M.th[heatPreset];
    el.innerHTML = `<span class="lg" style="background:var(--exc)"></span>Pass ≥${t[0]} <span class="lg" style="background:var(--fair)"></span>Marginal <span class="lg" style="background:var(--poor)"></span>Fail &lt;${t[1]} <span class="muted">${M.unit}</span>` + DOT_KEY;
  } else {
    el.innerHTML = `<span class="muted">${M.lo}</span><span class="gradbar" style="background:${colormapCss()}"></span><span class="muted">${M.hi} ${M.unit}</span>` + DOT_KEY;
  }
}

// build the perimeter polygon path on a context, scaled to W×H
function perimPath(ctx, W, H) {
  ctx.beginPath();
  perimeter.forEach((pt, i) => { const x = pt.x * W, y = pt.y * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  if (perimeter.length >= 3) ctx.closePath();
}
// Convex hull (Andrew's monotone chain) of the readings, expanded outward from the
// centroid by `margin`, so the heatmap covers the WALKED footprint with breathing room
// but doesn't paint coverage into areas you never measured (honest bounds for a client
// report). A drawn perimeter takes precedence over this. Returns null with < 3 points.
function coverageHull(mapped, margin) {
  const pts = mapped.map((p) => ({ x: p.mapX, y: p.mapY }));
  if (pts.length < 3) return null;
  pts.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 3) return null;
  const cx = hull.reduce((s, p) => s + p.x, 0) / hull.length, cy = hull.reduce((s, p) => s + p.y, 0) / hull.length;
  return hull.map((p) => ({ x: cx + (p.x - cx) * (1 + margin), y: cy + (p.y - cy) * (1 + margin) }));
}
// Clip the context to the coverage area before drawing the heatmap: a drawn perimeter
// wins; else the expanded convex hull of the readings; else no clip. Caller wraps in save/restore.
function heatClip(ctx, W, H, mapped) {
  if (perimeter.length >= 3) { perimPath(ctx, W, H); ctx.clip(); return; }
  // 14% bleed makes the heatmap read continuous; but when a requirement profile is scoring pass/fail,
  // paint only the tight scored hull so no colored-but-unscored ring can read as "passing".
  const hull = coverageHull(mapped, reqProfile !== "none" ? 0 : 0.14);
  if (!hull) return;
  ctx.beginPath();
  hull.forEach((p, i) => { const x = p.x * W, y = p.y * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.clip();
}
// draw router/AP markers (blue pin + label pill) onto a report canvas
function drawApMarks(ctx, W, H) {
  apMarks.forEach((a) => {
    const x = a.x * W, y = a.y * H, r = Math.max(7, W * 0.012);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "#2563eb"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = "#fff"; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
    const fs = Math.max(11, Math.round(W * 0.016));
    ctx.font = "bold " + fs + "px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    const tw = ctx.measureText(a.label).width;
    ctx.fillStyle = "#2563eb"; ctx.fillRect(x - tw / 2 - 6, y - r - fs - 9, tw + 12, fs + 6);
    ctx.fillStyle = "#fff"; ctx.fillText(a.label, x, y - r - 7);
  });
}

function renderCoverageMap() {
  const area = $("planArea");
  if (!area || area.classList.contains("hidden")) return;
  if (planMode === "image" && (!floorPlanImg || !floorPlanImg.naturalWidth)) return;
  if (planMode !== "image" && planMode !== "schematic") return;
  if (planMode === "schematic") renderRooms();
  const wrap = $("mapWrap"), cw = wrap.clientWidth, ch = wrap.clientHeight;
  if (!cw || !ch) return;
  const mapped = mappedPoints(points);
  $("dotsLayer").innerHTML = mapped
    .map((p) => {
      // The initial (E/G/W/D) is a second channel alongside the colour. Green, lime and amber
      // collapse to nearly the same shade under red-green colour blindness — Good vs Fair
      // measured 1.02:1 after simulation — and that pair is the -67 dBm "reliable vs
      // borderline" line, the most decision-relevant distinction on the map.
      const r = rate(p.signal, p.snr);
      const initial = { exc: "E", good: "G", fair: "W", poor: "D", na: "?" }[r.cls] || "?";
      return `<div title="${esc(p.location)} · ${p.signal} dBm · ${esc(r.label)}" style="position:absolute;left:${(p.mapX * 100).toFixed(1)}%;top:${(p.mapY * 100).toFixed(1)}%;transform:translate(-50%,-50%);width:17px;height:17px;border-radius:50%;background:${pointColor(p)};border:2px solid #fff;box-shadow:0 0 4px rgba(0,0,0,.7);font:800 9px/13px var(--font-sans);color:#0b1220;text-align:center">${initial}</div>`;
    })
    .join("") +
    apMarks
      .map((a) => `<div style="position:absolute;left:${(a.x * 100).toFixed(1)}%;top:${(a.y * 100).toFixed(1)}%;transform:translate(-50%,-100%);text-align:center;pointer-events:none">
        <div style="font-size:19px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.7))">📡</div>
        <div style="font-size:11px;font-weight:700;color:#04121f;background:var(--accent);border-radius:5px;padding:1px 6px;white-space:nowrap">${esc(a.label)}</div>
      </div>`)
      .join("");
  const canvas = $("heatCanvas");
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cw, ch);
  if (showPredict) {
    ctx.save();
    if (perimeter.length >= 3) { perimPath(ctx, cw, ch); ctx.clip(); }
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.62;
    const gw = 170, gh = Math.max(1, Math.round((170 * ch) / cw));
    ctx.drawImage(buildPredictCanvas(gw, gh), 0, 0, cw, ch);
    ctx.globalAlpha = 1;
    ctx.restore();
    drawPredictPins(ctx, cw, ch);
    drawPredictBadge(ctx, cw, ch);
  } else if (showHeatmap && mapped.length) {
    ctx.save();
    heatClip(ctx, cw, ch, mapped);
    const gw = 200, gh = Math.max(1, Math.round((200 * ch) / cw));
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 0.6;
    ctx.drawImage(buildHeatCanvas(mapped, gw, gh), 0, 0, cw, ch);
    if (showContours) drawContours(ctx, cw, ch, mapped);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  if ($("dotsLayer")) $("dotsLayer").style.opacity = showPredict ? "0.25" : "1";
  if (mapped.length && !showPredict) drawRequirementOverlay(ctx, cw, ch, mapped);
  if (perimeter.length) {
    perimPath(ctx, cw, ch);
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2.5;
    if (perimeter.length < 3) ctx.setLineDash([6, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    perimeter.forEach((pt) => {
      ctx.beginPath();
      ctx.arc(pt.x * cw, pt.y * ch, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#38bdf8";
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
  if (mapMode === "cal" && calTemp.a) {
    const A = calTemp.a, B = calTemp.b;
    ctx.save();
    if (B) {
      ctx.strokeStyle = "#f5b13f"; ctx.lineWidth = 3; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(A.x * cw, A.y * ch); ctx.lineTo(B.x * cw, B.y * ch); ctx.stroke();
    }
    [A, B].forEach((p) => { if (!p) return; ctx.beginPath(); ctx.arc(p.x * cw, p.y * ch, 6, 0, Math.PI * 2); ctx.fillStyle = "#f5b13f"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke(); });
    ctx.restore();
  }
  updateAreaPassing();
  updateScaleUI();
  renderSummary();
}

function loadFloorPlan(ev) {
  const f = ev.target.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // downscale so it fits localStorage and keeps the PDF light
      const scale = Math.min(1, 1400 / img.naturalWidth);
      const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      c.getContext("2d").drawImage(img, 0, 0, W, H);
      const url = c.toDataURL("image/jpeg", 0.82);
      // a freshly uploaded image has its own scale — it must NOT inherit a previous aerial's GPS
      // scale (getScale checks geoBounds first) or a manual calibration from a different image.
      calibration = null; calTemp = { a: null, b: null };
      geoBounds = null;
      if (curLevel()) { curLevel().cal = null; curLevel().geo = null; }
      setFloorPlan(url);
      toast("Floor plan added — tap where you're standing");
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
  ev.target.value = "";
}

/* ---------- aerial / satellite base map (Esri World Imagery via same-origin proxy) ---------- */
// Standard slippy-map Web Mercator, 256px tiles, n = 2^z. Returns TILE units (×256 for px).
function mercWorldX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
function mercWorldY(lat, z) {
  const r = lat * Math.PI / 180;
  return (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * Math.pow(2, z);
}
function tile2lon(xt, z) { return xt / Math.pow(2, z) * 360 - 180; }
function tile2lat(yt, z) {
  const n = Math.PI * (1 - 2 * yt / Math.pow(2, z));
  return Math.atan(Math.sinh(n)) * 180 / Math.PI;
}

let lastAerial = null;   // {lat, lon, z} — remembers the last geocoded center so zoom +/- can rebuild

// Geocode the address box, then compose the aerial around the returned point.
async function buildAerial() {
  const q = ($("aerialAddr") && $("aerialAddr").value.trim()) || "";
  if (!q) return toast("Type a property address first");
  const btn = $("btnAerial");
  const oldTxt = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.textContent = "Finding…"; }
  try {
    const d = await api("/api/geocode?q=" + encodeURIComponent(q));
    if (!d || !d.ok || d.lat == null || d.lon == null) {
      toast("Couldn't find that address — check spelling and include city, state & ZIP.");
      return;
    }
    if (d.name && $("aerialAddr")) $("aerialAddr").value = d.name;   // show the REAL matched address
    await composeAerial(d.lat, d.lon, 19);
    // Only the Census hit (and precise OSM matches) actually pin the house. If we
    // only got an area centroid, load it anyway but tell the tech to pin manually.
    if (d.precise === false) {
      toast("⚠️ Found only the area (couldn't pin the exact house) — zoom in with ＋ and tap the map to mark your spot.");
    } else {
      toast("📍 Found: " + (d.name || q));
    }
  } catch (e) {
    toast("Geocode failed — is the server running?");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = oldTxt || "🔎 Find"; }
  }
}

// Load one Esri tile through the same-origin proxy into an <img>. Resolves to the loaded
// Image, or null on failure (a missing tile just leaves a gap, never rejects the batch).
function loadTile(z, x, y) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = apiUrl("/api/tile?z=" + z + "&x=" + x + "&y=" + y);
  });
}

// Compose a tile grid CENTERED on (lat,lon) at zoom z into one canvas, set it as the level's
// image base map, and record the Web-Mercator geo-bounds so GPS fixes project onto it exactly.
// Uses a float grid origin (x0f = cx - nx/2) so the geocoded property lands dead-center.
async function composeAerial(lat, lon, z) {
  z = Math.max(1, Math.min(21, Math.round(z)));
  lastAerial = { lat, lon, z };
  toast("Loading satellite imagery…");
  const nx = 4, ny = 4;                              // composed image = 4×4 tiles (1024px)
  const cx = mercWorldX(lon, z), cy = mercWorldY(lat, z);
  const x0f = cx - nx / 2, y0f = cy - ny / 2;        // float origin → point at exact image center
  const nMax = Math.pow(2, z);

  const canvas = document.createElement("canvas");
  canvas.width = nx * 256; canvas.height = ny * 256;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#0b1020"; ctx.fillRect(0, 0, canvas.width, canvas.height); // fallback for any gap

  // fetch every integer tile touching the (fractional) window; draw at its sub-pixel offset
  const tx0 = Math.floor(x0f), ty0 = Math.floor(y0f);
  const tx1 = Math.ceil(x0f + nx) - 1, ty1 = Math.ceil(y0f + ny) - 1;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0 || tx >= nMax || ty >= nMax) continue;
      const px = (tx - x0f) * 256, py = (ty - y0f) * 256;
      jobs.push(loadTile(z, tx, ty).then((img) => { if (img) ctx.drawImage(img, px, py, 256, 256); }));
    }
  }
  await Promise.all(jobs);

  // geo-bounds of the composed image (exact tile-edge lat/lon of the float window)
  const bounds = {
    west:  tile2lon(x0f, z),
    east:  tile2lon(x0f + nx, z),
    north: tile2lat(y0f, z),
    south: tile2lat(y0f + ny, z),
    z: z,
  };
  geoBounds = bounds;
  if (curLevel()) { curLevel().geo = bounds; }

  const url = canvas.toDataURL("image/jpeg", 0.85);
  setFloorPlan(url);       // planMode='image', floorPlanUrl=url, shows planArea, survey mode
  saveLevels();            // persist geo + the new image on the level (levels serialize wholesale)
  showGpsSpotBtn();
  toast("Aerial ready — walk the property and tap “📍 Mark my GPS spot”, or tap the map");
}

// Rebuild the current aerial one zoom step wider (z−1) or closer (z+1), same center.
function zoomAerial(delta) {
  if (!lastAerial) return toast("Build an aerial from an address first");
  composeAerial(lastAerial.lat, lastAerial.lon, lastAerial.z + delta);
}

// Show/hide the "Mark my GPS spot" affordance depending on whether the level has an aerial.
function showGpsSpotBtn() { const b = $("gpsSpotBar"); if (b) b.classList.remove("hidden"); }
function hideGpsSpotBtn() { const b = $("gpsSpotBar"); if (b) b.classList.add("hidden"); }

// Forward transform: a GPS fix (or {lat,lon}) → the aerial's 0..1 relative coords.
// EXACT same projection markGpsSpot used; clamps to the image and reports `outside`.
// Requires geoBounds — returns null without it.
function gpsToMap(fix) {
  if (!geoBounds || !fix || fix.lat == null || fix.lon == null) return null;
  const z = geoBounds.z;
  const x0 = mercWorldX(geoBounds.west, z), y0 = mercWorldY(geoBounds.north, z);
  const nx = mercWorldX(geoBounds.east, z) - x0, ny = mercWorldY(geoBounds.south, z) - y0;
  let mapX = (mercWorldX(fix.lon, z) - x0) / nx;
  let mapY = (mercWorldY(fix.lat, z) - y0) / ny;
  const outside = mapX < 0 || mapX > 1 || mapY < 0 || mapY > 1;
  mapX = Math.max(0, Math.min(1, mapX));
  mapY = Math.max(0, Math.min(1, mapY));
  return { mapX, mapY, outside };
}

// Inverse transform: aerial 0..1 relative coords → {lat,lon}. Exact inverse of
// gpsToMap (round-trips to ~1e-14). Requires geoBounds — returns null without it.
// Project an image fraction back to lat/lon through a SPECIFIC level's aerial bounds. Each
// level has its own aerial, so anything walking across levels (the KML export) has to use the
// bounds belonging to the reading's own level — pushing them all through the active level's
// bounds scattered upstairs readings across the yard at coordinates nobody measured.
function mapToLatLonIn(geo, mapX, mapY) {
  if (!geo) return null;
  const z = geo.z;
  const wx = mercWorldX(geo.west, z), nx = mercWorldX(geo.east, z) - wx;
  const ny0 = mercWorldY(geo.north, z), ny = mercWorldY(geo.south, z) - ny0;
  return { lat: tile2lat(ny0 + mapY * ny, z), lon: tile2lon(wx + mapX * nx, z) };
}
function mapToLatLon(mapX, mapY) { return mapToLatLonIn(geoBounds, mapX, mapY); }

// Live "you are here" dot on the aerial. Separate #youHere element inside #mapWrap
// so renderCoverageMap()'s dotsLayer.innerHTML rebuild never wipes it. Shown only on
// the map page, with an aerial (geoBounds) and a fresh fix (age_sec <= 25).
function renderYouAreHere() {
  const dot = $("youHere");
  if (!dot) return;
  const onMap = $("page-map") && !$("page-map").classList.contains("hidden");
  const fresh = lastGpsFix && lastGpsFix.age_sec != null && lastGpsFix.age_sec <= 25;
  const m = onMap && geoBounds && fresh ? gpsToMap(lastGpsFix) : null;
  if (!m) { dot.classList.remove("show"); return; }
  dot.style.left = (m.mapX * 100).toFixed(2) + "%";
  dot.style.top = (m.mapY * 100).toFixed(2) + "%";
  dot.classList.toggle("outside", m.outside);   // dim when clamped to the edge
  dot.title = lastGpsFix.acc != null ? "You are here · ±" + Math.round(lastGpsFix.acc) + " m" : "You are here";
  dot.classList.add("show");
}

// Drop the current Wi-Fi reading at the phone's real lat/lon on the aerial.
function markGpsSpot() {
  if (!geoBounds) return toast("Build an aerial from an address first");
  if (!lastGpsFix || lastGpsFix.age_sec == null || lastGpsFix.age_sec > 25) {
    return toast("No GPS fix yet — open the GPS page & connect your phone");
  }
  if (!lastScan || !lastScan.current) return toast("No Wi-Fi signal — are you connected?");
  const m = gpsToMap(lastGpsFix);
  const outside = m.outside, mapX = m.mapX, mapY = m.mapY;
  const label = ($("easyRoom") && $("easyRoom").value.trim())
    || "Point " + (mappedPoints(points).length + 1);
  const added = addPoint(label, lastScan.current, { mapX, mapY });
  if (!added) return;
  // GPS marking is inherently GPS-located — stamp the raw coords even if the "tag readings" box is off
  if (!added.gps) { added.gps = { lat: lastGpsFix.lat, lon: lastGpsFix.lon, acc: lastGpsFix.acc }; savePoints(); }
  if ($("easyRoom")) $("easyRoom").value = "";
  renderCoverageMap();
  toast(outside ? `Placed “${label}” (outside the mapped area)` : `📍 Placed “${label}” · ${lastScan.current.signal} dBm`);
}

function setFloorPlan(url) {
  planMode = "image";
  floorPlanUrl = url;
  if (curLevel()) { curLevel().planMode = "image"; curLevel().floorPlanUrl = url; saveLevels(); }
  if ($("mapWrap")) $("mapWrap").classList.remove("schematic");
  if ($("schematicBar")) $("schematicBar").classList.add("hidden");
  floorPlanImg = new Image();
  floorPlanImg.onload = () => {
    if ($("planEmpty")) $("planEmpty").classList.add("hidden");
    if ($("planArea")) $("planArea").classList.remove("hidden");
    renderCoverageMap();
  };
  floorPlanImg.src = url;
  if ($("planImg")) { $("planImg").onload = renderCoverageMap; $("planImg").src = url; }
  setMapMode("survey");
}

function onMapTap(ev) {
  if (planMode !== "image" && planMode !== "schematic") return;
  const rect = $("mapWrap").getBoundingClientRect();
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (mapMode === "cal") {
    if (!calTemp.a || calTemp.b) { calTemp = { a: { x, y }, b: null }; setCalStep("Now tap the other end of that same distance."); }
    else { calTemp.b = { x, y }; setCalStep("done"); }
    renderCoverageMap();
    return;
  }
  if (mapMode === "predict") {
    predictAPs.push({ x, y });
    persistPredict();
    renderCoverageMap();
    toast(`Predicted AP ${predictAPs.length} placed`);
    return;
  }
  if (mapMode === "roomshape") {
    shapeVerts.push({ x, y });
    renderRooms();
    return;
  }
  if (mapMode === "perimeter") {
    perimeter.push({ x, y });
    if (curLevel()) { curLevel().perimeter = perimeter; saveLevels(); }
    renderCoverageMap();
    return;
  }
  if (mapMode === "ap") {
    const label = ($("apLabel") && $("apLabel").value.trim()) || "Router";
    apMarks.push({ x, y, label });
    if (curLevel()) { curLevel().apMarks = apMarks; saveLevels(); }
    renderCoverageMap();
    toast("Placed " + label);
    return;
  }
  if (mapMode === "edit") return; // in edit mode, taps are for arranging rooms, not placing readings
  if (!lastScan || !lastScan.current) return toast("No Wi-Fi signal — are you connected?");
  const label = $("easyRoom").value.trim() || "Point " + (mappedPoints(points).length + 1);
  if (!addPoint(label, lastScan.current, { mapX: x, mapY: y })) return;
  $("easyRoom").value = "";
  renderCoverageMap();
  toast(`Placed “${label}” · ${lastScan.current.signal} dBm`);
}

/* ---------- reusable dropdown menus (group related buttons) ---------- */
function toggleDrop(btn) {
  const menu = btn.parentElement.querySelector(".dropmenu");
  if (!menu) return;
  const show = menu.classList.contains("hidden");
  closeDrops();
  if (show) menu.classList.remove("hidden");
}
function closeDrops() { document.querySelectorAll(".dropmenu").forEach((m) => m.classList.add("hidden")); }

function toggleHeatmap() {
  showHeatmap = !showHeatmap;
  renderCoverageMap();
}
// labeled iso-signal contour lines over the heatmap — reads like a pro RF survey
function toggleContours() {
  showContours = $("contourChk") && $("contourChk").checked;
  renderCoverageMap();
}
// crisp-edges rendering for low-res / hand-drawn floor-plan images (keeps lines hard)
function togglePixelate() {
  const on = $("pixelateChk") && $("pixelateChk").checked;
  if ($("mapWrap")) $("mapWrap").classList.toggle("pixelated", !!on);
}

function undoMapPoint() {
  const mapped = mappedPoints(points);
  if (!mapped.length) return toast("No dots to undo");
  delPoint(mapped[mapped.length - 1].id);
}

// render the floor plan + heatmap + dots to a standalone image for the PDF report
function generateMapDataURL() {
  if (planMode === "schematic") return generateSchematicDataURL();
  if (!floorPlanImg || !floorPlanImg.naturalWidth) return null;
  const mapped = mappedPoints(points);
  if (!mapped.length) return null;
  const scale = Math.min(1, 1100 / floorPlanImg.naturalWidth);
  const W = Math.round(floorPlanImg.naturalWidth * scale), H = Math.round(floorPlanImg.naturalHeight * scale);
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.drawImage(floorPlanImg, 0, 0, W, H);
  ctx.save();
  heatClip(ctx, W, H, mapped);
  const gw = 220, gh = Math.max(1, Math.round((220 * H) / W));
  ctx.imageSmoothingEnabled = true;
  ctx.globalAlpha = 0.55;
  ctx.drawImage(buildHeatCanvas(mapped, gw, gh), 0, 0, W, H);
  if (showContours) drawContours(ctx, W, H, mapped);
  ctx.globalAlpha = 1;
  ctx.restore();
  drawRequirementOverlay(ctx, W, H, mapped);
  mapped.forEach((p) => {
    const x = p.mapX * W, y = p.mapY * H, rad = Math.max(5, W * 0.008);
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = pointColor(p);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    // second channel for the printed map — see the note on the live dots
    const r = rate(p.signal, p.snr);
    const initial = { exc: "E", good: "G", fair: "W", poor: "D", na: "?" }[r.cls] || "?";
    ctx.font = "800 " + Math.max(8, Math.round(rad * 1.25)) + "px sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#0b1220";
    ctx.fillText(initial, x, y + 0.5);
  });
  if (perimeter.length >= 2) { perimPath(ctx, W, H); ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 3; ctx.stroke(); }
  drawApMarks(ctx, W, H);
  return c.toDataURL("image/jpeg", 0.85);
}

/* ---------- levels (multi-floor) ---------- */
function curLevel() { return levels.find((l) => l.id === activeLevel); }
function newLevelId() { return "L" + (levels.reduce((m, l) => Math.max(m, +l.id.slice(1) || 0), 0) + 1); }
// The only persistence path for floor plans, rooms, perimeters and AP marks — a silent
// failure here loses the whole base map, which is the most expensive thing to rebuild.
function saveLevels() {
  if (!store(LS_LEVELS, JSON.stringify(levels))) return false;
  return store(LS_ACTIVELEVEL, activeLevel || "");
}
function initLevels() {
  if (!levels.length) {
    levels = [{ id: "L1", name: "Main floor", planMode: null, floorPlanUrl: null, rooms: [], perimeter: [], apMarks: [], sqft: "", snapshot: null }];
    activeLevel = "L1";
  }
  if (!activeLevel || !curLevel()) activeLevel = levels[0].id;
}
// mirror the active working state (base map) back into the current level object
function saveLevelMap() {
  const L = curLevel();
  if (!L) return;
  L.planMode = planMode;
  L.floorPlanUrl = floorPlanUrl;
  L.geo = geoBounds || L.geo || null;   // preserve aerial geo-bounds across level switches
  L.cal = calibration || L.cal || null;   // preserve the manual scale reference (uploaded plans)
  L.predictAPs = predictAPs;   // preserve predicted AP placements (design mode)
  L.surveyType = surveyType || L.surveyType || "all";   // preserve the WHAT-kind view choice
  L.rooms = rooms;
  L.perimeter = perimeter;
  L.apMarks = apMarks;
  try { const snap = generateMapDataURL(); if (snap) L.snapshot = snap; } catch (e) {}
  saveLevels();
}
// load a level's base map into the working state + reset the map UI
function applyLevelMap(L) {
  planMode = L.planMode || null;
  floorPlanUrl = L.floorPlanUrl || null;
  geoBounds = L.geo || null;   // restore aerial geo-bounds (null for schematic / uploaded-image levels)
  calibration = L.cal || null;   // restore the manual scale reference
  calTemp = { a: null, b: null };
  predictAPs = L.predictAPs || [];
  showPredict = false;
  rooms = L.rooms || [];
  perimeter = L.perimeter || [];
  apMarks = L.apMarks || [];
  floorPlanImg = null;
  $("mapWrap").classList.remove("schematic");
  $("schematicBar").classList.add("hidden");
  if ($("roomsLayer")) $("roomsLayer").innerHTML = "";
  if ($("dotsLayer")) $("dotsLayer").innerHTML = "";
  if ($("heatCanvas")) { const c = $("heatCanvas").getContext("2d"); c && c.clearRect(0, 0, $("heatCanvas").width, $("heatCanvas").height); }
  if ($("planImg")) $("planImg").removeAttribute("src");
  if (planMode === "image" && floorPlanUrl) {
    setFloorPlan(floorPlanUrl);
  } else if (planMode === "schematic") {
    $("planEmpty").classList.add("hidden");
    $("planArea").classList.remove("hidden");
    $("schematicBar").classList.remove("hidden");
    $("mapWrap").classList.add("schematic");
    setMapMode("survey");
    renderRooms();
    renderCoverageMap();
  } else {
    $("planArea").classList.add("hidden");
    $("planEmpty").classList.remove("hidden");
  }
  if (geoBounds) showGpsSpotBtn(); else hideGpsSpotBtn();
  applySurveyType(L.surveyType || "all");   // restore WHAT-kind view AFTER base mode is set, so the type default wins
}
function switchLevel(id) {
  if (id === activeLevel) return;
  saveLevelMap();
  activeLevel = id;
  applyLevelMap(curLevel());
  renderLevelTabs();
  renderPoints();
  renderCoverageMap();
  saveLevels();
}
function addLevel() {
  saveLevelMap();
  const id = newLevelId();
  levels.push({ id, name: "Floor " + (levels.length + 1), planMode: null, floorPlanUrl: null, rooms: [], perimeter: [], apMarks: [], snapshot: null });
  activeLevel = id;
  applyLevelMap(curLevel());
  editingLevel = true; // drop straight into inline rename
  renderLevelTabs();
  const inp = $("levelNameInput");
  if (inp) { inp.focus(); inp.select(); }
  renderPoints();
  renderCoverageMap();
  saveLevels();
}
function renameLevel() {
  editingLevel = true;
  renderLevelTabs();
  const inp = $("levelNameInput");
  if (inp) { inp.focus(); inp.select(); }
}
function commitLevelName(val) {
  editingLevel = false;
  const L = curLevel();
  if (L && val != null && val.trim()) L.name = val.trim();
  renderLevelTabs();
  renderPoints();
  saveLevels();
}
function cancelLevelName() { editingLevel = false; renderLevelTabs(); }
function deleteLevel() {
  if (levels.length <= 1) return toast("Keep at least one level");
  const L = curLevel();
  if (!confirm(`Delete level “${L.name}” and its readings?`)) return;
  const gone = activeLevel;
  points = points.filter((p) => p.level !== gone);
  levels = levels.filter((l) => l.id !== gone);
  activeLevel = levels[0].id;
  applyLevelMap(curLevel());
  renderLevelTabs();
  savePoints();
  renderPoints();
  renderCoverageMap();
  saveLevels();
}
function renderLevelTabs() {
  const el = $("levelTabs");
  if (!el) return;
  el.innerHTML =
    levels.map((l) => {
      if (l.id === activeLevel && editingLevel) {
        return `<input id="levelNameInput" value="${esc(l.name)}"
          style="width:150px;background:var(--surface-2);color:var(--ink);border:1px solid var(--accent);border-radius:var(--r-sm);padding:9px 12px;font-size:14px;font-weight:600;font-family:inherit"
          onkeydown="if(event.key==='Enter'){this.blur()}else if(event.key==='Escape'){cancelLevelName()}"
          onblur="commitLevelName(this.value)">`;
      }
      return `<button class="leveltab${l.id === activeLevel ? " on" : ""}" onclick="switchLevel('${l.id}')">${esc(l.name)}</button>`;
    }).join("") +
    `<button class="leveltab add" onclick="addLevel()">＋ Level</button>` +
    (!editingLevel ? `<button class="leveltab mini" onclick="renameLevel()" title="Rename this level">✎</button>` : "") +
    (levels.length > 1 && !editingLevel ? `<button class="leveltab mini" onclick="deleteLevel()" title="Delete this level">🗑</button>` : "");
}

/* ---------- schematic floor-plan editor ---------- */
const clampv = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function startSchematic() {
  planMode = "schematic";
  floorPlanImg = null;
  floorPlanUrl = null;
  if (curLevel()) { curLevel().planMode = "schematic"; curLevel().floorPlanUrl = null; saveLevels(); }
  $("planEmpty").classList.add("hidden");
  $("planArea").classList.remove("hidden");
  $("schematicBar").classList.remove("hidden");
  $("mapWrap").classList.add("schematic");
  if (!rooms.length) {
    rooms = [
      { id: 1, name: "Living room", x: 0.06, y: 0.08, w: 0.42, h: 0.4 },
      { id: 2, name: "Kitchen", x: 0.52, y: 0.08, w: 0.42, h: 0.4 },
      { id: 3, name: "Bedroom", x: 0.06, y: 0.52, w: 0.42, h: 0.4 },
      { id: 4, name: "Bath", x: 0.52, y: 0.52, w: 0.42, h: 0.4 },
    ];
    saveRooms();
  }
  setMapMode("edit");
  renderRooms();
  renderCoverageMap();
}

/* ---------- aerial address row toggle ---------- */
function toggleAerialBox() {
  const box = $("aerialBox"), hint = $("aerialHint");
  if (!box) return;
  const showing = box.classList.toggle("hidden") === false;
  if (hint) hint.classList.toggle("hidden", !showing);
  if (showing && $("aerialAddr")) {
    const addr = ($("f_address") && $("f_address").value.trim()) || "";
    if (addr && !$("aerialAddr").value) $("aerialAddr").value = addr;   // prefill from the report's Property address
    $("aerialAddr").focus();
  }
}

/* ---------- auto-layout: build a rough schematic from a room list ---------- */
function toggleAutoLayout() {
  const box = $("autoLayoutBox");
  if (!box) return;
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden") && $("autoRooms")) $("autoRooms").focus();
}
function parseRoomSpec(str) {
  const dims = str.match(/^(.*?)[\s:]*(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*$/i);
  if (dims) return { name: dims[1].trim() || "Room", w: +dims[2], h: +dims[3] };
  const area = str.match(/^(.*?)[\s:]+(\d+(?:\.\d+)?)\s*(?:sq\s?\.?\s?ft|sf)?\s*$/i);
  if (area && +area[2] > 0) { const side = Math.sqrt(+area[2]); return { name: area[1].trim() || "Room", w: side, h: side }; }
  const name = str.replace(/[\d.]+/g, "").replace(/[x×]/gi, "").trim() || "Room";
  return { name, w: 12, h: 12 };
}
function generateAutoLayout() {
  const raw = (($("autoRooms") && $("autoRooms").value) || "").trim();
  if (!raw) return toast("List some rooms first");
  const specs = raw.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 40).map(parseRoomSpec).filter(Boolean);
  if (!specs.length) return toast("Couldn't read any rooms");
  const totalArea = specs.reduce((a, s) => a + s.w * s.h, 0);
  const targetW = Math.sqrt(totalArea) * 1.2;
  specs.sort((a, b) => b.w * b.h - a.w * a.h);
  const gap = 1;
  let x = 0, y = 0, rowH = 0, maxX = 0;
  specs.forEach((s) => {
    if (x > 0 && x + s.w > targetW) { x = 0; y += rowH + gap; rowH = 0; }
    s.px = x; s.py = y; x += s.w + gap; rowH = Math.max(rowH, s.h); maxX = Math.max(maxX, x - gap);
  });
  const totalW = maxX, totalH = y + rowH;
  const m = 0.05, scale = (1 - 2 * m) / Math.max(totalW, totalH, 1);
  let id = 1;
  rooms = specs.map((s) => ({
    id: id++, name: s.name,
    x: +(m + s.px * scale).toFixed(3), y: +(m + s.py * scale).toFixed(3),
    w: +(s.w * scale).toFixed(3), h: +(s.h * scale).toFixed(3),
  }));
  planMode = "schematic";
  if (curLevel()) { curLevel().planMode = "schematic"; curLevel().floorPlanUrl = null; }
  saveRooms();
  $("planEmpty").classList.add("hidden");
  $("planArea").classList.remove("hidden");
  $("schematicBar").classList.remove("hidden");
  $("mapWrap").classList.add("schematic");
  setMapMode("edit");
  renderRooms();
  renderCoverageMap();
  saveLevels();
  toast(rooms.length + " rooms placed — drag them to match your space");
}

function resetPlan() {
  if (!confirm("Change the plan? Keeps your saved readings, but clears the current layout / photo.")) return;
  planMode = null;
  floorPlanImg = null;
  floorPlanUrl = null;
  geoBounds = null;
  calibration = null;
  calTemp = { a: null, b: null };
  rooms = [];
  perimeter = [];
  apMarks = [];
  if (curLevel()) { curLevel().planMode = null; curLevel().floorPlanUrl = null; curLevel().geo = null; curLevel().cal = null; curLevel().rooms = []; curLevel().perimeter = []; curLevel().apMarks = []; curLevel().snapshot = null; saveLevels(); }
  hideGpsSpotBtn();
  $("mapWrap").classList.remove("schematic");
  $("schematicBar").classList.add("hidden");
  $("planArea").classList.add("hidden");
  $("planEmpty").classList.remove("hidden");
  if ($("planImg")) $("planImg").removeAttribute("src");
  if ($("roomsLayer")) $("roomsLayer").innerHTML = "";
}

/* ---------- survey-type views (progressive disclosure) ---------- */
const ST_CLASSES = ["st-inhouse", "st-around", "st-property", "st-all"];
function defaultModeFor(t) { return t === "property" ? "perimeter" : "survey"; }

// Apply a survey type: set the gate class on #page-map, sync pill + card highlights,
// and (for a specific type) make sure the current mode is one this type allows.
function applySurveyType(t) {
  t = t || "all";
  surveyType = t;
  const page = $("page-map");
  if (page) { ST_CLASSES.forEach((c) => page.classList.remove(c)); page.classList.add("st-" + t); }
  document.querySelectorAll("#typeChooser .typecard").forEach((c) => c.classList.toggle("on", c.dataset.type === t));
  renderTypePill();
  const allowed = allowedModes(t);
  if (t !== "all" && !allowed.includes(mapMode)) setMapMode(defaultModeFor(t));
  else syncModeSelector();
}
// which map modes a type exposes in the selector (property keeps readings — land surveys drop points across acreage)
function allowedModes(t) {
  if (t === "inhouse") return ["survey", "edit", "perimeter", "ap"];
  if (t === "around") return ["survey", "perimeter", "ap"];
  if (t === "property") return ["survey", "perimeter"];
  return ["survey", "edit", "perimeter", "ap", "roomshape"];
}
function syncModeSelector() {
  document.querySelectorAll("#modeSelector .modeseg").forEach((s) => s.classList.toggle("on", s.dataset.mode === mapMode));
}
function selectMode(m) { setMapMode(m); }

function renderTypePill() {
  const el = $("typePill");
  if (!el) return;
  const opts = [["inhouse", "🏠 In-house"], ["around", "🏡 Around house"], ["property", "🌍 Property"], ["all", "🗺️ All tools"]];
  el.innerHTML = '<span style="font-weight:650">Survey type:</span>' +
    opts.map(([t, lbl]) => `<button class="tpbtn${t === surveyType ? " on" : ""}" onclick="chooseSurveyType('${t}')">${lbl}</button>`).join("");
}
// picked from a card (empty state) or the pill (later): persist on the level + apply the gate.
// Does NOT touch the base map or readings — purely a view/tool filter, safe mid-survey.
function chooseSurveyType(t) {
  applySurveyType(t);
  const L = curLevel();
  if (L) { L.surveyType = t; saveLevels(); }
}

function setMapMode(m) {
  if (m !== "roomshape") shapeVerts = [];
  mapMode = m;
  const wrap = $("mapWrap");
  if (wrap) { wrap.classList.toggle("mode-edit", m === "edit"); wrap.classList.toggle("mode-survey", m !== "edit"); }
  if ($("modeEditBtn")) $("modeEditBtn").classList.toggle("on", m === "edit");
  if ($("modeSurveyBtn")) $("modeSurveyBtn").classList.toggle("on", m === "survey");
  if ($("perimBar")) $("perimBar").classList.toggle("hidden", m !== "perimeter");
  if ($("apBar")) $("apBar").classList.toggle("hidden", m !== "ap");
  if ($("shapeBar")) $("shapeBar").classList.toggle("hidden", m !== "roomshape");
  if ($("calBar")) $("calBar").classList.toggle("hidden", m !== "cal");
  if ($("predictBar")) $("predictBar").classList.toggle("hidden", m !== "predict");
  if (m === "cal") setCalStep("Tap one end of a known distance on the plan (e.g. a wall you can measure).");
  if (m !== "predict" && showPredict) { showPredict = false; updatePredictUI(); }
  if ($("mapHint")) {
    $("mapHint").innerHTML = m === "edit"
      ? "<b>Arrange the rooms</b> — drag to move, grab any handle to resize, ◆ to morph a box into a custom shape (then drag corners, tap ＋ to add angles, double-click a corner to remove it), ✎ rename, ✕ delete. Then <b>Take readings</b>."
      : m === "perimeter"
      ? "<b>Tap each corner of your property / area</b> to trace the boundary — the heatmap fills only inside it. Tap <b>✓ Done</b> when closed."
      : m === "ap"
      ? "<b>Tap where the router / access point sits.</b> Name it first (Gateway, Mesh…). Tap <b>✓ Done</b> when placed."
      : m === "roomshape"
      ? "<b>Tap each corner of the room</b> to trace any shape (L-shaped, angled, round-ish…). Name it first, then tap <b>✓ Finish shape</b> when you've gone all the way around."
      : m === "cal"
      ? "<b>Set the scale:</b> tap the two ends of a distance you know in real life (a wall, a door, a car length), then type the feet. Everything after reads real square footage."
      : m === "predict"
      ? "<b>Predict coverage:</b> tap where you'd mount access points — the map models their combined coverage in real feet, so you can design placement before you ever walk it."
      : "Type the room above, then <b>tap the map where you're standing</b> to drop a reading.";
    $("mapHint").classList.toggle("hint-active", m === "perimeter" || m === "ap" || m === "roomshape" || m === "cal" || m === "predict");
  }
  if (m === "perimeter") toast("👆 Now tap each corner of your area on the map");
  else if (m === "ap") toast("👆 Now tap where the router / AP is on the map");
  else if (m === "roomshape") toast("👆 Tap the corners of the room, then Finish shape");
  updatePerimBtn();
  updateApBtn();
  updateShapeBtn();
  syncModeSelector();   // keep the integrated survey-type mode selector highlighted
  renderCoverageMap();
}
/* ---------- AP / router markers ---------- */
function toggleAP() { setMapMode(mapMode === "ap" ? "survey" : "ap"); }
function updateApBtn() {
  const b = $("btnAP");
  if (!b) return;
  b.textContent = mapMode === "ap" ? "✓ Done" : "📡 Mark router";
  b.classList.toggle("on", mapMode === "ap");
}
function undoAP() {
  apMarks.pop();
  if (curLevel()) { curLevel().apMarks = apMarks; saveLevels(); }
  renderCoverageMap();
}
function clearAPs() {
  apMarks = [];
  if (curLevel()) { curLevel().apMarks = []; saveLevels(); }
  renderCoverageMap();
}

/* ---------- scale calibration (a real-distance reference for uploaded plans) ---------- */
function toggleCalibrate() {
  if (mapMode === "cal") return cancelCalibration();
  if (geoBounds) return toast("This aerial already has real GPS scale — no calibration needed");
  if (planMode !== "image") return toast("Set scale works on an uploaded floor-plan image");
  calTemp = { a: null, b: null };
  setMapMode("cal");
}
function setCalStep(step) {
  const hint = $("calHint"), inp = $("calInputWrap");
  if (step === "done") {
    if (hint) hint.textContent = "Enter the real distance between those two points:";
    if (inp) inp.style.display = "inline-flex";
    if ($("calFeet")) $("calFeet").focus();
  } else {
    if (hint) hint.textContent = step;
    if (inp) inp.style.display = "none";
  }
}
function applyCalibration() {
  const feet = parseFloat(($("calFeet") && $("calFeet").value) || "");
  if (!(feet > 0)) return toast("Enter the real distance in feet");
  if (!calTemp.a || !calTemp.b) return toast("Tap both ends of the distance first");
  // Record the plan image's proportions with the reference line. The scale in feet depends on
  // them, and without it a level's square footage can only be worked out while that level is
  // the one on screen — which is why the report could only ever print one floor's figures.
  const imgAspect = floorPlanImg && floorPlanImg.naturalWidth
    ? floorPlanImg.naturalHeight / floorPlanImg.naturalWidth : null;
  calibration = { a: calTemp.a, b: calTemp.b, feet, imgAspect };
  if (curLevel()) { curLevel().cal = calibration; saveLevels(); }
  calTemp = { a: null, b: null };
  if ($("calFeet")) $("calFeet").value = "";
  setMapMode("survey");
  toast("Scale set — square footage now available");
}
function cancelCalibration() {
  calTemp = { a: null, b: null };
  if ($("calFeet")) $("calFeet").value = "";
  setMapMode("survey");
}
function fmtSqft(n) { return Math.round(n).toLocaleString() + " ft²"; }
// "Set scale" button visibility (uploaded-image plans only) + the live scale/area readout pill
function updateScaleUI() {
  const btn = $("btnCal"), pill = $("scalePill");
  if (btn) {
    btn.classList.toggle("hidden", !(planMode === "image" && !geoBounds));
    btn.textContent = mapMode === "cal" ? "✕ Cancel scale" : (calibration ? "📏 Redo scale" : "📏 Set scale");
    btn.classList.toggle("on", mapMode === "cal");
  }
  if (!pill) return;
  const s = getScale();
  if (!s) { pill.classList.add("hidden"); return; }
  const mapped = mappedPoints(points);
  const area = surveyedSqft(mapped), src = s.source === "gps" ? "from GPS" : "calibrated";
  pill.classList.remove("hidden");
  pill.innerHTML = area ? `📐 <b>≈ ${fmtSqft(area)}</b> surveyed <span class="muted">(${src})</span>` : `📐 Scale ${src}`;
  pill.title = `Full base map ≈ ${Math.round(s.ftW)} × ${Math.round(s.ftH)} ft`;
}

/* ---------- predictive design mode ---------- */
function togglePredict() {
  if (showPredict) { showPredict = false; setMapMode("survey"); updatePredictUI(); renderCoverageMap(); return; }
  if (!getScale()) return toast("Set the scale first (📏) so predictions come out in real feet");
  showPredict = true;
  setMapMode("predict");
  updatePredictUI();
  renderCoverageMap();
}
function setPredictEnv(v) { plExponent = PL_ENV[v] || 2.8; updatePredictUI(); renderCoverageMap(); }
function undoPredictAP() { predictAPs.pop(); persistPredict(); updatePredictUI(); renderCoverageMap(); }
function clearPredictAPs() { predictAPs = []; persistPredict(); updatePredictUI(); renderCoverageMap(); }
function persistPredict() { if (curLevel()) { curLevel().predictAPs = predictAPs; saveLevels(); } }
function updatePredictUI() {
  const btn = $("btnPredict");
  if (btn) { btn.classList.toggle("on", showPredict); btn.textContent = showPredict ? "✓ Exit predict" : "🔮 Predict coverage"; }
  if ($("predictBar")) $("predictBar").classList.toggle("hidden", !showPredict);
  const reach = $("predictReach");
  if (reach) reach.innerHTML = predictAPs.length
    ? `<b>${predictAPs.length} predicted AP${predictAPs.length > 1 ? "s" : ""}</b> · each reaches <b>≥ −67 dBm</b> to ~<b>${Math.round(predictReachFt(-67))} ft</b>, usable (−75 dBm) to ~<b>${Math.round(predictReachFt(-75))} ft</b>. Tap to add, drag not needed.`
    : `Tap the plan to drop APs. At this wall density one AP holds <b>≥ −67 dBm</b> to ~<b>${Math.round(predictReachFt(-67))} ft</b>.`;
}

/* ---------- perimeter (property boundary) ---------- */
function togglePerimeter() {
  setMapMode(mapMode === "perimeter" ? "survey" : "perimeter");
}
function updatePerimBtn() {
  const b = $("btnPerim");
  if (!b) return;
  b.textContent = mapMode === "perimeter" ? "✓ Done perimeter" : (perimeter.length ? "▱ Edit perimeter" : "▱ Draw perimeter");
  b.classList.toggle("on", mapMode === "perimeter");
}
function undoPerimeter() {
  perimeter.pop();
  if (curLevel()) { curLevel().perimeter = perimeter; saveLevels(); }
  renderCoverageMap();
}
function clearPerimeter() {
  perimeter = [];
  if (curLevel()) { curLevel().perimeter = []; saveLevels(); }
  updatePerimBtn();
  renderCoverageMap();
}

// Walk-the-lot-line: stand at a corner and push the CURRENT GPS fix as a perimeter
// vertex. Same perimeter[] + render path as tap-to-place, so it clips the heatmap and
// closes the polygon at >=3 pts exactly like manual corners.
function cornerAtGps() {
  if (!geoBounds) return toast("Build an aerial from an address first");
  if (!lastGpsFix || lastGpsFix.age_sec == null || lastGpsFix.age_sec > 25) {
    return toast("No GPS fix yet — open the GPS page & connect your phone");
  }
  const m = gpsToMap(lastGpsFix);
  perimeter.push({ x: m.mapX, y: m.mapY });
  if (curLevel()) { curLevel().perimeter = perimeter; saveLevels(); }
  updatePerimBtn();
  renderCoverageMap();
  toast(m.outside
    ? `Corner ${perimeter.length} added (outside the mapped area)`
    : `📍 Corner ${perimeter.length} added`);
}

function addRoom() {
  const id = (rooms.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  rooms.push({ id, name: "Room " + (rooms.length + 1), x: 0.36, y: 0.36, w: 0.28, h: 0.24 });
  saveRooms();
  renderRooms();
}

function renameRoom(id) {
  const room = rooms.find((r) => r.id === id);
  if (!room) return;
  const n = prompt("Room name:", room.name);
  if (n != null) { room.name = n.trim() || room.name; saveRooms(); renderRooms(); }
}

function deleteRoom(id) {
  rooms = rooms.filter((r) => r.id !== id);
  saveRooms();
  renderRooms();
}

function saveRooms() { if (curLevel()) { curLevel().rooms = rooms; saveLevels(); } }

// relative floor-area of a room (shoelace for polygons, w*h for rects)
function roomArea(r) {
  if (r.poly && r.poly.length >= 3) {
    let a = 0;
    for (let i = 0, j = r.poly.length - 1; i < r.poly.length; j = i++) a += (r.poly[j].x + r.poly[i].x) * (r.poly[j].y - r.poly[i].y);
    return Math.abs(a / 2);
  }
  return (r.w || 0) * (r.h || 0);
}
function polyCentroid(poly) {
  let x = 0, y = 0;
  poly.forEach((p) => { x += p.x; y += p.y; });
  return { x: x / poly.length, y: y / poly.length };
}
// turn a rectangular room into an editable 4-corner shape you can drag/angle into anything
function convertToShape(id) {
  const r = rooms.find((x) => x.id === id);
  if (!r || r.poly) return;
  r.poly = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
  delete r.x; delete r.y; delete r.w; delete r.h;
  saveRooms(); renderRooms();
  toast("Now drag any corner to angle it, or tap ＋ on an edge to add corners");
}
// insert a corner at the midpoint of edge i → i+1
function addPolyVertex(id, i) {
  const r = rooms.find((x) => x.id === id);
  if (!r || !r.poly) return;
  const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length];
  r.poly.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  saveRooms(); renderRooms();
}
// remove a corner (double-click a vertex), keeping at least a triangle
function deletePolyVertex(id, i) {
  const r = rooms.find((x) => x.id === id);
  if (!r || !r.poly) return;
  if (r.poly.length <= 3) return toast("A shape needs at least 3 corners");
  r.poly.splice(i, 1);
  saveRooms(); renderRooms();
}

/* ---------- polygon "shape" rooms (non-rectangular) ---------- */
function toggleShapeRoom() {
  if (mapMode === "roomshape") return finishShapeRoom();
  shapeVerts = [];
  setMapMode("roomshape");
}
function updateShapeBtn() {
  const b = $("btnShape");
  if (!b) return;
  b.textContent = mapMode === "roomshape" ? "✓ Finish shape" : "◇ Shape room";
  b.classList.toggle("on", mapMode === "roomshape");
}
function undoShapeVert() { shapeVerts.pop(); renderRooms(); }
function cancelShapeRoom() { shapeVerts = []; setMapMode("edit"); }
function finishShapeRoom() {
  if (shapeVerts.length < 3) { toast("Tap at least 3 corners to make a shape"); return; }
  const id = (rooms.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  const name = ($("shapeName") && $("shapeName").value.trim()) || "Room " + (rooms.length + 1);
  rooms.push({ id, name, poly: shapeVerts.slice() });
  if ($("shapeName")) $("shapeName").value = "";
  shapeVerts = [];
  saveRooms();
  setMapMode("edit");
  toast("Added " + name);
}

function renderRooms() {
  const layer = $("roomsLayer");
  if (!layer) return;
  if (planMode !== "schematic") { layer.innerHTML = ""; return; }
  const totalArea = rooms.reduce((s, r) => s + roomArea(r), 0) || 1;
  const sqft = parseFloat(($("f_sqft") && $("f_sqft").value) || "");
  const floorSqft = sqft > 0 ? sqft / Math.max(1, levels.length) : 0;
  const rectRooms = rooms.filter((r) => !(r.poly && r.poly.length >= 3));
  const polyRooms = rooms.filter((r) => r.poly && r.poly.length >= 3);
  // rectangular rooms — draggable / resizable divs
  let html = rectRooms
    .map((r) => {
      let sub = "";
      if (floorSqft > 0) { const est = Math.round((roomArea(r) / totalArea) * floorSqft); sub = `<div class="rsqft">~${est} sq ft</div>`; }
      const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"].map((d) => `<span class="rh rh-${d}" onpointerdown="event.stopPropagation();roomPointerDown(event,${r.id},'${d}')"></span>`).join("");
      return `<div class="room" style="left:${(r.x * 100).toFixed(1)}%;top:${(r.y * 100).toFixed(1)}%;width:${(r.w * 100).toFixed(1)}%;height:${(r.h * 100).toFixed(1)}%" onpointerdown="roomPointerDown(event,${r.id},'move')">
        <span class="redit" onpointerdown="event.stopPropagation()" onclick="renameRoom(${r.id})">✎</span>
        <span class="rmorph" onpointerdown="event.stopPropagation()" onclick="convertToShape(${r.id})" title="Morph into a custom shape — angled &amp; L-shaped rooms">◆</span>
        <span class="rdel" onpointerdown="event.stopPropagation()" onclick="deleteRoom(${r.id})">✕</span>
        <div class="rname">${esc(r.name)}</div>${sub}
        ${handles}
      </div>`;
    })
    .join("");
  // polygon rooms + the in-progress shape — one SVG overlay (0–100 coord space)
  const drawing = mapMode === "roomshape" && shapeVerts.length > 0;
  if (polyRooms.length || drawing) {
    let svg = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible">';
    polyRooms.forEach((r) => {
      const pts = r.poly.map((v) => `${(v.x * 100).toFixed(2)},${(v.y * 100).toFixed(2)}`).join(" ");
      svg += `<polygon points="${pts}" fill="rgba(79,140,255,.13)" stroke="#4f8cff" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"${mapMode !== "edit" ? ' stroke-dasharray="5 4"' : ""}/>`;
    });
    if (drawing) {
      const pts = shapeVerts.map((v) => `${(v.x * 100).toFixed(2)},${(v.y * 100).toFixed(2)}`).join(" ");
      svg += `<polyline points="${pts}" fill="rgba(56,189,248,.12)" stroke="#38bdf8" stroke-width="2.5" stroke-dasharray="5 4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
      shapeVerts.forEach((v) => { svg += `<circle cx="${(v.x * 100).toFixed(2)}" cy="${(v.y * 100).toFixed(2)}" r="4" fill="#38bdf8" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>`; });
    }
    svg += "</svg>";
    html += svg;
  }
  // labels + rename/delete controls for polygon rooms, centered on each shape
  html += polyRooms
    .map((r) => {
      const c = polyCentroid(r.poly);
      let sub = "";
      if (floorSqft > 0) { const est = Math.round((roomArea(r) / totalArea) * floorSqft); sub = `<div class="rsqft">~${est} sq ft</div>`; }
      return `<div class="proomlabel" style="left:${(c.x * 100).toFixed(1)}%;top:${(c.y * 100).toFixed(1)}%"${mapMode === "edit" ? ` onpointerdown="roomPointerDown(event,${r.id},'polymove')"` : ""}>
        <span class="rname">${esc(r.name)}</span>
        <span class="pctrls"><span class="redit" onpointerdown="event.stopPropagation()" onclick="renameRoom(${r.id})">✎</span><span class="rdel" onpointerdown="event.stopPropagation()" onclick="deleteRoom(${r.id})">✕</span></span>${sub}
      </div>`;
    })
    .join("");
  // editable vertices + edge "+" add-points for polygon rooms (arrange mode only)
  if (mapMode === "edit") {
    html += polyRooms.map((r) => r.poly.map((v, i) => {
      const nx = r.poly[(i + 1) % r.poly.length], mx = (v.x + nx.x) / 2, my = (v.y + nx.y) / 2;
      return `<span class="pvtx" style="left:${(v.x * 100).toFixed(2)}%;top:${(v.y * 100).toFixed(2)}%" onpointerdown="roomVertexDown(event,${r.id},${i})" ondblclick="deletePolyVertex(${r.id},${i})" title="Drag to reshape · double-click to remove this corner"></span>`
        + `<span class="pmid" style="left:${(mx * 100).toFixed(2)}%;top:${(my * 100).toFixed(2)}%" onpointerdown="event.stopPropagation()" onclick="addPolyVertex(${r.id},${i})" title="Add a corner here">+</span>`;
    }).join("")).join("");
  }
  layer.innerHTML = html;
}

function roomPointerDown(e, id, mode) {
  if (mapMode !== "edit") return;
  e.preventDefault();
  const room = rooms.find((r) => r.id === id);
  if (!room) return;
  const rect = $("mapWrap").getBoundingClientRect();
  dragState = { id, mode, sx: e.clientX, sy: e.clientY, rw: rect.width, rh: rect.height,
    orig: room.poly ? null : { x: room.x, y: room.y, w: room.w, h: room.h },
    origPoly: room.poly ? room.poly.map((p) => ({ x: p.x, y: p.y })) : null };
  window.addEventListener("pointermove", roomPointerMove);
  window.addEventListener("pointerup", roomPointerUp);
  window.addEventListener("pointercancel", roomPointerUp); // touch interruption -> don't leak the drag
}
// start dragging a single polygon vertex (reshape)
function roomVertexDown(e, id, i) {
  if (mapMode !== "edit") return;
  e.preventDefault(); e.stopPropagation();
  dragState = { id, mode: "vertex", vi: i };
  window.addEventListener("pointermove", roomPointerMove);
  window.addEventListener("pointerup", roomPointerUp);
  window.addEventListener("pointercancel", roomPointerUp);
}

function roomPointerMove(e) {
  if (!dragState) return;
  const room = rooms.find((r) => r.id === dragState.id);
  if (!room) return;
  if (dragState.mode === "vertex") {
    if (!room.poly) return;
    const rect = $("mapWrap").getBoundingClientRect();
    room.poly[dragState.vi] = { x: clampv((e.clientX - rect.left) / rect.width, 0, 1), y: clampv((e.clientY - rect.top) / rect.height, 0, 1) };
    renderRooms();
    return;
  }
  const dx = (e.clientX - dragState.sx) / dragState.rw;
  const dy = (e.clientY - dragState.sy) / dragState.rh;
  if (dragState.mode === "polymove") {
    const xs = dragState.origPoly.map((p) => p.x), ys = dragState.origPoly.map((p) => p.y);
    const ddx = clampv(dx, -Math.min(...xs), 1 - Math.max(...xs)), ddy = clampv(dy, -Math.min(...ys), 1 - Math.max(...ys));
    room.poly = dragState.origPoly.map((p) => ({ x: p.x + ddx, y: p.y + ddy }));
    renderRooms();
    return;
  }
  const o = dragState.orig;
  if (dragState.mode === "move") {
    room.x = clampv(o.x + dx, 0, 1 - room.w);
    room.y = clampv(o.y + dy, 0, 1 - room.h);
  } else {
    resizeRoom(room, dragState.mode, o, dx, dy);
  }
  renderRooms();
}
// resize a room from any handle direction (n/s/e/w and corners), keeping a minimum size and staying in bounds
function resizeRoom(room, dir, o, dx, dy) {
  const MIN = 0.06;
  let x = o.x, y = o.y, w = o.w, h = o.h;
  if (dir.includes("w")) { const nx = Math.max(0, Math.min(o.x + dx, o.x + o.w - MIN)); x = nx; w = o.x + o.w - nx; }
  if (dir.includes("e")) { w = Math.max(MIN, Math.min(o.w + dx, 1 - o.x)); }
  if (dir.includes("n")) { const ny = Math.max(0, Math.min(o.y + dy, o.y + o.h - MIN)); y = ny; h = o.y + o.h - ny; }
  if (dir.includes("s")) { h = Math.max(MIN, Math.min(o.h + dy, 1 - o.y)); }
  room.x = x; room.y = y; room.w = w; room.h = h;
}

function roomPointerUp() {
  window.removeEventListener("pointermove", roomPointerMove);
  window.removeEventListener("pointerup", roomPointerUp);
  window.removeEventListener("pointercancel", roomPointerUp);
  if (dragState) { dragState = null; saveRooms(); }
}

// bake the drawn schematic (rooms + labels + sqft) + heatmap + dots into an image for the PDF
function generateSchematicDataURL() {
  const mapped = mappedPoints(points);
  if (!rooms.length && !mapped.length && !apMarks.length) return null;
  const pad = 26, TH = 52, RW = 1000, RH = 750;
  const W = RW + pad * 2, H = TH + RH + pad * 2;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const totalArea = rooms.reduce((s, r) => s + roomArea(r), 0) || 1;
  const sqft = parseFloat(($("f_sqft") && $("f_sqft").value) || "");
  const floorSqft = sqft > 0 ? sqft / Math.max(1, levels.length) : 0;
  // page + title block
  ctx.fillStyle = "#f7f9fc"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#22304d"; ctx.font = "bold 21px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  ctx.fillText(((curLevel() && curLevel().name) || "Floor") + " — Floor Plan", pad, pad + TH / 2);
  if (floorSqft > 0) { ctx.textAlign = "right"; ctx.font = "14px sans-serif"; ctx.fillStyle = "#66748c"; ctx.fillText("~" + Math.round(floorSqft) + " sq ft", W - pad, pad + TH / 2); }
  // room drawing area (origin translated so relative coords map cleanly)
  const oy = pad + TH;
  ctx.save(); ctx.translate(pad, oy);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, RW, RH);
  ctx.strokeStyle = "#eef2f8"; ctx.lineWidth = 1;
  for (let x = 40; x < RW; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, RH); ctx.stroke(); }
  for (let y = 40; y < RH; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(RW, y); ctx.stroke(); }
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  rooms.forEach((r) => {
    if (r.poly && r.poly.length >= 3) {
      ctx.beginPath();
      r.poly.forEach((v, i) => { const px = v.x * RW, py = v.y * RH; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath();
      ctx.fillStyle = "#ffffff"; ctx.fill();
      ctx.strokeStyle = "#334155"; ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.stroke();
      const c = polyCentroid(r.poly);
      ctx.fillStyle = "#1e293b"; ctx.font = "bold 15px sans-serif";
      ctx.fillText(r.name, c.x * RW, c.y * RH - (floorSqft > 0 ? 8 : 0));
      if (floorSqft > 0) { ctx.fillStyle = "#8492a8"; ctx.font = "12px sans-serif"; ctx.fillText("~" + Math.round((roomArea(r) / totalArea) * floorSqft) + " sq ft", c.x * RW, c.y * RH + 10); }
      return;
    }
    const x = r.x * RW, y = r.y * RH, w = r.w * RW, h = r.h * RH;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = "#334155"; ctx.lineWidth = 3; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = "#1e293b"; ctx.font = "bold 15px sans-serif";
    ctx.fillText(r.name, x + w / 2, y + 16);
    if (floorSqft > 0) { ctx.fillStyle = "#8492a8"; ctx.font = "12px sans-serif"; ctx.fillText("~" + Math.round((roomArea(r) / totalArea) * floorSqft) + " sq ft", x + w / 2, y + 33); }
  });
  if (mapped.length) {
    ctx.save();
    heatClip(ctx, RW, RH, mapped);
    const gw = 220, gh = Math.round((220 * RH) / RW);
    ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.5;
    ctx.drawImage(buildHeatCanvas(mapped, gw, gh), 0, 0, RW, RH);
    if (showContours) drawContours(ctx, RW, RH, mapped);
    ctx.globalAlpha = 1;
    ctx.restore();
    drawRequirementOverlay(ctx, RW, RH, mapped);
  }
  mapped.forEach((p) => {
    const x = p.mapX * RW, y = p.mapY * RH;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = pointColor(p); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.stroke();
    const r = rate(p.signal, p.snr);
    ctx.font = "800 9px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#0b1220";
    ctx.fillText({ exc: "E", good: "G", fair: "W", poor: "D", na: "?" }[r.cls] || "?", x, y + 0.5);
  });
  if (perimeter.length >= 2) { perimPath(ctx, RW, RH); ctx.strokeStyle = "#2563eb"; ctx.lineWidth = 3; ctx.stroke(); }
  drawApMarks(ctx, RW, RH);
  ctx.restore();
  ctx.strokeStyle = "#c7d0e0"; ctx.lineWidth = 1.5; ctx.strokeRect(pad, oy, RW, RH);
  return c.toDataURL("image/jpeg", 0.92);
}

/* ---------- phone GPS bridge ---------- */
// The connection poll runs whenever the GPS page is visible (see showPage()),
// independent of the "tag readings" checkbox. The checkbox only decides whether
// a fix gets stamped onto saved points.
function toggleGps() {
  gpsEnabled = $("gpsEnable").checked;
}

// Paint the big 3-state badge from a /api/gps/latest fix (or null / offline).
function setGpsBadge(state, main, sub) {
  const b = $("gpsBadge");
  if (!b) return;
  b.className = "gpsbadge " + state;                 // wait | ok | stale
  const icon = state === "ok" ? "✅" : state === "stale" ? "⚠️" : "📡";
  $("gpsBadgeIcon").textContent = icon;
  $("gpsBadgeText").textContent = main;
  $("gpsBadgeSub").textContent = sub || "";
}

async function loadGpsConfig() {
  try {
    const d = await api("/api/gps/config");
    if (d.ok) {
      if ($("gpsUrl")) $("gpsUrl").textContent = d.gpslogger_url;      // Android / GPSLogger
      if ($("gpsUrlBase")) $("gpsUrlBase").textContent = d.owntracks_url; // iPhone / OwnTracks
    }
  } catch (e) {}
}

// One fetch of the latest fix; updates lastGpsFix + the badge. Returns the fix or null.
async function refreshGps() {
  try {
    const d = await api("/api/gps/latest");
    if (d.ok && d.fix) {
      lastGpsFix = d.fix;
      const acc = d.fix.acc != null ? "±" + Math.round(d.fix.acc) + " m" : "accuracy unknown";
      const age = Math.round(d.fix.age_sec);
      if (d.fix.age_sec > 20) {
        setGpsBadge("stale", `Last fix ${age}s ago (stale)`, "Is the phone app still running & broadcasting?");
      } else {
        setGpsBadge("ok", `Connected — ${acc}, updated ${age}s ago`,
          `Phone at ${d.fix.lat.toFixed(5)}, ${d.fix.lon.toFixed(5)}`);
      }
      renderYouAreHere(); // move the live "you are here" dot as they walk
      return d.fix;
    }
    lastGpsFix = null;
    setGpsBadge("wait", "Waiting for your phone…", "Set up your phone below, then keep this page open.");
    renderYouAreHere();
    return null;
  } catch (e) {
    lastGpsFix = null;
    setGpsBadge("wait", "Backend offline", "Is the survey server still running?");
    renderYouAreHere();
    return null;
  }
}

// Start/stop the lightweight 3s poll. Called by showPage() when the GPS page shows/hides.
function startGpsPoll() {
  loadGpsConfig();
  refreshGps();
  if (!gpsTimer) gpsTimer = setInterval(refreshGps, 3000);
}
function stopGpsPoll() {
  if (gpsTimer) clearInterval(gpsTimer);
  gpsTimer = null;
}

// "Check now" button — force an immediate fetch and report via badge + toast.
async function checkGpsNow() {
  const fix = await refreshGps();
  if (fix && fix.age_sec <= 20) {
    const acc = fix.acc != null ? "±" + Math.round(fix.acc) + " m" : "accuracy unknown";
    toast(`✅ Phone connected — ${acc}, ${Math.round(fix.age_sec)}s ago`);
  } else if (fix) {
    toast(`⚠️ Last fix ${Math.round(fix.age_sec)}s ago — is the phone app running?`);
  } else {
    toast("No fix yet — open the GPS app on your phone and start broadcasting.");
  }
}

// Copy a URL <span> to the clipboard with a graceful fallback.
function copyGpsUrl(id) {
  const el = $(id);
  if (!el) return;
  const text = el.textContent;
  const done = () => toast("URL copied — paste it into your phone's GPS app");
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch (e) {
    toast("Couldn't copy — select the URL and copy it manually.");
  }
}

/* ---------- survey profiles (named survey snapshots) ---------------------------
   INVARIANT: the individual working keys (LS_POINTS/LS_LEVELS/LS_CELLPTS/…) ALWAYS
   hold the ACTIVE profile's live data. A profile bundle (PROFILE_PREFIX+id) is a
   stored snapshot: authoritative for non-active profiles, refreshed whenever we
   snapshot the active one. On boot the active profile is whatever the working keys
   already contain (see loadProfiles migration). ~5MB quota: every bundle setItem is
   guarded; a quota failure toasts but never touches the live working state. */

function saveProfilesRegistry() {
  try { localStorage.setItem(LS_PROFILES, JSON.stringify(profiles)); localStorage.setItem(LS_ACTIVEPROFILE, activeProfile || ""); }
  catch (e) { toast("Couldn't save profile list — storage full"); }
}

// Gather the CURRENT in-memory + field state into one self-contained bundle.
function profileBundle() {
  saveLevelMap();
  const site = {};
  SITE_FIELDS.forEach((f) => (site[f] = $(f) ? $(f).value : ""));
  return {
    site, points, levels, activeLevel, cellPoints, importedScan, reportPhotos,
    heatmap: heatmapDataUrl, siteplan: sitePlan, surveyEnv,
  };
}

// Write the active profile's live state into its stored bundle + refresh its registry entry.
// Quota-safe: on failure warn and bail WITHOUT throwing (working keys stay intact).
function snapshotActiveProfile() {
  if (!activeProfile) return;
  let ok = true;
  try { localStorage.setItem(PROFILE_PREFIX + activeProfile, JSON.stringify(profileBundle())); }
  catch (e) { ok = false; toast("Storage full — this survey isn't fully saved to its slot"); }
  const entry = profiles.find((p) => p.id === activeProfile);
  if (entry) {
    const client = ($("f_client") && $("f_client").value.trim()) || "";
    if (client && isDefaultProfileName(entry.name)) entry.name = client;  // auto-name from client, but keep a manual rename
    else if (!entry.name) entry.name = "Untitled survey";
    entry.updated = Date.now();
  }
  if (ok) saveProfilesRegistry();
}

// A default (auto-generated) name may be replaced by the client name; a manual rename is kept.
function isDefaultProfileName(n) { return !n || /^Survey \d+$/.test(n) || n === "Untitled survey"; }

// Keep the active profile's label in sync with the client name (unless manually renamed).
function syncActiveName() {
  const entry = profiles.find((p) => p.id === activeProfile);
  if (!entry) return;
  const client = ($("f_client") && $("f_client").value.trim()) || "";
  if (client && isDefaultProfileName(entry.name) && entry.name !== client) { entry.name = client; saveProfilesRegistry(); renderProfileMenu(); }
}

function readBundle(id) {
  try { return JSON.parse(localStorage.getItem(PROFILE_PREFIX + id)) || null; } catch (e) { return null; }
}
function emptyBundle() {
  return { site: {}, points: [], levels: [], activeLevel: null, cellPoints: [], importedScan: [], reportPhotos: [], heatmap: null, siteplan: emptySitePlan(), surveyEnv: null };
}

// Load a bundle into the working keys + memory + UI. Follows importJSON's no-listener
// restore pattern EXACTLY — it must NOT re-add the SITE_FIELDS input listeners
// (those are added once in loadState; re-adding would double-fire saveSite).
function restoreProfileBundle(b) {
  b = b || emptyBundle();
  points = Array.isArray(b.points) ? b.points : [];
  cellPoints = Array.isArray(b.cellPoints) ? b.cellPoints : [];
  importedScan = Array.isArray(b.importedScan) ? b.importedScan : [];
  reportPhotos = Array.isArray(b.reportPhotos) ? b.reportPhotos : [];
  heatmapDataUrl = b.heatmap || null;
  surveyEnv = (b.surveyEnv && b.surveyEnv.current) ? b.surveyEnv : null;
  sitePlan = (b.siteplan && b.siteplan.yard) ? b.siteplan : emptySitePlan();
  saveSitePlan();
  levels = (b.levels && b.levels.length) ? b.levels
    : [{ id: "L1", name: "Main floor", planMode: null, floorPlanUrl: null, rooms: [], perimeter: [], apMarks: [], sqft: "", snapshot: null }];
  activeLevel = b.activeLevel || levels[0].id;

  // persist into the working keys via the existing save fns (each is quota-guarded)
  savePoints();
  saveCellPoints();
  savePhotos();
  saveLevels();
  try { if (heatmapDataUrl) localStorage.setItem(LS_HEATMAP, heatmapDataUrl); else localStorage.removeItem(LS_HEATMAP); } catch (e) {}
  try { localStorage.setItem(LS_IMPORTEDSCAN, JSON.stringify(importedScan)); } catch (e) {}
  try { if (surveyEnv) localStorage.setItem(LS_SURVEYENV, JSON.stringify(surveyEnv)); else localStorage.removeItem(LS_SURVEYENV); } catch (e) {}

  // site fields + their working key
  const s = b.site || {};
  SITE_FIELDS.forEach((f) => { if ($(f)) $(f).value = s[f] != null ? s[f] : ""; });
  saveSite();

  // rebuild map + UI (same calls importJSON/loadState make)
  initLevels();
  applyLevelMap(curLevel());
  renderLevelTabs();
  renderPoints();
  renderCellSpots();
  renderHeatmapThumb();
  renderReportPhotos();
  renderCoverageMap();
  renderReportInsights();
}

function switchProfile(id) {
  if (id === activeProfile) { toggleProfileMenu(true); return; }
  if (!profiles.some((p) => p.id === id)) return;
  snapshotActiveProfile();
  activeProfile = id;
  restoreProfileBundle(readBundle(id));
  saveProfilesRegistry();
  renderProfileMenu();
  toggleProfileMenu(true);
  const e = profiles.find((p) => p.id === id);
  toast("Switched to " + (e ? e.name : "survey"));
}

function newProfile() {
  snapshotActiveProfile();
  const id = "P" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
  const name = "Survey " + (profiles.length + 1);
  profiles.push({ id, name, updated: Date.now() });
  activeProfile = id;
  restoreProfileBundle(emptyBundle());      // reset the app to a clean survey
  try { localStorage.setItem(PROFILE_PREFIX + id, JSON.stringify(emptyBundle())); }
  catch (e) { toast("Storage full — couldn't reserve the new survey slot"); }
  saveProfilesRegistry();
  renderProfileMenu();
  toggleProfileMenu(true);
  showPage("live");
  toast("Started " + name);
}

function renameProfile(id) {
  const entry = profiles.find((p) => p.id === id);
  if (!entry) return;
  const nm = prompt("Rename this survey:", entry.name || "");
  if (nm == null) return;
  const t = nm.trim();
  if (!t) return;
  entry.name = t;                            // name is independent of f_client
  entry.updated = Date.now();
  saveProfilesRegistry();
  renderProfileMenu();
}

function deleteProfile(id) {
  const entry = profiles.find((p) => p.id === id);
  if (!entry) return;
  if (!confirm('Delete "' + (entry.name || "this survey") + '"? This permanently removes that survey and its readings.')) return;
  try { localStorage.removeItem(PROFILE_PREFIX + id); } catch (e) {}
  profiles = profiles.filter((p) => p.id !== id);
  if (id === activeProfile) {
    if (profiles.length) {
      activeProfile = profiles[0].id;
      restoreProfileBundle(readBundle(activeProfile));
    } else {
      // nothing left — mint a fresh clean one
      const nid = "P" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
      profiles.push({ id: nid, name: "Survey 1", updated: Date.now() });
      activeProfile = nid;
      restoreProfileBundle(emptyBundle());
      try { localStorage.setItem(PROFILE_PREFIX + nid, JSON.stringify(emptyBundle())); } catch (e) {}
    }
  }
  saveProfilesRegistry();
  renderProfileMenu();
}

// Called at boot BEFORE loadState. Reads the registry; if none exists, adopts the
// EXISTING working keys as "Survey 1" (data is NOT moved or cleared — it already is
// this profile's data). Never loses pre-existing user data.
function loadProfiles() {
  try { profiles = JSON.parse(localStorage.getItem(LS_PROFILES)) || []; } catch (e) { profiles = []; }
  try { activeProfile = localStorage.getItem(LS_ACTIVEPROFILE) || null; } catch (e) { activeProfile = null; }
  if (!profiles.length) {
    let name = "Survey 1";
    try { const s = JSON.parse(localStorage.getItem(LS_SITE)) || {}; if (s.f_client && s.f_client.trim()) name = s.f_client.trim(); } catch (e) {}
    const id = "P" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
    profiles = [{ id, name, updated: Date.now() }];
    activeProfile = id;
    saveProfilesRegistry();
  } else if (!activeProfile || !profiles.some((p) => p.id === activeProfile)) {
    activeProfile = profiles[0].id;
    saveProfilesRegistry();
  }
}

/* ---------- profile switcher UI ---------- */
function renderProfileMenu() {
  const nameBtn = $("profName");
  if (nameBtn) {
    const e = profiles.find((p) => p.id === activeProfile);
    nameBtn.innerHTML = "🗂 " + esc(e ? e.name : "Survey") + " ▾";
  }
  const list = $("profList");
  if (!list) return;
  list.innerHTML = profiles.map((p) => {
    const on = p.id === activeProfile ? " on" : "";
    return `<div class="profitem${on}">
      <button class="profpick" onclick="switchProfile('${p.id}')" title="Switch to this survey">${esc(p.name)}</button>
      <button class="profedit" onclick="event.stopPropagation();renameProfile('${p.id}')" title="Rename">✎</button>
      <button class="profdel" onclick="event.stopPropagation();deleteProfile('${p.id}')" title="Delete">✕</button>
    </div>`;
  }).join("");
}

// force=true forces the menu closed (used after an action). Otherwise it toggles.
function toggleProfileMenu(force) {
  const m = $("profMenu");
  if (!m) return;
  if (force === true) { m.classList.add("hidden"); return; }
  m.classList.toggle("hidden");
}

// close the dropdown when clicking anywhere outside it
document.addEventListener("click", (e) => {
  const m = $("profMenu");
  if (!m || m.classList.contains("hidden")) return;
  if (e.target.closest && e.target.closest("#profSwitcher")) return;
  m.classList.add("hidden");
});

/* ---------- persistence ---------- */
function savePoints() { return store(LS_POINTS, JSON.stringify(points)); }
function saveSite() {
  const s = {};
  SITE_FIELDS.forEach((f) => (s[f] = $(f).value));
  return store(LS_SITE, JSON.stringify(s));
}
function loadState() {
  try { points = JSON.parse(localStorage.getItem(LS_POINTS)) || []; } catch (e) { points = []; }
  try {
    const s = JSON.parse(localStorage.getItem(LS_SITE)) || {};
    SITE_FIELDS.forEach((f) => { if (s[f] && $(f)) $(f).value = s[f]; });
  } catch (e) {}
  try {
    const cc = JSON.parse(localStorage.getItem(LS_CELL)) || {};
    if (cc.ip) $("cellIp").value = cc.ip;
    if (cc.pass) $("cellPass").value = cc.pass;
  } catch (e) {}
  try { cellPoints = JSON.parse(localStorage.getItem(LS_CELLPTS)) || []; } catch (e) { cellPoints = []; }
  try { heatmapDataUrl = localStorage.getItem(LS_HEATMAP) || null; } catch (e) {}
  try { reportPhotos = JSON.parse(localStorage.getItem(LS_PHOTOS)) || []; } catch (e) { reportPhotos = []; }
  try { importedScan = JSON.parse(localStorage.getItem(LS_IMPORTEDSCAN)) || []; } catch (e) { importedScan = []; }
  try { const sp = JSON.parse(localStorage.getItem(LS_SITEPLAN)); sitePlan = sp && sp.yard ? sp : emptySitePlan(); } catch (e) { sitePlan = emptySitePlan(); }
  try { const se = JSON.parse(localStorage.getItem(LS_SURVEYENV)); surveyEnv = se && se.current ? se : null; } catch (e) { surveyEnv = null; }
  try { levels = JSON.parse(localStorage.getItem(LS_LEVELS)) || []; } catch (e) { levels = []; }
  try { activeLevel = localStorage.getItem(LS_ACTIVELEVEL) || null; } catch (e) {}
  initLevels();
  points.forEach((p) => { if (!p.level) p.level = activeLevel; });
  applyLevelMap(curLevel());
  renderLevelTabs();
  SITE_FIELDS.forEach((f) => $(f) && $(f).addEventListener("input", saveSite));
  renderPoints();
  renderCellSpots();
  renderHeatmapThumb();
  renderReportPhotos();
  renderCoverageMap();
}

// The master copy. Uses profileBundle() so the file holds everything the app holds —
// exporting a subset here is how the Site Plan and the active level used to vanish on reimport.
function exportJSON() {
  const bundle = profileBundle();
  if (!bundle.points.length && !bundle.cellPoints.length) return toast("Nothing to save yet — take some readings first.");
  const blob = new Blob([JSON.stringify({ format: "wifi-survey", version: 1, ...bundle }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wifi-survey-" + (($("f_client") && $("f_client").value) || "site").replace(/\W+/g, "_") + ".json";
  a.click();
  toast(`Survey file saved — ${bundle.points.length} readings, re-open it here any time`);
}

// Export every reading as a plain CSV — the format clients actually open (Excel/Numbers/Sheets).
// One row per reading with room/floor attribution, all RF metrics, throughput and GPS.
function exportCSV() {
  saveLevelMap();
  if (!points.length) return toast("No readings yet — take some on the Coverage page first.");
  const q = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const cols = ["#", "Room", "Floor", "Point", "SSID", "Band", "Channel", "Width", "RSSI (dBm)", "Noise", "SNR (dB)", "PHY", "Rate (Mbps)", "Down (Mbps)", "Up (Mbps)", "Latency (ms)", "Loss %", "Security", "Rating", "GPS lat", "GPS lon", "GPS +/-m"];
  const rows = points.map((p, i) => {
    const r = rate(p.signal, p.snr);
    const floor = (levels.find((l) => l.id === p.level) || {}).name || "";
    return [
      i + 1, roomOf(p), floor, p.location, p.ssid, p.band, p.channel, p.width,
      p.signal, p.noise, p.snr, p.phy_friendly || p.phy, p.rate,
      p.download_mbps, p.upload_mbps, p.ping_avg_ms, p.ping_loss_pct, p.security, r.label,
      p.gps ? p.gps.lat : "", p.gps ? p.gps.lon : "", p.gps && p.gps.acc != null ? Math.round(p.gps.acc) : "",
    ].map(q).join(",");
  });
  const blob = new Blob([cols.join(",") + "\n" + rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wifi-survey-" + (($("f_client") && $("f_client").value) || "site").replace(/\W+/g, "_") + ".csv";
  a.click();
  toast("CSV saved — opens in Excel / Numbers / Sheets");
}

// Export readings + perimeter + AP markers to a KML file that opens directly in
// Google Earth Pro or Google Maps — no Google Earth needed to view, but it's there
// if they want it. Readings use their real GPS coords when present, else the aerial
// inverse transform. Needs an aerial (geoBounds) or at least one GPS-tagged point.
function exportKML() {
  saveLevelMap();
  const hasGps = points.some((p) => p.gps && p.gps.lat != null);
  const anyGeo = levels.some((l) => l.geo);
  if (!anyGeo && !hasGps) {
    return toast("KML needs an aerial (Aerial from address) or GPS-tagged readings first.");
  }
  const geoOf = (levelId) => {
    const l = levels.find((L) => L.id === levelId);
    return (l && l.geo) || null;
  };
  const x = (s) => esc(s); // esc() already escapes & < > "
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
  const client = ($("f_client") && $("f_client").value.trim()) || "WiFi Survey";
  parts.push(`<name>${x(client)} — WiFi Survey</name>`);

  // reading placemarks (real GPS first, else aerial inverse) across ALL levels' mapped points
  points.forEach((p) => {
    let lat = null, lon = null;
    if (p.gps && p.gps.lat != null && p.gps.lon != null) { lat = p.gps.lat; lon = p.gps.lon; }
    else if (p.mapX != null && p.mapY != null) {
      // through the reading's OWN level's aerial, not whichever one happens to be open
      const ll = mapToLatLonIn(geoOf(p.level), p.mapX, p.mapY);
      if (ll) { lat = ll.lat; lon = ll.lon; }
    }
    if (lat == null || lon == null) return;
    const r = rate(p.signal, p.snr);
    const desc = `${p.signal != null ? p.signal + " dBm" : "no signal"} · ${r.word}`
      + (p.ssid ? " · " + p.ssid : "") + (p.snr != null ? " · SNR " + p.snr : "");
    parts.push(
      `<Placemark><name>${x(p.location || "Reading")}</name>` +
      `<description>${x(desc)}</description>` +
      `<Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`
    );
  });

  // AP / router markers (aerial-relative → lat/lon)
  if (geoBounds) {
    apMarks.forEach((a) => {
      const ll = mapToLatLon(a.x, a.y);
      parts.push(
        `<Placemark><name>${x(a.label || "Router")}</name>` +
        `<description>Router / access point</description>` +
        `<Point><coordinates>${ll.lon},${ll.lat},0</coordinates></Point></Placemark>`
      );
    });
  }

  // perimeter boundary as a LineString (closed ring when >=3 corners)
  if (geoBounds && perimeter.length >= 2) {
    const coords = perimeter.map((pt) => { const ll = mapToLatLon(pt.x, pt.y); return `${ll.lon},${ll.lat},0`; });
    if (perimeter.length >= 3) coords.push(coords[0]); // close the ring
    parts.push(
      '<Placemark><name>Property boundary</name>' +
      '<Style><LineStyle><color>fff8bd38</color><width>3</width></LineStyle></Style>' +
      `<LineString><tessellate>1</tessellate><coordinates>${coords.join(" ")}</coordinates></LineString></Placemark>`
    );
  }

  parts.push('</Document></kml>');
  const blob = new Blob([parts.join("\n")], { type: "application/vnd.google-earth.kml+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (client || "site").replace(/\W+/g, "_") + ".kml";
  a.click();
  toast("KML saved — open it in Google Earth Pro or Google Maps");
}
// Opening a file REPLACES the survey on screen, so it has to ask first — the neutral-looking
// button was the one destructive action in the app with no confirm.
function importJSON(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    let d;
    try { d = JSON.parse(r.result); } catch (e) { return warn("Import failed — that isn't a survey file."); }
    if (!d || typeof d !== "object" || (!Array.isArray(d.points) && !Array.isArray(d.levels))) {
      return warn("Import failed — that file has no survey data in it.");
    }
    const live = points.length + cellPoints.length;
    if (live && !confirm(
      `Open this survey file?\n\nIt replaces what's on screen now — ${points.length} readings and ${cellPoints.length} candidate spots.\n\n` +
      `Cancel and use “Save survey file” first if you haven't backed this one up.`
    )) return;
    restoreProfileBundle(d);
    // Readings written before levels existed carry no level — adopt the active one so they
    // appear on the map instead of only in the list.
    points.forEach((p) => { if (!p.level) p.level = activeLevel; });
    savePoints();
    renderPoints();
    renderCoverageMap();
    toast(`Opened — ${points.length} readings`);
  };
  r.readAsText(file);
  ev.target.value = "";
}

/* ---------- report ---------- */
function stripTags(s) { return String(s).replace(/<[^>]+>/g, ""); }

// which labeled room a reading falls inside (rect or polygon), else its own label
function roomOf(p) {
  if (p.mapX == null) return p.location;
  const lv = levels.find((l) => l.id === p.level);
  const rms = (lv && lv.rooms) || [];
  for (const r of rms) {
    if (r.poly && r.poly.length >= 3) { if (pointInPoly(p.mapX, p.mapY, r.poly)) return r.name; }
    else if (p.mapX >= r.x && p.mapX <= r.x + r.w && p.mapY >= r.y && p.mapY <= r.y + r.h) return r.name;
  }
  return p.location;
}
function distinctRooms(pts) { return new Set(pts.map(roomOf)).size; }
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > y) !== (poly[j].y > y) && x < (poly[j].x - poly[i].x) * (y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x) inside = !inside;
  }
  return inside;
}

/* ---------- findings engine (local, rule-based) ---------- */
// `env` is the Wi-Fi environment recorded WHEN THE SURVEY WAS WALKED. It must be passed in
// rather than read from lastScan: lastScan is refreshed every 5 seconds from whatever network
// this Mac is on right now, so regenerating a saved survey from the office used to describe
// the office's network in the client's report. Falls back to live only when a survey predates
// this field, and buildReport says which of the two it used.
function computeInsights(pts, site, env) {
  const scanEnv = env && env.current ? env : (lastScan && lastScan.current ? lastScan : null);
  const F = [];
  const plan = parseFloat(site.f_plan) || null;
  const sig = pts.filter((p) => p.signal != null);
  const dead = sig.filter((p) => p.signal < -75);
  const marg = sig.filter((p) => p.signal >= -75 && p.signal < -67);
  const lowSnr = pts.filter((p) => p.snr != null && p.snr < 15 && p.signal != null && p.signal >= -75);
  const thr = pts.filter((p) => p.download_mbps != null);
  const nm = (arr) => arr.map((p) => esc(p.location)).join(", ");
  const locOf = (p) => (p && p.mapX != null ? { x: p.mapX, y: p.mapY, level: p.level } : null);

  const subs = [];
  const covScore = (s) => s >= -55 ? 100 : s >= -67 ? 75 + (s + 67) / 12 * 25 : s >= -75 ? 40 + (s + 75) / 8 * 35 : s >= -85 ? 10 + (s + 85) / 10 * 30 : 5;
  if (sig.length) {
    const arr = sig.map((p) => covScore(p.signal)).sort((a, b) => a - b);
    subs.push({ name: "Coverage", val: Math.round(arr[Math.floor((arr.length - 1) * 0.25)]), w: 0.4 });
  }
  const snrPts = pts.filter((p) => p.snr != null);
  if (snrPts.length) {
    const snrScore = (n) => n >= 25 ? 100 : n >= 15 ? 60 + (n - 15) / 10 * 40 : n >= 5 ? 20 + (n - 5) / 10 * 40 : 10;
    subs.push({ name: "Reliability", val: Math.round(snrPts.reduce((a, p) => a + snrScore(p.snr), 0) / snrPts.length), w: 0.2 });
  }
  if (plan && thr.length) {
    const t = (dl) => { const r = Math.min(1, dl / plan); return r >= 0.9 ? 100 : r >= 0.5 ? 60 + (r - 0.5) / 0.4 * 40 : r >= 0.25 ? 30 + (r - 0.25) / 0.25 * 30 : 15; };
    subs.push({ name: "Throughput", val: Math.round(thr.reduce((a, p) => a + t(p.download_mbps), 0) / thr.length), w: 0.2 });
  }
  let intf = 100;
  const co = (scanEnv && scanEnv.current && scanEnv.nearby) ? scanEnv.nearby.filter((n) => n.channel === scanEnv.current.channel && n.ssid !== scanEnv.current.ssid) : [];
  if (co.length > 1) intf -= Math.min(40, (co.length - 1) * 8);
  const bandPts = pts.filter((p) => p.band);
  const all24 = bandPts.length >= 2 && bandPts.every((p) => (p.band || "").indexOf("2") === 0);
  const has5 = scanEnv && scanEnv.nearby && scanEnv.nearby.some((n) => (n.band || "").indexOf("5") === 0);
  if (all24 && has5) intf -= 15;
  intf = Math.max(0, intf);
  if (bandPts.length || co.length) subs.push({ name: "Interference", val: Math.round(intf), w: 0.1 });
  let bestSinr = null;
  if (cellPoints.length) {
    const b = bestCellSpot();
    bestSinr = b.nr_sinr != null ? b.nr_sinr : b.lte_sinr;
    const cS = bestSinr == null ? null : bestSinr >= 20 ? 100 : bestSinr >= 13 ? 75 + (bestSinr - 13) / 7 * 25 : bestSinr >= 0 ? 35 + bestSinr / 13 * 40 : 15;
    if (cS != null) subs.push({ name: "Cellular WAN", val: Math.round(cS), w: 0.1 });
  }
  let score = 60;
  if (subs.length) { const tw = subs.reduce((a, s) => a + s.w, 0); score = Math.round(subs.reduce((a, s) => a + s.w * s.val, 0) / tw); }
  if (dead.length) score = Math.min(score, 69);
  if ((sig.length && dead.length / sig.length >= 0.25) || (cellPoints.length && bestSinr != null && bestSinr < 0)) score = Math.min(score, 49);
  const grade = score >= 90 ? ["Excellent"] : score >= 75 ? ["Good"] : score >= 60 ? ["Fair"] : score >= 40 ? ["Poor"] : ["Critical"];

  if (pts.length >= 1 && pts.length < 4) F.push({ severity: "info", text: `Only ${pts.length} reading${pts.length > 1 ? "s" : ""} captured — conclusions are provisional until more rooms are sampled.`, rec: "Aim for about one reading per 400–500 sq ft plus the corners farthest from the router." });
  // Area has to be measured over the readings that actually sit on the map — `sig` includes
  // Live-page readings with no position (x/y NaN) and readings from other floors, which drove
  // this figure to 0 and silently dropped the sentence while the dashboard still showed a count.
  if (dead.length) { const w = dead.reduce((a, b) => (b.signal < a.signal ? b : a)); const holeFt = holeAreaSqft(-75, mappedPoints(pts)); const areaTxt = holeFt ? ` About <b>${fmtSqft(holeFt)}</b> of the surveyed area falls below −75 dBm.` : ""; F.push({ severity: "critical", text: `<b>${dead.length} dead zone${dead.length > 1 ? "s" : ""}</b> below −75 dBm: ${nm(dead)}.${areaTxt} The worst is ${esc(w.location)} at ${w.signal} dBm — Wi-Fi calls drop and smart devices fall offline here.`, rec: `Add a mesh node or wired access point roughly midway between the router and ${esc(w.location)}. A wired-backhaul node beats a repeater since the feeding signal is already ${w.signal} dBm. Re-measure to confirm the far rooms clear −67 dBm.`, loc: locOf(w) }); }
  if (marg.length) { const wm = marg.reduce((a, b) => (b.signal < a.signal ? b : a)); F.push({ severity: "warning", text: `${marg.length} marginal location${marg.length > 1 ? "s" : ""} (−68 to −75 dBm): ${nm(marg)}. Fine for browsing, borderline for 4K, video calls, and gaming when busy.`, rec: dead.length ? "Position any new access point so it overlaps both the dead zones and these rooms." : "Relocate the gateway higher and more central first; add one AP only if these rooms are heavily used.", loc: locOf(wm) }); }
  if (lowSnr.length) { const w = lowSnr.reduce((a, b) => (b.snr < a.snr ? b : a)); F.push({ severity: "warning", text: `${lowSnr.length} location${lowSnr.length > 1 ? "s" : ""} show strong signal but noisy air (SNR under 15 dB): ${nm(lowSnr)}. Lowest is ${esc(w.location)} at SNR ${w.snr} dB — bars look fine but throughput suffers.`, rec: "This is interference, not distance — adding an AP won't help. Move the gateway to a cleaner channel (2.4 GHz: stick to 1/6/11).", loc: locOf(w) }); }
  if (co.length >= 2) { const top = co.slice(0, 3).map((n) => esc(n.ssid || "(hidden)")).join(", "); F.push({ severity: "warning", text: `Channel ${scanEnv.current.channel} (${scanEnv.current.band || "?"}) is crowded — ${co.length} neighboring networks share it${top ? ", including " + top : ""}. Co-channel networks split airtime even at full signal.`, rec: "Change the gateway's channel to a quieter one (2.4 GHz: least-busy of 1/6/11) or enable auto-channel. Keep 2.4 GHz at 20 MHz width." }); }
  if (all24 && has5) F.push({ severity: "warning", text: "Every surveyed room connected on 2.4 GHz even though 5 GHz is available nearby — the client is stuck on the slower, congested band, capping speeds regardless of signal.", rec: "Enable band steering (single SSID, router picks the band) or manually join 5 GHz near the router. Keep 2.4 GHz for far rooms and IoT." });
  if (scanEnv && scanEnv.current) {
    const sg = secGrade(scanEnv.current.security), nm2 = esc(scanEnv.current.ssid || "the client network");
    if (sg.g === "open") F.push({ severity: "critical", text: `The client network “${nm2}” is <b>open (no encryption)</b> — anyone in range can read traffic and join.`, rec: "Enable WPA3 (or WPA2 at minimum) on the gateway before handoff." });
    else if (sg.g === "wep" || sg.g === "wpa") F.push({ severity: "warning", text: `“${nm2}” uses <b>${esc(sg.label)}</b>, which is outdated and crackable.`, rec: "Upgrade the gateway to WPA2 or, preferably, WPA3." });
    else if (sg.g === "wpa2" && wifiGen(scanEnv.current).g >= 6) F.push({ severity: "info", text: `“${nm2}” runs modern Wi-Fi but only WPA2 security. WPA3 adds stronger encryption and protected management frames.`, rec: "Switch to WPA3 (or WPA2/WPA3 transitional) if all client devices support it." });
    const infraAll = [scanEnv.current].concat(scanEnv.nearby || []);
    const sixBad = analyzeInfra(infraAll).sixViolation;
    if (sixBad) F.push({ severity: "warning", text: `${sixBad} access point${sixBad > 1 ? "s are" : " is"} broadcasting on 6 GHz without WPA3 — the 6 GHz band mandates WPA3/OWE.`, rec: "Reconfigure those APs for WPA3; some clients won't connect to a non-compliant 6 GHz SSID." });
  }
  if (plan && thr.length) { const low = thr.filter((p) => p.download_mbps < plan * 0.5); if (low.length) { const w = low.reduce((a, b) => (b.download_mbps < a.download_mbps ? b : a)); F.push({ severity: "warning", text: `Throughput fell below half the ${plan} Mbps plan at ${nm(low)}. Slowest: ${esc(w.location)} at ${w.download_mbps} Mbps (${Math.round(w.download_mbps / plan * 100)}% of plan).`, rec: "Where this tracks weak signal, fixing coverage fixes speed. Where signal is strong but speed is low, suspect 2.4 GHz, congestion, or the WAN feed — run a wired test at the gateway." }); } }
  if (levels.length > 1) levels.forEach((L) => { const fp = pts.filter((p) => p.level === L.id && p.signal != null); if (fp.length && fp.filter((p) => p.signal < -75).length / fp.length >= 0.5) F.push({ severity: "critical", text: `${esc(L.name)} is under-served — ${Math.round(fp.filter((p) => p.signal < -75).length / fp.length * 100)}% of its readings are dead zones. Wi-Fi struggles to pass between floors.`, rec: `Add an access point on ${esc(L.name)}, ideally stacked near the router's vertical position or wired back to it. Re-survey after adding.` }); });
  if (cellPoints.length) {
    const b = bestCellSpot();
    const allBad = cellPoints.every((c) => (c.nr_sinr == null || c.nr_sinr < 0) && (c.lte_sinr == null || c.lte_sinr < 0));
    if (allBad) F.push({ severity: "critical", text: `Every candidate spot shows poor cellular quality (SINR below 0 dB) — best was ${esc(b.location)} at 5G SINR ${b.nr_sinr ?? b.lte_sinr}. The gateway's WAN feed caps every downstream Wi-Fi speed.`, rec: "Improve the gateway signal first: try upper floors and windows facing the tower; mount the Waveform 2×2 antenna outside/high with clear line-of-sight until 5G SINR clears +5 dB." });
    else if (bestSinr != null && bestSinr < 13) F.push({ severity: "warning", text: `The best cellular spot (${esc(b.location)}) is only marginal at 5G SINR ${bestSinr} dB — usable but short of the 13+ dB that gives reliable full-speed service.`, rec: "Keep hunting: try higher and nearer a window facing the tower, and test an external antenna before committing." });
    else F.push({ severity: "good", text: `Best cellular placement is ${esc(b.location)} — 5G SINR ${b.nr_sinr ?? "—"} dB, RSRP ${b.nr_rsrp ?? "—"} dBm. A clean spot for the gateway.`, rec: `Mount the gateway and Waveform 2×2 antenna at ${esc(b.location)} with clear line-of-sight to the tower. SINR matters more than RSRP — favor the cleaner signal.` });
  }
  if (pts.length >= 4 && !dead.length && !marg.length && !lowSnr.length) F.push({ severity: "good", text: `Coverage is solid across all ${distinctRooms(pts)} surveyed rooms — every reading is Good or better with clean SNR. No dead zones, no interference flags.`, rec: "No additional access points needed. Keep the gateway in place; re-survey the far corners if the device count grows." });
  if (pts.length >= 3 && (dead.length || marg.length)) F.push({ severity: "info", text: "Router placement drives everything downstream.", rec: "Place the gateway central and high — off the floor, out of cabinets, away from metal, mirrors, and the microwave. A central router often fixes problem rooms more cheaply than new hardware." });

  const order = { critical: 0, warning: 1, good: 2, info: 3 };
  const sorted = F.sort((a, b) => order[a.severity] - order[b.severity]);
  const nameLine = site.f_client ? esc(site.f_client) : "This network";
  let summary = `${nameLine} scores <b>${score}/100 (${grade[0]})</b>. `;
  summary += (sorted.length && sorted[0].severity !== "good" && sorted[0].severity !== "info") ? stripTags(sorted[0].text) + " " : `Coverage held up across all ${distinctRooms(pts)} rooms surveyed. `;
  const firstRec = sorted.find((f) => f.rec && (f.severity === "critical" || f.severity === "warning"));
  summary += firstRec ? stripTags(firstRec.rec.split(".")[0]) + "." : "No changes recommended.";
  return { score, grade: grade[0], gradeColor: GRADE_INK.print[grade[0]], gradeInk: GRADE_INK.screen[grade[0]], subs, findings: sorted, summary };
}

function genReport() {
  if (!points.length) return toast("Save at least one room first");
  saveLevelMap();
  if ($("f_client") && !$("f_client").value.trim()) {
    const name = prompt("Client or site name for the report? (optional)");
    if (name) { $("f_client").value = name; saveSite(); }
  }
  const site = {};
  SITE_FIELDS.forEach((f) => (site[f] = $(f) ? $(f).value.trim() : ""));
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups for 127.0.0.1 to see the report");
  w.document.write(buildReport(site, points));
  w.document.close();
}

// Includes the apostrophe: several attributes in this file are single-quoted, and a name
// containing one would otherwise close the attribute early.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A data:/blob: URL for an <img src>. Everything here is produced locally by canvas.toDataURL
// or FileReader, but these values also arrive from imported .json survey files, which are
// hand-editable — so an imported survey shouldn't be able to inject a javascript: URL.
function safeImgSrc(u) {
  const s = String(u || "");
  return /^(data:image\/|blob:)/i.test(s) ? s.replace(/"/g, "&quot;") : "";
}

function healthBadge(ins, size) {
  return `<div class="hbadge" style="--bc:${ins.gradeColor};width:${size}px;height:${size}px">
    <div class="hnum">${ins.score}</div><div class="hgrade">${ins.grade}</div></div>`;
}

function buildReport(site, pts) {
  // The RF environment the survey was walked in — falls back to live only for surveys saved
  // before this was recorded, and the Interference section says which one it is either way.
  const env = (surveyEnv && surveyEnv.current) ? surveyEnv : null;
  const ins = computeInsights(pts, site, env);
  const rated = pts.map((p) => ({ ...p, r: rate(p.signal, p.snr) }));
  const dead = rated.filter((p) => p.r.cls === "poor");
  const signals = pts.map((p) => p.signal).filter((s) => s != null);
  const best = signals.length ? Math.max(...signals) : null;
  const worst = signals.length ? Math.min(...signals) : null;
  const avg = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : null;
  const plan = parseFloat(site.f_plan) || null;
  const thr = pts.filter((p) => p.download_mbps != null);
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const levelName = (id) => { const l = levels.find((x) => x.id === id); return l ? l.name : "—"; };
  const hasGps = pts.some((p) => p.gps);

  // sub-score bars
  const subBars = ins.subs.map((s) => `<div class="sbrow"><span class="sbl">${s.name}</span><div class="sbbar"><i style="width:${s.val}%;background:${s.val >= 75 ? "#3f8f13" : s.val >= 60 ? "#b45309" : "#dc2626"}"></i></div><span class="sbv">${s.val}</span></div>`).join("");

  // findings cards (relabeled for a plain-language reader: "Finding" / "What to do")
  const insightCards = ins.findings.map((f) => `<div class="finding f-${f.severity}"><div class="fsev">${f.severity === "good" ? "Looking good" : f.severity === "info" ? "Note" : f.severity === "warning" ? "Needs attention" : "Priority fix"}</div><div class="ftext">${f.text}${f.rec ? `<div class="frec"><b>What to do.</b> ${f.rec}</div>` : ""}</div></div>`).join("") || "<p>Not enough data for analysis yet.</p>";

  // ---- plain-language "bottom line" for a non-technical reader ----
  const byRoom = {};
  pts.forEach((p) => { const k = p.location || "—"; (byRoom[k] = byRoom[k] || []).push(p); });
  const roomKeys = Object.keys(byRoom), totalRooms = roomKeys.length;
  const roomsGood = roomKeys.filter((k) => byRoom[k].every((p) => p.signal == null || p.signal >= -67)).length;
  const mappedNow = mappedPoints(pts);
  let covPct = null;
  if (reqProfile !== "none") { const rs = requirementStats(mappedNow); if (rs.ok) covPct = rs.pct; }
  if (covPct == null && signals.length) covPct = Math.round((100 * signals.filter((s) => s >= -67).length) / signals.length);
  const areaFtR = surveyedSqft(mappedNow), holeFtR = dead.length ? holeAreaSqft(-75, mappedNow) : 0;
  const gword = (ins.grade || "").toLowerCase();
  const verdict = dead.length === 0
    ? `The Wi-Fi here is <b>${gword}</b> — every room we surveyed has reliable coverage, with no dead zones to fix.`
    : `The Wi-Fi here is <b>${gword}</b> overall, but <b>${dead.length} area${dead.length > 1 ? "s" : ""}</b> ${dead.length > 1 ? "need" : "needs"} attention before coverage is solid everywhere.`;
  const blk = (n, l, color) => `<div class="blk"><div class="blk-n"${color ? ` style="color:${color}"` : ""}>${n}</div><div class="blk-l">${l}</div></div>`;
  const bottomLine = `<div class="bottomline">${healthBadge(ins, 108)}<div class="bl-main"><div class="bl-verdict">${verdict}</div><div class="bl-kpis">
    ${blk(roomsGood + " / " + totalRooms, "rooms with strong Wi-Fi")}
    ${covPct != null ? blk(covPct + "%", "of the home covered well") : ""}
    ${blk(dead.length, "dead zone" + (dead.length !== 1 ? "s" : "") + (holeFtR ? " · " + fmtSqft(holeFtR) : ""), dead.length ? "#dc2626" : "#15803d")}
    ${areaFtR ? blk(fmtSqft(areaFtR), "area surveyed") : ""}
  </div></div></div>`;

  // room table (comprehensive)
  const gpsHead = hasGps ? "<th>GPS</th>" : "";
  const gpsCell = (p) => hasGps ? `<td>${p.gps ? p.gps.lat.toFixed(5) + ", " + p.gps.lon.toFixed(5) + (p.gps.acc ? " ±" + Math.round(p.gps.acc) + "m" : "") : "—"}</td>` : "";
  const colspan = 13 + (hasGps ? 1 : 0);
  const detailRow = (p, i) => `<tr><td>${i + 1}</td><td>${esc(p.location)}</td><td>${esc(levelName(p.level))}</td><td>${esc(p.ssid || "—")}</td>
    <td>${p.band || "?"} / ch ${p.channel ?? "?"}${p.width ? " " + p.width : ""}</td>
    <td>${p.signal ?? "—"}</td><td>${p.noise ?? "—"}</td><td>${p.snr ?? "—"}</td>
    <td>${p.phy_friendly || p.phy || "—"}${p.rate ? " · " + p.rate + "M" : ""}</td>
    <td>${p.download_mbps != null ? p.download_mbps + " / " + (p.upload_mbps ?? "—") : "—"}</td>
    <td>${p.ping_avg_ms != null ? p.ping_avg_ms + " ms" + (p.ping_loss_pct ? " · " + p.ping_loss_pct + "%" : "") : "—"}</td>
    <td>${esc(p.security || "—")}</td>
    <td class="r-${p.r.cls}">${p.r.label}</td>${gpsCell(p)}</tr>`;

  let rows;
  if (distinctRooms(rated) === rated.length) {
    // No rooms drawn / nothing actually groups — flat table, no group headers.
    rows = rated.map((p, i) => detailRow(p, i)).join("");
  } else {
    // Group by room (roomOf) within its floor, preserving first-appearance order.
    const RANK = { na: 0, exc: 1, good: 2, fair: 3, poor: 4 };
    const OVERALL = { na: { cls: "na", label: "—" }, exc: { cls: "exc", label: "Excellent" }, good: { cls: "good", label: "Good" }, fair: { cls: "fair", label: "Fair" }, poor: { cls: "poor", label: "Poor" } };
    const order = [];
    const groups = new Map();
    rated.forEach((p, i) => {
      const room = roomOf(p);
      const key = p.level + "\u241f" + room;
      let g = groups.get(key);
      if (!g) { g = { room, level: p.level, items: [] }; groups.set(key, g); order.push(key); }
      g.items.push({ p, i });
    });
    rows = order.map((key) => {
      const g = groups.get(key);
      const sigs = g.items.map((it) => it.p.signal).filter((s) => s != null);
      const avg = sigs.length ? Math.round(sigs.reduce((a, b) => a + b, 0) / sigs.length) : null;
      const worstCls = g.items.reduce((w, it) => RANK[it.p.r.cls] > RANK[w] ? it.p.r.cls : w, "na");
      const ov = OVERALL[worstCls];
      const n = g.items.length;
      const header = `<tr class="rgrp"><td colspan="${colspan}">` +
        `<b>${esc(g.room)}</b> · ${esc(levelName(g.level))} · ${n} reading${n === 1 ? "" : "s"}` +
        ` · avg RSSI ${avg != null ? avg + " dBm" : "—"}` +
        ` · <span class="r-${ov.cls}">${ov.label}</span></td></tr>`;
      const body = g.items.map((it) => detailRow(it.p, it.i)).join("");
      return header + body;
    }).join("");
  }

  // per-floor heatmaps
  let heatmapSection = "";
  const HM = METRICS[heatMetric];
  const rp = reqProfile !== "none" ? REQ_PROFILES[reqProfile] : null;

  // Area and % passing are per-FLOOR figures. They used to be printed once, from whichever
  // level happened to be selected, underneath every floor's heatmap — so the same numbers
  // appeared under all of them and changed depending on what was on screen at the time.
  const floorFigures = (l) => {
    const s = scaleFor(l);
    const pl = mappedPoints(points, l.id);
    if (!s || pl.length < 3) return "";
    const area = polyFracArea(requirementHull(pl) || coverageHull(pl, 0.14) || []) * s.ftW * s.ftH;
    if (!area) return "";
    let out = `<p class="legend">Surveyed area ≈ <b>${fmtSqft(area)}</b> (${s.source === "gps" ? "scaled from GPS imagery" : "from the set scale"}).</p>`;
    if (rp && l.id === activeLevel) {
      const rs = requirementStats(pl);
      const sqPass = rs.ok ? ` (≈ ${Math.round((area * rs.pct) / 100).toLocaleString()} ft²)` : "";
      out += `<p class="legend"><b>Requirement — ${esc(rp.label)}</b> (${esc(reqGateText(rp))}): ${rs.ok ? `an estimated <b>${rs.pct}%</b>${sqPass} of this floor passes` : "insufficient readings to score"}. Greyed cells fall short of target.</p>`;
    }
    return out;
  };

  const levelShots = levels.filter((l) => l.snapshot);
  if (levelShots.length) {
    heatmapSection = levelShots.map((l) =>
      `<h2>Coverage — ${esc(l.name)}</h2><img class="hm" src="${safeImgSrc(l.snapshot)}">${floorFigures(l)}`).join("");
  } else {
    const coverImg = generateMapDataURL() || heatmapDataUrl;
    const cur = levels.find((l) => l.id === activeLevel);
    heatmapSection = coverImg
      ? `<h2>Coverage Heatmap</h2><img class="hm" src="${safeImgSrc(coverImg)}">${cur ? floorFigures(cur) : ""}` : "";
  }
  if (heatmapSection) {
    heatmapSection += `<p class="legend">Heatmap metric: ${heatMode === "passfail" ? `${HM.label} — Pass/Fail (${heatPreset}): pass ≥ ${HM.th[heatPreset][0]} ${HM.unit}` : `${HM.label} (${HM.unit}) — weak <span style="display:inline-block;width:84px;height:9px;border-radius:5px;vertical-align:-1px;background:${colormapCss()}"></span> strong`}. 📡 marks router/access-point locations.</p>
      <p class="legend">Each reading is marked <b>E</b> excellent, <b>G</b> good, <b>W</b> weak or <b>D</b> dead zone, so the map reads correctly in greyscale and with colour blindness.</p>`;
    if (levels.some((l) => l.geo)) heatmapSection += `<p class="legend" style="opacity:.7;font-size:11px">Imagery © Esri — GPS-located readings.</p>`;
  }

  // throughput section
  let thrSection = "";
  if (thr.length) {
    const trows = thr.map((p) => { const pct = plan ? Math.round(p.download_mbps / plan * 100) : null; const bad = plan && p.download_mbps < plan * 0.5; return `<tr><td>${esc(p.location)}</td><td>${p.download_mbps} Mbps</td><td>${p.upload_mbps != null ? p.upload_mbps + " Mbps" : "—"}</td><td style="${bad ? "color:#dc2626;font-weight:700" : ""}">${pct != null ? pct + "% of plan" : "—"}</td><td>${p.ping_avg_ms != null ? p.ping_avg_ms + " ms" : "—"}</td></tr>`; }).join("");
    thrSection = `<h2>Throughput &amp; Latency</h2>${plan ? `<p>Plan speed: <b>${plan} Mbps</b>. Rooms under 50% of plan are flagged.</p>` : ""}<div class="tw"><table><thead><tr><th>Room</th><th>Download</th><th>Upload</th><th>vs Plan</th><th>Latency</th></tr></thead><tbody>${trows}</tbody></table></div>`;
  }

  // nearby / RF environment
  let rfSection = "";
  const envScan = env || (lastScan && lastScan.current ? lastScan : null);
  const scan = importedScan.length ? importedScan : ((envScan && envScan.nearby) || []);
  if (scan.length) {
    const cur = envScan && envScan.current ? envScan.current : null;
    const co = cur ? scan.filter((n) => n.channel === cur.channel && n.ssid !== cur.ssid) : [];
    const rich = importedScan.length > 0 && scan.some((n) => n.width || n.security || n.vendor);
    const nrows = scan.slice().sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999)).slice(0, 20)
      .map((n) => { const c = cur && n.channel === cur.channel && n.ssid !== cur.ssid; return `<tr><td>${esc(n.ssid || "(hidden)")}</td><td>${n.channel ?? "?"}</td><td>${esc(n.band || "?")}</td>${rich ? `<td>${esc(n.width || "—")}</td>` : ""}<td>${n.signal != null ? n.signal + " dBm" : "—"}</td>${rich ? `<td>${esc(n.security || "—")}</td><td>${esc(n.vendor || "—")}</td>` : ""}<td>${c ? '<span style="color:#b45309;font-weight:700">co-channel</span>' : ""}</td></tr>`; }).join("");
    const rfHead = `<th>Network</th><th>Channel</th><th>Band</th>${rich ? "<th>Width</th>" : ""}<th>Signal</th>${rich ? "<th>Security</th><th>Vendor</th>" : ""}<th>Note</th>`;
    // Say where these numbers came from. A reader can't otherwise tell a survey-time scan from
    // one taken wherever the laptop happened to be when the report was printed.
    const when = importedScan.length ? "Imported from an external scan."
      : env && env.ts ? `Recorded during the survey, ${new Date(env.ts).toLocaleString()}.`
      : "Read live when this report was generated, not during the survey — treat as indicative.";
    rfSection = `<h2>Interference &amp; Nearby Networks</h2>
      <p>${importedScan.length ? `Imported WiFi&nbsp;Explorer scan of <b>${scan.length}</b> networks. ` : `${cur ? `The network was surveyed on <b>channel ${cur.channel} (${cur.band || "?"})</b>. ` : ""}`}${co.length ? `<b>${co.length}</b> neighboring network${co.length > 1 ? "s share" : " shares"} the surveyed channel — a common cause of slowdowns even at full signal.` : "No neighbors share the surveyed channel — the RF environment is clean."} ${scan.length} networks detected in total.</p>
      <p class="legend">${when}</p>
      <div class="tw"><table><thead><tr>${rfHead}</tr></thead><tbody>${nrows}</tbody></table></div>`;
  }

  // infrastructure & security posture (connected AP + any visible neighbors)
  let postureSection = "";
  {
    const cur3 = envScan && envScan.current ? envScan.current : null;
    const infraAps = (cur3 ? [cur3] : []).concat(scan);
    if (infraAps.length) {
      const infra = analyzeInfra(infraAps);
      const chip = (label, n, color) => `<span style="display:inline-block;border:1px solid #cbd5e1;border-left:4px solid ${color};border-radius:6px;padding:3px 10px;margin:3px 4px 3px 0;font-size:13px;background:#f8fafc">${esc(label)}: <b>${n}</b></span>`;
      const genOrder = [["Wi-Fi 7", "#7c3aed"], ["Wi-Fi 6E", "#2563eb"], ["6 GHz (6E/7)", "#2563eb"], ["Wi-Fi 6", "#0891b2"], ["Wi-Fi 5", "#0d9488"], ["Wi-Fi 4", "#ca8a04"], ["Legacy a/b/g", "#dc2626"], ["Unknown", "#94a3b8"]];
      const genChips = genOrder.filter((o) => infra.gen[o[0]]).map((o) => chip(o[0], infra.gen[o[0]], o[1])).join("");
      const secOrder = [["WPA3", "#22c55e"], ["WPA2", "#84cc16"], ["WPA (legacy)", "#f59e0b"], ["WEP (insecure)", "#ef4444"], ["Open", "#ef4444"], ["Unknown", "#94a3b8"]];
      const secChips = secOrder.filter((o) => infra.sec[o[0]]).map((o) => chip(o[0], infra.sec[o[0]], o[1])).join("");
      const bandChips = Object.keys(infra.band).filter((k) => infra.band[k]).map((k) => chip(k, infra.band[k], "#64748b")).join("");
      const flags = [];
      if (infra.open) flags.push(`<b>${infra.open}</b> open / unencrypted network${infra.open > 1 ? "s" : ""} in range`);
      if (infra.legacy) flags.push(`<b>${infra.legacy}</b> using outdated WEP/WPA security`);
      if (infra.sixViolation) flags.push(`<b>${infra.sixViolation}</b> AP${infra.sixViolation > 1 ? "s" : ""} on 6 GHz without WPA3 (6 GHz mandates WPA3)`);
      const flagHtml = flags.length ? `<p class="legend" style="color:#b45309">⚠︎ ${flags.join(" · ")}.</p>` : `<p class="legend">No open, legacy-encryption, or 6 GHz compliance issues among visible networks.</p>`;
      const note = infraAps.length === 1 && cur3 ? `<p class="legend" style="opacity:.7;font-size:11px">Only the connected network was visible — grant the survey app Location Services access on this Mac for a full neighbor-AP inventory. Generation reflects the highest standard each AP advertises; security shown as reported (WPA3 implies PMF, not independently confirmed on macOS).</p>` : `<p class="legend" style="opacity:.7;font-size:11px">Generation reflects the highest standard each AP advertises. Security shown as reported (WPA3 implies PMF, not independently confirmed on macOS).</p>`;
      postureSection = `<h2>Infrastructure &amp; Security</h2>
        <p><b>Wi-Fi generations in range:</b></p><p>${genChips}</p>
        <p><b>Bands in use:</b></p><p>${bandChips}</p>
        <p><b>Security posture:</b></p><p>${secChips}</p>
        ${flagHtml}${note}`;
    }
  }

  // cellular
  let cellSection = "";
  if (cellPoints.length) {
    const cbest = bestCellSpot();
    const crows = cellPoints.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.location)}</td><td>${p.nr_sinr ?? "—"}</td><td>${p.nr_rsrp ?? "—"}</td><td>${esc(p.nr_band || "—")}</td><td>${p.lte_sinr ?? "—"}</td><td>${p.lte_rsrp ?? "—"}</td></tr>`).join("");
    cellSection = `<h2>Cellular WAN — Antenna Placement</h2>
      <p>The T-Mobile gateway's cellular signal is the internet feed everything else depends on. Higher <b>SINR</b> means faster, steadier service — mount the Waveform 2×2 antenna at the cleanest spot with clear line-of-sight to the tower.</p>
      <div class="tw"><table><thead><tr><th>#</th><th>Candidate spot</th><th>5G SINR</th><th>5G RSRP</th><th>5G Band</th><th>LTE SINR</th><th>LTE RSRP</th></tr></thead><tbody>${crows}</tbody></table></div>
      <p style="margin-top:10px"><b>Recommended mount location: ${esc(cbest.location)}</b> — 5G SINR ${cbest.nr_sinr ?? "—"} dB, RSRP ${cbest.nr_rsrp ?? "—"} dBm${cbest.nr_band ? " (band " + esc(cbest.nr_band) + ")" : ""}.</p>`;
  }

  // remediation plan
  const rems = ins.findings.filter((f) => (f.severity === "critical" || f.severity === "warning") && f.rec);
  let remSection = "";
  if (rems.length) {
    const rrows = rems.map((f, i) => `<tr><td><span class="pri p-${f.severity}">${f.severity === "critical" ? "P1" : "P2"}</span></td><td>${stripTags(f.text).split(".")[0]}.</td><td>${f.rec}</td></tr>`).join("");
    remSection = `<h2>Recommended Action Plan</h2><div class="tw"><table><thead><tr><th>Priority</th><th>Issue</th><th>Recommended action</th></tr></thead><tbody>${rrows}</tbody></table></div>`;
  }

  // site photos & screenshots
  let photosSection = "";
  if (reportPhotos.length) {
    const cards = reportPhotos.map((p) => `<figure class="pfig"><img src="${safeImgSrc(p.url)}" alt="site photo">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`).join("");
    photosSection = `<h2>Site Photos</h2><div class="pgrid">${cards}</div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Wi-Fi Report — ${esc(site.f_client || "Report")}</title>
<style>
  @page{margin:15mm}
  html{background:#fff}
  body{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1a2233;background:#fff;max-width:900px;margin:0 auto;padding:0 24px 24px}
  h1{font-size:23px;margin:0 0 2px}
  h2{font-size:14px;margin:30px 0 12px;color:#22304d;padding-bottom:6px;border-bottom:2px solid #e2e8f4;position:relative}
  h2::before{content:"";position:absolute;left:0;bottom:-2px;width:52px;height:2px;background:#4f8cff}
  p{margin:8px 0}
  .cover{min-height:96vh;display:flex;flex-direction:column;page-break-after:always}
  .cband{background:linear-gradient(120deg,#22304d,#4f8cff);color:#fff;border-radius:14px;padding:34px 32px;margin-top:20px}
  .cband .kick{font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85;font-weight:700}
  .cband h1{color:#fff;font-size:34px;margin:8px 0 4px;letter-spacing:-.3px}
  .cband .caddr{opacity:.9;font-size:15px}
  .coverbody{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center}
  .hbadge{border-radius:50%;border:9px solid var(--bc);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 8px 26px rgba(20,30,60,.12)}
  .hbadge .hnum{font-size:52px;font-weight:800;color:var(--bc);line-height:1}
  .hbadge .hgrade{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--bc)}
  .cmeta{color:#667;font-size:13px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 24px;background:#f4f7fc;padding:16px 20px;border-radius:10px;font-size:12.5px}
  .meta b{color:#556}
  .summarybox{display:flex;gap:20px;align-items:center;background:#f7f9fc;border:1px solid #e2e8f4;border-radius:12px;padding:20px 22px}
  .summarybox .stext{font-size:14px;line-height:1.6}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
  .stat{flex:1;min-width:96px;background:#f4f7fc;border:1px solid #e8edf6;border-radius:10px;padding:12px 14px}
  .stat .n{font-size:24px;font-weight:800}.stat .l{font-size:10.5px;color:#667;text-transform:uppercase;letter-spacing:.5px}
  .bottomline{display:flex;gap:22px;align-items:center;background:linear-gradient(120deg,#f7f9fc,#eef4ff);border:1px solid #dbe6fb;border-radius:14px;padding:22px 24px}
  .bl-main{flex:1}
  .bl-verdict{font-size:16px;line-height:1.5;color:#22304d;margin-bottom:14px}
  .bl-kpis{display:flex;gap:12px;flex-wrap:wrap}
  .blk{flex:1;min-width:118px;background:#fff;border:1px solid #e3e9f4;border-radius:10px;padding:12px 14px;text-align:center}
  .blk-n{font-size:25px;font-weight:800;color:#22304d;line-height:1}
  .blk-l{font-size:11px;color:#667;margin-top:5px;line-height:1.3}
  .appendix-divider{margin-top:42px;padding-top:6px;border-top:3px solid #22304d;page-break-before:always}
  .appendix-divider h2{border:none;margin:16px 0 2px;font-size:16px}.appendix-divider h2::before{display:none}
  .appendix-divider p{color:#667;font-size:12.5px;margin-top:2px}
  .appx h2{color:#556}
  .sbrow{display:flex;align-items:center;gap:12px;margin:7px 0;font-size:12.5px}
  .sbl{width:120px;color:#556;font-weight:600}.sbv{width:32px;text-align:right;font-weight:800}
  .sbbar{flex:1;height:9px;background:#eef2f8;border-radius:5px;overflow:hidden}.sbbar i{display:block;height:100%}
  .finding{border-left:4px solid #999;background:#fbfcfe;border-radius:0 10px 10px 0;padding:12px 16px;margin:10px 0}
  .finding.f-critical{border-color:#dc2626;background:#fef4f4}.finding.f-warning{border-color:#b45309;background:#fff9f0}
  .finding.f-good{border-color:#15803d;background:#f2fbf5}.finding.f-info{border-color:#4f8cff;background:#f4f8ff}
  .fsev{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
  .f-critical .fsev{color:#dc2626}.f-warning .fsev{color:#b45309}.f-good .fsev{color:#15803d}.f-info .fsev{color:#4f8cff}
  .frec{margin-top:6px;font-size:12px;color:#42506a}
  .tw{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:6px}
  th,td{border:1px solid #dde3ee;padding:6px 8px;text-align:left;white-space:nowrap}
  th{background:#22304d;color:#fff;font-size:10px;text-transform:uppercase}
  tr:nth-child(even) td{background:#f8fafd}
  .r-exc{color:#15803d;font-weight:700}.r-good{color:#3f8f13;font-weight:600}
  .r-fair{color:#b45309;font-weight:700}.r-poor{color:#dc2626;font-weight:700}.r-na{color:#889}
  .rgrp td{background:#eef2f9;border-top:2px solid #22304d;font-size:11px;color:#22304d;white-space:normal;padding:7px 10px}
  tr.rgrp:nth-child(even) td{background:#eef2f9}
  .rgrp td b{font-size:12px}
  .pri{display:inline-block;padding:2px 8px;border-radius:20px;font-weight:800;font-size:10px;color:#fff}
  .pri.p-critical{background:#dc2626}.pri.p-warning{background:#b45309}
  .hm{max-width:100%;border:1px solid #dde3ee;border-radius:8px;margin-top:4px}
  .legend{font-size:11px;color:#667;margin-top:8px}
  .pgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
  .pfig{margin:0;break-inside:avoid;page-break-inside:avoid}
  .pfig img{width:100%;max-height:340px;object-fit:contain;border:1px solid #dde3ee;border-radius:8px;background:#f8fafd;display:block}
  .pfig figcaption{font-size:11px;color:#556;margin-top:5px;text-align:center}
  @media print{.pfig{page-break-inside:avoid}}
  .noprint{padding:16px 0 0}
  button{background:#4f8cff;color:#fff;border:0;padding:11px 22px;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer}
  @media print{.noprint{display:none}h2{page-break-after:avoid}.finding,tr{page-break-inside:avoid}}
  footer{margin-top:30px;padding-top:12px;border-top:1px solid #dde3ee;color:#889;font-size:11px}
</style></head><body>
<div class="noprint"><button onclick="window.print()">🖨️  Print / Save as PDF</button></div>

<div class="cover">
  <div class="cband">
    <div class="kick">Wi-Fi Site Survey &amp; Coverage Report</div>
    <h1>${esc(site.f_client || "Client Site")}</h1>
    <div class="caddr">${esc(site.f_address || "")}</div>
  </div>
  <div class="coverbody">
    ${healthBadge(ins, 160)}
    <div style="font-size:18px;font-weight:700;color:#22304d">Wi-Fi Signal Score</div>
    <div class="cmeta">${distinctRooms(pts)} rooms · ${pts.length} readings · ${levels.length} floor${levels.length > 1 ? "s" : ""} · ${today}<br>Prepared by ${esc(site.f_tech || "—")}</div>
  </div>
</div>

<h2>The Bottom Line</h2>
${bottomLine}

<h2>Executive Summary</h2>
<div class="summarybox"><div class="stext">${ins.summary}</div></div>

${heatmapSection}

<h2>What We Found &amp; What To Do</h2>
${insightCards}

${remSection}
${photosSection}

<div class="appendix-divider">
  <h2>Technical Appendix</h2>
  <p>The measurements and detail behind the summary above — for the installer or IT team. Nothing here changes the recommendations; it's the supporting data.</p>
</div>
<div class="appx">

<h2>Survey Scope</h2>
<div class="meta">
  <div><b>Client / Site:</b> ${esc(site.f_client || "—")}</div>
  <div><b>Address:</b> ${esc(site.f_address || "—")}</div>
  <div><b>Technician:</b> ${esc(site.f_tech || "—")}</div>
  <div><b>Date:</b> ${today}</div>
  <div><b>Gateway / router:</b> ${esc(site.f_gw || "—")}</div>
  <div><b>Surveyed network:</b> ${esc(site.f_ssid || (lastScan && lastScan.current ? lastScan.current.ssid : "—"))}</div>
  <div><b>Internet plan:</b> ${plan ? plan + " Mbps" : "—"}</div>
  <div><b>Home size:</b> ${site.f_sqft ? esc(site.f_sqft) + " sq ft (est.)" : "—"}</div>
  <div><b>Rooms surveyed:</b> ${distinctRooms(pts)} (${pts.length} readings)</div>
  <div><b>Floors:</b> ${levels.map((l) => esc(l.name)).join(", ")}</div>
</div>

<h2>Signal Score Breakdown</h2>
<div class="stats">
  <div class="stat"><div class="n">${distinctRooms(pts)}</div><div class="l">Rooms</div></div>
  <div class="stat"><div class="n">${pts.length}</div><div class="l">Readings</div></div>
  <div class="stat"><div class="n">${best ?? "—"}</div><div class="l">Best dBm</div></div>
  <div class="stat"><div class="n">${worst ?? "—"}</div><div class="l">Worst dBm</div></div>
  <div class="stat"><div class="n">${avg ?? "—"}</div><div class="l">Avg dBm</div></div>
  <div class="stat"><div class="n" style="color:${dead.length ? "#dc2626" : "#15803d"}">${dead.length}</div><div class="l">Dead spots</div></div>
</div>
${subBars ? `<div style="margin-top:14px">${subBars}</div><p class="legend">Each sub-score is 0–100; the overall score weights coverage most heavily and is capped when dead zones exist so the headline number never overstates the network.</p>` : ""}

<h2>Survey Results — Room by Room</h2>
<div class="tw"><table><thead><tr><th>#</th><th>Point</th><th>Floor</th><th>SSID</th><th>Band / Ch</th><th>RSSI</th><th>Noise</th><th>SNR</th><th>PHY / Rate</th><th>↓/↑ Mbps</th><th>Latency</th><th>Security</th><th>Rating</th>${gpsHead}</tr></thead>
<tbody>${rows}</tbody></table></div>
<div class="legend">Rating (RSSI): Excellent ≥ −55 · Good −56 to −67 · Fair −68 to −75 · Poor &lt; −75. −67 dBm is the reliable-connectivity line; SNR &lt; 15 dB flags a noisy link.</div>

${thrSection}
${rfSection}
${postureSection}
${cellSection}
</div>

<h2>Methodology &amp; Notes</h2>
<p>Wi-Fi readings were taken with a MacBook (built-in Wi-Fi radio) using native macOS telemetry (<i>system_profiler</i>), Apple's <i>networkQuality</i> for throughput, and <i>ping</i> for latency/loss — one reading per room, device held ~1 m off the floor, stationary. Cellular placement readings come from the gateway's own 5G/LTE SINR &amp; RSRP telemetry. Coverage heatmaps are interpolated between measured points. This survey does not assess non-Wi-Fi (spectrum) interference, which requires dedicated hardware.</p>
<footer>Generated ${today} · Wi-Fi Site Survey. Readings are point-in-time and vary with device, orientation, and interference. Wi-Fi signal score is an automated estimate to guide decisions, not a guarantee.</footer>
</body></html>`;
}

/* ---------- tool data ingestion (JSON survey / scan CSV / heatmap image) ---------- */
function ingestFile(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const name = (file.name || "").toLowerCase();
  const st = $("ingestStatus");
  if (file.type.indexOf("image") === 0) { attachHeatmap(ev); if (st) st.innerHTML = "✅ Heatmap image attached — it will appear in the report."; return; }
  if (name.endsWith(".pcap") || name.endsWith(".pcapng") || name.endsWith(".cap")) {
    // binary capture — MUST read as an ArrayBuffer (readAsText would corrupt every byte ≥ 0x80)
    const rb = new FileReader();
    rb.onload = () => {
      let scan = [];
      try { scan = parsePcap(rb.result); } catch (e) { scan = []; }
      if (scan.length) {
        importedScan = scan;
        store(LS_IMPORTEDSCAN, JSON.stringify(scan));
        renderReportInsights();
        if (st) st.innerHTML = `✅ Ingested <b>${scan.length}</b> network${scan.length > 1 ? "s" : ""} from the packet capture — channel, signal &amp; security now feed the report's RF analysis.`;
      } else if (st) {
        st.innerHTML = "No Wi-Fi networks in that capture. A pcap only carries network info when it's a <b>monitor-mode</b> 802.11 capture (e.g. <code>sudo tcpdump -I -i en0 -w cap.pcap</code>) — a normal capture has no beacon frames to read.";
      }
    };
    rb.readAsArrayBuffer(file);
    ev.target.value = "";
    return;
  }
  const r = new FileReader();
  r.onload = () => {
    const text = String(r.result || "");
    if (name.endsWith(".json") || text.trim().charAt(0) === "{") return importSurveyText(text);
    let scan = parseScanCSV(text);
    if (!scan.length && (name.endsWith(".wifiexplorer") || name.endsWith(".plist") || text.indexOf("<plist") >= 0)) scan = parseWifiExplorerPlist(text);
    if (scan.length) {
      importedScan = scan;
      store(LS_IMPORTEDSCAN, JSON.stringify(scan));
      renderReportInsights();
      if (st) st.innerHTML = `✅ Ingested <b>${scan.length}</b> networks from WiFi&nbsp;Explorer — they now feed the report's interference / RF analysis (channel, width, security, vendor).`;
    } else if (st && text.indexOf("<plist") >= 0) {
      st.innerHTML = "That looks like a saved WiFi&nbsp;Explorer document. In WiFi Explorer use <b>File → Export As… → CSV</b>, then drop that file here.";
    } else if (st) st.textContent = "Couldn't read that file — expected a WiFi Explorer / NetSpot scan CSV or a survey .json.";
  };
  r.readAsText(file);
  ev.target.value = "";
}
// Same restore as importJSON — a survey .json dropped on the report's ingest box is the
// same file, so it goes through the same complete path rather than a partial copy of it.
function importSurveyText(text) {
  const st = $("ingestStatus");
  let d;
  try { d = JSON.parse(text); } catch (e) {
    if (st) st.textContent = "Import failed — that .json wasn't a valid survey file.";
    return;
  }
  if (!d || typeof d !== "object" || (!Array.isArray(d.points) && !Array.isArray(d.levels))) {
    if (st) st.textContent = "That .json has no survey data in it.";
    return;
  }
  const live = points.length + cellPoints.length;
  if (live && !confirm(
    `Open this survey file?\n\nIt replaces what's on screen now — ${points.length} readings and ${cellPoints.length} candidate spots.`
  )) return;
  restoreProfileBundle(d);
  points.forEach((p) => { if (!p.level) p.level = activeLevel; });
  savePoints();
  renderPoints();
  renderCoverageMap();
  if (st) st.innerHTML = `✅ Imported survey — <b>${points.length}</b> readings restored.`;
}
function parseScanCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0];
  const delim = head.indexOf("\t") > -1 ? "\t" : (head.indexOf(";") > -1 && head.indexOf(",") < 0) ? ";" : ",";
  const split = (l) => l.split(delim).map((s) => s.replace(/^"|"$/g, "").trim());
  const hdr = split(head).map((h) => h.toLowerCase());
  const col = (re) => hdr.findIndex((h) => re.test(h));
  // Prioritized finder: try each regex in order; first header matching the strongest
  // available pattern wins (order-independent, so a plain "SSID" column beats a "BSSID" column).
  const findCol = (pats) => { for (const re of pats) { const i = hdr.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
  const iB = col(/bssid|\bmac\b|address/);
  // SSID: none of these can match "bssid" (\bssid\b has no word boundary before "ssid" inside "bssid").
  let iS = findCol([/^ssid$/, /^network[ _-]?name$/, /^network$/, /\bssid\b/, /^name$/, /network[ _-]?name/]);
  if (iS >= 0 && iS === iB) iS = -1; // never let SSID collide onto the BSSID (MAC) column
  const iC = col(/channel|chan|\bch\b/), iBd = col(/band/), iSig = col(/rssi|signal|dbm|strength|level/), iSnr = col(/snr/), iN = col(/noise/), iW = col(/width|mhz/), iSec = col(/security|encryption|auth|privacy/), iV = col(/vendor|manufacturer/);
  const numish = (x) => { const m = (x || "").match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    if (!c.length) continue;
    const row = { ssid: iS >= 0 ? c[iS] : "", bssid: iB >= 0 ? c[iB] : "", channel: iC >= 0 ? numish(c[iC]) : null, band: iBd >= 0 ? c[iBd] : "", signal: iSig >= 0 ? numish(c[iSig]) : null, snr: iSnr >= 0 ? numish(c[iSnr]) : null, noise: iN >= 0 ? numish(c[iN]) : null, width: iW >= 0 ? c[iW] : "", security: iSec >= 0 ? c[iSec] : "", vendor: iV >= 0 ? c[iV] : "" };
    if (row.ssid || row.bssid || row.signal != null) out.push(row);
  }
  return out;
}
// WiFi Explorer native document (saved scan) is an XML plist — pull networks out of it.
function parseWifiExplorerPlist(text) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, "application/xml"); } catch (e) { return []; }
  if (!doc || doc.querySelector("parsererror")) return [];
  const numish = (x) => { const m = (x || "").match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
  const out = [];
  doc.querySelectorAll("dict").forEach((d) => {
    const kv = {}, kids = d.children;
    for (let i = 0; i < kids.length - 1; i++) {
      if (kids[i].tagName === "key" && kids[i + 1].tagName !== "key") kv[kids[i].textContent.trim().toLowerCase()] = kids[i + 1].textContent.trim();
    }
    const pick = (re) => { for (const k in kv) if (re.test(k)) return kv[k]; return null; };
    const ssid = pick(/^(?!.*bssid)(?:.*\bssid\b|.*network ?name)/), bssid = pick(/bssid|\bmac\b/), sig = pick(/rssi|signal/);
    if (!ssid && !bssid && sig == null) return;
    out.push({ ssid: ssid || "", bssid: bssid || "", channel: numish(pick(/channel|\bchan\b/)), band: pick(/band/) || "", signal: numish(sig), snr: numish(pick(/snr|signal.?to.?noise/)), noise: numish(pick(/noise/)), width: pick(/width/) || "", security: pick(/security|encryption|privacy/) || "", vendor: pick(/vendor|manufacturer/) || "" });
  });
  return out;
}

/* ---------- packet-capture ingestion (.pcap / .pcapng monitor-mode 802.11) ---------- */
// Extracts nearby networks from a capture into the importedScan shape. Handles classic
// pcap (LE/BE) + pcapng, radiotap (linktype 127) + bare 802.11 (105). Radiotap and the
// 802.11 payload are ALWAYS little-endian; only the pcap container uses the file's byte order.
function parsePcap(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 24) return [];
  const dv = new DataView(arrayBuffer);
  const m = dv.getUint32(0, false); // read the magic big-endian so on-disk byte order is explicit
  // LE classic file starts with bytes D4 C3 B2 A1 → reads BE as 0xD4C3B2A1 (µs) / 0x4D3CB2A1 (ns)
  if (m === 0xD4C3B2A1 || m === 0x4D3CB2A1) return pcapParseClassic(dv, true);
  // BE classic file starts with bytes A1 B2 C3 D4 → 0xA1B2C3D4 (µs) / 0xA1B23C4D (ns)
  if (m === 0xA1B2C3D4 || m === 0xA1B23C4D) return pcapParseClassic(dv, false);
  if (m === 0x0A0D0D0A) { // pcapng Section Header Block
    const bom = dv.getUint32(8, true);
    return pcapParsePcapng(dv, bom === 0x1A2B3C4D);
  }
  return [];
}
function pcapMac(dv, off) {
  let s = "";
  for (let i = 0; i < 6; i++) s += (i ? ":" : "") + dv.getUint8(off + i).toString(16).padStart(2, "0");
  return s; // lowercase, matching the CSV / WiFi-Explorer convention
}
function pcapFreqToChannel(freq) {
  if (freq == null) return null;
  if (freq === 2484) return 14;                              // special case (generic formula gives 15)
  if (freq >= 2412 && freq <= 2472) return (freq - 2407) / 5;
  if (freq >= 5000 && freq <= 5900) return (freq - 5000) / 5;
  if (freq >= 5955 && freq <= 7115) return (freq - 5950) / 5; // 6 GHz (Wi-Fi 6E)
  return null;
}
function pcapBand(freq, ch) {
  if (freq != null) return freq >= 5955 ? "6 GHz" : freq >= 5000 ? "5 GHz" : "2.4 GHz";
  if (ch != null) return ch <= 14 ? "2.4 GHz" : "5 GHz";
  return "";
}
// radiotap header → {signalDbm, freq, dataAfter}; the 802.11 frame is located via it_len
function pcapRadiotap(dv, off) {
  const itLen = dv.getUint16(off + 2, true);
  let p = off + 4, first = 0, wi = 0;
  // consume ALL extended present words (bit31 chains another u32) before reading any field
  while (true) {
    const word = dv.getUint32(p, true);
    if (wi === 0) first = word;
    p += 4; wi++;
    if (!(word & 0x80000000)) break;
    if (p - off >= itLen) break;
  }
  // canonical radiotap field order: [presentBit, sizeBytes, alignment]
  const FIELDS = [[0, 8, 8], [1, 1, 1], [2, 1, 1], [3, 4, 2], [4, 2, 2], [5, 1, 1], [6, 1, 1], [7, 2, 2]];
  let cursor = p - off, freq = null, signalDbm = null;
  for (const f of FIELDS) {
    const bit = f[0], size = f[1], align = f[2];
    if (!(first & (1 << bit))) continue;
    if (cursor % align) cursor += align - (cursor % align);
    const fpos = off + cursor;
    if (fpos + size > off + itLen) break;
    if (bit === 3) freq = dv.getUint16(fpos, true);          // CHANNEL: first u16 is frequency
    else if (bit === 5) signalDbm = dv.getInt8(fpos);        // DBM_ANTSIGNAL: signed 8-bit
    cursor += size;
  }
  return { signalDbm: signalDbm, freq: freq, dataAfter: off + itLen };
}
// parse a beacon (subtype 8) / probe-response (subtype 5) mgmt frame → {bssid,ssid,channel,security}
function pcap80211(dv, off, end) {
  if (off + 24 > end) return null;
  const fc = dv.getUint16(off, true), ftype = (fc >> 2) & 3, subtype = (fc >> 4) & 0xF;
  if (ftype !== 0 || (subtype !== 8 && subtype !== 5)) return null;
  const bssid = pcapMac(dv, off + 16); // addr3 = BSSID
  const body = off + 24;
  if (body + 12 > end) return null;
  const cap = dv.getUint16(body + 10, true), privacy = (cap & 0x0010) !== 0;
  let ie = body + 12, ssid = null, channel = null, hasRSN = false, hasWPA = false;
  while (ie + 2 <= end) {
    const tag = dv.getUint8(ie), ln = dv.getUint8(ie + 1), val = ie + 2;
    if (val + ln > end) break;                               // clamp against truncated captures
    if (tag === 0) {                                         // SSID
      if (ln > 0) {
        try { ssid = new TextDecoder("utf-8").decode(new Uint8Array(dv.buffer, dv.byteOffset + val, ln)); }
        catch (e) { ssid = ""; for (let i = 0; i < ln; i++) ssid += String.fromCharCode(dv.getUint8(val + i)); }
      } else ssid = "";
    } else if (tag === 3 && ln >= 1) channel = dv.getUint8(val); // DS Parameter Set
    else if (tag === 48) hasRSN = true;                      // RSN (WPA2/3)
    else if (tag === 221 && ln >= 4 && dv.getUint8(val) === 0 && dv.getUint8(val + 1) === 0x50 && dv.getUint8(val + 2) === 0xF2 && dv.getUint8(val + 3) === 1) hasWPA = true; // MS WPA IE
    ie = val + ln;
  }
  const security = hasRSN ? "WPA2/3" : hasWPA ? "WPA" : privacy ? "WEP" : "Open";
  return { bssid: bssid, ssid: ssid, channel: channel, security: security };
}
function pcapAggregate(agg, mgmt, sig, freq) {
  if (!mgmt || !mgmt.bssid) return;
  const ch = mgmt.channel != null ? mgmt.channel : pcapFreqToChannel(freq); // DS IE wins over radiotap freq
  const band = pcapBand(freq, ch);
  let rec = agg[mgmt.bssid];
  if (!rec) { rec = { ssid: "", bssid: mgmt.bssid, channel: null, band: "", signal: null, snr: null, noise: null, width: "", security: "", vendor: "" }; agg[mgmt.bssid] = rec; }
  if (mgmt.ssid) rec.ssid = mgmt.ssid;
  if (ch != null) { rec.channel = ch; rec.band = band; }
  if (mgmt.security) rec.security = mgmt.security;
  if (sig != null && (rec.signal == null || sig > rec.signal)) rec.signal = sig; // keep the strongest
}
function pcapHandleFrame(dv, ps, pe, lt, agg) {
  let fo = ps, sig = null, freq = null;
  if (lt === 127) {                                          // radiotap
    if (ps + 8 > pe) return;
    const rt = pcapRadiotap(dv, ps); fo = rt.dataAfter; sig = rt.signalDbm; freq = rt.freq;
  } else if (lt === 105) { fo = ps; }                        // bare 802.11 (no signal available)
  else return;
  if (fo >= pe) return;
  pcapAggregate(agg, pcap80211(dv, fo, pe), sig, freq);
}
function pcapParseClassic(dv, le) {
  const lt = dv.getUint32(20, le), agg = {}, n = dv.byteLength;
  let pos = 24;
  while (pos + 16 <= n) {
    const incl = dv.getUint32(pos + 8, le), data = pos + 16;
    if (data + incl > n) break;
    pcapHandleFrame(dv, data, data + incl, lt, agg);
    pos = data + incl;
  }
  return Object.keys(agg).map((k) => agg[k]);
}
function pcapParsePcapng(dv, le) {
  const agg = {}, n = dv.byteLength;
  let pos = 0, curlt = null;
  while (pos + 12 <= n) {
    const bt = dv.getUint32(pos, le), total = dv.getUint32(pos + 4, le);
    if (total < 12 || pos + total > n) break;
    const body = pos + 8;
    if (bt === 1) curlt = dv.getUint16(body, le);            // Interface Description Block → linktype
    else if (bt === 6) {                                     // Enhanced Packet Block
      const capLen = dv.getUint32(body + 12, le), pkt = body + 20, endp = pkt + capLen;
      if (endp <= pos + total - 4) pcapHandleFrame(dv, pkt, endp, curlt, agg);
    } else if (bt === 3) {                                   // Simple Packet Block
      const pkt = body + 4, capLen = total - 12 - 4, endp = pkt + capLen;
      if (capLen > 0 && endp <= pos + total - 4) pcapHandleFrame(dv, pkt, endp, curlt, agg);
    }
    pos += total;
  }
  return Object.keys(agg).map((k) => agg[k]);
}

/* ---------- guide + glossary + report insights ---------- */
const TIPS = [
  { term: "RSSI / Signal (dBm)", tip: "How strong your Wi-Fi is here. It's a negative number — closer to zero (−45) is stronger than −80." },
  { term: "SNR (Signal-to-Noise)", tip: "How clearly your device hears Wi-Fi over background static. Higher is better; low SNR means slow and flaky." },
  { term: "Channel", tip: "The lane your Wi-Fi uses. If neighbors crowd the same lane, everyone slows down." },
  { term: "Band (2.4 / 5 / 6 GHz)", tip: "2.4GHz reaches farther through walls; 5 and 6GHz are much faster but shorter-range." },
  { term: "PHY / Wi-Fi 6", tip: "Which generation of Wi-Fi is in use. Wi-Fi 6 and 6E are the newest and fastest." },
  { term: "Data rate vs Throughput", tip: "Data rate is the speed your device and router agreed to try for; throughput is the real speed you actually get." },
  { term: "Signal gauge", tip: "A live meter of Wi-Fi strength where you're standing. Walk around and watch it rise or fall." },
  { term: "Excellent / Good / Fair / Poor", tip: "A plain-English grade for the Wi-Fi at each spot, so you don't have to read raw numbers." },
  { term: "Pass/Fail coloring", tip: "Colors the map green where Wi-Fi is good enough and red where it falls short of the level you picked." },
  { term: "Web / Video / IoT presets", tip: "Pick what a room is used for and we set the bar: light Web, streaming Video, or simple smart-home IoT." },
  { term: "Coverage heatmap", tip: "A color map of your Wi-Fi across the home, built from your readings. Warm = strong, cool = weak." },
  { term: "Property perimeter", tip: "The outline you draw around your home so the color map stays inside your walls, not the neighbors'." },
  { term: "AP / Router marker", tip: "A pin showing where your router or access point sits, so you can see if coverage lines up with it." },
  { term: "Dead spot", tip: "A place with little or no usable Wi-Fi — a good spot for a booster or mesh unit." },
  { term: "Co-channel interference", tip: "When your Wi-Fi and nearby networks share a channel and take turns, slowing everyone down." },
  { term: "SINR (cellular)", tip: "How clean your cell signal is over interference. Higher means faster, steadier phone-network internet." },
  { term: "RSRP (cellular)", tip: "How strong the cell tower signal is. Closer to zero (−80) is stronger than −110." },
  { term: "Cellular antenna placement", tip: "Finds the best window/wall for your home cell gateway by scoring the signal at each spot you test." },
  { term: "GPS accuracy", tip: "How precisely your phone knows its location, in meters. Smaller is more exact." },
  { term: "Multi-floor levels", tip: "Tabs for each story so basement, main floor, and upstairs each get their own coverage map." },
  { term: "Wi-Fi signal score", tip: "A 0–100 grade blending coverage, reliability, speed, interference, and cellular signal into one number." },
  { term: "Survey type", tip: "In-house, Around the house, Property, or All — picks which tools you see so the screen stays simple. Switching never deletes your work." },
  { term: "Aerial base map", tip: "A satellite image pulled from an address, used as the map you tap readings onto — no floor plan needed. Best for outdoor and property jobs." },
  { term: "GPS walk & drop", tip: "Stream your phone's location to the Mac and drop a reading at your exact spot as you walk the property — no Google Earth Pro needed." },
  { term: "Contour lines", tip: "Topographic-style lines on the heatmap, each marking one signal level (e.g. −67), so you can see exactly where 'Good' turns into 'Fair'." },
  { term: "KML / Google Earth export", tip: "Saves your walked boundary and points as a .kml file that opens in Google Earth or goes to the client." },
  { term: "CSV export", tip: "Every reading as a spreadsheet row — room, floor, band, channel, RSSI, SNR, rate, rating, GPS — for records or a client who wants raw numbers." },
  { term: "Speed test gauge", tip: "A one-tap needle sweep for download, upload, and responsiveness, measuring your real internet path with macOS's built-in tool." },
  { term: "Mission Control", tip: "The home page — your whole survey on one screen: signal score, live vitals, a progress checklist, top findings, and the Generate Report button." },
  { term: "Coverage target", tip: "Pick what a space is used for — Voice, Data, Video, High-density — and the map grades every spot pass/fail, showing the % of the area that meets it." },
  { term: "Scale / square footage", tip: "Draw a known distance (a 10-ft wall) to teach the plan its real size, so coverage holes and areas report in actual square feet." },
  { term: "Predict coverage", tip: "Model an access point's reach before you walk — drop APs on the plan and see the predicted heatmap in real feet, tuned for open, typical, or dense walls." },
  { term: "Site plan", tip: "A plot plan of the whole property — the hand-drawn house placed inside the GPS-walked yard boundary, so you can show the house on its lot." },
  { term: "Signal verdict (cellular)", tip: "A plain Excellent/Good/Fair/Poor grade for the gateway signal — the worse of coverage (RSRP) and quality (SINR), so a strong-but-noisy signal isn't called good." },
];
const GUIDE_TOOLS = [
  { name: "This app (survey → heatmap + report)", when: "Every job needing a coverage map or client report — the walk where you tap the floor plan. It's your deliverable.", not: "Not a live channel troubleshooter, not cellular, not security capture — diagnose the 'why' with WiFi Explorer." },
  { name: "WiFi Explorer", when: "When you need to know WHY coverage is bad — channels in use, co-channel overlap, competing networks, SNR. Run it before retuning the router.", not: "Doesn't build heatmaps or a report — it describes the air where you stand, not coverage across the house." },
  { name: "NetSpot", when: "A quick visual second-opinion heatmap on-site.", not: "Free tier CAN'T save or export — so it can't be your deliverable. Don't run the billable survey in it." },
  { name: "Apple Wireless Diagnostics (built-in)", when: "The always-available fallback — a quick signal/noise/rate check or a packet capture.", not: "Coarse for channel planning and no report. Use it when nothing else is handy." },
  { name: "T-Mobile gateway app", when: "ONLY the cellular side — aim the gateway / Waveform antenna by SINR & RSRP to find the best window or wall.", not: "Nothing to do with Wi-Fi coverage or the report. Aim the gateway, then survey Wi-Fi with this app." },
  { name: "aircrack-ng", when: "Effectively never on this Mac — it's a security / monitor-mode suite, not a coverage tool.", not: "Not coverage, and it can't even capture here (the Alfa adapter has no Apple-Silicon driver). Skip it for surveys." },
];
const GUIDE_FLOW = [
  "<b>Start at Mission Control:</b> name the survey (client details on the Report page) — the home page tracks your progress and score as you go.",
  "<b>Get a base map:</b> on Coverage, draw a schematic, upload a floor plan or photo, auto-layout from a room list, or pull a satellite image from an address. Set a scale (🛠 Tools → Set scale) so everything reads in real square footage.",
  "<b>Map the property (optional):</b> on Site Plan, draw the house and walk the yard boundary by GPS to produce a plot plan of the whole lot.",
  "<b>Aim the gateway (if cellular):</b> use the Cellular page to find the best SINR/RSRP spot — watch the Excellent/Good/Fair/Poor verdict — then survey the Wi-Fi it puts out.",
  "<b>Survey:</b> walk and tap where you stand — indoors on the floor plan, outdoors by phone GPS. Pick a target (Voice / Data / Video) and watch % passing climb. The heatmap builds live.",
  "<b>Analyze:</b> switch metrics and colormaps, flip to Pass/Fail, turn on Contour lines, and use Predict coverage to model where to add access points before you walk.",
  "<b>Deliver:</b> back on Mission Control (or Report), the 0–100 score + findings + infrastructure summary are ready — Generate Report → Save as PDF, and export .json / .csv / .kml.",
];
const GUIDE_PAGES = [
  { name: "Mission Control", desc: "Your home base — the whole survey at a glance. A 0–100 signal score, live vitals (rooms, best/worst, dead spots in ft², % passing, area), a progress checklist, top findings you can locate on the map, quick links to every tool, and the one-click Generate Report." },
  { name: "Live", desc: "Stand somewhere and read the signal right now — a big live gauge plus a one-tap speed test (download / upload / responsiveness). Use it to hunt a dead spot or find the best router shelf." },
  { name: "Coverage", desc: "The main survey. Build a base map, walk and tap where you stand, and the heatmap builds live. Pick a target (Voice/Data/Video) for a live % passing, set a scale for real square footage, add contour lines, and use Predict coverage to model APs before you walk. Tools are grouped under the 🛠 Tools menu." },
  { name: "Site Plan", desc: "A plot plan for the whole property. Draw the house footprint by hand, walk the yard boundary with your phone GPS (to real scale), then drop the house where it sits on the lot. House and property are separate objects you can place, rotate, and resize." },
  { name: "Cellular", desc: "Aim a home cellular gateway or antenna. Live bars plus RSRP / RSRQ / SINR with Excellent/Good/Fair/Poor grades and an overall verdict find the window or wall with the best tower signal. Aim this first, then survey the Wi-Fi." },
  { name: "GPS", desc: "Walk a property outdoors. Your phone streams its location to the Mac; drop readings and property corners as you walk, trace a boundary, and export it to Google Earth (.kml)." },
  { name: "Report", desc: "Client details, the 0–100 score with plain-English findings, an infrastructure & security summary, and site photos. Make the report, then Save as PDF. Also where you save, export (.json/.csv/.kml), or re-open a survey." },
  { name: "Advanced", desc: "Live network internals (RSSI, SNR, channel, PHY, rate), launch buttons for NetSpot and WiFi Explorer, and a nearby-networks table for spotting channel crowding." },
];
function renderGuide() {
  if ($("guidePages")) $("guidePages").innerHTML = GUIDE_PAGES.map((p) => `<div class="guidecard"><h3>${esc(p.name)}</h3><div class="when">${esc(p.desc)}</div></div>`).join("");
  if ($("guideTools")) $("guideTools").innerHTML = GUIDE_TOOLS.map((t) => `<div class="guidecard"><h3>${esc(t.name)}</h3><div class="when"><b>Use it when:</b> ${esc(t.when)}</div><div class="not"><b>Not for:</b> ${esc(t.not)}</div></div>`).join("");
  if ($("guideFlow")) $("guideFlow").innerHTML = "<ol style='padding-left:20px;line-height:1.65;margin:0'>" + GUIDE_FLOW.map((s) => `<li style="margin-bottom:8px">${s}</li>`).join("") + "</ol>";
  if ($("glossary")) $("glossary").innerHTML = TIPS.map((t) => `<div class="gterm">${esc(t.term)}</div><div class="gdef">${esc(t.tip)}</div>`).join("");
}
const PAGE_TITLES = { home: "Mission Control", siteplan: "Site Plan", live: "Live Signal", map: "Coverage", cellular: "Cellular", gps: "GPS Walk", report: "Report", advanced: "Advanced", guide: "Guide" };

/* ---------- Site Plan: hand-drawn house placed inside a GPS-walked property ---------- */
function siteMeters(gps) {
  const midLat = gps.reduce((s, p) => s + p.lat, 0) / gps.length, k = Math.cos((midLat * Math.PI) / 180);
  return gps.map((p) => ({ mx: p.lon * 111320 * k, my: -p.lat * 110540 }));
}
// yard corners → canvas [0,1] fractions (GPS = aspect-preserving fit; else raw tap fractions) + real dimensions
function siteYardFit(W, H) {
  const y = sitePlan.yard;
  if (!y.length) return { pts: [], ftW: 0, ftH: 0, areaFt: 0, gps: false };
  const gps = y.every((p) => p.lat != null) && y.length >= 2;
  if (!gps) return { pts: y.map((p) => ({ x: p.x != null ? p.x : 0.5, y: p.y != null ? p.y : 0.5 })), ftW: 0, ftH: 0, areaFt: 0, gps: false };
  const m = siteMeters(y);
  const minx = Math.min(...m.map((p) => p.mx)), maxx = Math.max(...m.map((p) => p.mx));
  const miny = Math.min(...m.map((p) => p.my)), maxy = Math.max(...m.map((p) => p.my));
  const spanx = Math.max(1e-3, maxx - minx), spany = Math.max(1e-3, maxy - miny), pad = 0.1;
  const sc = Math.min(((1 - 2 * pad) / spanx) * W, ((1 - 2 * pad) / spany) * H);
  const offx = (W - spanx * sc) / 2, offy = (H - spany * sc) / 2;
  const pts = m.map((p) => ({ x: (offx + (p.mx - minx) * sc) / W, y: (offy + (p.my - miny) * sc) / H }));
  let a = 0; for (let i = 0, j = m.length - 1; i < m.length; j = i++) a += (m[j].mx + m[i].mx) * (m[j].my - m[i].my);
  return { pts, ftW: spanx * 3.28084, ftH: spany * 3.28084, areaFt: Math.abs(a / 2) * 10.7639, gps: true };
}
// house base poly + placement transform → canvas fractions (rotation in pixel space so it isn't skewed)
function siteHouseFit(W, H) {
  const h = sitePlan.house, t = sitePlan.houseT || { tx: 0, ty: 0, rot: 0, scale: 1 };
  if (!h || !h.length) return [];
  const cx = h.reduce((s, p) => s + p.x, 0) / h.length, cy = h.reduce((s, p) => s + p.y, 0) / h.length;
  const a = (t.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  return h.map((p) => {
    const dx = (p.x - cx) * W * t.scale, dy = (p.y - cy) * H * t.scale;
    return { x: (cx * W + dx * ca - dy * sa) / W + t.tx, y: (cy * H + dx * sa + dy * ca) / H + t.ty };
  });
}
function sitePoly(ctx, pts, W, H, close) {
  ctx.beginPath();
  pts.forEach((p, i) => { const x = p.x * W, y = p.y * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  if (close) ctx.closePath();
}
function renderSitePlan() {
  const wrap = $("siteWrap"), cv = $("siteCanvas");
  if (!wrap || !cv) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,.045)"; ctx.lineWidth = 1;
  for (let gx = 40; gx < W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
  for (let gy = 40; gy < H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
  const yf = siteYardFit(W, H);
  if (yf.pts.length) {
    sitePoly(ctx, yf.pts, W, H, yf.pts.length >= 3);
    if (yf.pts.length >= 3) { ctx.fillStyle = "rgba(55,220,203,.07)"; ctx.fill(); }
    ctx.strokeStyle = "#37dccb"; ctx.lineWidth = 2.5;
    if (yf.pts.length < 3) ctx.setLineDash([7, 5]);
    ctx.stroke(); ctx.setLineDash([]);
    yf.pts.forEach((p) => { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 5, 0, Math.PI * 2); ctx.fillStyle = "#37dccb"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#04140f"; ctx.stroke(); });
    if (yf.areaFt) { ctx.fillStyle = "#8fecdf"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left"; ctx.fillText("Property · ≈ " + Math.round(yf.areaFt).toLocaleString() + " ft²", 12, H - 14); }
  }
  const hf = siteHouseFit(W, H);
  if (hf.length) {
    sitePoly(ctx, hf, W, H, true);
    ctx.fillStyle = "rgba(245,177,63,.22)"; ctx.fill();
    ctx.strokeStyle = "#f5b13f"; ctx.lineWidth = 2.5; ctx.stroke();
    const cx = hf.reduce((s, p) => s + p.x, 0) / hf.length, cy = hf.reduce((s, p) => s + p.y, 0) / hf.length;
    ctx.fillStyle = "#f5b13f"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("🏠 House", cx * W, cy * H); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    if (siteMode === "house") hf.forEach((p) => { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2); ctx.fillStyle = "#f5b13f"; ctx.fill(); });
  }
  const info = $("siteInfo");
  if (info) info.textContent = (sitePlan.yard.length ? sitePlan.yard.length + " yard corner" + (sitePlan.yard.length > 1 ? "s" : "") : "no yard yet") + (sitePlan.house.length ? " · house " + sitePlan.house.length + " pts" : " · no house yet");
}
function onSiteTap(ev) {
  const r = $("siteWrap").getBoundingClientRect();
  const x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  if (siteMode === "yard") { sitePlan.yard.push({ x, y }); saveSitePlan(); renderSitePlan(); }
  else if (siteMode === "house") { sitePlan.house.push({ x, y }); sitePlan.houseT = { tx: 0, ty: 0, rot: 0, scale: 1 }; saveSitePlan(); renderSitePlan(); }
}
function onSitePointerDown(ev) {
  if (siteMode !== "place" || !sitePlan.house.length) return;
  const r = $("siteWrap").getBoundingClientRect();
  siteDrag = { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height, tx: sitePlan.houseT.tx, ty: sitePlan.houseT.ty };
}
function onSitePointerMove(ev) {
  if (!siteDrag) return;
  const r = $("siteWrap").getBoundingClientRect();
  sitePlan.houseT.tx = siteDrag.tx + ((ev.clientX - r.left) / r.width - siteDrag.x);
  sitePlan.houseT.ty = siteDrag.ty + ((ev.clientY - r.top) / r.height - siteDrag.y);
  renderSitePlan();
}
function onSitePointerUp() { if (siteDrag) { siteDrag = null; saveSitePlan(); } }
function setSiteMode(m) {
  siteMode = m;
  ["yard", "house", "place"].forEach((k) => { const b = $("siteBtn-" + k); if (b) b.classList.toggle("on", k === m); });
  const hint = $("siteHint");
  if (hint) hint.textContent = m === "yard"
    ? "Walk the property boundary — tap “＋ Corner at GPS” at each corner, or tap the plan to place corners by eye."
    : m === "house"
    ? "Tap the corners of the house footprint to draw it. Tap all the way around."
    : "Drag the house to position it inside the property. Use the sliders to rotate and resize it.";
  if ($("sitePlaceCtl")) $("sitePlaceCtl").classList.toggle("hidden", m !== "place");
  if ($("siteWrap")) $("siteWrap").style.cursor = m === "place" ? "grab" : "crosshair";
  renderSitePlan();
}
function siteCornerGps() {
  if (siteMode !== "yard") setSiteMode("yard");
  if (!lastGpsFix || lastGpsFix.age_sec == null || lastGpsFix.age_sec > 25) return toast("No fresh GPS fix — connect your phone on the GPS page first");
  sitePlan.yard.push({ lat: lastGpsFix.lat, lon: lastGpsFix.lon });
  saveSitePlan(); renderSitePlan();
  toast("Yard corner " + sitePlan.yard.length + " dropped");
}
function siteUndo() { if (siteMode === "house") sitePlan.house.pop(); else sitePlan.yard.pop(); saveSitePlan(); renderSitePlan(); }
function siteClear() {
  if (siteMode === "house") { sitePlan.house = []; sitePlan.houseT = { tx: 0, ty: 0, rot: 0, scale: 1 }; }
  else if (siteMode === "place") { sitePlan.houseT = { tx: 0, ty: 0, rot: 0, scale: 1 }; if ($("siteRot")) $("siteRot").value = 0; if ($("siteScale")) $("siteScale").value = 100; }
  else sitePlan.yard = [];
  saveSitePlan(); renderSitePlan();
}
function setSiteRot(v) { sitePlan.houseT.rot = +v; saveSitePlan(); renderSitePlan(); }
function setSiteScale(v) { sitePlan.houseT.scale = +v / 100; saveSitePlan(); renderSitePlan(); }

/* ---------- Mission Control home ---------- */
function renderHome() {
  renderSummary();
  renderHomeProgress();
  if (!$("mcScore")) return;
  const site = {}; SITE_FIELDS.forEach((f) => (site[f] = $(f) ? $(f).value : ""));
  if (!points.length) {
    $("mcScore").textContent = "—";
    $("mcGrade").textContent = "No data";
    $("mcRing").style.setProperty("--rc", "var(--na)");
    $("mcRing").style.setProperty("--pct", 0);
    $("mcTitle").textContent = "Your survey at a glance";
    $("mcSummary").textContent = "Capture a few readings and this hub fills in — signal score, coverage, dead spots, cellular, and your client report, all from one screen.";
    $("mcFindings").innerHTML = '<p class="muted" style="font-size:13px">No findings yet — capture readings to populate.</p>';
    return;
  }
  const ins = computeInsights(points, site, surveyEnv);
  $("mcScore").textContent = ins.score;
  $("mcGrade").textContent = ins.grade;
  $("mcRing").style.setProperty("--rc", ins.gradeInk);   // dark UI → screen palette, not the PDF's
  $("mcRing").style.setProperty("--pct", ins.score);
  $("mcTitle").textContent = (site.f_client || "This survey") + " · " + ins.grade;
  $("mcSummary").innerHTML = ins.summary;
  $("mcFindings").innerHTML = ins.findings.slice(0, 3).map((f) => {
    const fc = SEVERITY_COLOR[f.severity];
    const loc = f.loc ? `<button class="rilocate" onclick="locateOnMap(${(+f.loc.x).toFixed(4)},${(+f.loc.y).toFixed(4)},'${esc(f.loc.level || "")}')">📍 Locate</button>` : "";
    return `<div class="mc-find" style="--fc:${fc}"><div class="mc-find-sev">${f.severity}${loc}</div><div>${f.text}</div></div>`;
  }).join("");
}
function renderHomeProgress() {
  const el = $("mcProgress");
  if (!el) return;
  const sc = getScale();
  const steps = [
    { k: "Floor plan / map set", done: planMode != null },
    { k: "Readings captured", done: points.length > 0, note: points.length ? points.length + " pts" : "" },
    { k: "Scale calibrated", done: !!sc, note: sc ? (sc.source === "gps" ? "from GPS" : "calibrated") : "" },
    { k: "Router / AP marked", done: apMarks.length > 0 },
    { k: "Cellular checked", done: cellPoints.length > 0 || !!lastCell },
    { k: "Report ready", done: points.length > 0 },
  ];
  el.innerHTML = steps.map((s) => `<div class="mc-step ${s.done ? "done" : ""}"><span class="mc-check">✓</span><span class="mc-step-k">${s.k}</span><span class="mc-step-n">${s.note || ""}</span></div>`).join("");
}
function renderReportInsights() {
  const el = $("reportInsights");
  if (!el) return;
  if (!points.length) { el.innerHTML = '<p class="muted">Save some readings and the Wi-Fi signal score + findings will appear here, then flow into your PDF.</p>'; return; }
  const site = {}; SITE_FIELDS.forEach((f) => (site[f] = $(f) ? $(f).value : ""));
  const ins = computeInsights(points, site, surveyEnv);
  const cards = ins.findings.slice(0, 5).map((f) => {
    const fc = SEVERITY_COLOR[f.severity];
    const loc = f.loc ? `<button class="rilocate" onclick="locateOnMap(${(+f.loc.x).toFixed(4)},${(+f.loc.y).toFixed(4)},'${esc(f.loc.level || "")}')">📍 Locate</button>` : "";
    return `<div class="rifind" style="--fc:${fc}"><div class="rsev">${f.severity}${loc}</div>${f.text}${f.rec ? `<div class="muted" style="margin-top:4px;font-size:12.5px"><b>→</b> ${f.rec}</div>` : ""}</div>`;
  }).join("");
  el.innerHTML = `<div class="risum"><div class="rbadge" style="--rc:${ins.gradeInk}"><div class="rn">${ins.score}</div><div class="rg">${ins.grade}</div></div>
    <div style="font-size:14px;line-height:1.5">${ins.summary}</div></div>${cards}`;
}

/* ---------- boot ---------- */
buildZones();
buildSpeedZones();            // Live-page speed dial: colored zones…
buildSpeedTicks(speedMax);    // …initial 0 / max/2 / max tick labels (default 500)…
updateSpeedGauge(0, speedMax); // …and needle parked at 0 until the first Speed Test run
loadProfiles();     // BEFORE loadState: establish/migrate the registry + active profile id
loadState();        // reads the working keys into memory (= the active profile's live data)
// capture the active profile's live state into its bundle ONCE (first-run migration);
// skip on steady-state reloads so we don't re-serialize a large survey every load
if (activeProfile && !localStorage.getItem(PROFILE_PREFIX + activeProfile)) snapshotActiveProfile();
syncActiveName();   // reflect the loaded client name on the active profile's label (unless manually renamed)
if ($("f_client")) $("f_client").addEventListener("input", syncActiveName);  // live label update as the client name is typed
renderProfileMenu();
renderHeatUI();
showPage(localStorage.getItem(LS_PAGE) || "home");
// Both redraws run per-pixel interpolation over the whole canvas. Fired raw, a drag-resize
// queues one full pass per resize event and locks the main thread; coalesce to one per frame.
let resizeRaf = null;
window.addEventListener("resize", () => {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = null;
    renderCoverageMap();
    renderSitePlan();
  });
});
document.addEventListener("click", (e) => { if (!e.target.closest(".dropdown")) closeDrops(); });
if ($("siteWrap")) {
  const sw = $("siteWrap");
  sw.addEventListener("pointerdown", onSitePointerDown);
  sw.addEventListener("pointermove", onSitePointerMove);
  window.addEventListener("pointerup", onSitePointerUp);
}
poll();
setInterval(poll, 5000);
