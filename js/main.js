// Entry point. Two jobs: put the inline-handler functions back on window, then boot.
//
// dashboard.html wires buttons with onclick="foo()". Twelve of those handlers use `event`
// and nine use `this`, so rewriting them as addEventListener would change their meaning.
// Module scope is not global, so the names have to be re-exposed deliberately. They are
// listed explicitly rather than looped over, so check.sh can still prove that every
// onclick in the HTML resolves to a function that exists.

import { buildAerial, buildFromEarth, buildNaip, markGpsSpot, onMapTap, zoomAerial } from "./basemap.js";
import { addReportPhotos, attachHeatmap, connectCell, delCellSpot, logCellSpot, removeHeatmap, 
  removeReportPhoto, setPhotoCaption, toggleCellAuto } from "./cellular.js";
import { buildSpeedTicks, buildSpeedZones, buildZones, runSpeedTest, showPage, updateSpeedGauge } from "./core.js";
import { exportKML, importJSON, toggleLiveEarth } from "./earth.js";
import { checkGpsNow, copyGpsUrl, deleteProfile, exportCSV, exportJSON, loadProfiles, loadState, 
  newProfile, renameProfile, renderProfileMenu, saveSite, snapshotActiveProfile, switchProfile, 
  syncActiveName, toggleGps, toggleProfileMenu } from "./gps.js";
import { loadFloorPlan, locateOnMap, renderCoverageMap, renderHeatUI, setHeatColormap, 
  setHeatMetric, setHeatMode, setHeatPreset, setReqProfile } from "./heatmap.js";
import { ingestFile } from "./ingest.js";
import { captureAdv, clearAll, delPoint, launch, poll, runCellSpeed, runPing, runQuality, saveEasy, 
  startPlacing } from "./live.js";
import { onSitePointerDown, onSitePointerMove, onSitePointerUp, onSiteTap, renderSitePlan, 
  setSiteMode, setSiteRot, setSiteScale, siteClear, siteCornerGps, siteUndo } from "./pages.js";
import { addLevel, addPolyVertex, addRoom, applyCalibration, cancelCalibration, cancelShapeRoom, 
  chooseSurveyType, clearAPs, clearPerimeter, clearPredictAPs, closeDrops, commitLevelName, 
  convertToShape, cornerAtGps, deleteLevel, deletePolyVertex, deleteRoom, finishShapeRoom, 
  generateAutoLayout, renameLevel, renameRoom, renderRooms, resetPlan, roomPointerDown, 
  roomVertexDown, selectMode, setMapMode, setPredictEnv, startSchematic, switchLevel, toggleAP, 
  toggleAerialBox, toggleAutoLayout, toggleCalibrate, toggleContours, toggleDrop, toggleHeatmap, 
  togglePerimeter, togglePixelate, togglePredict, toggleShapeRoom, undoAP, undoMapPoint, 
  undoPerimeter, undoPredictAP, undoShapeVert } from "./planner.js";
import { genReport } from "./report.js";
import { $, LS_PAGE, PROFILE_PREFIX, activeProfile, speedMax } from "./state.js";

Object.assign(window, {
  // basemap
  buildAerial, buildFromEarth, buildNaip, markGpsSpot, onMapTap, zoomAerial,
  // cellular
  addReportPhotos, attachHeatmap, connectCell, delCellSpot, logCellSpot, removeHeatmap,
  removeReportPhoto, setPhotoCaption, toggleCellAuto,
  // core
  runSpeedTest, showPage,
  // earth
  exportKML, importJSON, toggleLiveEarth,
  // gps
  checkGpsNow, copyGpsUrl, deleteProfile, exportCSV, exportJSON, newProfile, renameProfile,
  saveSite, switchProfile, toggleGps, toggleProfileMenu,
  // heatmap
  loadFloorPlan, locateOnMap, setHeatColormap, setHeatMetric, setHeatMode, setHeatPreset,
  setReqProfile,
  // ingest
  ingestFile,
  // live
  captureAdv, clearAll, delPoint, launch, runCellSpeed, runPing, runQuality, saveEasy,
  startPlacing,
  // pages
  onSiteTap, setSiteMode, setSiteRot, setSiteScale, siteClear, siteCornerGps, siteUndo,
  // planner
  addLevel, addPolyVertex, addRoom, applyCalibration, cancelCalibration, cancelShapeRoom,
  chooseSurveyType, clearAPs, clearPerimeter, clearPredictAPs, closeDrops, commitLevelName,
  convertToShape, cornerAtGps, deleteLevel, deletePolyVertex, deleteRoom, finishShapeRoom,
  generateAutoLayout, renameLevel, renameRoom, renderRooms, resetPlan, roomPointerDown,
  roomVertexDown, selectMode, setMapMode, setPredictEnv, startSchematic, switchLevel, toggleAP,
  toggleAerialBox, toggleAutoLayout, toggleCalibrate, toggleContours, toggleDrop, toggleHeatmap,
  togglePerimeter, togglePixelate, togglePredict, toggleShapeRoom, undoAP, undoMapPoint,
  undoPerimeter, undoPredictAP, undoShapeVert,
  // report
  genReport,
});

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
