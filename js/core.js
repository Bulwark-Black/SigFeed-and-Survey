// Ratings, gauges, toasts, the backend call wrapper, and page switching.

import { renderYouAreHere } from "./basemap.js";
import { stopCellAuto } from "./cellular.js";
import { startGpsPoll, stopGpsPoll } from "./gps.js";
import { renderCoverageMap } from "./heatmap.js";
import { PAGE_TITLES, renderGuide, renderHome, renderReportInsights, setSiteMode } from "./pages.js";
import { $, LS_PAGE, geoBounds, set, siteMode, speedMax } from "./state.js";
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
// Follow the live throughput the server is reading off networkQuality, so the needle tracks
// the real measurement while it climbs instead of sitting at zero and then jumping. The dial's
// full-scale value grows with the reading — a 900 Mbps line would otherwise peg the needle for
// the whole run against a 50 Mbps default.
function trackSpeed(mbps) {
  if (mbps > speedMax * 0.98) {
    const grown = niceMax(mbps);
    if (grown !== speedMax) { set.speedMax(grown); buildSpeedTicks(speedMax); }
  }
  updateSpeedGauge(mbps, speedMax);
}

function setSpeedFields(d) {
  $("stDown").textContent = (d.download_mbps ?? "—") + " Mbps";
  $("stUp").textContent = (d.upload_mbps ?? "—") + " Mbps";
  $("stLat").textContent = d.base_rtt_ms != null ? d.base_rtt_ms + " ms" : "—";
  $("stRpm").textContent = d.responsiveness_rpm != null ? Math.round(d.responsiveness_rpm) + " RPM" : "—";
}

function resetSpeedUI(text) {
  updateSpeedGauge(0, speedMax);
  $("speedBig").textContent = text;
  if ($("speedSub")) $("speedSub").textContent = "Download speed";
  ["stDown", "stUp", "stLat", "stRpm"].forEach((i) => { if ($(i)) $(i).textContent = "—"; });
}

let speedPolling = false;
async function runSpeedTest() {
  const b = $("btnSpeedTest");
  if (!b || speedPolling) return;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>&nbsp; Starting…';
  set.speedMax(100);
  buildSpeedTicks(speedMax);
  updateSpeedGauge(0, speedMax);
  $("speedBig").textContent = "…";
  ["stDown", "stUp", "stLat", "stRpm"].forEach((i) => { if ($(i)) $(i).textContent = "…"; });

  const finish = (label) => {
    speedPolling = false;
    b.disabled = false;
    b.innerHTML = "⚡ Speed Test";
    if (label) $("speedBig").textContent = label;
  };

  try {
    await api("/api/quality/start");
  } catch (e) {
    resetSpeedUI("—");
    finish();
    return toast("Couldn't start the speed test. Is the server running?");
  }

  speedPolling = true;
  let lastPhase = "";
  const pollProgress = async () => {
    let s;
    try { s = await api("/api/quality/progress"); }
    catch (e) { resetSpeedUI("—"); finish(); return toast("Lost contact with the speed test"); }

    if (s.phase === "error") { resetSpeedUI("—"); finish(); return toast("Speed test failed: " + (s.error || "")); }

    if (s.phase === "download" || s.phase === "upload") {
      const live = s.phase === "upload" ? s.up : s.down;
      trackSpeed(live);
      $("speedBig").textContent = Math.round(live) + " Mbps";
      if (s.phase !== lastPhase) {
        lastPhase = s.phase;
        b.innerHTML = s.phase === "download"
          ? '<span class="spin"></span>&nbsp; Download…'
          : '<span class="spin"></span>&nbsp; Upload…';
        // the caption has to follow the needle — it read "Download speed" while the dial was
        // showing the upload figure, which is worse than not labelling it at all
        if ($("speedSub")) $("speedSub").textContent = s.phase === "download" ? "Download: measuring…" : "Upload: measuring…";
      }
      // fill each direction in as its half completes, so the numbers appear as they're measured
      if (s.down > 0) $("stDown").textContent = s.down.toFixed(1) + " Mbps";
      if (s.up > 0) $("stUp").textContent = s.up.toFixed(1) + " Mbps";
    }

    if (s.phase === "done" && s.result) {
      const d = s.result, dl = d.download_mbps;
      set.speedMax(niceMax(Math.max(dl || 0, d.upload_mbps || 0)));
      buildSpeedTicks(speedMax);
      animateSpeedNeedle(dl, speedMax);      // settle on the headline download figure
      if ($("speedSub")) $("speedSub").textContent = "Download speed";
      setSpeedFields(d);
      finish((dl != null ? Math.round(dl) : "—") + " Mbps");
      return toast(`↓${dl} / ↑${d.upload_mbps} Mbps`);
    }
    if (!s.running && s.phase !== "done") { resetSpeedUI("—"); finish(); return toast("Speed test stopped"); }
    setTimeout(pollProgress, 250);
  };
  pollProgress();
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

// Browsers give a page roughly 5MB of localStorage, and this survey lives entirely in it:
// site photos, floor plans, composed aerials and a per-level heatmap snapshot are all base64
// JPEGs, which inflate about a third over the raw bytes. Three floors with aerials will reach
// the ceiling on a normal job. store() shouts when a write has already failed; this is so the
// surveyor can see it coming and export while everything still fits.
const STORAGE_BUDGET = 5 * 1024 * 1024;
function storageBytes() {
  let n = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); n += k.length + (localStorage.getItem(k) || "").length; } }
  catch (e) { return 0; }
  return n * 2;    // UTF-16 code units
}
function fmtBytes(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB"; }

let storageWarned = false;
function renderStorageBar() {
  const el = $("storageBar");
  if (!el) return;
  const used = storageBytes(), pct = Math.min(100, Math.round((used / STORAGE_BUDGET) * 100));
  const level = pct >= 85 ? "full" : pct >= 65 ? "warn" : "";
  el.className = "storagebar" + (level ? " " + level : "");
  el.innerHTML = `<span>Browser storage</span><span class="track"><span class="fill" style="width:${pct}%"></span></span>` +
    `<span>${fmtBytes(used)} of ~${fmtBytes(STORAGE_BUDGET)}${pct >= 65 ? ". Save the survey file now; photos and floor plans are what fill this" : ""}</span>`;
  // one nudge per session, at the point where there's still room to act
  if (pct >= 85 && !storageWarned) { storageWarned = true; warn("Browser storage is nearly full. Save the survey file before adding more photos."); }
  if (pct < 65) storageWarned = false;
}

// Every localStorage write goes through here. A write that fails must be loud:
// out in the field a silent quota error looks exactly like "the save button stopped working".
function store(key, value) {
  try { localStorage.setItem(key, value); return true; }
  catch (e) { warn("Storage full. That didn't save. Export the survey now to avoid losing it."); return false; }
}

/* ---------- backend calls ---------- */
// The server injects this run's key into the page it serves; a cross-origin page can't read
// that response, so it can't call the API on the technician's behalf.
const API_KEY = (document.querySelector('meta[name="survey-key"]') || {}).content || "";
// Separate, persistent credential for the live Google Earth feed. Earth holds its NetworkLink
// across server restarts, so anything it fetches must be addressed with a token that outlives
// the process — API_KEY is regenerated every run and would silently 403 into a frozen overlay.
const LIVE_TOKEN = (document.querySelector('meta[name="live-token"]') || {}).content || "";

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
  if (name === "report") { renderReportInsights(); renderStorageBar(); }
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

export { API_KEY,LIVE_TOKEN,api,apiUrl,buildSpeedTicks,buildSpeedZones,buildZones,rate,
  renderStorageBar,runSpeedTest,showPage,store,toast,updateGauge,updateSpeedGauge,warn };
