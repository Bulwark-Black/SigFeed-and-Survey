// The client report and the rule-based findings engine.

import { baseMapCredit } from "./basemap.js";
import { GRADE_INK, analyzeInfra, bestCellSpot, secGrade, wifiGen } from "./cellular.js";
import { rate, showPage, toast } from "./core.js";
import { saveSite } from "./gps.js";
import { METRICS, REQ_PROFILES, colormapCss, coverageHull, holeAreaSqft, mappedPoints, polyFracArea, reqGateText, requirementHull, requirementStats, scaleFor, surveyedSqft, unplacedPoints } from "./heatmap.js";
import { fmtSqft, generateMapDataURL, saveLevelMap } from "./planner.js";
import { $, SITE_FIELDS, activeLevel, cellPoints, heatMetric, heatMode, heatPreset, heatmapDataUrl, importedScan, lastScan, levels, points, reportPhotos, reqProfile, rooms, set, surveyEnv } from "./state.js";
/* ---------- report ---------- */
function stripTags(s) { return String(s).replace(/<[^>]+>/g, ""); }

// which labeled room a reading falls inside (rect or polygon), else its own label
function roomOf(p) {
  if (p.mapX == null) return p.location;
  const lv = levels.find((l) => l.id === p.level);
  const rms = (lv && lv.rooms) || [];
  for (const r of rms) {
    if (r.poly && r.poly.length >= 3) { if (pointInPoly(p.mapX, p.mapY, r.poly)) return r.name; }
    else if (p.mapX >= r.x && p.mapX <= r.x + r.w && p.mapY >= r.y && p.mapY <= r.y + r.h) return r.name;
  }
  return p.location;
}
function distinctRooms(pts) { return new Set(pts.map(roomOf)).size; }
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i].y > y) !== (poly[j].y > y) && x < (poly[j].x - poly[i].x) * (y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x) inside = !inside;
  }
  return inside;
}

/* ---------- findings engine (local, rule-based) ---------- */
// `env` is the Wi-Fi environment recorded WHEN THE SURVEY WAS WALKED. It must be passed in
// rather than read from lastScan: lastScan is refreshed every 5 seconds from whatever network
// this Mac is on right now, so regenerating a saved survey from the office used to describe
// the office's network in the client's report. Falls back to live only when a survey predates
// this field, and buildReport says which of the two it used.
function computeInsights(pts, site, env) {
  const scanEnv = env && env.current ? env : (lastScan && lastScan.current ? lastScan : null);
  const F = [];
  const plan = parseFloat(site.f_plan) || null;
  const sig = pts.filter((p) => p.signal != null);
  const dead = sig.filter((p) => p.signal < -75);
  const marg = sig.filter((p) => p.signal >= -75 && p.signal < -67);
  const lowSnr = pts.filter((p) => p.snr != null && p.snr < 15 && p.signal != null && p.signal >= -75);
  const thr = pts.filter((p) => p.download_mbps != null);
  const nm = (arr) => arr.map((p) => esc(p.location)).join(", ");
  const locOf = (p) => (p && p.mapX != null ? { x: p.mapX, y: p.mapY, level: p.level } : null);

  const subs = [];
  const covScore = (s) => s >= -55 ? 100 : s >= -67 ? 75 + (s + 67) / 12 * 25 : s >= -75 ? 40 + (s + 75) / 8 * 35 : s >= -85 ? 10 + (s + 85) / 10 * 30 : 5;
  if (sig.length) {
    const arr = sig.map((p) => covScore(p.signal)).sort((a, b) => a - b);
    subs.push({ name: "Coverage", val: Math.round(arr[Math.floor((arr.length - 1) * 0.25)]), w: 0.4 });
  }
  const snrPts = pts.filter((p) => p.snr != null);
  if (snrPts.length) {
    const snrScore = (n) => n >= 25 ? 100 : n >= 15 ? 60 + (n - 15) / 10 * 40 : n >= 5 ? 20 + (n - 5) / 10 * 40 : 10;
    subs.push({ name: "Reliability", val: Math.round(snrPts.reduce((a, p) => a + snrScore(p.snr), 0) / snrPts.length), w: 0.2 });
  }
  if (plan && thr.length) {
    const t = (dl) => { const r = Math.min(1, dl / plan); return r >= 0.9 ? 100 : r >= 0.5 ? 60 + (r - 0.5) / 0.4 * 40 : r >= 0.25 ? 30 + (r - 0.25) / 0.25 * 30 : 15; };
    subs.push({ name: "Throughput", val: Math.round(thr.reduce((a, p) => a + t(p.download_mbps), 0) / thr.length), w: 0.2 });
  }
  let intf = 100;
  const co = (scanEnv && scanEnv.current && scanEnv.nearby) ? scanEnv.nearby.filter((n) => n.channel === scanEnv.current.channel && n.ssid !== scanEnv.current.ssid) : [];
  if (co.length > 1) intf -= Math.min(40, (co.length - 1) * 8);
  const bandPts = pts.filter((p) => p.band);
  const all24 = bandPts.length >= 2 && bandPts.every((p) => (p.band || "").indexOf("2") === 0);
  const has5 = scanEnv && scanEnv.nearby && scanEnv.nearby.some((n) => (n.band || "").indexOf("5") === 0);
  if (all24 && has5) intf -= 15;
  intf = Math.max(0, intf);
  if (bandPts.length || co.length) subs.push({ name: "Interference", val: Math.round(intf), w: 0.1 });
  let bestSinr = null;
  if (cellPoints.length) {
    const b = bestCellSpot();
    bestSinr = b.nr_sinr != null ? b.nr_sinr : b.lte_sinr;
    const cS = bestSinr == null ? null : bestSinr >= 20 ? 100 : bestSinr >= 13 ? 75 + (bestSinr - 13) / 7 * 25 : bestSinr >= 0 ? 35 + bestSinr / 13 * 40 : 15;
    if (cS != null) subs.push({ name: "Cellular WAN", val: Math.round(cS), w: 0.1 });
  }
  let score = 60;
  if (subs.length) { const tw = subs.reduce((a, s) => a + s.w, 0); score = Math.round(subs.reduce((a, s) => a + s.w * s.val, 0) / tw); }
  if (dead.length) score = Math.min(score, 69);
  if ((sig.length && dead.length / sig.length >= 0.25) || (cellPoints.length && bestSinr != null && bestSinr < 0)) score = Math.min(score, 49);
  const grade = score >= 90 ? ["Excellent"] : score >= 75 ? ["Good"] : score >= 60 ? ["Fair"] : score >= 40 ? ["Poor"] : ["Critical"];

  if (pts.length >= 1 && pts.length < 4) F.push({ severity: "info", text: `Only ${pts.length} reading${pts.length > 1 ? "s" : ""} captured. Conclusions are provisional until more rooms are sampled.`, rec: "Aim for about one reading per 400–500 sq ft plus the corners farthest from the router." });
  // Area has to be measured over the readings that actually sit on the map — `sig` includes
  // Live-page readings with no position (x/y NaN) and readings from other floors, which drove
  // this figure to 0 and silently dropped the sentence while the dashboard still showed a count.
  if (dead.length) { const w = dead.reduce((a, b) => (b.signal < a.signal ? b : a)); const holeFt = holeAreaSqft(-75, mappedPoints(pts)); const areaTxt = holeFt ? ` About <b>${fmtSqft(holeFt)}</b> of the surveyed area falls below −75 dBm.` : ""; F.push({ severity: "critical", text: `<b>${dead.length} dead zone${dead.length > 1 ? "s" : ""}</b> below −75 dBm: ${nm(dead)}.${areaTxt} The worst is ${esc(w.location)} at ${w.signal} dBm. Expect Wi-Fi calls to drop and smart devices to fall offline here.`, rec: `Add a mesh node or wired access point roughly midway between the router and ${esc(w.location)}. A wired-backhaul node beats a repeater since the feeding signal is already ${w.signal} dBm. Re-measure to confirm the far rooms clear −67 dBm.`, loc: locOf(w) }); }
  if (marg.length) { const wm = marg.reduce((a, b) => (b.signal < a.signal ? b : a)); F.push({ severity: "warning", text: `${marg.length} marginal location${marg.length > 1 ? "s" : ""} (−68 to −75 dBm): ${nm(marg)}. Fine for browsing, borderline for 4K, video calls, and gaming when busy.`, rec: dead.length ? "Position any new access point so it overlaps both the dead zones and these rooms." : "Relocate the gateway higher and more central first; add one AP only if these rooms are heavily used.", loc: locOf(wm) }); }
  if (lowSnr.length) { const w = lowSnr.reduce((a, b) => (b.snr < a.snr ? b : a)); F.push({ severity: "warning", text: `${lowSnr.length} location${lowSnr.length > 1 ? "s" : ""} show strong signal but noisy air (SNR under 15 dB): ${nm(lowSnr)}. Lowest is ${esc(w.location)} at SNR ${w.snr} dB. Bars look fine but throughput suffers.`, rec: "Signal strength isn't the problem here, background noise is, which usually points to interference rather than distance. Move the gateway to a cleaner channel first (2.4 GHz: stick to 1/6/11). A closer access point does raise the signal, but it can't lower the noise.", loc: locOf(w) }); }
  if (co.length >= 2) { const top = co.slice(0, 3).map((n) => esc(n.ssid || "(hidden)")).join(", "); F.push({ severity: "warning", text: `Channel ${scanEnv.current.channel} (${scanEnv.current.band || "?"}) is crowded: ${co.length} neighboring networks share it${top ? ", including " + top : ""}. Co-channel networks split airtime even at full signal.`, rec: "Change the gateway's channel to a quieter one (2.4 GHz: least-busy of 1/6/11) or enable auto-channel. Keep 2.4 GHz at 20 MHz width." }); }
  if (all24 && has5) F.push({ severity: "warning", text: "Every surveyed room connected on 2.4 GHz even though 5 GHz is available nearby. The client is stuck on the slower, congested band, capping speeds regardless of signal.", rec: "Enable band steering (single SSID, router picks the band) or manually join 5 GHz near the router. Keep 2.4 GHz for far rooms and IoT." });
  if (scanEnv && scanEnv.current) {
    const sg = secGrade(scanEnv.current.security), nm2 = esc(scanEnv.current.ssid || "the client network");
    if (sg.g === "open") F.push({ severity: "critical", text: `The client network “${nm2}” is <b>open (no encryption)</b>. Anyone in range can read traffic and join.`, rec: "Enable WPA3 (or WPA2 at minimum) on the gateway before handoff." });
    else if (sg.g === "wep" || sg.g === "wpa") F.push({ severity: "warning", text: `“${nm2}” uses <b>${esc(sg.label)}</b>, which is outdated and crackable.`, rec: "Upgrade the gateway to WPA2 or, preferably, WPA3." });
    else if (sg.g === "wpa2" && wifiGen(scanEnv.current).g >= 6) F.push({ severity: "info", text: `“${nm2}” runs modern Wi-Fi but only WPA2 security. WPA3 adds stronger encryption and protected management frames.`, rec: "Switch to WPA3 (or WPA2/WPA3 transitional) if all client devices support it." });
    const infraAll = [scanEnv.current].concat(scanEnv.nearby || []);
    const sixBad = analyzeInfra(infraAll).sixViolation;
    if (sixBad) F.push({ severity: "warning", text: `${sixBad} access point${sixBad > 1 ? "s are" : " is"} broadcasting on 6 GHz without WPA3. The 6 GHz band mandates WPA3/OWE.`, rec: "Reconfigure those APs for WPA3; some clients won't connect to a non-compliant 6 GHz SSID." });
  }
  if (plan && thr.length) { const low = thr.filter((p) => p.download_mbps < plan * 0.5); if (low.length) { const w = low.reduce((a, b) => (b.download_mbps < a.download_mbps ? b : a)); F.push({ severity: "warning", text: `Throughput fell below half the ${plan} Mbps plan at ${nm(low)}. Slowest: ${esc(w.location)} at ${w.download_mbps} Mbps (${Math.round(w.download_mbps / plan * 100)}% of plan).`, rec: "Where this tracks weak signal, fixing coverage fixes speed. Where signal is strong but speed is low, suspect 2.4 GHz, congestion, or the WAN feed. Run a wired test at the gateway." }); } }
  if (levels.length > 1) levels.forEach((L) => { const fp = pts.filter((p) => p.level === L.id && p.signal != null); if (fp.length && fp.filter((p) => p.signal < -75).length / fp.length >= 0.5) F.push({ severity: "critical", text: `${esc(L.name)} is under-served: ${Math.round(fp.filter((p) => p.signal < -75).length / fp.length * 100)}% of its readings are dead zones. The existing coverage is not reaching this level.`, rec: `Add an access point on ${esc(L.name)}, ideally stacked near the router's vertical position or wired back to it. Re-survey after adding.` }); });
  if (cellPoints.length) {
    const b = bestCellSpot();
    const allBad = cellPoints.every((c) => (c.nr_sinr == null || c.nr_sinr < 0) && (c.lte_sinr == null || c.lte_sinr < 0));
    // bestSinr falls back to LTE when the gateway reports no 5G (see bestSinr above), so the label
    // has to follow the number. Printing an LTE figure under a "5G SINR" heading put a measurement
    // in a client's PDF that the gateway never reported.
    if (allBad) F.push({ severity: "critical", text: `No candidate spot reported a usable cellular signal (SINR of 0 dB or better). ${b.nr_sinr != null ? `Best was ${esc(b.location)} at 5G SINR ${b.nr_sinr}.` : b.lte_sinr != null ? `Best was ${esc(b.location)} at LTE SINR ${b.lte_sinr}.` : "The gateway reported no SINR at any spot, so the spots could not be ranked."} The gateway's WAN feed caps every downstream Wi-Fi speed.`, rec: "Improve the gateway signal first: try upper floors and windows facing the tower; mount the Waveform 2×2 antenna outside/high with clear line-of-sight until 5G SINR clears +5 dB." });
    else if (bestSinr != null && bestSinr < 13) F.push({ severity: "warning", text: `The best cellular spot (${esc(b.location)}) is only marginal at ${b.nr_sinr != null ? "5G" : "LTE"} SINR ${bestSinr} dB, usable but short of the 13 dB usually treated as the line for reliable full-speed service.`, rec: "Keep hunting: try higher and nearer a window facing the tower, and test an external antenna before committing." });
    else F.push({ severity: "good", text: `Best cellular placement is ${esc(b.location)}: 5G SINR ${b.nr_sinr ?? "—"} dB, RSRP ${b.nr_rsrp ?? "—"} dBm. A clean spot for the gateway.`, rec: `Mount the gateway and Waveform 2×2 antenna at ${esc(b.location)} with clear line-of-sight to the tower. SINR matters more than RSRP. Favor the cleaner signal.` });
  }
  if (pts.length >= 4 && !dead.length && !marg.length && !lowSnr.length) F.push({ severity: "good", text: `Coverage is solid across all ${distinctRooms(pts)} surveyed rooms. Every reading is Good or better with clean SNR. No dead zones, no interference flags.`, rec: "No additional access points needed. Keep the gateway in place; re-survey the far corners if the device count grows." });
  if (pts.length >= 3 && (dead.length || marg.length)) F.push({ severity: "info", text: "Router placement drives everything downstream.", rec: "Place the gateway central and high: off the floor, out of cabinets, away from metal, mirrors, and the microwave. A central router often fixes problem rooms more cheaply than new hardware." });

  const order = { critical: 0, warning: 1, good: 2, info: 3 };
  const sorted = F.sort((a, b) => order[a.severity] - order[b.severity]);
  const nameLine = site.f_client ? esc(site.f_client) : "This network";
  let summary = `${nameLine} scores <b>${score}/100 (${grade[0]})</b>. `;
  summary += (sorted.length && sorted[0].severity !== "good" && sorted[0].severity !== "info") ? stripTags(sorted[0].text) + " " : `Coverage held up across all ${distinctRooms(pts)} rooms surveyed. `;
  const firstRec = sorted.find((f) => f.rec && (f.severity === "critical" || f.severity === "warning"));
  summary += firstRec ? stripTags(firstRec.rec.split(".")[0]) + "." : "No changes recommended.";
  return { score, grade: grade[0], gradeColor: GRADE_INK.print[grade[0]], gradeInk: GRADE_INK.screen[grade[0]], subs, findings: sorted, summary };
}

function genReport() {
  if (!points.length) return toast("Save at least one room first");
  // Last chance to catch a survey walked entirely with ✓ SAVE: the readings are all there but
  // none of them has a position, so the report would come out with no map and no area figures.
  const off = unplacedPoints().length;
  if (off && !confirm(
    `${off} of your ${points.length} readings ${off > 1 ? "aren't" : "isn't"} on the map.\n\n` +
    `${off === points.length
      ? "The report will have no heatmap, no surveyed area and no % passing."
      : `${off > 1 ? "They won't" : "It won't"} appear on the heatmap or count toward the area figures.`}\n\n` +
    `On the Coverage page you can tap ${off > 1 ? "each one" : "it"} onto the map. Make the report anyway?`
  )) { showPage("map"); return; }
  saveLevelMap();
  if ($("f_client") && !$("f_client").value.trim()) {
    const name = prompt("Client or site name for the report? (optional)");
    if (name) { $("f_client").value = name; saveSite(); }
  }
  const site = {};
  SITE_FIELDS.forEach((f) => (site[f] = $(f) ? $(f).value.trim() : ""));
  const w = window.open("", "_blank");
  if (!w) return toast("Allow pop-ups for 127.0.0.1 to see the report");
  w.document.write(buildReport(site, points));
  w.document.close();
}

// Includes the apostrophe. Nothing in this file needs it, since every attribute here is
// double-quoted, and it does not make pages.js's inline onclick safe either: the HTML parser turns
// &#39; back into ' before the JS string is parsed. It stays as a cheap default in case a
// single-quoted attribute is added later.
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A data:/blob: URL for an <img src>. Everything here is produced locally by canvas.toDataURL
// or FileReader, but these values also arrive from imported .json survey files, which are
// hand-editable — so an imported survey shouldn't be able to inject a javascript: URL.
function safeImgSrc(u) {
  const s = String(u || "");
  return /^(data:image\/|blob:)/i.test(s) ? s.replace(/"/g, "&quot;") : "";
}

function healthBadge(ins, size) {
  return `<div class="hbadge" style="--bc:${ins.gradeColor};width:${size}px;height:${size}px">
    <div class="hnum">${ins.score}</div><div class="hgrade">${ins.grade}</div></div>`;
}

function buildReport(site, pts) {
  // The RF environment the survey was walked in — falls back to live only for surveys saved
  // before this was recorded, and the Interference section says which one it is either way.
  const env = (surveyEnv && surveyEnv.current) ? surveyEnv : null;
  const ins = computeInsights(pts, site, env);
  const rated = pts.map((p) => ({ ...p, r: rate(p.signal, p.snr) }));
  const dead = rated.filter((p) => p.r.cls === "poor");
  const signals = pts.map((p) => p.signal).filter((s) => s != null);
  const best = signals.length ? Math.max(...signals) : null;
  const worst = signals.length ? Math.min(...signals) : null;
  const avg = signals.length ? Math.round(signals.reduce((a, b) => a + b, 0) / signals.length) : null;
  const plan = parseFloat(site.f_plan) || null;
  const thr = pts.filter((p) => p.download_mbps != null);
  const today = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const levelName = (id) => { const l = levels.find((x) => x.id === id); return l ? l.name : "—"; };
  const hasGps = pts.some((p) => p.gps);

  // sub-score bars
  const subBars = ins.subs.map((s) => `<div class="sbrow"><span class="sbl">${s.name}</span><div class="sbbar"><i style="width:${s.val}%;background:${s.val >= 75 ? "#3f8f13" : s.val >= 60 ? "#b45309" : "#dc2626"}"></i></div><span class="sbv">${s.val}</span></div>`).join("");

  // findings cards (relabeled for a plain-language reader: "Finding" / "What to do")
  const insightCards = ins.findings.map((f) => `<div class="finding f-${f.severity}"><div class="fsev">${f.severity === "good" ? "Looking good" : f.severity === "info" ? "Note" : f.severity === "warning" ? "Needs attention" : "Priority fix"}</div><div class="ftext">${f.text}${f.rec ? `<div class="frec"><b>What to do.</b> ${f.rec}</div>` : ""}</div></div>`).join("") || "<p>Not enough data for analysis yet.</p>";

  // ---- plain-language "bottom line" for a non-technical reader ----
  const byRoom = {};
  pts.forEach((p) => { const k = p.location || "—"; (byRoom[k] = byRoom[k] || []).push(p); });
  const roomKeys = Object.keys(byRoom), totalRooms = roomKeys.length;
  const roomsGood = roomKeys.filter((k) => byRoom[k].every((p) => p.signal == null || p.signal >= -67)).length;
  const mappedNow = mappedPoints(pts);
  // Two different numbers used to share one label. The target figure is an area estimate over the
  // mapped floor; the fallback is a plain count of readings. Calling either "of the home covered
  // well" overstated both, since neither knows about the parts of the home nobody walked.
  let covPct = null, covLabel = "";
  if (reqProfile !== "none") { const rs = requirementStats(mappedNow); if (rs.ok) { covPct = rs.pct; covLabel = "of the mapped floor meeting the target"; } }
  if (covPct == null && signals.length) { covPct = Math.round((100 * signals.filter((s) => s >= -67).length) / signals.length); covLabel = "of readings at −67 dBm or better"; }
  const areaFtR = surveyedSqft(mappedNow), holeFtR = dead.length ? holeAreaSqft(-75, mappedNow) : 0;
  const gword = (ins.grade || "").toLowerCase();
  const verdict = dead.length === 0
    ? `The Wi-Fi here is <b>${gword}</b>. No reading fell into the dead-zone range (below −75 dBm), so there are no dead zones to fix.`
    : `The Wi-Fi here is <b>${gword}</b> overall, but <b>${dead.length} area${dead.length > 1 ? "s" : ""}</b> ${dead.length > 1 ? "need" : "needs"} attention before coverage is solid everywhere.`;
  const blk = (n, l, color) => `<div class="blk"><div class="blk-n"${color ? ` style="color:${color}"` : ""}>${n}</div><div class="blk-l">${l}</div></div>`;
  const bottomLine = `<div class="bottomline">${healthBadge(ins, 108)}<div class="bl-main"><div class="bl-verdict">${verdict}</div><div class="bl-kpis">
    ${blk(roomsGood + " / " + totalRooms, "rooms with strong Wi-Fi")}
    ${covPct != null ? blk(covPct + "%", covLabel) : ""}
    ${blk(dead.length, "dead zone" + (dead.length !== 1 ? "s" : "") + (holeFtR ? " · " + fmtSqft(holeFtR) : ""), dead.length ? "#dc2626" : "#15803d")}
    ${areaFtR ? blk(fmtSqft(areaFtR), "area surveyed") : ""}
  </div></div></div>`;

  // room table (comprehensive)
  const gpsHead = hasGps ? "<th>GPS</th>" : "";
  const gpsCell = (p) => hasGps ? `<td>${p.gps ? p.gps.lat.toFixed(5) + ", " + p.gps.lon.toFixed(5) + (p.gps.acc ? " ±" + Math.round(p.gps.acc) + "m" : "") : "—"}</td>` : "";
  const colspan = 13 + (hasGps ? 1 : 0);
  const detailRow = (p, i) => `<tr><td>${i + 1}</td><td>${esc(p.location)}</td><td>${esc(levelName(p.level))}</td><td>${esc(p.ssid || "—")}</td>
    <td>${p.band || "?"} / ch ${p.channel ?? "?"}${p.width ? " " + p.width : ""}</td>
    <td>${p.signal ?? "—"}</td><td>${p.noise ?? "—"}</td><td>${p.snr ?? "—"}</td>
    <td>${p.phy_friendly || p.phy || "—"}${p.rate ? " · " + p.rate + "M" : ""}</td>
    <td>${p.download_mbps != null ? p.download_mbps + " / " + (p.upload_mbps ?? "—") : "—"}</td>
    <td>${p.ping_avg_ms != null ? p.ping_avg_ms + " ms" + (p.ping_loss_pct ? " · " + p.ping_loss_pct + "%" : "") : "—"}</td>
    <td>${esc(p.security || "—")}</td>
    <td class="r-${p.r.cls}">${p.r.label}</td>${gpsCell(p)}</tr>`;

  let rows;
  if (distinctRooms(rated) === rated.length) {
    // No rooms drawn / nothing actually groups — flat table, no group headers.
    rows = rated.map((p, i) => detailRow(p, i)).join("");
  } else {
    // Group by room (roomOf) within its floor, preserving first-appearance order.
    const RANK = { na: 0, exc: 1, good: 2, fair: 3, poor: 4 };
    const OVERALL = { na: { cls: "na", label: "—" }, exc: { cls: "exc", label: "Excellent" }, good: { cls: "good", label: "Good" }, fair: { cls: "fair", label: "Fair" }, poor: { cls: "poor", label: "Poor" } };
    const order = [];
    const groups = new Map();
    rated.forEach((p, i) => {
      const room = roomOf(p);
      const key = p.level + "\u241f" + room;
      let g = groups.get(key);
      if (!g) { g = { room, level: p.level, items: [] }; groups.set(key, g); order.push(key); }
      g.items.push({ p, i });
    });
    rows = order.map((key) => {
      const g = groups.get(key);
      const sigs = g.items.map((it) => it.p.signal).filter((s) => s != null);
      const avg = sigs.length ? Math.round(sigs.reduce((a, b) => a + b, 0) / sigs.length) : null;
      const worstCls = g.items.reduce((w, it) => RANK[it.p.r.cls] > RANK[w] ? it.p.r.cls : w, "na");
      const ov = OVERALL[worstCls];
      const n = g.items.length;
      const header = `<tr class="rgrp"><td colspan="${colspan}">` +
        `<b>${esc(g.room)}</b> · ${esc(levelName(g.level))} · ${n} reading${n === 1 ? "" : "s"}` +
        ` · avg RSSI ${avg != null ? avg + " dBm" : "—"}` +
        ` · <span class="r-${ov.cls}">${ov.label}</span></td></tr>`;
      const body = g.items.map((it) => detailRow(it.p, it.i)).join("");
      return header + body;
    }).join("");
  }

  // per-floor heatmaps
  let heatmapSection = "";
  const HM = METRICS[heatMetric];
  const rp = reqProfile !== "none" ? REQ_PROFILES[reqProfile] : null;

  // Area and % passing are per-FLOOR figures. They used to be printed once, from whichever
  // level happened to be selected, underneath every floor's heatmap — so the same numbers
  // appeared under all of them and changed depending on what was on screen at the time.
  const floorFigures = (l) => {
    const s = scaleFor(l);
    const pl = mappedPoints(points, l.id);
    if (!s || pl.length < 3) return "";
    const area = polyFracArea(requirementHull(pl) || coverageHull(pl, 0.14) || []) * s.ftW * s.ftH;
    if (!area) return "";
    let out = `<p class="legend">Surveyed area ≈ <b>${fmtSqft(area)}</b> (${s.source === "gps" ? "scaled from GPS imagery" : "from the set scale"}).</p>`;
    if (rp && l.id === activeLevel) {
      const rs = requirementStats(pl);
      const sqPass = rs.ok ? ` (≈ ${Math.round((area * rs.pct) / 100).toLocaleString()} ft²)` : "";
      out += `<p class="legend"><b>Requirement: ${esc(rp.label)}</b> (${esc(reqGateText(rp))}): ${rs.ok ? `an estimated <b>${rs.pct}%</b>${sqPass} of this floor passes` : "insufficient readings to score"}. Greyed cells fall short of target.</p>`;
    }
    return out;
  };

  const levelShots = levels.filter((l) => l.snapshot);
  if (levelShots.length) {
    heatmapSection = levelShots.map((l) =>
      `<h2>Coverage: ${esc(l.name)}</h2><img class="hm" src="${safeImgSrc(l.snapshot)}">${floorFigures(l)}`).join("");
  } else {
    const coverImg = generateMapDataURL() || heatmapDataUrl;
    const cur = levels.find((l) => l.id === activeLevel);
    heatmapSection = coverImg
      ? `<h2>Coverage Heatmap</h2><img class="hm" src="${safeImgSrc(coverImg)}">${cur ? floorFigures(cur) : ""}` : "";
  }
  if (heatmapSection) {
    heatmapSection += `<p class="legend">Heatmap metric: ${heatMode === "passfail" ? `${HM.label}. Pass/Fail (${heatPreset}): pass ≥ ${HM.th[heatPreset][0]} ${HM.unit}` : `${HM.label} (${HM.unit}), weak <span style="display:inline-block;width:84px;height:9px;border-radius:5px;vertical-align:-1px;background:${colormapCss()}"></span> strong`}. Routers and access points are marked with a blue dot and a name label above it.</p>
      <p class="legend">Each reading is marked <b>E</b> excellent, <b>G</b> good, <b>W</b> weak or <b>D</b> dead zone, so the map reads correctly in greyscale and with colour blindness.</p>`;
    heatmapSection += baseMapCredit();
  }

  // throughput section
  let thrSection = "";
  if (thr.length) {
    const trows = thr.map((p) => { const pct = plan ? Math.round(p.download_mbps / plan * 100) : null; const bad = plan && p.download_mbps < plan * 0.5; return `<tr><td>${esc(p.location)}</td><td>${p.download_mbps} Mbps</td><td>${p.upload_mbps != null ? p.upload_mbps + " Mbps" : "—"}</td><td style="${bad ? "color:#dc2626;font-weight:700" : ""}">${pct != null ? pct + "% of plan" : "—"}</td><td>${p.ping_avg_ms != null ? p.ping_avg_ms + " ms" : "—"}</td></tr>`; }).join("");
    thrSection = `<h2>Throughput &amp; Latency</h2>${plan ? `<p>Plan speed: <b>${plan} Mbps</b>. Rooms under 50% of plan are flagged.</p>` : ""}<div class="tw"><table><thead><tr><th>Room</th><th>Download</th><th>Upload</th><th>vs Plan</th><th>Latency</th></tr></thead><tbody>${trows}</tbody></table></div>`;
  }

  // nearby / RF environment
  let rfSection = "";
  const envScan = env || (lastScan && lastScan.current ? lastScan : null);
  const scan = importedScan.length ? importedScan : ((envScan && envScan.nearby) || []);
  if (scan.length) {
    const cur = envScan && envScan.current ? envScan.current : null;
    const co = cur ? scan.filter((n) => n.channel === cur.channel && n.ssid !== cur.ssid) : [];
    const rich = importedScan.length > 0 && scan.some((n) => n.width || n.security || n.vendor);
    const nrows = scan.slice().sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999)).slice(0, 20)
      .map((n) => { const c = cur && n.channel === cur.channel && n.ssid !== cur.ssid; return `<tr><td>${esc(n.ssid || "(hidden)")}</td><td>${n.channel ?? "?"}</td><td>${esc(n.band || "?")}</td>${rich ? `<td>${esc(n.width || "—")}</td>` : ""}<td>${n.signal != null ? n.signal + " dBm" : "—"}</td>${rich ? `<td>${esc(n.security || "—")}</td><td>${esc(n.vendor || "—")}</td>` : ""}<td>${c ? '<span style="color:#b45309;font-weight:700">co-channel</span>' : ""}</td></tr>`; }).join("");
    const rfHead = `<th>Network</th><th>Channel</th><th>Band</th>${rich ? "<th>Width</th>" : ""}<th>Signal</th>${rich ? "<th>Security</th><th>Vendor</th>" : ""}<th>Note</th>`;
    // Say where these numbers came from. A reader can't otherwise tell a survey-time scan from
    // one taken wherever the laptop happened to be when the report was printed.
    const when = importedScan.length ? "Imported from an external scan."
      : env && env.ts ? `Recorded during the survey, ${new Date(env.ts).toLocaleString()}.`
      : "Read live when this report was generated, not during the survey. Treat as indicative.";
    rfSection = `<h2>Interference &amp; Nearby Networks</h2>
      <p>${importedScan.length ? `Imported WiFi&nbsp;Explorer scan of <b>${scan.length}</b> networks. ` : `${cur ? `The network was surveyed on <b>channel ${cur.channel} (${cur.band || "?"})</b>. ` : ""}`}${co.length ? `<b>${co.length}</b> neighboring network${co.length > 1 ? "s share" : " shares"} the surveyed channel, a common cause of slowdowns even at full signal.` : cur ? "No other network was seen on the surveyed channel. Adjacent-channel overlap and non-Wi-Fi interference are not assessed." : "No connected network was recorded with this scan, so channel overlap could not be checked."} ${scan.length} networks detected in total.</p>
      <p class="legend">${when}</p>
      <div class="tw"><table><thead><tr>${rfHead}</tr></thead><tbody>${nrows}</tbody></table></div>`;
  }

  // infrastructure & security posture (connected AP + any visible neighbors)
  let postureSection = "";
  {
    const cur3 = envScan && envScan.current ? envScan.current : null;
    const infraAps = (cur3 ? [cur3] : []).concat(scan);
    if (infraAps.length) {
      const infra = analyzeInfra(infraAps);
      const chip = (label, n, color) => `<span style="display:inline-block;border:1px solid #cbd5e1;border-left:4px solid ${color};border-radius:6px;padding:3px 10px;margin:3px 4px 3px 0;font-size:13px;background:#f8fafc">${esc(label)}: <b>${n}</b></span>`;
      const genOrder = [["Wi-Fi 7", "#7c3aed"], ["Wi-Fi 6E", "#2563eb"], ["6 GHz (6E/7)", "#2563eb"], ["Wi-Fi 6", "#0891b2"], ["Wi-Fi 5", "#0d9488"], ["Wi-Fi 4", "#ca8a04"], ["Legacy a/b/g", "#dc2626"], ["Unknown", "#94a3b8"]];
      const genChips = genOrder.filter((o) => infra.gen[o[0]]).map((o) => chip(o[0], infra.gen[o[0]], o[1])).join("");
      const secOrder = [["WPA3", "#22c55e"], ["WPA2", "#84cc16"], ["WPA (legacy)", "#f59e0b"], ["WEP (insecure)", "#ef4444"], ["Open", "#ef4444"], ["Unknown", "#94a3b8"]];
      const secChips = secOrder.filter((o) => infra.sec[o[0]]).map((o) => chip(o[0], infra.sec[o[0]], o[1])).join("");
      const bandChips = Object.keys(infra.band).filter((k) => infra.band[k]).map((k) => chip(k, infra.band[k], "#64748b")).join("");
      const flags = [];
      if (infra.open) flags.push(`<b>${infra.open}</b> open / unencrypted network${infra.open > 1 ? "s" : ""} in range`);
      if (infra.legacy) flags.push(`<b>${infra.legacy}</b> using outdated WEP/WPA security`);
      if (infra.sixViolation) flags.push(`<b>${infra.sixViolation}</b> AP${infra.sixViolation > 1 ? "s" : ""} on 6 GHz without WPA3 (6 GHz mandates WPA3)`);
      const flagHtml = flags.length ? `<p class="legend" style="color:#b45309">⚠︎ ${flags.join(" · ")}.</p>` : `<p class="legend">No open, legacy-encryption, or 6 GHz compliance issues among visible networks.</p>`;
      const note = infraAps.length === 1 && cur3 ? `<p class="legend" style="opacity:.7;font-size:11px">Only the connected network was visible. Grant the survey app Location Services access on this Mac for a full neighbor-AP inventory. Generation reflects the highest standard each AP advertises; security shown as reported (WPA3 implies PMF, not independently confirmed on macOS).</p>` : `<p class="legend" style="opacity:.7;font-size:11px">Generation reflects the highest standard each AP advertises. Security shown as reported (WPA3 implies PMF, not independently confirmed on macOS).</p>`;
      postureSection = `<h2>Infrastructure &amp; Security</h2>
        <p><b>Wi-Fi generations in range:</b></p><p>${genChips}</p>
        <p><b>Bands in use:</b></p><p>${bandChips}</p>
        <p><b>Security posture:</b></p><p>${secChips}</p>
        ${flagHtml}${note}`;
    }
  }

  // cellular
  let cellSection = "";
  if (cellPoints.length) {
    const cbest = bestCellSpot();
    const crows = cellPoints.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.location)}</td><td>${p.nr_sinr ?? "—"}</td><td>${p.nr_rsrp ?? "—"}</td><td>${esc(p.nr_band || "—")}</td><td>${p.lte_sinr ?? "—"}</td><td>${p.lte_rsrp ?? "—"}</td></tr>`).join("");
    cellSection = `<h2>Cellular WAN: Antenna Placement</h2>
      <p>The T-Mobile gateway's cellular signal is the internet feed everything else depends on. Higher <b>SINR</b> means faster, steadier service. Mount the Waveform 2×2 antenna at the cleanest spot with clear line-of-sight to the tower.</p>
      <div class="tw"><table><thead><tr><th>#</th><th>Candidate spot</th><th>5G SINR</th><th>5G RSRP</th><th>5G Band</th><th>LTE SINR</th><th>LTE RSRP</th></tr></thead><tbody>${crows}</tbody></table></div>
      <p style="margin-top:10px"><b>Recommended mount location: ${esc(cbest.location)}</b>. 5G SINR ${cbest.nr_sinr ?? "—"} dB, RSRP ${cbest.nr_rsrp ?? "—"} dBm${cbest.nr_band ? " (band " + esc(cbest.nr_band) + ")" : ""}.</p>`;
  }

  // remediation plan
  const rems = ins.findings.filter((f) => (f.severity === "critical" || f.severity === "warning") && f.rec);
  let remSection = "";
  if (rems.length) {
    const rrows = rems.map((f, i) => `<tr><td><span class="pri p-${f.severity}">${f.severity === "critical" ? "P1" : "P2"}</span></td><td>${stripTags(f.text).split(".")[0]}.</td><td>${f.rec}</td></tr>`).join("");
    remSection = `<h2>Recommended Action Plan</h2><div class="tw"><table><thead><tr><th>Priority</th><th>Issue</th><th>Recommended action</th></tr></thead><tbody>${rrows}</tbody></table></div>`;
  }

  // site photos & screenshots
  let photosSection = "";
  if (reportPhotos.length) {
    const cards = reportPhotos.map((p) => `<figure class="pfig"><img src="${safeImgSrc(p.url)}" alt="site photo">${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ""}</figure>`).join("");
    photosSection = `<h2>Site Photos</h2><div class="pgrid">${cards}</div>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Wi-Fi Report: ${esc(site.f_client || "Report")}</title>
<style>
  @page{margin:15mm}
  html{background:#fff}
  body{font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1a2233;background:#fff;max-width:900px;margin:0 auto;padding:0 24px 24px}
  h1{font-size:23px;margin:0 0 2px}
  h2{font-size:14px;margin:30px 0 12px;color:#22304d;padding-bottom:6px;border-bottom:2px solid #e2e8f4;position:relative}
  h2::before{content:"";position:absolute;left:0;bottom:-2px;width:52px;height:2px;background:#4f8cff}
  p{margin:8px 0}
  .cover{min-height:96vh;display:flex;flex-direction:column;page-break-after:always}
  .cband{background:linear-gradient(120deg,#22304d,#4f8cff);color:#fff;border-radius:14px;padding:34px 32px;margin-top:20px}
  .cband .kick{font-size:12px;letter-spacing:2px;text-transform:uppercase;opacity:.85;font-weight:700}
  .cband h1{color:#fff;font-size:34px;margin:8px 0 4px;letter-spacing:-.3px}
  .cband .caddr{opacity:.9;font-size:15px}
  .coverbody{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center}
  .hbadge{border-radius:50%;border:9px solid var(--bc);display:flex;flex-direction:column;align-items:center;justify-content:center;box-shadow:0 8px 26px rgba(20,30,60,.12)}
  .hbadge .hnum{font-size:52px;font-weight:800;color:var(--bc);line-height:1}
  .hbadge .hgrade{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--bc)}
  .cmeta{color:#667;font-size:13px}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 24px;background:#f4f7fc;padding:16px 20px;border-radius:10px;font-size:12.5px}
  .meta b{color:#556}
  .summarybox{display:flex;gap:20px;align-items:center;background:#f7f9fc;border:1px solid #e2e8f4;border-radius:12px;padding:20px 22px}
  .summarybox .stext{font-size:14px;line-height:1.6}
  .stats{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}
  .stat{flex:1;min-width:96px;background:#f4f7fc;border:1px solid #e8edf6;border-radius:10px;padding:12px 14px}
  .stat .n{font-size:24px;font-weight:800}.stat .l{font-size:10.5px;color:#667;text-transform:uppercase;letter-spacing:.5px}
  .bottomline{display:flex;gap:22px;align-items:center;background:linear-gradient(120deg,#f7f9fc,#eef4ff);border:1px solid #dbe6fb;border-radius:14px;padding:22px 24px}
  .bl-main{flex:1}
  .bl-verdict{font-size:16px;line-height:1.5;color:#22304d;margin-bottom:14px}
  .bl-kpis{display:flex;gap:12px;flex-wrap:wrap}
  .blk{flex:1;min-width:118px;background:#fff;border:1px solid #e3e9f4;border-radius:10px;padding:12px 14px;text-align:center}
  .blk-n{font-size:25px;font-weight:800;color:#22304d;line-height:1}
  .blk-l{font-size:11px;color:#667;margin-top:5px;line-height:1.3}
  .appendix-divider{margin-top:42px;padding-top:6px;border-top:3px solid #22304d;page-break-before:always}
  .appendix-divider h2{border:none;margin:16px 0 2px;font-size:16px}.appendix-divider h2::before{display:none}
  .appendix-divider p{color:#667;font-size:12.5px;margin-top:2px}
  .appx h2{color:#556}
  .sbrow{display:flex;align-items:center;gap:12px;margin:7px 0;font-size:12.5px}
  .sbl{width:120px;color:#556;font-weight:600}.sbv{width:32px;text-align:right;font-weight:800}
  .sbbar{flex:1;height:9px;background:#eef2f8;border-radius:5px;overflow:hidden}.sbbar i{display:block;height:100%}
  .finding{border-left:4px solid #999;background:#fbfcfe;border-radius:0 10px 10px 0;padding:12px 16px;margin:10px 0}
  .finding.f-critical{border-color:#dc2626;background:#fef4f4}.finding.f-warning{border-color:#b45309;background:#fff9f0}
  .finding.f-good{border-color:#15803d;background:#f2fbf5}.finding.f-info{border-color:#4f8cff;background:#f4f8ff}
  .fsev{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;margin-bottom:4px}
  .f-critical .fsev{color:#dc2626}.f-warning .fsev{color:#b45309}.f-good .fsev{color:#15803d}.f-info .fsev{color:#4f8cff}
  .frec{margin-top:6px;font-size:12px;color:#42506a}
  .tw{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:6px}
  th,td{border:1px solid #dde3ee;padding:6px 8px;text-align:left;white-space:nowrap}
  th{background:#22304d;color:#fff;font-size:10px;text-transform:uppercase}
  tr:nth-child(even) td{background:#f8fafd}
  .r-exc{color:#15803d;font-weight:700}.r-good{color:#3f8f13;font-weight:600}
  .r-fair{color:#b45309;font-weight:700}.r-poor{color:#dc2626;font-weight:700}.r-na{color:#889}
  .rgrp td{background:#eef2f9;border-top:2px solid #22304d;font-size:11px;color:#22304d;white-space:normal;padding:7px 10px}
  tr.rgrp:nth-child(even) td{background:#eef2f9}
  .rgrp td b{font-size:12px}
  .pri{display:inline-block;padding:2px 8px;border-radius:20px;font-weight:800;font-size:10px;color:#fff}
  .pri.p-critical{background:#dc2626}.pri.p-warning{background:#b45309}
  .hm{max-width:100%;border:1px solid #dde3ee;border-radius:8px;margin-top:4px}
  .legend{font-size:11px;color:#667;margin-top:8px}
  .pgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:8px}
  .pfig{margin:0;break-inside:avoid;page-break-inside:avoid}
  .pfig img{width:100%;max-height:340px;object-fit:contain;border:1px solid #dde3ee;border-radius:8px;background:#f8fafd;display:block}
  .pfig figcaption{font-size:11px;color:#556;margin-top:5px;text-align:center}
  @media print{.pfig{page-break-inside:avoid}}
  .noprint{padding:16px 0 0}
  button{background:#4f8cff;color:#fff;border:0;padding:11px 22px;border-radius:9px;font-size:14px;font-weight:700;cursor:pointer}
  @media print{.noprint{display:none}h2{page-break-after:avoid}.finding,tr{page-break-inside:avoid}}
  footer{margin-top:30px;padding-top:12px;border-top:1px solid #dde3ee;color:#889;font-size:11px}
</style></head><body>
<div class="noprint"><button onclick="window.print()">🖨️  Print / Save as PDF</button></div>

<div class="cover">
  <div class="cband">
    <div class="kick">Wi-Fi Site Survey &amp; Coverage Report</div>
    <h1>${esc(site.f_client || "Client Site")}</h1>
    <div class="caddr">${esc(site.f_address || "")}</div>
  </div>
  <div class="coverbody">
    ${healthBadge(ins, 160)}
    <div style="font-size:18px;font-weight:700;color:#22304d">Wi-Fi Signal Score</div>
    <div class="cmeta">${distinctRooms(pts)} rooms · ${pts.length} readings · ${levels.length} floor${levels.length > 1 ? "s" : ""} · ${today}<br>Prepared by ${esc(site.f_tech || "—")}</div>
  </div>
</div>

<h2>The Bottom Line</h2>
${bottomLine}

<h2>Executive Summary</h2>
<div class="summarybox"><div class="stext">${ins.summary}</div></div>

${heatmapSection}

<h2>What We Found &amp; What To Do</h2>
${insightCards}

${remSection}
${photosSection}

<div class="appendix-divider">
  <h2>Technical Appendix</h2>
  <p>The measurements and detail behind the summary above, for the installer or IT team. Nothing here changes the recommendations; it's the supporting data.</p>
</div>
<div class="appx">

<h2>Survey Scope</h2>
<div class="meta">
  <div><b>Client / Site:</b> ${esc(site.f_client || "—")}</div>
  <div><b>Address:</b> ${esc(site.f_address || "—")}</div>
  <div><b>Technician:</b> ${esc(site.f_tech || "—")}</div>
  <div><b>Date:</b> ${today}</div>
  <div><b>Gateway / router:</b> ${esc(site.f_gw || "—")}</div>
  <div><b>Surveyed network:</b> ${esc(site.f_ssid || (lastScan && lastScan.current ? lastScan.current.ssid : "—"))}</div>
  <div><b>Internet plan:</b> ${plan ? plan + " Mbps" : "—"}</div>
  <div><b>Home size:</b> ${site.f_sqft ? esc(site.f_sqft) + " sq ft (est.)" : "—"}</div>
  <div><b>Rooms surveyed:</b> ${distinctRooms(pts)} (${pts.length} readings)</div>
  <div><b>Floors:</b> ${levels.map((l) => esc(l.name)).join(", ")}</div>
</div>

<h2>Signal Score Breakdown</h2>
<div class="stats">
  <div class="stat"><div class="n">${distinctRooms(pts)}</div><div class="l">Rooms</div></div>
  <div class="stat"><div class="n">${pts.length}</div><div class="l">Readings</div></div>
  <div class="stat"><div class="n">${best ?? "—"}</div><div class="l">Best dBm</div></div>
  <div class="stat"><div class="n">${worst ?? "—"}</div><div class="l">Worst dBm</div></div>
  <div class="stat"><div class="n">${avg ?? "—"}</div><div class="l">Avg dBm</div></div>
  <div class="stat"><div class="n" style="color:${dead.length ? "#dc2626" : "#15803d"}">${dead.length}</div><div class="l">Dead spots</div></div>
</div>
${subBars ? `<div style="margin-top:14px">${subBars}</div><p class="legend">Each sub-score is 0–100; the overall score weights coverage most heavily and is capped when dead zones exist so the headline number never overstates the network.</p>` : ""}

<h2>Survey Results: Room by Room</h2>
<div class="tw"><table><thead><tr><th>#</th><th>Point</th><th>Floor</th><th>SSID</th><th>Band / Ch</th><th>RSSI</th><th>Noise</th><th>SNR</th><th>PHY / Rate</th><th>↓/↑ Mbps</th><th>Latency</th><th>Security</th><th>Rating</th>${gpsHead}</tr></thead>
<tbody>${rows}</tbody></table></div>
<div class="legend">Rating (RSSI): Excellent ≥ −55 · Good −56 to −67 · Fair −68 to −75 · Poor &lt; −75. −67 dBm is the reliable-connectivity line; SNR &lt; 15 dB flags a noisy link.</div>

${thrSection}
${rfSection}
${postureSection}
${cellSection}
</div>

<h2>Methodology &amp; Notes</h2>
<p>Wi-Fi readings were taken with a MacBook (built-in Wi-Fi radio) using native macOS telemetry (<i>system_profiler</i>), Apple's <i>networkQuality</i> for throughput, and <i>ping</i> for latency/loss. Readings were taken at named spots with the device held still at each one; larger rooms may hold more than one, and every reading is listed separately in the room-by-room table. Cellular placement readings come from the gateway's own 5G/LTE SINR &amp; RSRP telemetry. Coverage heatmaps are interpolated between measured points. This survey does not assess non-Wi-Fi (spectrum) interference, which requires dedicated hardware.</p>
<footer>Generated ${today} · Wi-Fi Site Survey. Readings are point-in-time and vary with device, orientation, and interference. Wi-Fi signal score is an automated estimate to guide decisions, not a guarantee.</footer>
</body></html>`;
}

export { computeInsights,distinctRooms,esc,genReport,roomOf,safeImgSrc };
