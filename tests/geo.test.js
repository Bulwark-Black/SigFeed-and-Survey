// Coordinate maths. A defect here doesn't crash — it silently puts a reading somewhere it
// wasn't taken, which then reaches a client report looking perfectly plausible. Tolerances are
// stated in METRES on the ground, not in float ulps, because that is the thing that matters.
const { grab, grabConst, ok, section, done } = require("./helpers");

eval([
  grabConst("AERIAL_TILES"),
  grab("mercWorldX"), grab("mercWorldY"), grab("tile2lon"), grab("tile2lat"),
  grab("aerialBounds"), grab("mapToLatLonIn"), grab("reprojectFrac"), grab("haversineFt"),
].join("\n"));

const SPAN_M = 305.7;                  // a z19 4x4 aerial spans about this
const mm = (frac) => frac * SPAN_M * 1000;
const TOL_MM = 0.001;                  // 1 micrometre — absurdly stricter than any GPS
const metres = (a, b) =>
  Math.hypot((a.lat - b.lat) * 111320,
             (a.lon - b.lon) * 111320 * Math.cos(a.lat * Math.PI / 180));

const SITES = [
  { name: "Montana",   lat: 45.6770, lon: -111.0429 },
  { name: "Florida",   lat: 26.0500, lon: -80.2000 },
  { name: "equator",   lat: 0.0001,  lon: 0.0001 },
  { name: "far north", lat: 64.8378, lon: -147.7164 },
  { name: "southern",  lat: -33.8688, lon: 151.2093 },
];

section("aerialBounds");
SITES.forEach((s) => {
  const g = aerialBounds(s.lat, s.lon, 19);
  ok(g.west < g.east && g.south < g.north, s.name + ": box is not inside-out");
  // the geocoded point must land dead centre or the property sits off-frame
  const z = g.z;
  const x0 = mercWorldX(g.west, z), nx = mercWorldX(g.east, z) - x0;
  const y0 = mercWorldY(g.north, z), ny = mercWorldY(g.south, z) - y0;
  const cx = (mercWorldX(s.lon, z) - x0) / nx, cy = (mercWorldY(s.lat, z) - y0) / ny;
  ok(mm(Math.abs(cx - 0.5)) < TOL_MM && mm(Math.abs(cy - 0.5)) < TOL_MM,
     s.name + ": point lands dead centre",
     "off by " + mm(Math.max(Math.abs(cx - 0.5), Math.abs(cy - 0.5))).toExponential(1) + " mm");
});
ok(aerialBounds(45, -111, 99).z === 21, "zoom clamps at 21");
ok(aerialBounds(45, -111, -5).z === 1, "zoom clamps at 1");
ok(aerialBounds(45, -111, 19.4).z === 19, "zoom rounds to an integer");

section("reprojectFrac — ground truth must survive a frame change");
let worst = 0, worstAt = "";
SITES.forEach((s) => {
  for (const za of [16, 18, 19, 20, 21]) for (const zb of [16, 18, 19, 20, 21]) {
    const ga = aerialBounds(s.lat, s.lon, za), gb = aerialBounds(s.lat, s.lon, zb);
    for (let i = 1; i < 10; i += 2) for (let j = 1; j < 10; j += 2) {
      const before = mapToLatLonIn(ga, i / 10, j / 10);
      const r = reprojectFrac(i / 10, j / 10, ga, gb);
      const after = mapToLatLonIn(gb, r.x, r.y);
      const d = metres(before, after);
      if (d > worst) { worst = d; worstAt = `${s.name} z${za}->z${zb}`; }
    }
  }
});
ok(worst < 1e-6, "position preserved across every zoom pair at every site",
   "worst " + worst.toExponential(2) + " m (" + worstAt + ")");

section("reprojectFrac — must NOT clamp");
{
  const g19 = aerialBounds(26.05, -80.2, 19), g20 = aerialBounds(26.05, -80.2, 20);
  const edge = reprojectFrac(0.95, 0.5, g19, g20);
  ok(edge.x > 1, "an off-frame reading reports a fraction outside [0,1]", "x=" + edge.x.toFixed(3));
  const inside = reprojectFrac(0.52, 0.52, g19, g20);
  ok(inside.x >= 0 && inside.x <= 1 && inside.y >= 0 && inside.y <= 1,
     "a central reading stays inside [0,1]");
  let lost = false;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const r = reprojectFrac(i / 10, j / 10, g19, aerialBounds(26.05, -80.2, 18));
    if (r.x < 0 || r.x > 1 || r.y < 0 || r.y > 1) lost = true;
  }
  ok(!lost, "zooming OUT never pushes a reading off-frame");
  ok(reprojectFrac(0.5, 0.5, null, g19) === null, "null source bounds returns null, not NaN");
}

section("regression: the bug that moved readings");
{
  // Before the fix, a zoom kept the raw [0,1] fraction, so the ground under it changed.
  const g19 = aerialBounds(26.05, -80.2, 19), g18 = aerialBounds(26.05, -80.2, 18);
  const truth = mapToLatLonIn(g19, 0.62, 0.31);
  const naive = mapToLatLonIn(g18, 0.62, 0.31);        // old behaviour
  const fixed = (() => { const r = reprojectFrac(0.62, 0.31, g19, g18); return mapToLatLonIn(g18, r.x, r.y); })();
  ok(metres(truth, naive) > 10, "the old behaviour really did move readings",
     metres(truth, naive).toFixed(1) + " m off");
  ok(metres(truth, fixed) < 1e-6, "the fix keeps them put");
}

section("captured (non-tile) bounds");
{
  // A Google Earth frame is not tile-aligned and not square. z must still be a finite number:
  // mercWorld* raises 2 to it, and 2**undefined is NaN, which poisons every IDW cell it touches.
  const cap = { west: -80.2011, east: -80.1989, north: 26.0506, south: 26.0494, z: 19 };
  const mid = mapToLatLonIn(cap, 0.5, 0.5);
  ok(Math.abs(mid.lon - (cap.west + cap.east) / 2) < 1e-9, "centre longitude is the box centre");
  ok(mid.lat > cap.south && mid.lat < cap.north, "centre latitude is inside the box");
  ok(Number.isNaN(mercWorldX(0, undefined)), "z=undefined really does produce NaN (why it's validated)");

  const ftW = haversineFt(26.05, cap.west, 26.05, cap.east);
  const ftH = haversineFt(cap.north, -80.2, cap.south, -80.2);
  // Compare against the span computed from the box itself, not a number copied from one run —
  // a hardcoded figure only tests that the bounds were typed the same way twice.
  const expectW = (cap.east - cap.west) * 111320 * Math.cos(26.05 * Math.PI / 180) * 3.28084;
  const expectH = (cap.north - cap.south) * 111320 * 3.28084;
  ok(Math.abs(ftW - expectW) / expectW < 0.005, "ground width matches the box",
     ftW.toFixed(0) + " ft vs " + expectW.toFixed(0) + " expected");
  ok(Math.abs(ftH - expectH) / expectH < 0.005, "ground height matches the box",
     ftH.toFixed(0) + " ft vs " + expectH.toFixed(0) + " expected");
  ok(ftH > 0 && ftH < ftW, "height is positive and less than width for a landscape frame");
}

section("haversineFt");
{
  ok(Math.abs(haversineFt(0, 0, 0, 0)) < 1e-9, "zero distance");
  const oneDeg = haversineFt(0, 0, 0, 1);
  ok(Math.abs(oneDeg - 365221) / 365221 < 0.01, "1° of longitude at the equator ≈ 365,221 ft",
     oneDeg.toFixed(0) + " ft");
  ok(haversineFt(45, -111, 45.001, -111) > 0, "tiny north/south distance is positive");
}

done();
