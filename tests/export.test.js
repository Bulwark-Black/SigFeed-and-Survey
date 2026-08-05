// buildSurveyKml() is what a client actually opens. Its failures are silent — a folder that
// never renders, a reading that appears twice, a boundary that quietly belongs to another floor.
// Canvas isn't available in node, so heatOverlayPng is stubbed out; everything else is the real
// shipped code.
const { grab, grabConst, ok, section, done } = require("./helpers");

// --- minimum globals buildSurveyKml touches -------------------------------
let levels = [], points = [], activeLevel = "L1", perimeter = [], apMarks = [];
let liveVersion = 0;
let lastGpsFix = null;      // null in the app until the phone connects
const API_KEY = "testkey", LIVE_TOKEN = "testlive";
const location = { origin: "http://127.0.0.1:8765" };
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function heatOverlayPng() { return null; }        // no canvas in node
function mapAspectOf() { return 1; }

eval([
  grab("mercWorldX"), grab("mercWorldY"), grab("tile2lon"), grab("tile2lat"),
  grab("mapToLatLonIn"), grab("rate"), grab("kmlColor"), grab("buildSurveyKml"),
].join("\n"));

const GEO = { west: -80.2011, east: -80.1989, north: 26.0506, south: 26.0494, z: 19 };
const count = (s, sub) => (s.split(sub).length - 1);

function reset() {
  levels = [
    { id: "L1", name: "Ground", geo: { ...GEO }, apMarks: [{ x: 0.3, y: 0.3, label: "Router A" }],
      perimeter: [{ x: .1, y: .1 }, { x: .9, y: .1 }, { x: .9, y: .9 }, { x: .1, y: .9 }] },
    { id: "L2", name: "Upstairs", geo: { ...GEO }, apMarks: [{ x: 0.4, y: 0.6, label: "Router B" }],
      perimeter: [{ x: .2, y: .2 }, { x: .8, y: .2 }, { x: .8, y: .8 }] },
  ];
  activeLevel = "L1";
  points = [
    { id: 1, level: "L1", location: "Kitchen", signal: -52, mapX: .3, mapY: .3 },
    { id: 2, level: "L1", location: "Deck", signal: -79, mapX: .7, mapY: .7 },
    { id: 3, level: "L2", location: "Bedroom", signal: -64, mapX: .5, mapY: .4 },
  ];
}

section("every level contributes, not just the active one");
{
  reset();
  const doc = buildSurveyKml({}).doc;
  ok(doc.includes("<name>Ground</name>") && doc.includes("<name>Upstairs</name>"),
     "both levels get a folder");
  ok(doc.includes("Router A") && doc.includes("Router B"),
     "both levels' routers survive (regression: only the active level's were emitted)");
  ok(count(doc, "Property boundary") === 2,
     "both levels' boundaries survive", count(doc, "Property boundary") + " found");
  ok(count(doc, "<Placemark>") === 3 + 2 + 2, "3 readings + 2 routers + 2 boundaries",
     count(doc, "<Placemark>") + " placemarks");
}

section("readings are emitted exactly once");
{
  // A GPS-tagged reading on a level with NO geo used to appear in its level folder AND again in
  // the catch-all GPS folder.
  reset();
  levels.push({ id: "L3", name: "Shed", geo: null, apMarks: [], perimeter: [] });
  points.push({ id: 4, level: "L3", location: "ShedPoint", signal: -70, gps: { lat: 26.05, lon: -80.2 } });
  const doc = buildSurveyKml({}).doc;
  ok(count(doc, "<name>ShedPoint</name>") === 1, "a GPS reading on a geo-less level appears once",
     count(doc, "<name>ShedPoint</name>") + " times");

  // one that belongs to no level at all must still make it out
  points.push({ id: 5, level: "GONE", location: "Stray", signal: -75, gps: { lat: 26.0502, lon: -80.2002 } });
  const doc2 = buildSurveyKml({}).doc;
  ok(count(doc2, "<name>Stray</name>") === 1, "a reading whose level no longer exists is still exported once");
  ok(doc2.includes("GPS readings"), "…via the catch-all folder");
}

section("signal quality is visible");
{
  reset();
  const doc = buildSurveyKml({}).doc;
  ok(doc.includes("styleUrl>#r_exc"), "an excellent reading gets the excellent style");
  ok(doc.includes("styleUrl>#r_poor"), "a poor reading gets the poor style");
  ["exc", "good", "fair", "poor", "na"].forEach((c) =>
    ok(doc.includes(`<Style id="r_${c}">`), "style r_" + c + " is defined"));
}

section("live mode differs from file mode");
{
  reset();
  const file = buildSurveyKml({});
  const live = buildSurveyKml({ live: true });
  ok(!file.doc.includes("127.0.0.1"), "the KMZ references local files, not URLs");
  ok(file.overlay === null, "file mode returns no inline overlay");
  ok(live.doc.length > 0, "live mode produces a document");

  // "you are here" only when the fix is real and recent — a stale one would plant the surveyor
  // wherever they last had signal and let them walk away from it.
  ok(!live.doc.includes("You are here"), "no position marker without a GPS fix");
  lastGpsFix = { lat: 26.05, lon: -80.2, age_sec: 5 };
  ok(buildSurveyKml({ live: true }).doc.includes("You are here"), "fresh fix places the marker");
  lastGpsFix = { lat: 26.05, lon: -80.2, age_sec: 600 };
  ok(!buildSurveyKml({ live: true }).doc.includes("You are here"), "a 10-minute-old fix is not shown");
  lastGpsFix = { lat: 26.05, lon: -80.2, age_sec: null };
  ok(!buildSurveyKml({ live: true }).doc.includes("You are here"), "a fix of unknown age is not shown");
  lastGpsFix = null;
  ok(!buildSurveyKml({}).doc.includes("You are here"), "never in the KMZ file export");
}

section("degenerate inputs don't throw");
{
  levels = []; points = []; activeLevel = "L1";
  ok(typeof buildSurveyKml({}).doc === "string", "no levels, no points");
  levels = [{ id: "L1", name: "Empty", geo: { ...GEO }, apMarks: [], perimeter: [] }];
  ok(typeof buildSurveyKml({}).doc === "string", "a level with geo but nothing on it");
  points = [{ id: 1, level: "L1", location: "NoPos", signal: -60 }];
  const doc = buildSurveyKml({}).doc;
  ok(!doc.includes("NoPos"), "a reading with neither map position nor GPS is skipped, not emitted broken");
  levels = [{ id: "L1", name: "Odd & <Name>", geo: { ...GEO }, apMarks: [], perimeter: [] }];
  points = [{ id: 1, level: "L1", location: 'Bad & "quoted" <name>', signal: -60, mapX: .5, mapY: .5 }];
  const doc2 = buildSurveyKml({}).doc;
  ok(doc2.includes("Odd &amp; &lt;Name&gt;"), "level names are XML-escaped");
  ok(!doc2.includes('<name>Bad & "quoted"'), "reading names are XML-escaped");
}

section("committed vs saved — a quota failure must still rebase the pins");
{
  // adoptAerial swaps geoBounds and the on-screen image BEFORE it tries to persist, so
  // "didn't save" is not "nothing happened". zoomAerial gated on ok, which meant a storage-full
  // rebuild left every reading pinned to the previous frame, describing different ground.
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "app.js"), "utf8");
  ok(/return \{ ok: false, committed: adopted\.ok, gaps/.test(src),
     "a failed save still reports whether the frame went live");
  ok(/return \{ ok: false, committed: false, gaps/.test(src),
     "a path that never reached adoptAerial reports committed:false");
  ok(/if \(built\.committed\) move\.apply\(\);/.test(src),
     "zoomAerial rebases on committed, not on ok");
  ok(!/if \(!built\.ok\) return;/.test(src),
     "the old ok-gated early return is gone");
  ok(/const okPts = savePoints\(\);/.test(src) && /const okMap = saveLevelMap\(\);/.test(src),
     "planRebase.apply checks both writes");
  ok(/^\s*return saveLevels\(\);\s*$/m.test(src),
     "saveLevelMap returns a result for it to check");
}

done();
