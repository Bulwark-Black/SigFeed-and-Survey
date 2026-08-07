// Phone GPS bridge, profile switcher, and persistence.

import { renderYouAreHere } from "./basemap.js";
import { renderCellSpots, renderHeatmapThumb, renderReportPhotos, saveCellPoints, savePhotos } from "./cellular.js";
import { api, rate, showPage, store, toast, updateSideStatus } from "./core.js";
import { scheduleLivePush } from "./earth.js";
import { renderCoverageMap } from "./heatmap.js";
import { renderPoints } from "./live.js";
import { renderReportInsights, saveSitePlan } from "./pages.js";
import { applyLevelMap, curLevel, initLevels, renderLevelTabs, saveLevelMap, saveLevels } from "./planner.js";
import { esc, roomOf } from "./report.js";
import { $, LS_ACTIVELEVEL, LS_ACTIVEPROFILE, LS_CELL, LS_CELLPTS, LS_HEATMAP, LS_IMPORTEDSCAN, LS_LEVELS, LS_PHOTOS, LS_POINTS, LS_PROFILES, LS_SITE, LS_SITEPLAN, LS_SURVEYENV, PROFILE_PREFIX, SITE_FIELDS, activeLevel, activeProfile, apMarks, cellPoints, emptySitePlan, floorPlanUrl, heatmapDataUrl, importedScan, levels, perimeter, planMode, points, reportPhotos, rooms, set, sitePlan, surveyEnv } from "./state.js";
/* ---------- phone GPS bridge ---------- */
let profiles = [];        // [{id,name,updated}] registry: mirrors LS_PROFILES
let gpsTimer = null;
// The connection poll runs whenever the GPS page is visible (see showPage()),
// independent of the "tag readings" checkbox. The checkbox only decides whether
// a fix gets stamped onto saved points.
function toggleGps() {
  set.gpsEnabled($("gpsEnable").checked);
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
      set.lastGpsFix(d.fix);
      const acc = d.fix.acc != null ? "±" + Math.round(d.fix.acc) + " m" : "accuracy unknown";
      const age = Math.round(d.fix.age_sec);
      if (d.fix.age_sec > 20) {
        setGpsBadge("stale", `Last fix ${age}s ago (stale)`, "Is the phone app still running & broadcasting?");
      } else {
        setGpsBadge("ok", `Connected: ${acc}, updated ${age}s ago`,
          `Phone at ${d.fix.lat.toFixed(5)}, ${d.fix.lon.toFixed(5)}`);
      }
      renderYouAreHere(); // move the live "you are here" dot as they walk
      return d.fix;
    }
    set.lastGpsFix(null);
    setGpsBadge("wait", "Waiting for your phone…", "Set up your phone below, then keep this page open.");
    renderYouAreHere();
    return null;
  } catch (e) {
    set.lastGpsFix(null);
    setGpsBadge("wait", "Backend offline", "Is the survey server still running?");
    renderYouAreHere();
    return null;
  }
  // every exit path, so losing a fix puts the pill back to off rather than leaving it live
  updateSideStatus();
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
    toast(`✅ Phone connected. ${acc}, ${Math.round(fix.age_sec)}s ago`);
  } else if (fix) {
    toast(`⚠️ Last fix ${Math.round(fix.age_sec)}s ago. Is the phone app running?`);
  } else {
    toast("No fix yet. Open the GPS app on your phone and start broadcasting.");
  }
}

// Copy a URL <span> to the clipboard with a graceful fallback.
function copyGpsUrl(id) {
  const el = $(id);
  if (!el) return;
  const text = el.textContent;
  const done = () => toast("URL copied. Paste it into your phone's GPS app");
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
    toast("Couldn't copy. Select the URL and copy it manually.");
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
  catch (e) { toast("Couldn't save profile list: storage full"); }
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
  catch (e) { ok = false; toast("Storage full. This survey isn't fully saved to its slot"); }
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
  set.points(Array.isArray(b.points) ? b.points : []);
  set.cellPoints(Array.isArray(b.cellPoints) ? b.cellPoints : []);
  set.importedScan(Array.isArray(b.importedScan) ? b.importedScan : []);
  set.reportPhotos(Array.isArray(b.reportPhotos) ? b.reportPhotos : []);
  set.heatmapDataUrl(b.heatmap || null);
  set.surveyEnv((b.surveyEnv && b.surveyEnv.current) ? b.surveyEnv : null);
  set.sitePlan((b.siteplan && b.siteplan.yard) ? b.siteplan : emptySitePlan());
  saveSitePlan();
  set.levels((b.levels && b.levels.length) ? b.levels
    : [{ id: "L1", name: "Main floor", planMode: null, floorPlanUrl: null, rooms: [], perimeter: [], apMarks: [], sqft: "", snapshot: null }]);
  set.activeLevel(b.activeLevel || levels[0].id);

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
  set.activeProfile(id);
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
  set.activeProfile(id);
  restoreProfileBundle(emptyBundle());      // reset the app to a clean survey
  try { localStorage.setItem(PROFILE_PREFIX + id, JSON.stringify(emptyBundle())); }
  catch (e) { toast("Storage full. Couldn't reserve the new survey slot"); }
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
      set.activeProfile(profiles[0].id);
      restoreProfileBundle(readBundle(activeProfile));
    } else {
      // nothing left — mint a fresh clean one
      const nid = "P" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
      profiles.push({ id: nid, name: "Survey 1", updated: Date.now() });
      set.activeProfile(nid);
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
  try { set.activeProfile(localStorage.getItem(LS_ACTIVEPROFILE) || null); } catch (e) { set.activeProfile(null); }
  if (!profiles.length) {
    let name = "Survey 1";
    try { const s = JSON.parse(localStorage.getItem(LS_SITE)) || {}; if (s.f_client && s.f_client.trim()) name = s.f_client.trim(); } catch (e) {}
    const id = "P" + Date.now() + "-" + Math.floor(Math.random() * 1e4);
    profiles = [{ id, name, updated: Date.now() }];
    set.activeProfile(id);
    saveProfilesRegistry();
  } else if (!activeProfile || !profiles.some((p) => p.id === activeProfile)) {
    set.activeProfile(profiles[0].id);
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
// Every reading, every edit and every deletion already funnels through here, which makes it the
// one place the live Google Earth view needs to know about.
function savePoints() { const ok = store(LS_POINTS, JSON.stringify(points)); scheduleLivePush(); return ok; }
function saveSite() {
  const s = {};
  SITE_FIELDS.forEach((f) => (s[f] = $(f).value));
  return store(LS_SITE, JSON.stringify(s));
}
function loadState() {
  try { set.points(JSON.parse(localStorage.getItem(LS_POINTS)) || []); } catch (e) { set.points([]); }
  try {
    const s = JSON.parse(localStorage.getItem(LS_SITE)) || {};
    SITE_FIELDS.forEach((f) => { if (s[f] && $(f)) $(f).value = s[f]; });
  } catch (e) {}
  try {
    const cc = JSON.parse(localStorage.getItem(LS_CELL)) || {};
    if (cc.ip) $("cellIp").value = cc.ip;
    if (cc.pass) $("cellPass").value = cc.pass;
  } catch (e) {}
  try { set.cellPoints(JSON.parse(localStorage.getItem(LS_CELLPTS)) || []); } catch (e) { set.cellPoints([]); }
  try { set.heatmapDataUrl(localStorage.getItem(LS_HEATMAP) || null); } catch (e) {}
  try { set.reportPhotos(JSON.parse(localStorage.getItem(LS_PHOTOS)) || []); } catch (e) { set.reportPhotos([]); }
  try { set.importedScan(JSON.parse(localStorage.getItem(LS_IMPORTEDSCAN)) || []); } catch (e) { set.importedScan([]); }
  try { const sp = JSON.parse(localStorage.getItem(LS_SITEPLAN)); set.sitePlan(sp && sp.yard ? sp : emptySitePlan()); } catch (e) { set.sitePlan(emptySitePlan()); }
  try { const se = JSON.parse(localStorage.getItem(LS_SURVEYENV)); set.surveyEnv(se && se.current ? se : null); } catch (e) { set.surveyEnv(null); }
  try { set.levels(JSON.parse(localStorage.getItem(LS_LEVELS)) || []); } catch (e) { set.levels([]); }
  try { set.activeLevel(localStorage.getItem(LS_ACTIVELEVEL) || null); } catch (e) {}
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
  if (!bundle.points.length && !bundle.cellPoints.length) return toast("Nothing to save yet. Take some readings first.");
  const blob = new Blob([JSON.stringify({ format: "wifi-survey", version: 1, ...bundle }, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "wifi-survey-" + (($("f_client") && $("f_client").value) || "site").replace(/\W+/g, "_") + ".json";
  a.click();
  toast(`Survey file saved: ${bundle.points.length} readings, re-open it here any time`);
}

// Export every reading as a plain CSV — the format clients actually open (Excel/Numbers/Sheets).
// One row per reading with room/floor attribution, all RF metrics, throughput and GPS.
function exportCSV() {
  saveLevelMap();
  if (!points.length) return toast("No readings yet. Take some on the Coverage page first.");
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
  toast("CSV saved. Opens in Excel / Numbers / Sheets");
}

// Export readings + perimeter + AP markers to a KML file that opens directly in
// Google Earth Pro or Google Maps — no Google Earth needed to view, but it's there
// if they want it. Readings use their real GPS coords when present, else the aerial
// inverse transform. Needs an aerial (geoBounds) or at least one GPS-tagged point.

export { checkGpsNow,copyGpsUrl,deleteProfile,exportCSV,exportJSON,loadProfiles,loadState,
  newProfile,renameProfile,renderProfileMenu,restoreProfileBundle,savePoints,saveSite,
  snapshotActiveProfile,startGpsPoll,stopGpsPoll,switchProfile,syncActiveName,toggleGps,
  toggleProfileMenu };
