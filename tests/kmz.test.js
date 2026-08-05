// The KMZ is a deliverable a client opens in Google Earth. A malformed zip or a wrong colour
// byte order fails silently there — Earth just shows nothing — so these check the bytes.
const { grab, grabConst, ok, section, done } = require("./helpers");
const zlib = require("zlib");

eval([
  grabConst("CRC_TABLE"), grab("crc32"), grab("makeZip"), grab("dataUrlToBytes"), grab("kmlColor"),
].join("\n"));

// makeZip returns a Blob; node 18+ has Blob, and arrayBuffer() is async.
const enc = new TextEncoder();
const dec = new TextDecoder();

async function bytesOf(blob) { return new Uint8Array(await blob.arrayBuffer()); }

// Minimal reader: walk local headers, then verify the central directory and EOCD agree.
function readZip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = [];
  let i = 0;
  while (i + 4 <= buf.length && dv.getUint32(i, true) === 0x04034b50) {
    const crc = dv.getUint32(i + 14, true);
    const size = dv.getUint32(i + 18, true);
    const nlen = dv.getUint16(i + 26, true), elen = dv.getUint16(i + 28, true);
    const name = dec.decode(buf.slice(i + 30, i + 30 + nlen));
    const data = buf.slice(i + 30 + nlen + elen, i + 30 + nlen + elen + size);
    entries.push({ name, data, crc, offset: i, method: dv.getUint16(i + 8, true) });
    i += 30 + nlen + elen + size;
  }
  const cdStart = i;
  let count = 0, j = i;
  while (j + 4 <= buf.length && dv.getUint32(j, true) === 0x02014b50) {
    const nlen = dv.getUint16(j + 28, true);
    const off = dv.getUint32(j + 42, true);
    entries[count].cdOffset = off;
    count++;
    j += 46 + nlen + dv.getUint16(j + 30, true) + dv.getUint16(j + 32, true);
  }
  const eocd = j;
  return {
    entries, cdStart, cdCount: count,
    eocdSig: dv.getUint32(eocd, true) === 0x06054b50,
    eocdCount: dv.getUint16(eocd + 10, true),
    eocdCdSize: dv.getUint32(eocd + 12, true),
    eocdCdStart: dv.getUint32(eocd + 16, true),
    trailing: buf.length - (eocd + 22),
  };
}

(async () => {
  section("crc32");
  ok(crc32(enc.encode("")) === 0, "empty input");
  ok(crc32(enc.encode("123456789")) === 0xCBF43926, "the standard CRC-32 check value",
     "0x" + crc32(enc.encode("123456789")).toString(16).toUpperCase());
  // must agree with zlib, which is what every unzip implementation uses
  const sample = enc.encode("the quick brown fox jumps over the lazy dog");
  ok(crc32(sample) === (zlib.crc32 ? zlib.crc32(Buffer.from(sample)) : crc32(sample)),
     "agrees with zlib.crc32");

  section("makeZip structure");
  {
    const files = [
      { name: "doc.kml", bytes: enc.encode("<kml>a</kml>") },
      { name: "overlay_0.png", bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) },
      { name: "overlay_1.png", bytes: new Uint8Array(5000).fill(7) },
    ];
    const buf = await bytesOf(makeZip(files));
    const z = readZip(buf);
    ok(z.entries.length === 3, "all three local headers present", z.entries.length + " found");
    ok(z.cdCount === 3, "central directory lists three entries", z.cdCount + " listed");
    ok(z.eocdSig, "end-of-central-directory signature present");
    ok(z.eocdCount === 3, "EOCD entry count is right");
    ok(z.eocdCdStart === z.cdStart, "EOCD points at the real central directory start",
       z.eocdCdStart + " vs " + z.cdStart);
    ok(z.trailing === 0, "no trailing garbage after EOCD", z.trailing + " bytes");
    // the offset accumulation is the classic multi-file zip bug
    z.entries.forEach((e, n) =>
      ok(e.cdOffset === e.offset, "entry " + n + " central-dir offset matches its local header",
         e.cdOffset + " vs " + e.offset));
    z.entries.forEach((e, n) => {
      ok(crc32(e.data) === e.crc, "entry " + n + " CRC matches its data");
      ok(e.method === 0, "entry " + n + " is stored, not deflated");
    });
    ok(dec.decode(z.entries[0].data) === "<kml>a</kml>", "doc.kml round-trips exactly");
    ok(z.entries[2].data.length === 5000 && z.entries[2].data.every((b) => b === 7),
       "5000-byte entry round-trips exactly");
  }

  section("makeZip — non-ASCII filenames");
  {
    // TextEncoder gives BYTES; using .length on the string would under-count and corrupt
    // every offset after it.
    const name = "överlay_ñ.png";
    const buf = await bytesOf(makeZip([
      { name, bytes: new Uint8Array([1, 2, 3]) },
      { name: "after.kml", bytes: enc.encode("second") },
    ]));
    const z = readZip(buf);
    ok(z.entries.length === 2, "both entries parse despite a multi-byte name");
    ok(z.entries[0].name === name, "the multi-byte name survives", z.entries[0].name);
    ok(dec.decode(z.entries[1].data) === "second", "the entry AFTER it is not corrupted");
    ok(z.eocdCdStart === z.cdStart, "offsets still line up");
  }

  section("makeZip — edge cases");
  {
    const empty = await bytesOf(makeZip([]));
    const z = readZip(empty);
    ok(z.eocdSig && z.eocdCount === 0, "an empty zip is still structurally valid");
    const zero = await bytesOf(makeZip([{ name: "a.txt", bytes: new Uint8Array(0) }]));
    const z2 = readZip(zero);
    ok(z2.entries.length === 1 && z2.entries[0].data.length === 0, "zero-length entry is fine");
    ok(crc32(new Uint8Array(0)) === z2.entries[0].crc, "zero-length CRC is right");
  }

  section("kmlColor — aabbggrr, not rgba");
  {
    ok(kmlColor("#34d399", 255) === "ff99d334", "green #34d399 -> ff99d334", kmlColor("#34d399", 255));
    ok(kmlColor("#f87171", 255) === "ff7171f8", "red #f87171 -> ff7171f8", kmlColor("#f87171", 255));
    ok(kmlColor("#000000", 0) === "00000000", "transparent black");
    ok(kmlColor("#ffffff", 180) === "b4ffffff", "70% white -> b4ffffff", kmlColor("#ffffff", 180));
    // the trap: if byte order were rgba, red would come out fff87171
    ok(kmlColor("#f87171", 255) !== "fff87171", "byte order is NOT rgba");
  }

  section("dataUrlToBytes");
  {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const url = "data:image/png;base64," + png.toString("base64");
    const out = dataUrlToBytes(url);
    ok(out.length === 8 && out[0] === 137 && out[3] === 71, "decodes a PNG signature");
    const jpg = "data:image/jpeg;base64," + Buffer.from([255, 216, 255]).toString("base64");
    ok(dataUrlToBytes(jpg)[0] === 255, "handles a jpeg data URL too");
  }

  done();
})();
