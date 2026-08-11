// Base maps: Esri aerial, Google Earth capture, USDA NAIP, and reprojection.

import { api, apiUrl, renderStorageBar, toast, warn } from "./core.js";
import { savePoints } from "./gps.js";
import { mappedPoints, renderCoverageMap, unplacedPoints } from "./heatmap.js";
import { addPoint, renderPoints } from "./live.js";
import { curLevel, persistPredict, renderRooms, saveLevelMap, saveLevels, setCalStep, setMapMode } from "./planner.js";
import { esc } from "./report.js";
import { $, activeLevel, apMarks, calTemp, floorPlanImg, geoBounds, lastAerial, lastGpsFix, lastScan, levels, mapMode, perimeter, placingId, planMode, points, predictAPs, set, shapeVerts } from "./state.js";
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


const AERIAL_TILES = 4;   // composed aerial is AERIAL_TILES² tiles (4×4 = 1024px)

// Geo-bounds the composed image WOULD have at this center and zoom. Pure math, no network —
// so zoomAerial can work out what a zoom would do to the readings before committing to it.
function aerialBounds(lat, lon, z) {
  z = Math.max(1, Math.min(21, Math.round(z)));
  const n = AERIAL_TILES;
  const x0f = mercWorldX(lon, z) - n / 2, y0f = mercWorldY(lat, z) - n / 2;
  return {
    west:  tile2lon(x0f, z),
    east:  tile2lon(x0f + n, z),
    north: tile2lat(y0f, z),
    south: tile2lat(y0f + n, z),
    z: z,
  };
}

// A [0,1] fraction of one aerial → the same patch of ground as a fraction of another.
// Deliberately does NOT clamp, unlike gpsToMap: a result outside [0,1] is the useful
// answer — it means that reading falls off the edge of the new frame.
function reprojectFrac(x, y, fromGeo, toGeo) {
  const ll = mapToLatLonIn(fromGeo, x, y);
  if (!ll) return null;
  const z = toGeo.z;
  const x0 = mercWorldX(toGeo.west, z), nx = mercWorldX(toGeo.east, z) - x0;
  const y0 = mercWorldY(toGeo.north, z), ny = mercWorldY(toGeo.south, z) - y0;
  return { x: (mercWorldX(ll.lon, z) - x0) / nx, y: (mercWorldY(ll.lat, z) - y0) / ny };
}

// Make a georeferenced image THE base map for this level, whatever produced it. Every source —
// Esri tiles, a Google Earth capture — funnels through here so they can't drift apart.
//
// `meta` is what the source needs to rebuild or replace this frame later; it must carry a
// `source` so zoomAerial knows whether there's a tile ladder to walk.
//
// Order below is load-bearing. setFloorPlan is not a passive setter: it saves the level and kicks
// off three renderCoverageMap chains, and renderCoverageMap reaches geoBounds through mapAspect()
// → getScale(). Set the georeference first or the heat grid builds at the image's pixel aspect
// instead of its true feet aspect, the "Set scale" button un-hides on a map that already has GPS
// scale, and a level holding an un-georeferenced image can get persisted.
function adoptAerial(dataUrl, bounds, meta) {
  const finite = (v) => typeof v === "number" && isFinite(v);
  // z is not decorative: mercWorldX/Y raise 2 to it, and Math.pow(2, undefined) is NaN, which
  // spreads into every IDW cell a NaN reading touches. z:null would quietly pass as 2^0=1.
  if (!bounds || !["west", "east", "north", "south", "z"].every((k) => finite(bounds[k]))
      || bounds.west >= bounds.east || bounds.north <= bounds.south) {
    warn("That base map has no usable position data. Not loading it.");
    return { ok: false, saved: false };
  }

  set.geoBounds(bounds);
  // An aerial carries true scale, so any manual ruler left over from an uploaded plan is now
  // dead weight — and getScale() prefers geoBounds anyway, so a stale cal would sit there
  // looking authoritative while being ignored. loadFloorPlan already clears these; this didn't.
  set.calibration(null); set.calTemp({ a: null, b: null });
  set.lastAerial(meta || null);
  const L = curLevel();
  if (L) { L.geo = bounds; L.aerial = lastAerial; L.cal = null; }

  setFloorPlan(dataUrl);
  const saved = saveLevels();
  showGpsSpotBtn();
  showAerialBar();
  renderStorageBar();        // the single largest write in the app; show what it cost
  return { ok: true, saved };
}

/* ---------- Google Earth Pro capture ---------- */
// How far a reading can sit from where it really is, in feet. Driven almost entirely by relief:
// tall trees and buildings lean outward from the centre of a nadir photo, so the error is real
// but concentrated around tall things and near the frame edges.
const EARTH_ACC_EXACT_FT = 5;     // below this the base map isn't the limiting error. GPS is
const EARTH_ACC_NOTE_FT  = 25;    // above this, say the number out loud
const EARTH_ACC_STOP_FT  = 82;    // above this a reading can land on the neighbouring parcel

function mToFt(m) { return m * 3.28084; }

// Shrink a capture before it goes into localStorage. Scales uniformly — the bounds describe the
// whole frame, so any change to the pixel aspect would desync the image from its georeference.
function downscaleCapture(dataUrl, maxW) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.naturalWidth);
      if (scale === 1) return resolve(dataUrl);
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Drive Google Earth Pro to a nadir view of (lat,lon) covering `spanM` metres and adopt the
// result as this level's base map. Slow (~30-70s), so it's a start/poll job like the speed test.
async function captureFromEarth(lat, lon, spanM) {
  const btn = $("btnEarth");
  const setBusy = (t) => { if (btn) { btn.disabled = !!t; btn.textContent = t || "🌍 Google Earth"; } };
  try {
    const s = await api(`/api/earth/start?lat=${lat}&lon=${lon}&span=${spanM}`);
    if (!s.ok) { warn(s.error || "Couldn't start the capture."); return false; }
    toast("Moving Google Earth to the property. About 30 seconds. Don't touch it while it runs.");

    let r = null;
    for (let i = 0; i < 90; i++) {
      await new Promise((ok) => setTimeout(ok, 2000));
      r = await api("/api/earth/progress");
      setBusy(r.phase ? "⏳ " + r.phase : "⏳ working…");
      if (!r.running) break;
    }
    setBusy(null);
    if (!r || r.running) { warn("Google Earth is taking too long. Is it stuck on a dialog?"); return false; }
    if (r.error) { warn(r.error); return false; }
    if (!r.result) { warn("The capture finished with nothing to show."); return false; }

    const res = r.result;
    const accFt = mToFt(res.accuracy.worst_m);
    // Say the number BEFORE adopting when it's large enough to change how the survey is read.
    if (accFt > EARTH_ACC_STOP_FT && !confirm(
      `This view is very hilly or heavily wooded.\n\n` +
      `Positions on this base map could be off by about ${Math.round(accFt)} ft: far enough that a ` +
      `reading could land on the neighbouring property.\n\nCapture a smaller area instead, or use it anyway?`
    )) return false;
    if (accFt > EARTH_ACC_NOTE_FT && accFt <= EARTH_ACC_STOP_FT && !confirm(
      `Positions on this base map will be accurate to about ${Math.round(accFt)} ft.\n\n` +
      `Tall trees and buildings lean outward from the middle of the picture, so readings near the ` +
      `edges are the least certain. Capturing a smaller area reduces this.\n\nUse it?`
    )) return false;

    const small = await downscaleCapture(res.image, 1024);
    const got = adoptAerial(small, res.bounds, {
      source: "earth", lat: res.lat, lon: res.lon, spanM: res.span_m,
      accuracy: res.accuracy, captured: res.captured,
    });
    if (!got.ok) return false;
    if (!got.saved) {
      warn("Captured, but browser storage is full. Export the survey now.");
      return false;
    }
    toast(accFt <= EARTH_ACC_EXACT_FT
      ? `📷 Base map captured. Positions are accurate to under ${EARTH_ACC_EXACT_FT} ft.`
      : `📷 Base map captured. Positions accurate to about ${Math.round(accFt)} ft.`);
    return true;
  } catch (e) {
    setBusy(null);
    warn(e.message || "Couldn't reach Google Earth.");
    return false;
  }
}

// Geocode whatever's in the address box, then capture that spot from Google Earth.
async function buildFromEarth() {
  const q = ($("aerialAddr") && $("aerialAddr").value.trim()) || "";
  const spanM = +(($("earthSpan") && $("earthSpan").value) || 230);
  let lat = null, lon = null;
  if (q) {
    const btn = $("btnEarth");
    if (btn) { btn.disabled = true; btn.textContent = "Finding…"; }
    try {
      const d = await api("/api/geocode?q=" + encodeURIComponent(q));
      if (!d || !d.ok || d.lat == null) { warn("Couldn't find that address."); return; }
      if (d.name && $("aerialAddr")) $("aerialAddr").value = d.name;
      lat = d.lat; lon = d.lon;
    } catch (e) {
      warn("Geocode failed. Is the server running?"); return;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "🌍 Google Earth"; }
    }
  } else if (lastGpsFix && lastGpsFix.lat != null && lastGpsFix.age_sec <= 120) {
    lat = lastGpsFix.lat; lon = lastGpsFix.lon;   // standing on the property with no address typed
    toast("Using your current GPS position");
  } else {
    return toast("Type a property address first, or connect your phone's GPS");
  }
  await captureFromEarth(lat, lon, spanM);
}

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
      toast("Couldn't find that address. Check spelling and include city, state & ZIP.");
      return;
    }
    if (d.name && $("aerialAddr")) $("aerialAddr").value = d.name;   // show the REAL matched address
    // A missing-imagery or full-storage message from composeAerial is the thing the surveyor
    // most needs to see, and it lands first — don't paint the address over the top of it.
    const built = await composeAerial(d.lat, d.lon, 19);
    if (!built.ok || built.gaps) return;
    // Only the Census hit (and precise OSM matches) actually pin the house. If we
    // only got an area centroid, load it anyway but tell the tech to pin manually.
    if (d.precise === false) {
      toast("⚠️ Found only the area (couldn't pin the exact house). Zoom in with ＋ and tap the map to mark your spot.");
    } else {
      toast("📍 Found: " + (d.name || q));
    }
  } catch (e) {
    toast("Geocode failed. Is the server running?");
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
  toast("Loading satellite imagery…");
  const nx = AERIAL_TILES, ny = AERIAL_TILES;
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
  let asked = 0, got = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0 || tx >= nMax || ty >= nMax) continue;
      const px = (tx - x0f) * 256, py = (ty - y0f) * 256;
      asked++;
      jobs.push(loadTile(z, tx, ty).then((img) => { if (img) { got++; ctx.drawImage(img, px, py, 256, 256); } }));
    }
  }
  await Promise.all(jobs);

  // Esri has no imagery everywhere at every zoom, and the depth it runs out at is local —
  // rural Montana has ground at z21 while downtown San Francisco doesn't. A short grid is a
  // base map with blank squares in it, so say so instead of letting it reach a client report.
  if (!got) {
    warn("No satellite imagery here at this zoom. Tap − for a wider view.");
    return { ok: false, committed: false, gaps: asked };
  }
  const gaps = asked - got;
  if (gaps) {
    warn(`Only ${got} of ${asked} image tiles exist at this zoom. The gaps are blank. Tap − for a wider view.`);
  }

  // geo-bounds of the composed image (exact tile-edge lat/lon of the float window)
  const bounds = aerialBounds(lat, lon, z);
  // toDataURL stays with the producer: each source picks its own size and quality.
  const adopted = adoptAerial(canvas.toDataURL("image/jpeg", 0.85), bounds,
    { source: "esri", lat, lon, z });
  // `committed` says the frame is LIVE — geoBounds swapped, image on screen. `saved` says it
  // reached storage. They differ on a quota failure, and callers need the first: a caller that
  // treats "didn't save" as "nothing happened" leaves every pin describing the previous frame.
  //
  // An aerial is the most expensive thing in a survey to rebuild — an hour of driving if it's
  // lost — so a failed write still has to be loud.
  if (!adopted.saved) {
    warn("Aerial loaded but couldn't be saved: browser storage is full. Export the survey now.");
    return { ok: false, committed: adopted.ok, gaps };
  }
  if (!gaps) toast("Aerial ready. Walk the property and tap “📍 Mark my GPS spot”, or tap the map");
  return { ok: true, committed: adopted.ok, gaps };
}

// Everything pinned to this level's base map — readings, boundary corners, router marks — is a
// plain [0,1] fraction of the image, so swapping the frame underneath them silently moved all of
// it to different ground. A reading taken at the back fence ended up in the neighbour's yard with
// nothing to show it had happened.
//
// Work out the move BEFORE the new frame is fetched. That's what lets the "you'll lose spots off
// the edge" question be asked while the old frame is still on screen and still undoable.
function planRebase(oldGeo, newGeo) {
  const moving = [
    ...points.filter((p) => p.level === activeLevel && p.mapX != null).map((p) => ({ o: p, x: "mapX", y: "mapY" })),
    ...perimeter.map((v) => ({ o: v, x: "x", y: "y" })),
    ...apMarks.map((a) => ({ o: a, x: "x", y: "y" })),
  ];
  const next = moving.map((m) => reprojectFrac(m.o[m.x], m.o[m.y], oldGeo, newGeo));
  return {
    lost: next.filter((n) => n && (n.x < 0 || n.x > 1 || n.y < 0 || n.y > 1)).length,
    apply() {
      moving.forEach((m, i) => { const n = next[i]; if (n) { m.o[m.x] = n.x; m.o[m.y] = n.y; } });
      // The re-projection is already applied in memory, so a failed write leaves the survey on
      // screen correct and the copy on disk describing the OLD frame. Reloading would silently
      // scatter every reading. Loud, or it isn't a save.
      const okPts = savePoints();
      const okMap = saveLevelMap();
      renderCoverageMap();
      if (!okPts || !okMap) {
        warn("Positions were updated on screen but couldn't be saved. Export the survey now, "
             + "and don't reload the page first.");
      }
      return okPts && okMap;
    },
  };
}

// Shared by every frame swap. A tighter frame is the one thing a rebase can genuinely destroy,
// so it's asked about rather than assumed.
function confirmRebaseLoss(lost) {
  return !lost || confirm(
    `This pushes ${lost} marked ${lost === 1 ? "spot" : "spots"} off the edge of the map.\n\n` +
    `They stay in the survey and the readings list, but they won't show on the map or in the heatmap.\n\nContinue?`
  );
}

// Sources that define their frame as a zoom-z Mercator box can be rebuilt at any other z.
// A Google Earth capture can't: this code has no way to ask Earth for a different view, and its
// z is synthetic, so `lastAerial.z + delta` would name a frame nothing can produce.
const ZOOMABLE = { esri: composeAerial, naip: composeNaip };

// Rebuild the current aerial one zoom step wider (z−1) or closer (z+1), same center.
async function zoomAerial(delta) {
  if (!lastAerial) return toast("Build an aerial from an address first");
  const rebuild = ZOOMABLE[lastAerial.source];
  if (!rebuild) return toast("Re-capture from Google Earth to change the area");
  const z = Math.max(1, Math.min(21, Math.round(lastAerial.z + delta)));
  if (z === lastAerial.z) {
    return toast(delta > 0 ? "Already at the closest zoom" : "Already at the widest zoom");
  }

  const oldGeo = geoBounds;
  if (!oldGeo) return rebuild(lastAerial.lat, lastAerial.lon, z);   // nothing pinned yet

  const move = planRebase(oldGeo, aerialBounds(lastAerial.lat, lastAerial.lon, z));
  if (!confirmRebaseLoss(move.lost)) return;

  const built = await rebuild(lastAerial.lat, lastAerial.lon, z);
  // Rebase whenever the new frame actually went live. Gating on `ok` meant a storage-full
  // rebuild swapped the map but left every reading, corner and router pinned to the OLD box —
  // each one silently describing different ground.
  if (built.committed) move.apply();
}

/* ---------- USDA NAIP base map ---------- */
// Public-domain and orthorectified. Georeferenced by construction: the export is requested for
// exactly the aerialBounds() box we ask for, so unlike the Earth path there is nothing to fit and
// no residual to measure. Same box as the Esri path, so it's a drop-in — including −／＋ zoom.
//
// No capture date. An earlier version of this comment claimed one, and the README repeated it:
// the request is f=image, which returns pixels and no metadata, so nothing here knows when the
// imagery was flown. Don't reintroduce the claim without also fetching it.
//
// Flown leaf-on, May to September, so on a wooded parcel the canopy can hide a driveway or an
// outbuilding that winter imagery would show. That's why it's a choice, not a replacement.
async function composeNaip(lat, lon, z) {
  z = Math.max(1, Math.min(21, Math.round(z)));
  toast("Loading NAIP imagery…");
  const bounds = aerialBounds(lat, lon, z);
  const url = apiUrl(`/api/naip?west=${bounds.west}&east=${bounds.east}` +
                     `&north=${bounds.north}&south=${bounds.south}&size=1024`);
  const img = await new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = url;
  });
  if (!img) {
    warn("No NAIP imagery here. It covers the United States only. Try satellite instead.");
    return { ok: false, committed: false, gaps: 0 };
  }
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  const adopted = adoptAerial(c.toDataURL("image/jpeg", 0.85), bounds,
    { source: "naip", lat, lon, z });
  if (!adopted.saved) {
    warn("NAIP loaded but couldn't be saved. Browser storage is full. Export the survey now.");
    return { ok: false, committed: adopted.ok, gaps: 0 };
  }
  toast("NAIP aerial ready. Walk the property and tap “📍 Mark my GPS spot”, or tap the map");
  return { ok: true, committed: adopted.ok, gaps: 0 };
}

// Geocode the address box, then build a NAIP base map around it.
async function buildNaip() {
  const q = ($("aerialAddr") && $("aerialAddr").value.trim()) || "";
  if (!q) return toast("Type a property address first");
  const btn = $("btnNaip");
  if (btn) { btn.disabled = true; btn.textContent = "Finding…"; }
  try {
    const d = await api("/api/geocode?q=" + encodeURIComponent(q));
    if (!d || !d.ok || d.lat == null) return warn("Couldn't find that address.");
    if (d.name && $("aerialAddr")) $("aerialAddr").value = d.name;
    await composeNaip(d.lat, d.lon, 19);
  } catch (e) {
    warn("Geocode failed. Is the server running?");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🌾 NAIP"; }
  }
}

// Show/hide the "Mark my GPS spot" affordance depending on whether the level has an aerial.
function showGpsSpotBtn() { const b = $("gpsSpotBar"); if (b) b.classList.remove("hidden"); }
function hideGpsSpotBtn() { const b = $("gpsSpotBar"); if (b) b.classList.add("hidden"); }

// The base-map bar, shown only when this level actually has a georeferenced base map. The zoom
// buttons are Esri-only — a captured frame has no tile ladder, so they'd compute a view nothing
// can produce.
function showAerialBar() {
  const b = $("aerialBar"); if (!b) return;
  b.classList.toggle("hidden", !geoBounds);
  const src = (lastAerial && lastAerial.source) || "esri";
  const zoomable = !!ZOOMABLE[src];
  ["btnZoomOut", "btnZoomIn"].forEach((id) => { const x = $(id); if (x) x.classList.toggle("hidden", !zoomable); });
  const s = $("aerialSrc");
  if (s) s.textContent =
    src === "naip" ? "USDA NAIP (summer imagery). −／＋ for a wider or closer view."
    : src === "earth" ? earthAccuracyNote(lastAerial)
    : "Satellite imagery: −／＋ for a wider or closer view.";
}

// Credit every base map the survey actually used, and state each one's positional tolerance.
// A survey can mix sources across floors now, so this can't be one hardcoded line — and the
// tolerance belongs in the deliverable, not just on screen.
function baseMapCredit() {
  const geoLevels = levels.filter((l) => l.geo);
  if (!geoLevels.length) return "";
  const bits = [];
  // Esri's own copyrightText, verbatim — naming only Esri drops the licensors it requires.
  if (geoLevels.some((l) => !l.aerial || l.aerial.source === "esri")) {
    bits.push("Imagery source: Esri, Vantor, Earthstar Geographics, and the GIS User Community.");
  }
  if (geoLevels.some((l) => l.aerial && l.aerial.source === "naip")) {
    bits.push("Aerial imagery: USDA National Agriculture Imagery Program (public domain).");
  }
  const earth = geoLevels.filter((l) => l.aerial && l.aerial.source === "earth");
  if (earth.length) {
    bits.push("Base map imagery captured from Google Earth.");
    earth.forEach((l) => {
      const a = l.aerial.accuracy;
      if (!a) return;
      const raw = mToFt(a.worst_m);
      const ft = Math.round(raw);
      // "accurate to about under 5 ft" is what gluing "about" to "under" produces. Below the
      // threshold the honest phrasing is a bound, not an estimate, so the whole clause switches.
      //
      // Test `raw`, not `ft`. Rounding first made 5.4 ft print as "under 5 ft", which is a
      // tolerance the capture does not meet, in a document a client relies on.
      const tol = raw <= EARTH_ACC_EXACT_FT
        ? `accurate to under ${EARTH_ACC_EXACT_FT} ft`
        : `accurate to about ${ft} ft`;
      bits.push(`<b>${esc(l.name)}</b>: positions on this base map are ${tol}` +
        // relief_m is max(elev) - min(elev) over the terrain probe grid (earth.py), so it is
        // ground elevation only. The probes never touch a canopy, and lean on tall trees is a
        // separate error on top of this one, not part of what was measured.
        (a.relief_m > 5 ? `, measured in a view spanning ${Math.round(mToFt(a.relief_m))} ft of ` +
          `terrain elevation. Readings beside tall trees or buildings near the edge of the ` +
          `picture are the least certain` : "") +
        (l.aerial.captured ? ` (captured ${String(l.aerial.captured).slice(0, 10)})` : "") + ".");
    });
  }
  return `<p class="legend" style="opacity:.7;font-size:11px">${bits.join(" ")} GPS-located readings.</p>`;
}

// One sentence about how much this base map can be trusted. The tolerance travels with the image
// everywhere it's shown — on the map and in the report — because a stated tolerance is the
// difference between a measurement and an implied precision that isn't there.
function earthAccuracyNote(meta) {
  if (!meta || meta.source !== "earth" || !meta.accuracy) return "Captured base map.";
  const raw = mToFt(meta.accuracy.worst_m);          // test unrounded: 5.4 ft is not "under 5 ft"
  const ft = Math.round(raw);
  const when = meta.captured ? " · captured " + String(meta.captured).slice(0, 10) : "";
  if (raw <= EARTH_ACC_EXACT_FT) return `Google Earth · positions accurate to under ${EARTH_ACC_EXACT_FT} ft${when}`;
  return `Google Earth · positions accurate to about ${ft} ft. Tall trees and buildings near the ` +
         `edges are the least certain${when}`;
}
function hideAerialBar() { const b = $("aerialBar"); if (b) b.classList.add("hidden"); }

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
// gpsToMap (round-trips to ~1e-14). Takes the bounds as an argument and never reads the
// module-level geoBounds, so it returns null only when that argument is missing.
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
    return toast("No GPS fix yet. Open the GPS page & connect your phone");
  }
  if (!lastScan || !lastScan.current) return toast("No Wi-Fi signal. Are you connected?");
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
  set.planMode("image");
  set.floorPlanUrl(url);
  if (curLevel()) { curLevel().planMode = "image"; curLevel().floorPlanUrl = url; saveLevels(); }
  if ($("mapWrap")) $("mapWrap").classList.remove("schematic");
  if ($("schematicBar")) $("schematicBar").classList.add("hidden");
  set.floorPlanImg(new Image());
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
  if (!(rect.width > 0) || !(rect.height > 0)) return;   // not laid out yet — a tap here would divide by zero
  const x = (ev.clientX - rect.left) / rect.width;
  const y = (ev.clientY - rect.top) / rect.height;
  // NaN fails every comparison, so a bare range check lets it through — and a NaN coordinate
  // poisons every interpolation cell it touches downstream.
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return;
  if (mapMode === "cal") {
    if (!calTemp.a || calTemp.b) { set.calTemp({ a: { x, y }, b: null }); setCalStep("Now tap the other end of that same distance."); }
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
  // Placing a reading that was saved without a map position — this tap moves the existing
  // reading onto the map rather than measuring a new one.
  if (placingId != null) {
    const p = points.find((q) => q.id === placingId);
    if (p) {
      p.mapX = x; p.mapY = y; p.level = activeLevel;
      savePoints();
      const left = unplacedPoints().length;
      toast(left ? `Placed “${p.location}”. ${left} still to place` : `Placed “${p.location}”. That's all of them`);
      set.placingId(left ? unplacedPoints()[0].id : null);
      renderPoints();
      renderCoverageMap();
      return;
    }
    set.placingId(null);
  }
  if (!lastScan || !lastScan.current) return toast("No Wi-Fi signal. Are you connected?");
  const label = $("easyRoom").value.trim() || "Point " + (mappedPoints(points).length + 1);
  if (!addPoint(label, lastScan.current, { mapX: x, mapY: y })) return;
  $("easyRoom").value = "";
  renderCoverageMap();
  toast(`Placed “${label}” · ${lastScan.current.signal} dBm`);
}

export { baseMapCredit,buildAerial,buildFromEarth,buildNaip,gpsToMap,hideAerialBar,
  hideGpsSpotBtn,mapToLatLonIn,markGpsSpot,mercWorldY,onMapTap,renderYouAreHere,setFloorPlan,
  showAerialBar,showGpsSpotBtn,tile2lat,zoomAerial };
