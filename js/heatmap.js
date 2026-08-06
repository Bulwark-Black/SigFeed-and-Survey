// The coverage engine: IDW grid, contours, clipping, and map rendering.

import { setFloorPlan } from "./basemap.js";
import { rate, showPage, toast } from "./core.js";
import { renderSummary } from "./live.js";
import { curLevel, renderRooms, switchLevel, updateScaleUI } from "./planner.js";
import { esc } from "./report.js";
import { $, PL_TXREF, activeLevel, apMarks, calTemp, calibration, floorPlanImg, geoBounds, heatMetric, heatMode, heatPreset, levels, mapMode, perimeter, plExponent, planMode, points, predictAPs, reqProfile, set, showContours, showHeatmap, showPredict } from "./state.js";
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
// Readings saved from the Live page or the ✓ SAVE button carry no map position. They show up
// in the list, the table and the CSV, but every spatial figure — heatmap, surveyed area,
// % passing, dead-zone footage, the map image in the PDF — skips them. Left unflagged, a
// technician can walk an entire property the fast way and only discover at report time that
// there is no map. This is what makes them visible and repairable.
function unplacedPoints() { return points.filter((p) => p.mapX == null); }

// Readings with no map position carry x/y of NaN and would poison every cell they touch,
// so they are dropped here rather than silently turning the whole grid into NaN.
function idwSamples(pts, get) {
  return pts
    .map((p) => ({ x: p.mapX, y: p.mapY, s: get(p) }))
    .filter((p) => p.s != null && !isNaN(p.s) && Number.isFinite(p.x) && Number.isFinite(p.y));
}

// `ar` is the map's TRUE height/width in feet — pass mapAspect(). Distance falloff has to be
// measured on the ground, not in canvas pixels: every other consumer of the grid (drawContours,
// requirementStats, drawRequirementOverlay, holeAreaSqft) already uses mapAspect(), and this one
// used the pixel aspect instead. The two agree only while the base map is square, which every
// Esri aerial is (1024×1024) and no Google Earth capture is — so the wash would have been drawn
// against a differently-stretched field than the pass rate printed beside it in the same report.
function buildHeatCanvas(pts, gw, gh, ar) {
  const M = METRICS[heatMetric];
  const c = document.createElement("canvas");
  c.width = gw; c.height = gh;
  const ctx = c.getContext("2d");
  const im = ctx.createImageData(gw, gh), d = im.data;
  const P = idwSamples(pts, M.get);
  if (!P.length) { ctx.putImageData(im, 0, 0); return c; }
  const aspect = (ar != null ? ar : gh / gw);   // map height as a fraction of its width
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
  const bands = contourLevels(grid);
  if (!bands.length) return;
  const sx = W / (gw - 1), sy = H / (gh - 1);
  const v = (x, y) => grid[y * gw + x];
  const f = (a, b, L) => (L - a) / (b - a);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  bands.forEach((L, li) => {
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
  set.reqProfile(v);
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
  el.title = `${reqGateText(prof)}: estimated % of the surveyed area (interpolated, clipped to the walked area)`;
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
  const t = "🔮 PREDICTED: modeled, not measured";
  ctx.save();
  ctx.font = "bold 12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  const w = ctx.measureText(t).width + 18;
  ctx.fillStyle = "rgba(55,220,203,.92)";
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(12, 12, w, 26, 7); ctx.fill(); } else ctx.fillRect(12, 12, w, 26);
  ctx.fillStyle = "#04140f"; ctx.fillText(t, 21, 26);
  ctx.restore();
}
function setHeatMetric(v) { set.heatMetric(v); renderHeatUI(); renderCoverageMap(); }
function setHeatMode(v) {
  set.heatMode(v);
  if ($("heatPreset")) $("heatPreset").classList.toggle("hidden", v !== "passfail");
  if ($("heatCmapSel")) $("heatCmapSel").classList.toggle("hidden", v === "passfail");
  renderHeatUI();
  renderCoverageMap();
}
function setHeatPreset(v) { set.heatPreset(v); renderHeatUI(); renderCoverageMap(); }
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
    ctx.drawImage(buildHeatCanvas(mapped, gw, gh, mapAspect()), 0, 0, cw, ch);
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
      set.calibration(null); set.calTemp({ a: null, b: null });
      set.geoBounds(null);
      if (curLevel()) { curLevel().cal = null; curLevel().geo = null; }
      setFloorPlan(url);
      toast("Floor plan added. Tap where you're standing");
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(f);
  ev.target.value = "";
}

export { METRICS,REQ_PROFILES,buildHeatCanvas,colormapCss,coverageHull,drawApMarks,drawContours,
  drawRequirementOverlay,getScale,haversineFt,heatClip,holeAreaSqft,loadFloorPlan,locateOnMap,
  mapAspect,mappedPoints,perimPath,pointColor,polyFracArea,predictReachFt,renderCoverageMap,
  renderHeatUI,reqGateText,requirementHull,requirementStats,scaleFor,setHeatColormap,
  setHeatMetric,setHeatMode,setHeatPreset,setReqProfile,surveyedSqft,unplacedPoints };
