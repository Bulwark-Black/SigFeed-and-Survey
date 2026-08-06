// Google Earth output: the live NetworkLink feed and the KMZ writer.

import { mapToLatLonIn } from "./basemap.js";
import { API_KEY, LIVE_TOKEN, api, rate, toast, warn } from "./core.js";
import { restoreProfileBundle, savePoints } from "./gps.js";
import { buildHeatCanvas, haversineFt, heatClip, renderCoverageMap } from "./heatmap.js";
import { renderPoints } from "./live.js";
import { saveLevelMap } from "./planner.js";
import { esc } from "./report.js";
import { $, activeLevel, cellPoints, lastGpsFix, levels, perimeter, points, set } from "./state.js";
/* ---------- live view in Google Earth ---------- */
// Google Earth polls the local server every few seconds; this pushes the current survey to it
// so coverage builds up on the imagery while the property is being walked.
let livePush = null;      // pending debounce timer
let liveOn = false;
// Google Earth keeps every NetworkLink it is handed, and there is no way to remove one from
// here. Opening a second time therefore draws the whole survey twice — doubled labels, doubled
// overlay. Once this session has handed Earth a link, stopping and restarting just resumes
// pushing to the link that is already there.
let liveOpened = false;
let liveStalled = false;   // warn once per stall, not once per retry

// Put the button back to "off" WITHOUT re-entering toggleLiveEarth — calling it again would flip
// liveOn straight back to true and fire another /api/live/open, which on a failing server loops
// for as long as the page is open.
function liveOff(msg) {
  liveOn = false;
  clearTimeout(livePush);
  const b = $("btnLive");
  if (b) { b.classList.remove("on"); b.textContent = "🛰 Live in Google Earth"; }
  if (msg) warn(msg);
}

function toggleLiveEarth() {
  liveOn = !liveOn;
  const b = $("btnLive");
  if (b) { b.classList.toggle("on", liveOn); b.textContent = liveOn ? "🛑 Stop live view" : "🛰 Live in Google Earth"; }
  if (!liveOn) { clearTimeout(livePush); return toast("Live view stopped. Google Earth will keep the last picture."); }
  if (liveOpened) {
    toast("Live view resumed. Google Earth is already watching.");
    return pushLive();
  }
  api("/api/live/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then((r) => {
      if (!r.ok) return liveOff(r.error || "Couldn't open Google Earth.");
      liveOpened = true;
      toast(`Live view on. Google Earth refreshes every ${r.refresh}s as you walk.`);
      // Earth draws its 3D trees on top of the coverage wash, so on a wooded lot the colour only
      // shows through gaps in the canopy. There is no way to fix that from the KML side.
      const hint = $("liveHint");
      if (hint) hint.classList.remove("hidden");
      pushLive();
    })
    .catch((e) => liveOff(e.message || "Couldn't reach the server."));
}

// Called from savePoints/saveLevels. Debounced: a walk generates a burst of writes and Earth
// only reads every few seconds anyway, so pushing on every keystroke would be wasted work.
function scheduleLivePush() {
  if (!liveOn) return;
  clearTimeout(livePush);
  livePush = setTimeout(pushLive, 1200);
}

async function pushLive() {
  if (!liveOn) return;
  try {
    const built = buildSurveyKml({ live: true });
    await api("/api/live/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc: built.doc, overlay: built.overlay }),
    });
    if (liveStalled) { liveStalled = false; toast("Live view caught up. Google Earth is current again."); }
  } catch (e) {
    // Swallowing this was wrong. Google Earth keeps polling happily and keeps redrawing the LAST
    // ACCEPTED frame, so a stalled push looks exactly like a working one. And a push that failed
    // on size never recovers by itself — readings only accumulate. Say it once per stall.
    if (!liveStalled) {
      liveStalled = true;
      warn("Google Earth is showing an older picture: " + (e.message || "the update didn't go through"));
    }
  }
}

/* ---------- KMZ (zip) writer ---------- */
// A KMZ is a zip. Stored entries only — the payload is already-compressed PNG and JPEG, so
// deflating would cost code and buy nothing. ~60 lines beats taking on a zip dependency in a
// project that deliberately has none.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// files: [{name, bytes:Uint8Array}] -> Blob
function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  files.forEach((f) => {
    const name = enc.encode(f.name), crc = crc32(f.bytes), len = f.bytes.length;
    const local = new Uint8Array([
      0x50, 0x4B, 0x03, 0x04, ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),                       // no timestamp: keeps exports reproducible
      ...u32(crc), ...u32(len), ...u32(len), ...u16(name.length), ...u16(0),
    ]);
    chunks.push(local, name, f.bytes);
    central.push(new Uint8Array([
      0x50, 0x4B, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0),
      ...u32(crc), ...u32(len), ...u32(len), ...u16(name.length),
      ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]), name);
    offset += local.length + name.length + len;
  });
  const cdStart = offset;
  let cdSize = 0;
  central.forEach((c) => { cdSize += c.length; });
  const end = new Uint8Array([
    0x50, 0x4B, 0x05, 0x06, ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(cdStart), ...u16(0),
  ]);
  return new Blob([...chunks, ...central, end], { type: "application/vnd.google-earth.kmz" });
}
function dataUrlToBytes(u) {
  const bin = atob(u.split(",", 2)[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// KML colour is aabbggrr, NOT rgba — the byte order is reversed and alpha comes first.
function kmlColor(hex, alpha) {
  const h = hex.replace("#", "");
  return ((alpha & 0xFF).toString(16).padStart(2, "0") + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2));
}

// The coverage wash for one level as a transparent PNG, in the level's own geo box.
// buildHeatCanvas already fades to alpha 0 away from readings; heatClip is what keeps it inside
// the drawn boundary instead of painting the whole rectangle.
function heatOverlayPng(levelPts, geo, W, levelPerimeter) {
  if (!levelPts.length || !geo) return null;
  W = W || 1024;
  const H = Math.max(1, Math.round(W * mapAspectOf(geo)));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.save();
  // heatClip reads the module-level `perimeter`, i.e. whichever level happens to be open. On a
  // multi-level export that clipped the upstairs wash to the ground floor's boundary. Swap in the
  // level's own boundary for the duration of the draw, then put it back.
  const saved = perimeter;
  set.perimeter(levelPerimeter || []);
  try { heatClip(ctx, W, H, levelPts); } finally { set.perimeter(saved); }
  ctx.drawImage(buildHeatCanvas(levelPts, Math.min(W, 260), Math.min(H, 260), mapAspectOf(geo)), 0, 0, W, H);
  ctx.restore();
  return c.toDataURL("image/png");
}
// True feet aspect of an arbitrary level's box — mapAspect() only knows the active level.
function mapAspectOf(geo) {
  if (!geo) return 1;
  const midLat = (geo.north + geo.south) / 2, midLon = (geo.west + geo.east) / 2;
  const w = haversineFt(midLat, geo.west, midLat, geo.east);
  const h = haversineFt(geo.north, midLon, geo.south, midLon);
  return w > 0 ? h / w : 1;
}

// Export the whole survey to a .kmz that opens in Google Earth: the coverage heatmap as a
// ground overlay, every reading styled by signal, plus boundaries and routers — per level, each
// in its own folder so they can be toggled independently.
// Build the survey as KML. Two consumers with one body of geometry:
//   exportKML()  — a .kmz file, each level's heatmap zipped alongside as its own PNG
//   pushLive()   — the same document served to Google Earth, overlay fetched over http
// Returns {doc, files, overlay}: `doc` is the Document body (no envelope), `files` are the
// entries a KMZ needs, `overlay` is a base64 PNG for the live path.
// Seeded from the clock, not 0: a page reload would otherwise reissue v=1, v=2 … and Google
// Earth caches a GroundOverlay by URL, so a repeated URL can redraw the previous survey's wash.
let liveVersion = Date.now() % 1000000;
function buildSurveyKml(opts) {
  const live = !!(opts && opts.live);
  const x = (s) => esc(s);
  const files = [];
  let overlay = null;
  const parts = [];
  const emitted = new Set();   // points already placed in a level folder
  if (live) liveVersion++;

  // one style per rating, so signal quality is visible instead of every pin looking the same
  ["exc", "good", "fair", "poor", "na"].forEach((cls) => {
    const c = { exc: "#34d399", good: "#a3e635", fair: "#fbbf24", poor: "#f87171", na: "#7c8aa6" }[cls];
    parts.push(`<Style id="r_${cls}"><IconStyle><color>${kmlColor(c, 255)}</color><scale>1.1</scale>` +
      `<Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon></IconStyle>` +
      `<LabelStyle><scale>0.8</scale></LabelStyle></Style>`);
  });

  levels.forEach((L, li) => {
    const geo = L.geo || null;
    const lvPts = points.filter((p) => p.level === L.id);
    const mapped = lvPts.filter((p) => p.mapX != null);
    const body = [];

    // heatmap ground overlay, in THIS level's box.
    // Live mode carries only the ACTIVE level: the overlay travels as base64 in a POST body,
    // and one level at 512px is the difference between a comfortable push and one that trips
    // the server's 1 MiB body cap mid-walk.
    const wantOverlay = geo && mapped.length && (!live || L.id === activeLevel);
    if (wantOverlay) {
      const png = heatOverlayPng(mapped, geo, live ? 512 : 1024, L.perimeter);
      if (png) {
        // Earth caches a GroundOverlay by its URL independently of the NetworkLink that named
        // it, so without a changing query the wash would freeze on the first frame forever.
        const href = live
          // 127.0.0.1, not location.origin: Google Earth fetches this from the Mac, and the
          // live routes are loopback-only. Driving the dashboard from a phone would
          // otherwise put the Mac's LAN IP here and get a 403.
          ? `http://127.0.0.1:${location.port || 8765}/api/live/overlay.png?k=${encodeURIComponent(LIVE_TOKEN || API_KEY)}&v=${liveVersion}`
          : `overlay_${li}.png`;
        if (live) overlay = png; else files.push({ name: href, bytes: dataUrlToBytes(png) });
        // Clamped to the ground, the wash is drawn UNDER Google Earth's 3D trees and buildings —
        // on a wooded lot it disappears exactly where the survey matters most. Floating it above
        // the canopy keeps it visible. relativeToGround (not absolute) so it follows terrain on
        // a slope instead of cutting into a hillside.
        // Google Earth's 3D trees and buildings always draw OVER a GroundOverlay, so on a wooded
        // lot the wash shows through gaps in the canopy and nowhere else. Measured: raising the
        // overlay to 250 m with relativeToGround changes nothing — the occlusion is render order,
        // not depth, so there is no KML-side fix. The technician turns off Google Earth's
        // "3D Buildings" layer instead, which is why the UI says so.
        body.push(`<GroundOverlay><name>Coverage heatmap</name><color>b4ffffff</color><drawOrder>1</drawOrder>` +
          `<Icon><href>${x(href)}</href><refreshMode>onChange</refreshMode></Icon>` +
          `<LatLonBox><north>${geo.north}</north><south>${geo.south}</south>` +
          `<east>${geo.east}</east><west>${geo.west}</west><rotation>0</rotation></LatLonBox></GroundOverlay>`);
      }
    }

    lvPts.forEach((p) => {
      let lat = null, lon = null;
      if (p.gps && p.gps.lat != null && p.gps.lon != null) { lat = p.gps.lat; lon = p.gps.lon; }
      else if (p.mapX != null && geo) {
        const ll = mapToLatLonIn(geo, p.mapX, p.mapY);
        if (ll) { lat = ll.lat; lon = ll.lon; }
      }
      if (lat == null) return;
      emitted.add(p);
      const r = rate(p.signal, p.snr);
      const desc = `${p.signal != null ? p.signal + " dBm" : "no signal"} · ${r.word}`
        + (p.ssid ? " · " + p.ssid : "") + (p.snr != null ? " · SNR " + p.snr : "");
      body.push(`<Placemark><name>${x(p.location || "Reading")}</name>` +
        `<description>${x(desc)}</description><styleUrl>#r_${r.cls}</styleUrl>` +
        `<Point><coordinates>${lon},${lat},0</coordinates></Point></Placemark>`);
    });

    // These used to read the ACTIVE level's globals, so every other floor's routers and
    // boundary silently vanished from the export.
    if (geo) {
      (L.apMarks || []).forEach((a) => {
        const ll = mapToLatLonIn(geo, a.x, a.y);
        body.push(`<Placemark><name>${x(a.label || "Router")}</name>` +
          `<description>Router / access point</description>` +
          `<Point><coordinates>${ll.lon},${ll.lat},0</coordinates></Point></Placemark>`);
      });
      const per = L.perimeter || [];
      if (per.length >= 2) {
        const coords = per.map((pt) => { const ll = mapToLatLonIn(geo, pt.x, pt.y); return `${ll.lon},${ll.lat},0`; });
        if (per.length >= 3) coords.push(coords[0]);
        body.push('<Placemark><name>Property boundary</name>' +
          `<Style><LineStyle><color>${kmlColor("#f8bd38", 255)}</color><width>3</width></LineStyle></Style>` +
          `<LineString><tessellate>1</tessellate><coordinates>${coords.join(" ")}</coordinates></LineString></Placemark>`);
      }
    }
    if (body.length) parts.push(`<Folder><name>${x(L.name || "Level")}</name>${body.join("")}</Folder>`);
  });

  // readings with a GPS fix but no level geo would otherwise be dropped entirely
  // Anything with a real fix that no level folder already carried. Deriving this from
  // "level has no geo" instead double-counted every GPS reading on a schematic level:
  // the level loop emits it from p.gps, then this emitted it again.
  const orphans = points.filter((p) => p.gps && p.gps.lat != null && !emitted.has(p));
  if (orphans.length) {
    parts.push(`<Folder><name>GPS readings</name>` + orphans.map((p) => {
      const r = rate(p.signal, p.snr);
      return `<Placemark><name>${x(p.location || "Reading")}</name><styleUrl>#r_${r.cls}</styleUrl>` +
        `<Point><coordinates>${p.gps.lon},${p.gps.lat},0</coordinates></Point></Placemark>`;
    }).join("") + `</Folder>`);
  }

  // where the surveyor is standing right now — the whole point of watching it live
  if (live && lastGpsFix && lastGpsFix.lat != null && lastGpsFix.age_sec != null && lastGpsFix.age_sec <= 60) {
    parts.push(`<Placemark><name>You are here</name>` +
      `<Style><IconStyle><color>ffffffff</color><scale>1.3</scale>` +
      `<Icon><href>http://maps.google.com/mapfiles/kml/shapes/track.png</href></Icon></IconStyle></Style>` +
      `<Point><coordinates>${lastGpsFix.lon},${lastGpsFix.lat},0</coordinates></Point></Placemark>`);
  }
  return { doc: parts.join("\n"), files, overlay };
}

function exportKML() {
  saveLevelMap();
  const hasGps = points.some((p) => p.gps && p.gps.lat != null);
  if (!levels.some((l) => l.geo) && !hasGps) {
    return toast("KML needs an aerial (Aerial from address) or GPS-tagged readings first.");
  }
  const client = ($("f_client") && $("f_client").value.trim()) || "";
  const built = buildSurveyKml({});
  const doc = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
    + `<name>${esc(client ? client + ": WiFi Survey" : "WiFi Survey")}</name>`
    + built.doc + '</Document></kml>';
  const files = [{ name: "doc.kml", bytes: new TextEncoder().encode(doc) }, ...built.files];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(makeZip(files));
  a.download = (client || "site").replace(/\W+/g, "_") + ".kmz";
  a.click();
  toast("KMZ saved. Open it in Google Earth to see the coverage overlay");
}
// Opening a file REPLACES the survey on screen, so it has to ask first — the neutral-looking
// button was the one destructive action in the app with no confirm.
function importJSON(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    let d;
    try { d = JSON.parse(r.result); } catch (e) { return warn("Import failed. That isn't a survey file."); }
    if (!d || typeof d !== "object" || (!Array.isArray(d.points) && !Array.isArray(d.levels))) {
      return warn("Import failed. That file has no survey data in it.");
    }
    const live = points.length + cellPoints.length;
    if (live && !confirm(
      `Open this survey file?\n\nIt replaces what's on screen now: ${points.length} readings and ${cellPoints.length} candidate spots.\n\n` +
      `Cancel and use “Save survey file” first if you haven't backed this one up.`
    )) return;
    restoreProfileBundle(d);
    // Readings written before levels existed carry no level — adopt the active one so they
    // appear on the map instead of only in the list.
    points.forEach((p) => { if (!p.level) p.level = activeLevel; });
    savePoints();
    renderPoints();
    renderCoverageMap();
    toast(`Opened: ${points.length} readings`);
  };
  r.readAsText(file);
  ev.target.value = "";
}

export { exportKML,importJSON,scheduleLivePush,toggleLiveEarth };
