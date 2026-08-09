// Shared survey state. Everything more than one module both reads and writes.
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
let placingId = null;  // id of an already-saved reading waiting to be tapped onto the map
let rooms = [];        // rect rooms {id,name,x,y,w,h} or polygon rooms {id,name,poly:[{x,y}]}
let shapeVerts = [];   // in-progress polygon vertices while drawing a shape room
let perimeter = [];    // [{x,y}] relative property-boundary vertices for the active level
let apMarks = [];      // [{x,y,label}] router/AP reference markers for the active level
let levels = [];       // [{id, name, planMode, floorPlanUrl, rooms, perimeter, snapshot}]
let activeLevel = null;
let gpsEnabled = false;
let lastGpsFix = null;
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
// a GPS-walked yard boundary is an hour on foot — a failed write here has to be visible
let activeProfile = null; // id of the currently-loaded profile. Its live data is in the working keys

let lastAerial = null;   // {lat, lon, z}: remembers the last geocoded center so zoom +/- can rebuild
let speedMax = 500; // current dial full-scale (Mbps); auto-scaled per run via niceMax()

/* ---------- shared state writes ---------- */
// These are the module-level values more than one area of the app both reads and writes.
// Reads stay plain (`points`), writes go through `set` (`set.points(...)`).
//
// The asymmetry is deliberate: it gives every write to shared state one greppable shape, so a
// write that bypasses it can be found statically.
//
// It is NOT self-enforcing, and an earlier version of this comment claimed it was. An imported
// binding is read-only, but `points = x` in an importing module still PARSES; V8 raises
// TypeError only on the line that runs. Most of this code writes state inside a try/catch
// (poll, refreshGps, loadState, every localStorage access), so a missed write does not surface
// as an error at all: poll()'s catch turns one into "Backend offline. Is the server running?"
// against a perfectly healthy server, with nothing logged.
//
// check.sh is what actually enforces it, by flagging any assignment to an imported binding.
// Without that check this convention is a convention, not a guarantee.
const set = {
  points: (v) => { points = v; },
  levels: (v) => { levels = v; },
  activeLevel: (v) => { activeLevel = v; },
  cellPoints: (v) => { cellPoints = v; },
  planMode: (v) => { planMode = v; },
  lastGpsFix: (v) => { lastGpsFix = v; },
  perimeter: (v) => { perimeter = v; },
  apMarks: (v) => { apMarks = v; },
  geoBounds: (v) => { geoBounds = v; },
  heatmapDataUrl: (v) => { heatmapDataUrl = v; },
  surveyEnv: (v) => { surveyEnv = v; },
  reportPhotos: (v) => { reportPhotos = v; },
  mapMode: (v) => { mapMode = v; },
  lastScan: (v) => { lastScan = v; },
  lastCell: (v) => { lastCell = v; },
  importedScan: (v) => { importedScan = v; },
  floorPlanUrl: (v) => { floorPlanUrl = v; },
  floorPlanImg: (v) => { floorPlanImg = v; },
  reqProfile: (v) => { reqProfile = v; },
  rooms: (v) => { rooms = v; },
  calibration: (v) => { calibration = v; },
  calTemp: (v) => { calTemp = v; },
  lastAerial: (v) => { lastAerial = v; },
  placingId: (v) => { placingId = v; },
  shapeVerts: (v) => { shapeVerts = v; },
  predictAPs: (v) => { predictAPs = v; },
  showPredict: (v) => { showPredict = v; },
  showHeatmap: (v) => { showHeatmap = v; },
  showContours: (v) => { showContours = v; },
  heatMetric: (v) => { heatMetric = v; },
  heatMode: (v) => { heatMode = v; },
  heatPreset: (v) => { heatPreset = v; },
  sitePlan: (v) => { sitePlan = v; },
  siteMode: (v) => { siteMode = v; },
  gpsEnabled: (v) => { gpsEnabled = v; },
  plExponent: (v) => { plExponent = v; },
  speedMax: (v) => { speedMax = v; },
  activeProfile: (v) => { activeProfile = v; },
};

export { $,LS_ACTIVELEVEL,LS_ACTIVEPROFILE,LS_CELL,LS_CELLPTS,LS_HEATMAP,LS_IMPORTEDSCAN,
  LS_LEVELS,LS_PAGE,LS_PHOTOS,LS_POINTS,LS_PROFILES,LS_SITE,LS_SITEPLAN,LS_SURVEYENV,PL_ENV,
  PL_TXREF,PROFILE_PREFIX,SITE_FIELDS,activeLevel,activeProfile,apMarks,calTemp,calibration,
  cellPoints,emptySitePlan,floorPlanImg,floorPlanUrl,geoBounds,gpsEnabled,heatMetric,heatMode,
  heatPreset,heatmapDataUrl,importedScan,lastAerial,lastCell,lastGpsFix,lastScan,levels,mapMode,
  perimeter,plExponent,placingId,planMode,points,predictAPs,reportPhotos,reqProfile,rooms,set,
  shapeVerts,showContours,showHeatmap,showPredict,siteMode,sitePlan,speedMax,surveyEnv };
