// The imagery credit is the report's honesty line: which source the base map came from, and how
// far a reading on it can be from where it really is. A silent wrong answer here puts an
// unqualified number in a client's hands, so it gets its own test.
const { grab, grabConst, ok, section, done } = require("./helpers");

let levels = [];
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
eval([grabConst("EARTH_ACC_EXACT_FT"), grab("mToFt"), grab("baseMapCredit")].join("\n"));

const GEO = { west: -80.2011, east: -80.1989, north: 26.0506, south: 26.0494, z: 19 };
const text = () => baseMapCredit().replace(/<[^>]+>/g, "").trim();

section("no georeferenced level means no credit at all");
{
  levels = [{ id: "L1", name: "Sketch", geo: null }];
  ok(baseMapCredit() === "", "a hand-drawn plan credits nothing");
}

section("Esri");
{
  levels = [{ id: "L1", name: "Ground", geo: { ...GEO }, aerial: { source: "esri", z: 19 } }];
  const t = text();
  ok(t.includes("Esri"), "names Esri");
  ok(t.includes("Vantor") && t.includes("Earthstar"),
     "names the data providers Esri's own copyrightText requires, not just Esri");
  ok(!/Google Earth|NAIP/.test(t), "does not credit sources it did not use");
}

section("a level saved before source metadata existed still credits Esri");
{
  levels = [{ id: "L1", name: "Legacy", geo: { ...GEO } }];   // no .aerial at all
  ok(text().includes("Esri"), "an aerial with no source record is treated as Esri, which it was");
}

section("NAIP");
{
  levels = [{ id: "L1", name: "Land", geo: { ...GEO }, aerial: { source: "naip", z: 19 } }];
  const t = text();
  ok(t.includes("USDA") && t.includes("public domain"), "names USDA NAIP and its public-domain status");
  ok(!t.includes("Esri"), "does not also credit Esri");
}

section("Google Earth carries its measured tolerance");
{
  levels = [{ id: "L1", name: "Ground", geo: { ...GEO },
              aerial: { source: "earth", captured: "2026-08-06T10:00:00",
                        accuracy: { worst_m: 7.35, rms_m: 2.96, relief_m: 21.8, probes: 81 } } }];
  const t = text();
  ok(t.includes("Google Earth"), "names Google Earth");
  ok(/accurate to about 24 ft/.test(t), "prints the measured tolerance in feet", t.match(/about [^,.]*/)?.[0]);
  ok(t.includes("2026-08-06"), "prints the capture date");
  ok(/least certain/.test(t), "warns which readings are least trustworthy");
  ok(!t.includes("Esri"), "an Earth capture is not credited to Esri");
}

section("a very accurate capture says so without a spurious figure");
{
  levels = [{ id: "L1", name: "Farm", geo: { ...GEO },
              aerial: { source: "earth", accuracy: { worst_m: 0.19, relief_m: 0.9 } } }];
  const t = text();
  ok(/accurate to under 5 ft/.test(t), "flat ground reports a bound, not a false-precision figure", t);
  ok(!/about under/.test(t), "and does not read \"about under 5 ft\"");
  ok(!/least certain/.test(t), "no tall-object warning when there is no relief to speak of");
}

section("a survey mixing sources credits every one of them");
{
  levels = [
    { id: "L1", name: "Ground", geo: { ...GEO }, aerial: { source: "esri", z: 19 } },
    { id: "L2", name: "Upstairs", geo: { ...GEO }, aerial: { source: "naip", z: 19 } },
    { id: "L3", name: "Yard", geo: { ...GEO },
      aerial: { source: "earth", accuracy: { worst_m: 15.2, relief_m: 64 } } },
  ];
  const t = text();
  ok(t.includes("Esri") && t.includes("USDA") && t.includes("Google Earth"),
     "all three sources are named");
  ok(/accurate to about 50 ft/.test(t), "the Earth level's own tolerance is printed");
  ok(t.includes("Yard"), "the tolerance is attributed to the level it belongs to");
}

section("malformed metadata degrades quietly instead of throwing");
{
  levels = [{ id: "L1", name: "Odd", geo: { ...GEO }, aerial: { source: "earth" } }];  // no accuracy
  ok(typeof baseMapCredit() === "string", "an Earth level with no accuracy record still returns a string");
  levels = [{ id: "L1", name: 'Bad & <name>', geo: { ...GEO },
              aerial: { source: "earth", accuracy: { worst_m: 9, relief_m: 20 } } }];
  ok(baseMapCredit().includes("Bad &amp; &lt;name&gt;"), "level names are XML-escaped in the credit");
}

done();
