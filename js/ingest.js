// Importing surveys, scan CSVs, and packet captures.

import { attachHeatmap } from "./cellular.js";
import { store } from "./core.js";
import { restoreProfileBundle, savePoints } from "./gps.js";
import { renderCoverageMap } from "./heatmap.js";
import { renderPoints } from "./live.js";
import { renderReportInsights } from "./pages.js";
import { $, LS_IMPORTEDSCAN, activeLevel, cellPoints, points, set } from "./state.js";
/* ---------- tool data ingestion (JSON survey / scan CSV / heatmap image) ---------- */
function ingestFile(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const name = (file.name || "").toLowerCase();
  const st = $("ingestStatus");
  if (file.type.indexOf("image") === 0) { attachHeatmap(ev); if (st) st.innerHTML = "✅ Heatmap image attached. It will appear in the report."; return; }
  if (name.endsWith(".pcap") || name.endsWith(".pcapng") || name.endsWith(".cap")) {
    // binary capture — MUST read as an ArrayBuffer (readAsText would corrupt every byte ≥ 0x80)
    const rb = new FileReader();
    rb.onload = () => {
      let scan = [];
      try { scan = parsePcap(rb.result); } catch (e) { scan = []; }
      if (scan.length) {
        set.importedScan(scan);
        store(LS_IMPORTEDSCAN, JSON.stringify(scan));
        renderReportInsights();
        if (st) st.innerHTML = `✅ Ingested <b>${scan.length}</b> network${scan.length > 1 ? "s" : ""} from the packet capture. Channel, signal &amp; security now feed the report's RF analysis.`;
      } else if (st) {
        st.innerHTML = "No Wi-Fi networks in that capture. A pcap only carries network info when it's a <b>monitor-mode</b> 802.11 capture (e.g. <code>sudo tcpdump -I -i en0 -w cap.pcap</code>). A normal capture has no beacon frames to read.";
      }
    };
    rb.readAsArrayBuffer(file);
    ev.target.value = "";
    return;
  }
  const r = new FileReader();
  r.onload = () => {
    const text = String(r.result || "");
    if (name.endsWith(".json") || text.trim().charAt(0) === "{") return importSurveyText(text);
    let scan = parseScanCSV(text);
    if (!scan.length && (name.endsWith(".wifiexplorer") || name.endsWith(".plist") || text.indexOf("<plist") >= 0)) scan = parseWifiExplorerPlist(text);
    if (scan.length) {
      set.importedScan(scan);
      store(LS_IMPORTEDSCAN, JSON.stringify(scan));
      renderReportInsights();
      if (st) st.innerHTML = `✅ Ingested <b>${scan.length}</b> networks from WiFi&nbsp;Explorer. They now feed the report's interference / RF analysis (channel, width, security, vendor).`;
    } else if (st && text.indexOf("<plist") >= 0) {
      st.innerHTML = "That looks like a saved WiFi&nbsp;Explorer document. In WiFi Explorer use <b>File → Export As… → CSV</b>, then drop that file here.";
    } else if (st) st.textContent = "Couldn't read that file: expected a WiFi Explorer / NetSpot scan CSV or a survey .json.";
  };
  r.readAsText(file);
  ev.target.value = "";
}
// Same restore as importJSON — a survey .json dropped on the report's ingest box is the
// same file, so it goes through the same complete path rather than a partial copy of it.
function importSurveyText(text) {
  const st = $("ingestStatus");
  let d;
  try { d = JSON.parse(text); } catch (e) {
    if (st) st.textContent = "Import failed. That .json wasn't a valid survey file.";
    return;
  }
  if (!d || typeof d !== "object" || (!Array.isArray(d.points) && !Array.isArray(d.levels))) {
    if (st) st.textContent = "That .json has no survey data in it.";
    return;
  }
  const live = points.length + cellPoints.length;
  if (live && !confirm(
    `Open this survey file?\n\nIt replaces what's on screen now: ${points.length} readings and ${cellPoints.length} candidate spots.`
  )) return;
  restoreProfileBundle(d);
  points.forEach((p) => { if (!p.level) p.level = activeLevel; });
  savePoints();
  renderPoints();
  renderCoverageMap();
  if (st) st.innerHTML = `✅ Imported survey. <b>${points.length}</b> readings restored.`;
}
function parseScanCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const head = lines[0];
  const delim = head.indexOf("\t") > -1 ? "\t" : (head.indexOf(";") > -1 && head.indexOf(",") < 0) ? ";" : ",";
  const split = (l) => l.split(delim).map((s) => s.replace(/^"|"$/g, "").trim());
  const hdr = split(head).map((h) => h.toLowerCase());
  const col = (re) => hdr.findIndex((h) => re.test(h));
  // Prioritized finder: try each regex in order; first header matching the strongest
  // available pattern wins (order-independent, so a plain "SSID" column beats a "BSSID" column).
  const findCol = (pats) => { for (const re of pats) { const i = hdr.findIndex((h) => re.test(h)); if (i >= 0) return i; } return -1; };
  const iB = col(/bssid|\bmac\b|address/);
  // SSID: none of these can match "bssid" (\bssid\b has no word boundary before "ssid" inside "bssid").
  let iS = findCol([/^ssid$/, /^network[ _-]?name$/, /^network$/, /\bssid\b/, /^name$/, /network[ _-]?name/]);
  if (iS >= 0 && iS === iB) iS = -1; // never let SSID collide onto the BSSID (MAC) column
  const iC = col(/channel|chan|\bch\b/), iBd = col(/band/), iSig = col(/rssi|signal|dbm|strength|level/), iSnr = col(/snr/), iN = col(/noise/), iW = col(/width|mhz/), iSec = col(/security|encryption|auth|privacy/), iV = col(/vendor|manufacturer/);
  const numish = (x) => { const m = (x || "").match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    if (!c.length) continue;
    const row = { ssid: iS >= 0 ? c[iS] : "", bssid: iB >= 0 ? c[iB] : "", channel: iC >= 0 ? numish(c[iC]) : null, band: iBd >= 0 ? c[iBd] : "", signal: iSig >= 0 ? numish(c[iSig]) : null, snr: iSnr >= 0 ? numish(c[iSnr]) : null, noise: iN >= 0 ? numish(c[iN]) : null, width: iW >= 0 ? c[iW] : "", security: iSec >= 0 ? c[iSec] : "", vendor: iV >= 0 ? c[iV] : "" };
    if (row.ssid || row.bssid || row.signal != null) out.push(row);
  }
  return out;
}
// WiFi Explorer native document (saved scan) is an XML plist — pull networks out of it.
function parseWifiExplorerPlist(text) {
  let doc;
  try { doc = new DOMParser().parseFromString(text, "application/xml"); } catch (e) { return []; }
  if (!doc || doc.querySelector("parsererror")) return [];
  const numish = (x) => { const m = (x || "").match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
  const out = [];
  doc.querySelectorAll("dict").forEach((d) => {
    const kv = {}, kids = d.children;
    for (let i = 0; i < kids.length - 1; i++) {
      if (kids[i].tagName === "key" && kids[i + 1].tagName !== "key") kv[kids[i].textContent.trim().toLowerCase()] = kids[i + 1].textContent.trim();
    }
    const pick = (re) => { for (const k in kv) if (re.test(k)) return kv[k]; return null; };
    const ssid = pick(/^(?!.*bssid)(?:.*\bssid\b|.*network ?name)/), bssid = pick(/bssid|\bmac\b/), sig = pick(/rssi|signal/);
    if (!ssid && !bssid && sig == null) return;
    out.push({ ssid: ssid || "", bssid: bssid || "", channel: numish(pick(/channel|\bchan\b/)), band: pick(/band/) || "", signal: numish(sig), snr: numish(pick(/snr|signal.?to.?noise/)), noise: numish(pick(/noise/)), width: pick(/width/) || "", security: pick(/security|encryption|privacy/) || "", vendor: pick(/vendor|manufacturer/) || "" });
  });
  return out;
}

/* ---------- packet-capture ingestion (.pcap / .pcapng monitor-mode 802.11) ---------- */
// Extracts nearby networks from a capture into the importedScan shape. Handles classic
// pcap (LE/BE) + pcapng, radiotap (linktype 127) + bare 802.11 (105). Radiotap and the
// 802.11 payload are ALWAYS little-endian; only the pcap container uses the file's byte order.
function parsePcap(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 24) return [];
  const dv = new DataView(arrayBuffer);
  const m = dv.getUint32(0, false); // read the magic big-endian so on-disk byte order is explicit
  // LE classic file starts with bytes D4 C3 B2 A1 → reads BE as 0xD4C3B2A1 (µs) / 0x4D3CB2A1 (ns)
  if (m === 0xD4C3B2A1 || m === 0x4D3CB2A1) return pcapParseClassic(dv, true);
  // BE classic file starts with bytes A1 B2 C3 D4 → 0xA1B2C3D4 (µs) / 0xA1B23C4D (ns)
  if (m === 0xA1B2C3D4 || m === 0xA1B23C4D) return pcapParseClassic(dv, false);
  if (m === 0x0A0D0D0A) { // pcapng Section Header Block
    const bom = dv.getUint32(8, true);
    return pcapParsePcapng(dv, bom === 0x1A2B3C4D);
  }
  return [];
}
function pcapMac(dv, off) {
  let s = "";
  for (let i = 0; i < 6; i++) s += (i ? ":" : "") + dv.getUint8(off + i).toString(16).padStart(2, "0");
  return s; // lowercase, matching the CSV / WiFi-Explorer convention
}
function pcapFreqToChannel(freq) {
  if (freq == null) return null;
  if (freq === 2484) return 14;                              // special case (generic formula gives 15)
  if (freq >= 2412 && freq <= 2472) return (freq - 2407) / 5;
  if (freq >= 5000 && freq <= 5900) return (freq - 5000) / 5;
  if (freq >= 5955 && freq <= 7115) return (freq - 5950) / 5; // 6 GHz (Wi-Fi 6E)
  return null;
}
function pcapBand(freq, ch) {
  if (freq != null) return freq >= 5955 ? "6 GHz" : freq >= 5000 ? "5 GHz" : "2.4 GHz";
  if (ch != null) return ch <= 14 ? "2.4 GHz" : "5 GHz";
  return "";
}
// radiotap header → {signalDbm, freq, dataAfter}; the 802.11 frame is located via it_len
function pcapRadiotap(dv, off) {
  const itLen = dv.getUint16(off + 2, true);
  let p = off + 4, first = 0, wi = 0;
  // consume ALL extended present words (bit31 chains another u32) before reading any field
  while (true) {
    const word = dv.getUint32(p, true);
    if (wi === 0) first = word;
    p += 4; wi++;
    if (!(word & 0x80000000)) break;
    if (p - off >= itLen) break;
  }
  // canonical radiotap field order: [presentBit, sizeBytes, alignment]
  const FIELDS = [[0, 8, 8], [1, 1, 1], [2, 1, 1], [3, 4, 2], [4, 2, 2], [5, 1, 1], [6, 1, 1], [7, 2, 2]];
  let cursor = p - off, freq = null, signalDbm = null;
  for (const f of FIELDS) {
    const bit = f[0], size = f[1], align = f[2];
    if (!(first & (1 << bit))) continue;
    if (cursor % align) cursor += align - (cursor % align);
    const fpos = off + cursor;
    if (fpos + size > off + itLen) break;
    if (bit === 3) freq = dv.getUint16(fpos, true);          // CHANNEL: first u16 is frequency
    else if (bit === 5) signalDbm = dv.getInt8(fpos);        // DBM_ANTSIGNAL: signed 8-bit
    cursor += size;
  }
  return { signalDbm: signalDbm, freq: freq, dataAfter: off + itLen };
}
// parse a beacon (subtype 8) / probe-response (subtype 5) mgmt frame → {bssid,ssid,channel,security}
function pcap80211(dv, off, end) {
  if (off + 24 > end) return null;
  const fc = dv.getUint16(off, true), ftype = (fc >> 2) & 3, subtype = (fc >> 4) & 0xF;
  if (ftype !== 0 || (subtype !== 8 && subtype !== 5)) return null;
  const bssid = pcapMac(dv, off + 16); // addr3 = BSSID
  const body = off + 24;
  if (body + 12 > end) return null;
  const cap = dv.getUint16(body + 10, true), privacy = (cap & 0x0010) !== 0;
  let ie = body + 12, ssid = null, channel = null, hasRSN = false, hasWPA = false;
  while (ie + 2 <= end) {
    const tag = dv.getUint8(ie), ln = dv.getUint8(ie + 1), val = ie + 2;
    if (val + ln > end) break;                               // clamp against truncated captures
    if (tag === 0) {                                         // SSID
      if (ln > 0) {
        try { ssid = new TextDecoder("utf-8").decode(new Uint8Array(dv.buffer, dv.byteOffset + val, ln)); }
        catch (e) { ssid = ""; for (let i = 0; i < ln; i++) ssid += String.fromCharCode(dv.getUint8(val + i)); }
      } else ssid = "";
    } else if (tag === 3 && ln >= 1) channel = dv.getUint8(val); // DS Parameter Set
    else if (tag === 48) hasRSN = true;                      // RSN (WPA2/3)
    else if (tag === 221 && ln >= 4 && dv.getUint8(val) === 0 && dv.getUint8(val + 1) === 0x50 && dv.getUint8(val + 2) === 0xF2 && dv.getUint8(val + 3) === 1) hasWPA = true; // MS WPA IE
    ie = val + ln;
  }
  const security = hasRSN ? "WPA2/3" : hasWPA ? "WPA" : privacy ? "WEP" : "Open";
  return { bssid: bssid, ssid: ssid, channel: channel, security: security };
}
function pcapAggregate(agg, mgmt, sig, freq) {
  if (!mgmt || !mgmt.bssid) return;
  const ch = mgmt.channel != null ? mgmt.channel : pcapFreqToChannel(freq); // DS IE wins over radiotap freq
  const band = pcapBand(freq, ch);
  let rec = agg[mgmt.bssid];
  if (!rec) { rec = { ssid: "", bssid: mgmt.bssid, channel: null, band: "", signal: null, snr: null, noise: null, width: "", security: "", vendor: "" }; agg[mgmt.bssid] = rec; }
  if (mgmt.ssid) rec.ssid = mgmt.ssid;
  if (ch != null) { rec.channel = ch; rec.band = band; }
  if (mgmt.security) rec.security = mgmt.security;
  if (sig != null && (rec.signal == null || sig > rec.signal)) rec.signal = sig; // keep the strongest
}
function pcapHandleFrame(dv, ps, pe, lt, agg) {
  let fo = ps, sig = null, freq = null;
  if (lt === 127) {                                          // radiotap
    if (ps + 8 > pe) return;
    const rt = pcapRadiotap(dv, ps); fo = rt.dataAfter; sig = rt.signalDbm; freq = rt.freq;
  } else if (lt === 105) { fo = ps; }                        // bare 802.11 (no signal available)
  else return;
  if (fo >= pe) return;
  pcapAggregate(agg, pcap80211(dv, fo, pe), sig, freq);
}
function pcapParseClassic(dv, le) {
  const lt = dv.getUint32(20, le), agg = {}, n = dv.byteLength;
  let pos = 24;
  while (pos + 16 <= n) {
    const incl = dv.getUint32(pos + 8, le), data = pos + 16;
    if (data + incl > n) break;
    pcapHandleFrame(dv, data, data + incl, lt, agg);
    pos = data + incl;
  }
  return Object.keys(agg).map((k) => agg[k]);
}
function pcapParsePcapng(dv, le) {
  const agg = {}, n = dv.byteLength;
  let pos = 0, curlt = null;
  while (pos + 12 <= n) {
    const bt = dv.getUint32(pos, le), total = dv.getUint32(pos + 4, le);
    if (total < 12 || pos + total > n) break;
    const body = pos + 8;
    if (bt === 1) curlt = dv.getUint16(body, le);            // Interface Description Block → linktype
    else if (bt === 6) {                                     // Enhanced Packet Block
      const capLen = dv.getUint32(body + 12, le), pkt = body + 20, endp = pkt + capLen;
      if (endp <= pos + total - 4) pcapHandleFrame(dv, pkt, endp, curlt, agg);
    } else if (bt === 3) {                                   // Simple Packet Block
      const pkt = body + 4, capLen = total - 12 - 4, endp = pkt + capLen;
      if (capLen > 0 && endp <= pos + total - 4) pcapHandleFrame(dv, pkt, endp, curlt, agg);
    }
    pos += total;
  }
  return Object.keys(agg).map((k) => agg[k]);
}

export { ingestFile };
