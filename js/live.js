// Live signal page: polling, capturing readings, the speed test, summary strip.

import { GRADE_COLOR, cellVerdict, removeHeatmap, renderCellSpots, renderReportPhotos, saveCellPoints, savePhotos } from "./cellular.js";
import { api, rate, store, toast, updateGauge, updateSideStatus } from "./core.js";
import { savePoints } from "./gps.js";
import { REQ_PROFILES, getScale, holeAreaSqft, mappedPoints, renderCoverageMap, requirementStats, surveyedSqft, unplacedPoints } from "./heatmap.js";
import { renderReportInsights } from "./pages.js";
import { fmtSqft, saveLevels, setMapMode } from "./planner.js";
import { distinctRooms, esc } from "./report.js";
import { $, LS_IMPORTEDSCAN, LS_SURVEYENV, activeLevel, cellPoints, geoBounds, gpsEnabled, heatmapDataUrl, importedScan, lastCell, lastGpsFix, lastScan, levels, mapMode, placingId, planMode, points, reportPhotos, reqProfile, set, surveyEnv } from "./state.js";
/* ---------- live poll ---------- */
async function poll() {
  try {
    const d = await api("/api/scan");
    if (!d.ok) throw new Error();
    set.lastScan(d);
    const c = d.current;
    const r = rate(c ? c.signal : null, c ? c.snr : null);
    updateGauge(c ? c.signal : null, r);
    $("gaugeDbm").textContent = c ? `${c.signal} dBm` : "—";
    $("gaugeNet").textContent = c ? `${c.ssid}${c.phy_friendly ? " · " + c.phy_friendly : ""}` : "Not connected";
    if ($("miniDbm")) {
      $("miniDbm").textContent = c ? `${c.signal} dBm` : "—";
      $("miniDbm").style.color = c ? r.color : "var(--muted)";
      $("miniWord").textContent = c ? r.word : "—";
      $("miniWord").style.color = c ? r.color : "var(--muted)";
      $("miniNet").textContent = c ? c.ssid : "not connected";
    }
    updateFloatDbm(c, r);
    const band = $("easyStatus");
    if (c) {
      band.className = "statusband ok";
      band.querySelector(".big-dot").textContent = "✅";
      $("easyStatusText").textContent = "Connected to " + c.ssid;
    } else {
      band.className = "statusband bad";
      band.querySelector(".big-dot").textContent = "⚠️";
      $("easyStatusText").textContent = "Not connected. Join the home's Wi-Fi";
    }
    renderAdvLive(d);
    renderNearby(d.nearby, c);
    updateSideStatus();   // the sidebar pills track the live scan, not just saved readings
  } catch (e) {
    $("easyStatusText").textContent = "Backend offline. Is the server running?";
    $("gaugeWord").textContent = "—";
  }
}

// keep the fixed floating dBm readout (Coverage page) in sync with the live scan.
// c = lastScan.current (or null); r = rate(c.signal, c.snr). Hidden when there is no signal.
function updateFloatDbm(c, r) {
  const box = $("floatDbm");
  if (!box) return;
  const onMap = $("page-map") && !$("page-map").classList.contains("hidden");
  if (!onMap || !c || c.signal == null) {
    box.classList.remove("show");
    return;
  }
  box.classList.add("show");
  box.style.setProperty("--floatc", r.color);
  $("floatDbmVal").textContent = `${c.signal} dBm`;
  $("floatDbmWord").textContent = r.word;
  $("floatDbmNet").textContent = c.ssid || "—";
}

function renderAdvLive(d) {
  if (!$("liveRssi")) return;
  $("liveTs").textContent = d.ts ? "· " + d.ts.split("T")[1] : "";
  $("liveGw").textContent = d.default_gateway || "—";
  const c = d.current;
  if (!c) {
    $("liveRssi").textContent = "—";
    $("liveSsid").textContent = "not associated";
    ["liveSnr", "liveChan", "livePhy", "liveTx", "liveSec"].forEach((i) => ($(i).textContent = "—"));
    $("liveRating").innerHTML = "";
    $("liveRate").textContent = "";
    return;
  }
  const r = rate(c.signal, c.snr);
  $("liveRssi").textContent = (c.signal ?? "—") + " dBm";
  $("liveSsid").textContent = c.ssid || "—";
  $("liveRate").textContent = c.phy_friendly || "";
  $("liveRating").innerHTML = `<span class="tag t-${r.cls}">${r.label}</span>`;
  $("liveSnr").textContent = c.snr != null ? c.snr + " dB" : "—";
  $("liveChan").textContent = c.channel ? `${c.channel} · ${c.band || ""} ${c.width || ""}`.trim() : "—";
  $("livePhy").textContent = c.phy || "—";
  $("liveTx").textContent = c.rate ? c.rate + " Mbps" + (c.mcs != null ? ` (MCS ${c.mcs})` : "") : "—";
  $("liveSec").textContent = c.security || "—";
}

function renderNearby(list, current) {
  const el = $("nearbyList");
  if (!el) return;
  if (!list || !list.length) return void (el.innerHTML = '<li class="muted">none detected</li>');
  const curCh = current && current.channel;
  el.innerHTML = list
    .slice()
    .sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999))
    .map((n) => {
      const co = n.channel && n.channel === curCh ? ' <span class="tag t-fair">co-channel</span>' : "";
      const sig = n.signal != null ? n.signal + " dBm" : "—";
      return `<li><span>${esc(n.ssid || "(hidden)")}${co}</span>
        <span class="muted">ch ${n.channel ?? "?"} · ${n.band || "?"} · ${sig}</span></li>`;
    })
    .join("");
}

async function launch(app) {
  try {
    const d = await api("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app }),
    });
    if (!d.ok) toast("Couldn't open " + app + ". Is it installed?");
  } catch (e) {
    toast("Launch failed");
  }
}

/* ---------- capture ---------- */
// Record the RF environment once, on the first reading of a survey — that is the moment the
// tech is standing in the client's building on the client's network. Later readings don't
// overwrite it: the first one is the honest answer to "what was the air like during the survey".
function captureSurveyEnv() {
  if (surveyEnv || !lastScan || !lastScan.current) return;
  set.surveyEnv({
    current: lastScan.current,
    nearby: lastScan.nearby || [],
    ts: new Date().toISOString(),
  });
  store(LS_SURVEYENV, JSON.stringify(surveyEnv));
}

function addPoint(loc, c, extras) {
  const pt = {
    id: Date.now(), location: loc, ts: new Date().toISOString(), level: activeLevel,
    ssid: c.ssid, signal: c.signal, noise: c.noise, snr: c.snr,
    channel: c.channel, band: c.band, width: c.width,
    phy: c.phy, phy_friendly: c.phy_friendly, rate: c.rate, mcs: c.mcs, security: c.security,
    download_mbps: null, upload_mbps: null, responsiveness_rpm: null, ping_avg_ms: null, ping_loss_pct: null,
  };
  if (extras) Object.assign(pt, extras);
  if (gpsEnabled && lastGpsFix && lastGpsFix.age_sec != null && lastGpsFix.age_sec < 25) {
    pt.gps = { lat: lastGpsFix.lat, lon: lastGpsFix.lon, acc: lastGpsFix.acc };
  }
  points.push(pt);
  // If the write failed the reading only exists in memory — it will not survive a reload.
  // store() has already warned; roll it back so the list can't show a reading that isn't saved.
  if (!savePoints()) { points.pop(); return null; }
  captureSurveyEnv();
  renderPoints();
  return pt;
}

function saveEasy() {
  const loc = $("easyRoom").value.trim();
  if (!loc) return toast("Type the room name first");
  if (!lastScan || !lastScan.current) return toast("No Wi-Fi signal. Are you connected?");
  if (!addPoint(loc, lastScan.current, null)) return;   // storage failed — keep the typed name so it can be retried
  $("easyRoom").value = "";
  $("easyRoom").focus();
  toast(`Saved “${loc}”  ·  ${lastScan.current.signal} dBm`);
}

async function captureAdv() {
  const loc = $("capLoc").value.trim();
  if (!loc) return toast("Enter a location label first");
  if (!lastScan || !lastScan.current) return toast("No live signal. Is Wi-Fi connected?");
  const extras = {};
  if ($("capThroughput").checked) {
    toast("Measuring throughput…");
    try {
      const q = await api("/api/quality");
      if (q.ok) { extras.download_mbps = q.download_mbps; extras.upload_mbps = q.upload_mbps; extras.responsiveness_rpm = q.responsiveness_rpm; }
      const host = (lastScan && lastScan.default_gateway) || "1.1.1.1";
      const p = await api("/api/ping?host=" + encodeURIComponent(host) + "&count=5");
      if (p.ok) { extras.ping_avg_ms = p.avg_ms; extras.ping_loss_pct = p.loss_pct; }
    } catch (e) {}
  }
  if (!addPoint(loc, lastScan.current, extras)) return;
  $("capLoc").value = "";
  toast(`Captured “${loc}”`);
}

// Start (or cancel) placing an already-saved reading onto the map.
function startPlacing(id) {
  set.placingId(placingId === id ? null : id);
  if (placingId != null) {
    const p = points.find((q) => q.id === placingId);
    if (mapMode === "edit") setMapMode("survey");
    toast(p ? `Tap the map where you took “${p.location}”` : "Tap the map to place it");
    const wrap = $("mapWrap");
    if (wrap && wrap.scrollIntoView) wrap.scrollIntoView({ block: "center" });
  }
  renderPoints();
  renderUnplacedBar();
}

// Standing warning on the Coverage page while any reading is missing a position.
function renderUnplacedBar() {
  const el = $("unplacedBar");
  if (!el) return;
  const n = unplacedPoints().length;
  if (!n) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const first = unplacedPoints()[0];
  el.innerHTML = `<div><b>${n} reading${n > 1 ? "s aren't" : " isn't"} on the map.</b>
      ${n > 1 ? "They're" : "It's"} in the list and the CSV, but the heatmap, surveyed area,
      % passing and dead-zone figures can't use ${n > 1 ? "them" : "it"}.</div>
    <button class="ghost" onclick="startPlacing(${first.id})">${placingId != null ? "Tap the map…" : "Place " + esc(first.location)}</button>`;
}

function renderPoints() {
  $("easyCount").textContent = points.length;
  if ($("ptCount")) $("ptCount").textContent = points.length;
  renderUnplacedBar();
  renderSummary();
  renderReportInsights();
  const es = $("easySpots");
  if (!points.length) {
    es.innerHTML = '<div class="spot-empty">No rooms yet. Walk to a room and tap <b>SAVE</b>.</div>';
  } else {
    es.innerHTML = points
      .map((p) => {
        const r = rate(p.signal, p.snr);
        const off = p.mapX == null
          ? `<button class="placebtn${placingId === p.id ? " on" : ""}" onclick="startPlacing(${p.id})" title="This reading has no position, so it's missing from the heatmap and every area figure. Tap here, then tap the map.">not on map</button>`
          : "";
        return `<div class="spot"><span class="dot" style="background:${r.color}"></span>
          <span class="nm">${esc(p.location)}</span>${off}
          <span class="rt" style="color:${r.color}">${r.word}</span>
          <span class="muted" style="font-size:14px">${p.signal ?? "—"} dBm</span>
          <button class="x" onclick="delPoint(${p.id})">✕</button></div>`;
      })
      .join("");
  }
  const tb = $("ptBody");
  if (tb) {
    if (!points.length) {
      tb.innerHTML = '<tr><td colspan="11" class="muted" style="text-align:center;padding:22px">No points yet.</td></tr>';
    } else {
      tb.innerHTML = points
        .map((p, i) => {
          const r = rate(p.signal, p.snr);
          const thr = p.download_mbps != null ? `${p.download_mbps}/${p.upload_mbps}` : "—";
          const lat = p.ping_avg_ms != null ? `${p.ping_avg_ms}ms` : "—";
          return `<tr><td>${i + 1}</td><td><b>${esc(p.location)}</b></td><td>${esc(p.ssid || "—")}</td>
            <td>${p.band || "?"} ch${p.channel ?? "?"}${p.width ? " " + p.width : ""}</td>
            <td>${p.signal ?? "—"}</td><td>${p.snr ?? "—"}</td>
            <td>${p.phy_friendly || p.phy || "—"}${p.rate ? " " + p.rate : ""}</td>
            <td>${thr}</td><td>${lat}</td>
            <td><span class="tag t-${r.cls}">${r.label}</span></td>
            <td><button class="x" style="border:0;background:transparent;color:var(--muted);cursor:pointer" onclick="delPoint(${p.id})">✕</button></td></tr>`;
        })
        .join("");
    }
  }
}

/* ---------- smart summary strip ---------- */
function renderSummary() {
  if (!$("sumRooms")) return;
  const sig = points.map((p) => p.signal).filter((s) => s != null);
  $("sumRooms").textContent = points.length ? distinctRooms(points) : 0;
  $("sumRoomsDot").style.background = points.length ? "var(--accent)" : "var(--na)";
  if (sig.length) {
    const best = Math.max(...sig), worst = Math.min(...sig);
    const bp = points.find((p) => p.signal === best), wp = points.find((p) => p.signal === worst);
    setSum("Best", best + " dBm", rate(best).color, bp ? bp.location : "");
    setSum("Worst", worst + " dBm", rate(worst).color, wp ? wp.location : "");
    const dead = points.filter((p) => p.signal != null && p.signal < -75).length;
    $("sumDead").textContent = dead;
    $("sumDead").style.color = dead ? "var(--poor)" : "var(--exc)";
    $("sumDeadDot").style.background = dead ? "var(--poor)" : "var(--exc)";
    const mapped = mappedPoints(points);
    const hole = dead ? holeAreaSqft(-75, mapped) : 0;
    if ($("sumDeadSub")) $("sumDeadSub").textContent = hole ? "≈ " + fmtSqft(hole) : "";
  } else {
    setSum("Best", "—", "na", "No readings yet");
    setSum("Worst", "—", "na", "");
    $("sumDead").textContent = "—";
    $("sumDead").style.color = "var(--faint)";
    $("sumDeadDot").style.background = "var(--na)";
    if ($("sumDeadSub")) $("sumDeadSub").textContent = "";
  }
  // % Passing (requirement profile) — surfaces the requirement-target feature
  if ($("sumPass")) {
    const mapped = mappedPoints(points);
    if (reqProfile === "none") {
      $("sumPass").textContent = "—"; $("sumPass").style.color = "var(--faint)";
      $("sumPassDot").style.background = "var(--na)";
      $("sumPassSub").textContent = "no target set";
    } else {
      const st = requirementStats(mapped);
      const prof = REQ_PROFILES[reqProfile];
      if (st.ok) {
        const c = st.pct >= 90 ? "var(--exc)" : st.pct >= 70 ? "var(--fair)" : "var(--poor)";
        $("sumPass").textContent = st.pct + "%"; $("sumPass").style.color = c;
        $("sumPassDot").style.background = c;
      } else {
        $("sumPass").textContent = "—"; $("sumPass").style.color = "var(--faint)";
        $("sumPassDot").style.background = "var(--na)";
      }
      $("sumPassSub").textContent = prof.label;
    }
  }
  // Area (scale) — surfaces the calibration feature
  if ($("sumArea")) {
    const mapped = mappedPoints(points);
    const area = surveyedSqft(mapped), sc = getScale();
    if (area) {
      $("sumArea").textContent = fmtSqft(area); $("sumArea").style.color = "var(--ink)";
      $("sumAreaDot").style.background = "var(--accent)";
      $("sumAreaSub").textContent = sc.source === "gps" ? "from GPS" : "calibrated";
    } else {
      $("sumArea").textContent = "—"; $("sumArea").style.color = "var(--faint)";
      $("sumAreaDot").style.background = "var(--na)";
      $("sumAreaSub").textContent = planMode === "image" && !geoBounds ? "set scale" : "";
    }
  }
  const connected = !!lastCell;
  const verdict = connected ? cellVerdict(lastCell.nr && (lastCell.nr.rsrp != null || lastCell.nr.sinr != null) ? lastCell.nr : lastCell.lte) : null;
  $("sumCell").textContent = verdict || (connected ? "Connected" : "—");
  $("sumCell").style.color = verdict ? GRADE_COLOR[verdict] : connected ? "var(--exc)" : "var(--faint)";
  $("sumCellDot").style.background = verdict ? GRADE_COLOR[verdict] : connected ? "var(--exc)" : "var(--na)";
  updateSideStatus();
}
function setSum(which, val, color, sub) {
  const ids = which === "Best" ? ["sumBest", "sumBestDot", "sumBestRoom"] : ["sumWorst", "sumWorstDot", "sumWorstRoom"];
  $(ids[0]).textContent = val;
  $(ids[0]).style.color = color === "na" ? "var(--faint)" : color;
  $(ids[1]).style.background = color === "na" ? "var(--na)" : color;
  if ($(ids[2])) $(ids[2]).textContent = sub;
}

function delPoint(id) {
  set.points(points.filter((p) => p.id !== id));
  savePoints();
  renderPoints();
  renderCoverageMap();
}
// Clears the MEASUREMENTS for this job. Client details stay — they identify the job, and
// a different job is a different survey (use "New survey"). Photos and the imported scan are
// measurements of this property, so they go too: leaving them behind is how one client's
// premises photos and network list ended up in the next client's PDF.
function clearAll() {
  const n = (c, one, many) => (c ? `${c} ${c === 1 ? one : many || one + "s"}` : null);
  const bits = [
    n(points.length, "reading"),
    n(cellPoints.length, "candidate spot"),
    n(reportPhotos.length, "site photo"),
    importedScan.length ? "the imported scan" : null,
    heatmapDataUrl ? "the heatmap" : null,
  ].filter(Boolean);
  if (!bits.length) return toast("Nothing to clear.");
  const what = bits.length > 1 ? bits.slice(0, -1).join(", ") + " and " + bits[bits.length - 1] : bits[0];
  if (!confirm(`Start over?\n\nClears ${what}.\n\nClient and site details are kept. This can't be undone.`)) return;
  set.points([]);
  set.cellPoints([]);
  set.reportPhotos([]);
  set.importedScan([]);
  set.surveyEnv(null);                    // the next walk records its own environment
  try { localStorage.removeItem(LS_SURVEYENV); } catch (e) {}
  levels.forEach((l) => (l.snapshot = null));
  savePoints();
  saveCellPoints();
  savePhotos();
  store(LS_IMPORTEDSCAN, JSON.stringify(importedScan));
  saveLevels();
  removeHeatmap();
  renderPoints();
  renderCellSpots();
  renderReportPhotos();
  renderCoverageMap();
  renderReportInsights();
}

/* ---------- advanced tools ---------- */
async function runQuality() {
  const b = $("btnQuality");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> testing…';
  try {
    const d = await api("/api/quality");
    if (d.ok) {
      $("qDown").textContent = (d.download_mbps ?? "—") + " Mbps";
      $("qUp").textContent = (d.upload_mbps ?? "—") + " Mbps";
      $("qRpm").textContent = (d.responsiveness_rpm ?? "—") + " RPM";
      toast(`↓${d.download_mbps} / ↑${d.upload_mbps} Mbps`);
    } else toast("Throughput failed: " + (d.error || ""));
  } catch (e) { toast("Throughput failed"); }
  b.disabled = false;
  b.innerHTML = "⚡ Throughput";
}
// Cellular-page speed test — same /api/quality endpoint as runQuality(), separate button/readout.
// Measures the REAL internet speed through the gateway (the cellular data speed).
async function runCellSpeed() {
  const b = $("btnCellSpeed");
  if (!b) return;
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> testing… (~20s)';
  $("csDown").textContent = "…";
  $("csUp").textContent = "…";
  $("csLat").textContent = "…";
  try {
    const d = await api("/api/quality");
    if (d.ok) {
      $("csDown").textContent = (d.download_mbps ?? "—") + " Mbps";
      $("csUp").textContent = (d.upload_mbps ?? "—") + " Mbps";
      $("csLat").textContent = d.base_rtt_ms != null ? d.base_rtt_ms + " ms" : "—";
      toast(`↓${d.download_mbps} / ↑${d.upload_mbps} Mbps through the gateway`);
    } else {
      $("csDown").textContent = "—"; $("csUp").textContent = "—"; $("csLat").textContent = "—";
      toast("Speed test failed: " + (d.error || ""));
    }
  } catch (e) {
    $("csDown").textContent = "—"; $("csUp").textContent = "—"; $("csLat").textContent = "—";
    toast("Speed test failed");
  }
  b.disabled = false;
  b.innerHTML = "⚡ Test connection speed";
}
async function runPing() {
  const host = (lastScan && lastScan.default_gateway) || "1.1.1.1";
  const b = $("btnPing");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span> ping…';
  try {
    const d = await api("/api/ping?host=" + encodeURIComponent(host) + "&count=5");
    $("pLat").textContent = d.ok ? `${d.avg_ms} ms · ${d.loss_pct}% loss` : "unreachable";
    toast(d.ok ? `Ping ${host}: ${d.avg_ms} ms` : "Ping failed");
  } catch (e) { toast("Ping failed"); }
  b.disabled = false;
  b.innerHTML = "📍 Ping gateway";
}

export { addPoint,captureAdv,clearAll,delPoint,launch,poll,renderPoints,renderSummary,
  runCellSpeed,runPing,runQuality,saveEasy,startPlacing };
