// Floor plans: levels, schematic editor, rooms, AP marks, calibration, perimeter.

import { gpsToMap, hideAerialBar, hideGpsSpotBtn, mercWorldY, setFloorPlan, showAerialBar, showGpsSpotBtn, tile2lat } from "./basemap.js";
import { rate, store, toast } from "./core.js";
import { scheduleLivePush } from "./earth.js";
import { savePoints } from "./gps.js";
import { buildHeatCanvas, drawApMarks, drawContours, drawRequirementOverlay, getScale, heatClip, mapAspect, mappedPoints, perimPath, pointColor, predictReachFt, renderCoverageMap, surveyedSqft } from "./heatmap.js";
import { delPoint, renderPoints } from "./live.js";
import { esc } from "./report.js";
import { $, LS_ACTIVELEVEL, LS_LEVELS, PL_ENV, activeLevel, apMarks, calTemp, calibration, floorPlanImg, floorPlanUrl, geoBounds, lastAerial, lastGpsFix, levels, mapMode, perimeter, planMode, points, predictAPs, rooms, set, shapeVerts, showContours, showHeatmap, showPredict } from "./state.js";
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
  set.showHeatmap(!showHeatmap);
  renderCoverageMap();
}
// labeled iso-signal contour lines over the heatmap — reads like a pro RF survey
function toggleContours() {
  set.showContours($("contourChk") && $("contourChk").checked);
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
  ctx.drawImage(buildHeatCanvas(mapped, gw, gh, mapAspect()), 0, 0, W, H);
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
let editingLevel = false;
function curLevel() { return levels.find((l) => l.id === activeLevel); }
function newLevelId() { return "L" + (levels.reduce((m, l) => Math.max(m, +l.id.slice(1) || 0), 0) + 1); }
// The only persistence path for floor plans, rooms, perimeters and AP marks — a silent
// failure here loses the whole base map, which is the most expensive thing to rebuild.
function saveLevels() {
  if (!store(LS_LEVELS, JSON.stringify(levels))) return false;
  const ok = store(LS_ACTIVELEVEL, activeLevel || "");
  scheduleLivePush();
  return ok;
}
function initLevels() {
  if (!levels.length) {
    set.levels([{ id: "L1", name: "Main floor", planMode: null, floorPlanUrl: null, rooms: [], perimeter: [], apMarks: [], sqft: "", snapshot: null }]);
    set.activeLevel("L1");
  }
  if (!activeLevel || !curLevel()) set.activeLevel(levels[0].id);
}
// mirror the active working state (base map) back into the current level object
function saveLevelMap() {
  const L = curLevel();
  if (!L) return false;
  L.planMode = planMode;
  L.floorPlanUrl = floorPlanUrl;
  L.geo = geoBounds || L.geo || null;   // preserve aerial geo-bounds across level switches
  // The center+zoom the aerial was built from. Without it on the level, lastAerial died with the
  // page and the −／＋ buttons went dead after any reload on a level that plainly had an aerial.
  L.aerial = (geoBounds && lastAerial) ? lastAerial : (L.aerial || null);
  L.cal = calibration || L.cal || null;   // preserve the manual scale reference (uploaded plans)
  L.predictAPs = predictAPs;   // preserve predicted AP placements (design mode)
  L.surveyType = surveyType || L.surveyType || "all";   // preserve the WHAT-kind view choice
  L.rooms = rooms;
  L.perimeter = perimeter;
  L.apMarks = apMarks;
  try { const snap = generateMapDataURL(); if (snap) L.snapshot = snap; } catch (e) {}
  return saveLevels();
}
// load a level's base map into the working state + reset the map UI
function applyLevelMap(L) {
  set.planMode(L.planMode || null);
  set.floorPlanUrl(L.floorPlanUrl || null);
  set.geoBounds(L.geo || null);   // restore aerial geo-bounds (null for schematic / uploaded-image levels)
  // Surveys saved before L.aerial existed have geo but no source metadata. Every one of those is
  // an Esri tile frame and its centre is exactly the centre of its own box, so rebuild the record
  // instead of leaving the zoom buttons pointing at nothing.
  set.lastAerial(L.aerial || (L.geo ? {
    source: "esri", z: L.geo.z,
    lat: tile2lat((mercWorldY(L.geo.north, L.geo.z) + mercWorldY(L.geo.south, L.geo.z)) / 2, L.geo.z),
    lon: (L.geo.west + L.geo.east) / 2,
  } : null));
  set.calibration(L.cal || null);   // restore the manual scale reference
  set.calTemp({ a: null, b: null });
  set.predictAPs(L.predictAPs || []);
  set.showPredict(false);
  set.rooms(L.rooms || []);
  set.perimeter(L.perimeter || []);
  set.apMarks(L.apMarks || []);
  set.floorPlanImg(null);
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
  if (geoBounds) { showGpsSpotBtn(); showAerialBar(); } else { hideGpsSpotBtn(); hideAerialBar(); }
  applySurveyType(L.surveyType || "all");   // restore WHAT-kind view AFTER base mode is set, so the type default wins
}
function switchLevel(id) {
  if (id === activeLevel) return;
  saveLevelMap();
  set.activeLevel(id);
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
  set.activeLevel(id);
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
  set.points(points.filter((p) => p.level !== gone));
  set.levels(levels.filter((l) => l.id !== gone));
  set.activeLevel(levels[0].id);
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
let dragState = null;
const clampv = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function startSchematic() {
  set.planMode("schematic");
  set.floorPlanImg(null);
  set.floorPlanUrl(null);
  if (curLevel()) { curLevel().planMode = "schematic"; curLevel().floorPlanUrl = null; saveLevels(); }
  $("planEmpty").classList.add("hidden");
  $("planArea").classList.remove("hidden");
  $("schematicBar").classList.remove("hidden");
  $("mapWrap").classList.add("schematic");
  if (!rooms.length) {
    set.rooms([
      { id: 1, name: "Living room", x: 0.06, y: 0.08, w: 0.42, h: 0.4 },
      { id: 2, name: "Kitchen", x: 0.52, y: 0.08, w: 0.42, h: 0.4 },
      { id: 3, name: "Bedroom", x: 0.06, y: 0.52, w: 0.42, h: 0.4 },
      { id: 4, name: "Bath", x: 0.52, y: 0.52, w: 0.42, h: 0.4 },
    ]);
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
  set.rooms(specs.map((s) => ({
    id: id++, name: s.name,
    x: +(m + s.px * scale).toFixed(3), y: +(m + s.py * scale).toFixed(3),
    w: +(s.w * scale).toFixed(3), h: +(s.h * scale).toFixed(3),
  })));
  set.planMode("schematic");
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
  toast(rooms.length + " rooms placed. Drag them to match your space");
}

function resetPlan() {
  if (!confirm("Change the plan? Keeps your saved readings, but clears the current layout / photo.")) return;
  set.planMode(null);
  set.floorPlanImg(null);
  set.floorPlanUrl(null);
  set.geoBounds(null);
  set.calibration(null);
  set.calTemp({ a: null, b: null });
  set.rooms([]);
  set.perimeter([]);
  set.apMarks([]);
  set.lastAerial(null);   // the frame it described is gone; leaving it lets zoomAerial rebuild a base map the tech just cleared
  if (curLevel()) { curLevel().planMode = null; curLevel().floorPlanUrl = null; curLevel().geo = null; curLevel().aerial = null; curLevel().cal = null; curLevel().rooms = []; curLevel().perimeter = []; curLevel().apMarks = []; curLevel().snapshot = null; saveLevels(); }
  hideGpsSpotBtn();
  hideAerialBar();
  $("mapWrap").classList.remove("schematic");
  $("schematicBar").classList.add("hidden");
  $("planArea").classList.add("hidden");
  $("planEmpty").classList.remove("hidden");
  if ($("planImg")) $("planImg").removeAttribute("src");
  if ($("roomsLayer")) $("roomsLayer").innerHTML = "";
}

/* ---------- survey-type views (progressive disclosure) ---------- */
let surveyType = "all";  // 'inhouse'|'around'|'property'|'all' — WHAT is being surveyed (mirrors curLevel().surveyType; default 'all' = show everything = back-compat)
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
  if (m !== "roomshape") set.shapeVerts([]);
  set.mapMode(m);
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
  if (m !== "predict" && showPredict) { set.showPredict(false); updatePredictUI(); }
  if ($("mapHint")) {
    $("mapHint").innerHTML = m === "edit"
      ? "<b>Arrange the rooms</b>: drag to move, grab any handle to resize, ◆ to morph a box into a custom shape (then drag corners, tap ＋ to add angles, double-click a corner to remove it), ✎ rename, ✕ delete. Then <b>Take readings</b>."
      : m === "perimeter"
      ? "<b>Tap each corner of your property / area</b> to trace the boundary. The heatmap fills only inside it. Tap <b>✓ Done</b> when closed."
      : m === "ap"
      ? "<b>Tap where the router / access point sits.</b> Name it first (Gateway, Mesh…). Tap <b>✓ Done</b> when placed."
      : m === "roomshape"
      ? "<b>Tap each corner of the room</b> to trace any shape (L-shaped, angled, round-ish…). Name it first, then tap <b>✓ Finish shape</b> when you've gone all the way around."
      : m === "cal"
      ? "<b>Set the scale:</b> tap the two ends of a distance you know in real life (a wall, a door, a car length), then type the feet. Everything after reads real square footage."
      : m === "predict"
      ? "<b>Predict coverage:</b> tap where you'd mount access points. The map models their combined coverage in real feet, so you can design placement before you ever walk it."
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
  set.apMarks([]);
  if (curLevel()) { curLevel().apMarks = []; saveLevels(); }
  renderCoverageMap();
}

/* ---------- scale calibration (a real-distance reference for uploaded plans) ---------- */
function toggleCalibrate() {
  if (mapMode === "cal") return cancelCalibration();
  if (geoBounds) return toast("This aerial already has real GPS scale. No calibration needed");
  if (planMode !== "image") return toast("Set scale works on an uploaded floor-plan image");
  set.calTemp({ a: null, b: null });
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
  set.calibration({ a: calTemp.a, b: calTemp.b, feet, imgAspect });
  if (curLevel()) { curLevel().cal = calibration; saveLevels(); }
  set.calTemp({ a: null, b: null });
  if ($("calFeet")) $("calFeet").value = "";
  setMapMode("survey");
  toast("Scale set. Square footage now available");
}
function cancelCalibration() {
  set.calTemp({ a: null, b: null });
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
  if (showPredict) { set.showPredict(false); setMapMode("survey"); updatePredictUI(); renderCoverageMap(); return; }
  if (!getScale()) return toast("Set the scale first (📏) so predictions come out in real feet");
  set.showPredict(true);
  setMapMode("predict");
  updatePredictUI();
  renderCoverageMap();
}
function setPredictEnv(v) { set.plExponent(PL_ENV[v] || 2.8); updatePredictUI(); renderCoverageMap(); }
function undoPredictAP() { predictAPs.pop(); persistPredict(); updatePredictUI(); renderCoverageMap(); }
function clearPredictAPs() { set.predictAPs([]); persistPredict(); updatePredictUI(); renderCoverageMap(); }
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
  set.perimeter([]);
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
    return toast("No GPS fix yet. Open the GPS page & connect your phone");
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
  set.rooms(rooms.filter((r) => r.id !== id));
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
  set.shapeVerts([]);
  setMapMode("roomshape");
}
function updateShapeBtn() {
  const b = $("btnShape");
  if (!b) return;
  b.textContent = mapMode === "roomshape" ? "✓ Finish shape" : "◇ Shape room";
  b.classList.toggle("on", mapMode === "roomshape");
}
function undoShapeVert() { shapeVerts.pop(); renderRooms(); }
function cancelShapeRoom() { set.shapeVerts([]); setMapMode("edit"); }
function finishShapeRoom() {
  if (shapeVerts.length < 3) { toast("Tap at least 3 corners to make a shape"); return; }
  const id = (rooms.reduce((m, r) => Math.max(m, r.id), 0) || 0) + 1;
  const name = ($("shapeName") && $("shapeName").value.trim()) || "Room " + (rooms.length + 1);
  rooms.push({ id, name, poly: shapeVerts.slice() });
  if ($("shapeName")) $("shapeName").value = "";
  set.shapeVerts([]);
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
        <span class="rmorph" onpointerdown="event.stopPropagation()" onclick="convertToShape(${r.id})" title="Morph into a custom shape: angled &amp; L-shaped rooms">◆</span>
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
  ctx.fillText(((curLevel() && curLevel().name) || "Floor") + ": Floor Plan", pad, pad + TH / 2);
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
    ctx.drawImage(buildHeatCanvas(mapped, gw, gh, mapAspect()), 0, 0, RW, RH);
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

export { addLevel,addPolyVertex,addRoom,applyCalibration,applyLevelMap,cancelCalibration,
  cancelShapeRoom,chooseSurveyType,clearAPs,clearPerimeter,clearPredictAPs,closeDrops,
  commitLevelName,convertToShape,cornerAtGps,curLevel,deleteLevel,deletePolyVertex,deleteRoom,
  finishShapeRoom,fmtSqft,generateAutoLayout,generateMapDataURL,initLevels,persistPredict,
  renameLevel,renameRoom,renderLevelTabs,renderRooms,resetPlan,roomPointerDown,roomVertexDown,
  saveLevelMap,saveLevels,selectMode,setCalStep,setMapMode,setPredictEnv,startSchematic,
  switchLevel,toggleAP,toggleAerialBox,toggleAutoLayout,toggleCalibrate,toggleContours,
  toggleDrop,toggleHeatmap,togglePerimeter,togglePixelate,togglePredict,toggleShapeRoom,undoAP,
  undoMapPoint,undoPerimeter,undoPredictAP,undoShapeVert,updateScaleUI };
