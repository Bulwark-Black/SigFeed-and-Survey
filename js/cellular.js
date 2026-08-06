// Cellular gateway aiming, placement spots, heatmap image attach, site photos.

import { api, renderStorageBar, store, toast, warn } from "./core.js";
import { renderSummary } from "./live.js";
import { esc, safeImgSrc } from "./report.js";
import { $, LS_CELL, LS_CELLPTS, LS_HEATMAP, LS_PHOTOS, cellPoints, heatmapDataUrl, lastCell, reportPhotos, set } from "./state.js";
/* ---------- cellular / antenna aiming ---------- */
let cellTimer = null;
let cellSeq = 0;        // newest request wins — a gateway read can take longer than one interval
let cellInFlight = false;
let cellFails = 0;

async function connectCell() {
  // A read can take up to 16s (login + fetch) against a 6s refresh, so without this the
  // requests pile up and can resolve out of order — showing an older reading as the newer one.
  if (cellInFlight) return;
  cellInFlight = true;
  const seq = ++cellSeq;
  const ip = $("cellIp").value.trim();
  const pass = $("cellPass").value;
  const b = $("btnCell");
  b.disabled = true;
  b.innerHTML = '<span class="spin"></span>';
  // only show the "Connecting…" state on a manual connect, not on every auto-refresh tick
  if (!cellTimer) setCellBadge("wait", "📡", "Connecting to gateway…", "Reading signal from the gateway…");
  try {
    const d = await api("/api/cellular", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip, password: pass }),
    });
    if (seq !== cellSeq) return;              // a newer read already landed
    if (!d.ok) {
      cellFails++;
      setCellBadge("stale", "⚠️", d.error || "Couldn't read the gateway.", "Check the address and admin password, and that you're on the gateway's Wi-Fi.");
      // Don't tear down the auto-refresh on one miss — moving the gateway is exactly what
      // this page is for, and that is precisely when a read drops. Keep the last numbers on
      // screen (marked stale) and give it a few tries before giving up.
      if (cellTimer && cellFails >= 5) {
        stopCellAuto();
        setCellBadge("stale", "⚠️", "Lost the gateway. Auto-refresh stopped.", "Reconnect once it's back on the network.");
      }
      if (!lastCell) $("cellResults").classList.add("hidden");
    } else {
      cellFails = 0;
      set.lastCell(d);
      renderCell(d);
      renderCellSpots();
      $("cellResults").classList.remove("hidden");
      const band5g = (d.nr && d.nr.bands) ? " · 5G " + d.nr.bands : (d.lte && d.lte.bands ? " · LTE " + d.lte.bands : "");
      const when = d.ts ? d.ts.split("T")[1] : "";
      setCellBadge("ok", "✅", `Connected: ${d.model || "gateway"}${band5g}`, `Updated ${when} · let readings settle ~15s before comparing spots.`);
      store(LS_CELL, JSON.stringify({ ip, pass }));
    }
  } catch (e) {
    if (seq === cellSeq) setCellBadge("stale", "⚠️", "Could not reach the tool backend.", "Is the survey server running on this Mac?");
  } finally {
    cellInFlight = false;
    if (seq === cellSeq) {
      renderSummary();
      b.disabled = false;
      b.textContent = "Connect";
    }
  }
}
function renderCell(d) {
  setCell("nr", d.nr);
  setCell("lte", d.lte);
}
// drive the #cellStatus connection badge (reuses the .gpsbadge visual states: wait/ok/stale)
function setCellBadge(state, icon, text, sub) {
  const el = $("cellStatus");
  if (!el) return;
  el.className = "gpsbadge cellbadge " + state;
  if ($("cellBadgeIcon")) $("cellBadgeIcon").textContent = icon;
  if ($("cellBadgeText")) $("cellBadgeText").textContent = text;
  if ($("cellBadgeSub")) $("cellBadgeSub").textContent = sub || "";
}
// map RSRP (dBm) → phone signal-bar count 0..5; null/missing → 0 bars
function rsrpBars(rsrp) {
  if (rsrp == null || isNaN(rsrp)) return 0;
  if (rsrp >= -80) return 5;
  if (rsrp >= -90) return 4;
  if (rsrp >= -100) return 3;
  if (rsrp >= -110) return 2;
  return 1;
}
// render 5 increasing-height bars into a container: `filled` of them get `color`, rest are empty
function renderBars(container, filled, color) {
  if (!container) return;
  const bars = container.querySelectorAll("i");
  for (let i = 0; i < bars.length; i++) {
    bars[i].style.background = i < filled ? color : "var(--line-strong)";
  }
}
function setCellVerdict(pfx, word) {
  const v = $(pfx + "Verdict");
  if (!v) return;
  if (!word) { v.classList.add("hidden"); return; }
  v.textContent = word;
  v.style.color = GRADE_COLOR[word];
  v.style.borderColor = GRADE_COLOR[word];
  v.classList.remove("hidden");
}
function setCell(pfx, s) {
  const el = $(pfx + "Sinr");
  const color = rateCell(s ? s.sinr : null);
  if (!s) {
    el.textContent = "—";
    el.style.color = "var(--muted)";
    renderBars($(pfx + "Bars"), 0, color);
    $(pfx + "Rsrp").textContent = "—"; $(pfx + "Rsrp").style.color = "";
    $(pfx + "Rsrq").textContent = "—";
    $(pfx + "Rssi").textContent = "—";
    $(pfx + "Band").textContent = "—";
    setCellVerdict(pfx, null);
    return;
  }
  el.textContent = s.sinr != null ? s.sinr : "—";
  el.style.color = color;
  renderBars($(pfx + "Bars"), rsrpBars(s.rsrp), color);
  const rsG = cellGrade("rsrp", s.rsrp);
  $(pfx + "Rsrp").textContent = s.rsrp != null ? s.rsrp + " dBm" : "—";
  $(pfx + "Rsrp").style.color = rsG ? GRADE_COLOR[rsG] : "";
  $(pfx + "Rsrq").textContent = s.rsrq != null ? s.rsrq + " dB" : "—";
  $(pfx + "Rssi").textContent = s.rssi != null ? s.rssi + " dBm" : "—";
  $(pfx + "Band").textContent = s.bands ? s.bands : "—";
  setCellVerdict(pfx, cellVerdict(s));
}
function rateCell(sinr) {
  if (sinr == null) return "var(--muted)";
  if (sinr >= 20) return "#22c55e";
  if (sinr >= 13) return "#84cc16";
  if (sinr >= 0) return "#f59e0b";
  return "#ef4444";
}

/* ---------- signal interpretation: Wi-Fi generation, security posture, cellular grades ----------
   All derived from fields macOS already reports per AP (PHY mode, channel/band, security) — no
   extra tooling. PHY for a scanned AP is a capability list (e.g. 802.11a/n/ac/ax); we take the
   HIGHEST generation present, and use the 6 GHz band to tell Wi-Fi 6E from plain Wi-Fi 6. */
function is6GHz(ap) { return (ap.band || "").trim().charAt(0) === "6"; }
function wifiGen(ap) {
  const p = (ap.phy || "").toLowerCase();
  if (p.includes("be")) return { g: 7, label: "Wi-Fi 7" };
  if (p.includes("ax")) return is6GHz(ap) ? { g: 6.5, label: "Wi-Fi 6E" } : { g: 6, label: "Wi-Fi 6" };
  if (p.includes("ac")) return { g: 5, label: "Wi-Fi 5" };
  if (p.includes("n")) return { g: 4, label: "Wi-Fi 4" };
  if (p) return { g: 3, label: "Legacy a/b/g" };
  if (is6GHz(ap)) return { g: 6.4, label: "6 GHz (6E/7)" };   // no PHY (imported scan): 6 GHz band ⇒ 6E OR 7, can't tell which
  return { g: 0, label: "Unknown" };
}
function secGrade(sec) {
  const s = (sec || "").toLowerCase();
  if (s.includes("wpa3")) return { g: "wpa3", label: "WPA3", rank: 4, color: "#22c55e" };
  if (s.includes("wpa2")) return { g: "wpa2", label: "WPA2", rank: 3, color: "#84cc16" };
  if (s.includes("wpa")) return { g: "wpa", label: "WPA (legacy)", rank: 1, color: "#f59e0b" };
  if (s.includes("wep")) return { g: "wep", label: "WEP (insecure)", rank: 0, color: "#ef4444" };
  if (s.includes("open") || s.includes("none")) return { g: "open", label: "Open", rank: 0, color: "#ef4444" };
  return { g: "unknown", label: sec || "Unknown", rank: 2, color: "#94a3b8" };
}
// summarize the RF infrastructure across a set of APs (connected + neighbors)
function analyzeInfra(aps) {
  const gen = {}, band = { "2.4 GHz": 0, "5 GHz": 0, "6 GHz": 0 }, sec = {};
  let open = 0, legacy = 0, sixViolation = 0;
  aps.forEach((ap) => {
    gen[wifiGen(ap).label] = (gen[wifiGen(ap).label] || 0) + 1;
    const b = (ap.band || "").trim().charAt(0);
    if (b === "2") band["2.4 GHz"]++; else if (b === "5") band["5 GHz"]++; else if (b === "6") band["6 GHz"]++;
    const sg = secGrade(ap.security); sec[sg.label] = (sec[sg.label] || 0) + 1;
    if (sg.g === "open") open++;
    if (sg.g === "wep" || sg.g === "wpa") legacy++;
    // 6 GHz mandates WPA3/OWE: flag only EXPLICIT legacy security on 6 GHz (bare "Open" there may be OWE — indeterminate on macOS)
    if (is6GHz(ap) && (sg.g === "wep" || sg.g === "wpa" || sg.g === "wpa2")) sixViolation++;
  });
  return { gen, band, sec, total: aps.length, open, legacy, sixViolation };
}
// cellular interpretation bands (3GPP-aligned rules of thumb, NOT a normative pass/fail standard)
const CELL_BANDS = { rsrp: [[-80, "Excellent"], [-90, "Good"], [-100, "Fair"], [-110, "Poor"]], sinr: [[20, "Excellent"], [13, "Good"], [0, "Fair"]], rsrq: [[-10, "Excellent"], [-15, "Good"], [-20, "Fair"]] };
// One grade colour per surface. `print` is tuned for the PDF's white page; `screen` for the
// dark UI. These were the same set, so the print palette was rendering on the dashboard at
// 2.69:1 for Critical — the most prominent number in the product, least readable exactly when
// the news was worst. Both sets pass AA on the surface they are for.
// Poor and Critical share a red on screen deliberately: both are failing grades, the badge
// prints the word next to the number, and every second red that clears 4.5:1 on this
// background reads *lighter* than the first — i.e. less severe, which is backwards.
const GRADE_INK = {
  print:  { Excellent: "#15803d", Good: "#3f8f13", Fair: "#b45309", Poor: "#dc2626", Critical: "#b91c1c" },
  screen: { Excellent: "#34d399", Good: "#a3e635", Fair: "#fbbf24", Poor: "#f87171", Critical: "#f87171" },
};
// The signal ratings use the same four screen colours, so a chip on one page and a dot on
// another can't disagree about what "Good" looks like.
const GRADE_COLOR = { Excellent: "#34d399", Good: "#a3e635", Fair: "#fbbf24", Poor: "#f87171" };
// Finding severity, one definition for every renderer.
const SEVERITY_COLOR = { critical: "var(--poor)", warning: "var(--fair)", good: "var(--exc)", info: "var(--accent)" };
const GRADE_RANK = { Excellent: 3, Good: 2, Fair: 1, Poor: 0 };
function cellGrade(metric, v) {
  if (v == null || isNaN(v)) return null;
  for (const b of CELL_BANDS[metric]) if (v >= b[0]) return b[1];
  return "Poor";
}
// overall verdict = the WORSE of RSRP (coverage) and SINR (quality) — a strong-but-noisy signal isn't "good"
function cellVerdict(s) {
  if (!s) return null;
  const gs = [cellGrade("rsrp", s.rsrp), cellGrade("sinr", s.sinr)].filter(Boolean);
  return gs.length ? gs.reduce((a, b) => (GRADE_RANK[b] < GRADE_RANK[a] ? b : a)) : null;
}
function toggleCellAuto() {
  if ($("cellAuto").checked) {
    cellFails = 0;
    connectCell();
    // re-armed from each response rather than a fixed interval, so a slow gateway spaces the
    // reads out instead of queueing them up behind each other
    const tick = () => { connectCell().finally(() => { if (cellTimer) cellTimer = setTimeout(tick, 6000); }); };
    cellTimer = setTimeout(tick, 6000);
  } else stopCellAuto();
}
function stopCellAuto() {
  if (cellTimer) clearTimeout(cellTimer);
  cellTimer = null;
  cellFails = 0;
  if ($("cellAuto")) $("cellAuto").checked = false;
}

/* ---------- cellular placement spots ---------- */
function saveCellPoints() { return store(LS_CELLPTS, JSON.stringify(cellPoints)); }

function logCellSpot() {
  const label = $("cellSpotLabel").value.trim();
  if (!label) return toast("Name the spot first");
  if (!lastCell) return toast("Connect to the gateway first");
  const n = lastCell.nr || {}, l = lastCell.lte || {};
  cellPoints.push({
    id: Date.now(), location: label, ts: new Date().toISOString(), model: lastCell.model,
    nr_sinr: n.sinr, nr_rsrp: n.rsrp, nr_band: n.bands,
    lte_sinr: l.sinr, lte_rsrp: l.rsrp, lte_band: l.bands,
  });
  saveCellPoints();
  renderCellSpots();
  $("cellSpotLabel").value = "";
  $("cellSpotLabel").focus();
  toast(`Logged “${label}”  ·  5G SINR ${n.sinr ?? "—"}`);
}

function bestCellSpot() {
  return cellPoints.slice().sort((a, b) => (b.nr_sinr ?? b.lte_sinr ?? -999) - (a.nr_sinr ?? a.lte_sinr ?? -999))[0];
}

function renderCellSpots() {
  if ($("cellCount")) $("cellCount").textContent = cellPoints.length;
  const el = $("cellSpots");
  if (!el) return;
  if (!cellPoints.length) {
    el.innerHTML = '<div class="spot-empty">Move the gateway to a spot, let it settle, then LOG it.</div>';
    return;
  }
  const best = bestCellSpot();
  el.innerHTML = cellPoints
    .map((p) => {
      const isBest = best && p.id === best.id && (p.nr_sinr != null || p.lte_sinr != null);
      const star = isBest ? ' <span class="tag t-exc">★ best</span>' : "";
      return `<div class="spot"><span class="dot" style="background:${rateCell(p.nr_sinr)}"></span>
        <span class="nm">${esc(p.location)}${star}</span>
        <span class="rt" style="color:${rateCell(p.nr_sinr)}">5G ${p.nr_sinr ?? "—"}</span>
        <span class="muted" style="font-size:14px">RSRP ${p.nr_rsrp ?? "—"}</span>
        <button class="x" onclick="delCellSpot(${p.id})">✕</button></div>`;
    })
    .join("");
}

function delCellSpot(id) {
  set.cellPoints(cellPoints.filter((p) => p.id !== id));
  saveCellPoints();
  renderCellSpots();
}

/* ---------- heatmap image attach ---------- */
function attachHeatmap(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    set.heatmapDataUrl(r.result);
    renderHeatmapThumb();
    // Still usable this session if it won't fit, but the user has to know it won't survive a reload.
    try { localStorage.setItem(LS_HEATMAP, heatmapDataUrl); toast("Heatmap attached. It'll appear in the report"); }
    catch (e) { warn("Heatmap attached, but it's too big to save. Make the report before reloading."); }
  };
  r.readAsDataURL(file);
  ev.target.value = "";
}

function removeHeatmap() {
  set.heatmapDataUrl(null);
  try { localStorage.removeItem(LS_HEATMAP); } catch (e) {}
  renderHeatmapThumb();
}

function renderHeatmapThumb() {
  const el = $("heatmapThumb");
  if (!el) return;
  el.innerHTML = heatmapDataUrl
    ? `<div style="margin-top:12px"><img src="${safeImgSrc(heatmapDataUrl)}" style="max-height:130px;border-radius:8px;border:1px solid var(--line)"><br>
       <button class="ghost" style="margin-top:8px;font-size:13px" onclick="removeHeatmap()">✕ Remove heatmap</button></div>`
    : "";
}

/* ---------- site photos & screenshots (embedded in the report) ---------- */
// Photos are the bulkiest thing in storage, so this is the write most likely to hit quota.
// It stays non-fatal (they're in memory and will still reach the PDF) but never silent.
function savePhotos() {
  try { localStorage.setItem(LS_PHOTOS, JSON.stringify(reportPhotos)); return true; }
  catch (e) { warn("Photos are too big to save. Make the report before reloading, or remove a photo."); return false; }
}

// downscale each picked image to a ~1400px jpeg data URL (same approach as loadFloorPlan) and add it
function addReportPhotos(ev) {
  const files = Array.from(ev.target.files || []);
  if (!files.length) return;
  let pending = files.length;
  files.forEach((f) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1400 / img.naturalWidth);
        const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
        const c = document.createElement("canvas");
        c.width = W; c.height = H;
        c.getContext("2d").drawImage(img, 0, 0, W, H);
        reportPhotos.push({ url: c.toDataURL("image/jpeg", 0.82), caption: "" });
        if (--pending === 0) { savePhotos(); renderReportPhotos(); toast(files.length + " photo" + (files.length > 1 ? "s" : "") + " added. They'll appear in the report"); }
      };
      img.onerror = () => { if (--pending === 0) { savePhotos(); renderReportPhotos(); } };
      img.src = reader.result;
    };
    reader.onerror = () => { if (--pending === 0) { savePhotos(); renderReportPhotos(); } };
    reader.readAsDataURL(f);
  });
  ev.target.value = "";
}

function removeReportPhoto(idx) {
  reportPhotos.splice(idx, 1);
  savePhotos();
  renderReportPhotos();
}

function setPhotoCaption(idx, val) {
  if (reportPhotos[idx]) { reportPhotos[idx].caption = val; savePhotos(); }
}

// photos are the bulkiest thing in storage, so keep the meter honest right after adding one
function renderReportPhotos() {
  renderStorageBar();
  const el = $("reportPhotoStrip");
  if (!el) return;
  if (!reportPhotos.length) { el.innerHTML = ""; return; }
  el.innerHTML = reportPhotos.map((p, i) =>
    `<div class="rpthumb">
       <button class="rpx" title="Remove" onclick="removeReportPhoto(${i})">✕</button>
       <img src="${safeImgSrc(p.url)}" alt="site photo ${i + 1}">
       <input type="text" value="${esc(p.caption || "")}" placeholder="Caption (optional)"
              oninput="setPhotoCaption(${i}, this.value)">
     </div>`).join("");
}

export { GRADE_COLOR,GRADE_INK,SEVERITY_COLOR,addReportPhotos,analyzeInfra,attachHeatmap,
  bestCellSpot,cellVerdict,connectCell,delCellSpot,logCellSpot,removeHeatmap,removeReportPhoto,
  renderCellSpots,renderHeatmapThumb,renderReportPhotos,saveCellPoints,savePhotos,secGrade,
  setPhotoCaption,stopCellAuto,toggleCellAuto,wifiGen };
