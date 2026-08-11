// Guide, glossary, Site Plan, and the Mission Control home page.

import { SEVERITY_COLOR } from "./cellular.js";
import { store, toast } from "./core.js";
import { getScale } from "./heatmap.js";
import { renderSummary } from "./live.js";
import { computeInsights, esc } from "./report.js";
import { $, LS_SITEPLAN, SITE_FIELDS, apMarks, cellPoints, lastCell, lastGpsFix, planMode, points, set, siteMode, sitePlan, surveyEnv } from "./state.js";
/* ---------- guide + glossary + report insights ---------- */
const TIPS = [
  { term: "RSSI / Signal (dBm)", tip: "How strong your Wi-Fi is here. It's a negative number: closer to zero (−45) is stronger than −80." },
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
  { term: "Dead spot", tip: "A place with little or no usable Wi-Fi, a good spot for a booster or mesh unit." },
  { term: "Co-channel interference", tip: "When your Wi-Fi and nearby networks share a channel and take turns, slowing everyone down." },
  { term: "SINR (cellular)", tip: "How clean your cell signal is over interference. Higher means faster, steadier phone-network internet." },
  { term: "RSRP (cellular)", tip: "How strong the cell tower signal is. Closer to zero (−80) is stronger than −110." },
  { term: "Cellular antenna placement", tip: "Finds the best window/wall for your home cell gateway by scoring the signal at each spot you test." },
  { term: "GPS accuracy", tip: "How precisely your phone knows its location, in meters. Smaller is more exact." },
  { term: "Multi-floor levels", tip: "Tabs for each story so basement, main floor, and upstairs each get their own coverage map." },
  { term: "Wi-Fi signal score", tip: "A 0–100 grade blending coverage, reliability, speed, interference, and cellular signal into one number." },
  { term: "Survey type", tip: "In-house, Around the house, Property, or All: picks which tools you see so the screen stays simple. Switching never deletes your work." },
  { term: "Aerial base map", tip: "A satellite image pulled from an address, used as the map you tap readings onto. No floor plan needed. Best for outdoor and property jobs." },
  { term: "GPS walk & drop", tip: "Stream your phone's location to the Mac and drop a reading at your exact spot as you walk the property. No Google Earth Pro needed." },
  { term: "Contour lines", tip: "Topographic-style lines on the heatmap, each labelled with its value. The app picks a handful of round levels across whatever metric the map is showing (for signal, usually every 2 or 5 dBm), so you can see how steeply coverage falls off across a space." },
  { term: "KMZ / Google Earth export", tip: "Saves the coverage heatmap, every reading, your boundary and the routers as a .kmz that opens in Google Earth or goes to the client." },
  { term: "CSV export", tip: "Every reading as a spreadsheet row: room, floor, band, channel, RSSI, SNR, rate, rating, GPS. For records or a client who wants raw numbers." },
  { term: "Speed test gauge", tip: "A one-tap needle sweep for download, upload, and responsiveness, measuring your real internet path with macOS's built-in tool." },
  { term: "Mission Control", tip: "The home page, your whole survey on one screen: signal score, live vitals, a progress checklist, top findings, and the Generate Report button." },
  { term: "Coverage target", tip: "Pick what a space is used for (Voice, Data, Video, High-density) and the map grades every spot pass/fail, showing the % of the area that meets it." },
  { term: "Scale / square footage", tip: "Draw a known distance (a 10-ft wall) to teach the plan its real size, so coverage holes and areas report in actual square feet." },
  { term: "Predict coverage", tip: "Model an access point's reach before you walk. Drop APs on the plan and see the predicted heatmap in real feet, tuned for open, typical, or dense walls." },
  { term: "Site plan", tip: "A plot plan of the whole property: the hand-drawn house placed inside the GPS-walked yard boundary, so you can show the house on its lot." },
  { term: "Signal verdict (cellular)", tip: "A plain Excellent/Good/Fair/Poor grade for the gateway signal: the worse of coverage (RSRP) and quality (SINR), so a strong-but-noisy signal isn't called good." },
];
const GUIDE_TOOLS = [
  { name: "This app (survey → heatmap + report)", when: "Every job needing a coverage map or client report: the walk where you tap the floor plan. It's your deliverable.", not: "Not a live channel troubleshooter, not a packet-capture or security tool. Diagnose the 'why' with WiFi Explorer." },
  { name: "WiFi Explorer", when: "When you need to know WHY coverage is bad: channels in use, co-channel overlap, competing networks, SNR. Run it before retuning the router.", not: "Doesn't build heatmaps or a report. It describes the air where you stand, not coverage across the house." },
  { name: "NetSpot", when: "A quick visual second-opinion heatmap on-site.", not: "Free tier CAN'T save or export, so it can't be your deliverable. Don't run the billable survey in it." },
  { name: "Apple Wireless Diagnostics (built-in)", when: "The always-available fallback: a quick signal/noise/rate check or a packet capture.", not: "Coarse for channel planning and no report. Use it when nothing else is handy." },
  { name: "T-Mobile gateway app", when: "ONLY the cellular side: aim the gateway / Waveform antenna by SINR & RSRP to find the best window or wall.", not: "Nothing to do with Wi-Fi coverage or the report. Aim the gateway, then survey Wi-Fi with this app." },
  { name: "aircrack-ng", when: "Effectively never on this Mac: it's a security / monitor-mode suite, not a coverage tool.", not: "Not coverage, and it can't even capture here (the Alfa adapter has no Apple-Silicon driver). Skip it for surveys." },
];
const GUIDE_FLOW = [
  "<b>Start at Mission Control:</b> name the survey (client details on the Report page). The home page tracks your progress and score as you go.",
  "<b>Get a base map:</b> on Coverage, draw a schematic, upload a floor plan or photo, auto-layout from a room list, or pull a satellite image from an address. On an uploaded plan or photo, set a scale (🛠 Tools → 📏 Set scale) so areas read in real square feet. An aerial already has true scale from GPS; a drawn schematic has none, so type the home's total sq ft at the top of the Coverage page for rough per-room estimates.",
  "<b>Map the property (optional):</b> on Site Plan, draw the house and walk the yard boundary by GPS to produce a plot plan of the whole lot.",
  "<b>Aim the gateway (if cellular):</b> use the Cellular page to find the best SINR/RSRP spot, watch the Excellent/Good/Fair/Poor verdict, then survey the Wi-Fi it puts out.",
  "<b>Survey:</b> walk and tap where you stand, indoors on the floor plan, outdoors by phone GPS. Pick a target (Voice / Data / Video) and watch % passing climb. The heatmap builds live.",
  "<b>Analyze:</b> switch metrics and colormaps, flip to Pass/Fail, turn on Contour lines, and use Predict coverage to model where to add access points before you walk.",
  "<b>Deliver:</b> back on Mission Control (or Report), the 0–100 score + findings + infrastructure summary are ready. Generate Report → Save as PDF, and export .json / .csv / .kmz.",
];
const GUIDE_PAGES = [
  { name: "Mission Control", desc: "Your home base. The whole survey at a glance. A 0–100 signal score, live vitals (rooms, best/worst, dead spots in ft², % passing, area), a progress checklist, top findings you can locate on the map, quick links to every tool, and the one-click Generate Report." },
  { name: "Live", desc: "Stand somewhere and read the signal right now: a big live gauge plus a one-tap speed test (download / upload / responsiveness). Use it to hunt a dead spot or find the best router shelf." },
  { name: "Coverage", desc: "The main survey. Build a base map, walk and tap where you stand, and the heatmap builds live. Pick a target (Voice/Data/Video) for a live % passing, set a scale for real square footage, add contour lines, and use Predict coverage to model APs before you walk. Tools are grouped under the 🛠 Tools menu." },
  { name: "Site Plan", desc: "A plot plan for the whole property. Draw the house footprint by hand, walk the yard boundary with your phone GPS (to real scale), then drop the house where it sits on the lot. The house is a separate object you can drag, rotate and resize over the property outline." },
  { name: "Cellular", desc: "Aim a home cellular gateway or antenna. Live bars plus RSRP / RSRQ / SINR with Excellent/Good/Fair/Poor grades and an overall verdict find the window or wall with the best tower signal. Aim this first, then survey the Wi-Fi." },
  { name: "GPS", desc: "Walk a property outdoors. Your phone streams its location to the Mac; drop readings and property corners as you walk, trace a boundary, and export the survey to Google Earth (.kmz)." },
  { name: "Report", desc: "Client details, the 0–100 score with plain-English findings, an infrastructure & security summary, and site photos. Make the report, then Save as PDF. Also where you save, export (.json/.csv/.kmz), or re-open a survey." },
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
let siteDrag = null;                  // in-progress house drag
function saveSitePlan() { return store(LS_SITEPLAN, JSON.stringify(sitePlan)); }
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
  set.siteMode(m);
  ["yard", "house", "place"].forEach((k) => { const b = $("siteBtn-" + k); if (b) b.classList.toggle("on", k === m); });
  const hint = $("siteHint");
  if (hint) hint.textContent = m === "yard"
    ? "Walk the property boundary. Tap “＋ Corner at GPS” at each corner, or tap the plan to place corners by eye."
    : m === "house"
    ? "Tap the corners of the house footprint to draw it. Tap all the way around."
    : "Drag the house to position it inside the property. Use the sliders to rotate and resize it.";
  if ($("sitePlaceCtl")) $("sitePlaceCtl").classList.toggle("hidden", m !== "place");
  if ($("siteWrap")) $("siteWrap").style.cursor = m === "place" ? "grab" : "crosshair";
  renderSitePlan();
}
function siteCornerGps() {
  if (siteMode !== "yard") setSiteMode("yard");
  if (!lastGpsFix || lastGpsFix.age_sec == null || lastGpsFix.age_sec > 25) return toast("No fresh GPS fix. Connect your phone on the GPS page first");
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
    $("mcSummary").textContent = "Capture a few readings and this hub fills in: signal score, coverage, dead spots, cellular, and your client report, all from one screen.";
    $("mcFindings").innerHTML = '<p class="muted" style="font-size:13px">No findings yet. Capture readings to populate.</p>';
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

export { PAGE_TITLES,onSitePointerDown,onSitePointerMove,onSitePointerUp,onSiteTap,renderGuide,
  renderHome,renderReportInsights,renderSitePlan,saveSitePlan,setSiteMode,setSiteRot,
  setSiteScale,siteClear,siteCornerGps,siteUndo };
