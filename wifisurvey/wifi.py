"""Wi-Fi telemetry from native macOS tools: scan, link quality, speed test, ping."""

import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime

from .config import LAUNCHABLE
from .util import run

def parse_signal_noise(s):
    """'-31 dBm / -94 dBm' -> (-31, -94, 63)."""
    nums = re.findall(r"-?\d+", s or "")
    if len(nums) >= 2:
        sig, noise = int(nums[0]), int(nums[1])
        return sig, noise, sig - noise
    if len(nums) == 1:
        return int(nums[0]), None, None
    return None, None, None


def parse_channel(s):
    """'40 (5GHz, 80MHz)' -> (40, '5GHz', '80MHz')."""
    ch = band = width = None
    m = re.match(r"\s*(\d+)", s or "")
    if m:
        ch = int(m.group(1))
    inside = re.search(r"\(([^)]+)\)", s or "")
    if inside:
        parts = [x.strip() for x in inside.group(1).split(",")]
        if parts:
            band = parts[0]
        if len(parts) > 1:
            width = parts[1]
    return ch, band, width


def clean_security(s):
    if not s:
        return "Unknown"
    s = s.replace("spairport_security_mode_", "").replace("_", " ")
    up = {"wpa", "wpa2", "wpa3", "wep", "psk", "eap", "wps"}
    return " ".join(w.upper() if w.lower() in up else w.capitalize() for w in s.split())


def clean_type(s):
    if not s:
        return ""
    return s.replace("spairport_network_type_", "").capitalize()


def phy_friendly(phy):
    p = phy or ""
    if "ax" in p:
        return "Wi-Fi 6/6E"
    if "ac" in p:
        return "Wi-Fi 5"
    if "n" in p:
        return "Wi-Fi 4"
    return p


def net_from_entry(d):
    """Normalize one network dict from system_profiler JSON."""
    sig, noise, snr = parse_signal_noise(d.get("spairport_signal_noise"))
    ch, band, width = parse_channel(d.get("spairport_network_channel"))
    return {
        "ssid": d.get("_name"),
        "signal": sig,
        "noise": noise,
        "snr": snr,
        "channel": ch,
        "band": band,
        "width": width,
        "phy": d.get("spairport_network_phymode"),
        "phy_friendly": phy_friendly(d.get("spairport_network_phymode")),
        "rate": d.get("spairport_network_rate"),
        "mcs": d.get("spairport_network_mcs"),
        "security": clean_security(d.get("spairport_security_mode")),
        "type": clean_type(d.get("spairport_network_type")),
    }


def default_gateway():
    rc, out, _ = run(["route", "-n", "get", "default"], 4)
    if rc == 0:
        m = re.search(r"gateway:\s*([0-9a-fA-F.:]+)", out)
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# actions
# ---------------------------------------------------------------------------
def action_scan():
    rc, out, err = run(["system_profiler", "-json", "SPAirPortDataType"], 20)
    if rc != 0:
        return {"ok": False, "error": err or "system_profiler failed"}
    try:
        data = json.loads(out)
        iface = data["SPAirPortDataType"][0]["spairport_airport_interfaces"][0]
    except (ValueError, KeyError, IndexError) as e:
        return {"ok": False, "error": "parse error: %s" % e}

    cur = iface.get("spairport_current_network_information")
    nearby_raw = iface.get("spairport_airport_other_local_wireless_networks") or []
    result = {
        "ok": True,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "connected": bool(cur),
        "default_gateway": default_gateway(),
        "current": net_from_entry(cur) if cur else None,
        "nearby": [net_from_entry(n) for n in nearby_raw],
    }
    return result


def action_quality():
    """Blocking test, both directions at once (~15-25s).

    Used where a number is wanted and nobody is watching a dial: attached to a reading, the
    Advanced page, and the cellular aiming loop. The Live page uses the streaming pair above,
    which runs sequentially so the gauge can show one direction at a time.
    """
    rc, out, err = run(["networkQuality", "-c"], 45)
    if rc != 0 or not out.strip():
        return {"ok": False, "error": err or "networkQuality failed (need internet?)"}
    try:
        d = json.loads(out)
    except ValueError as e:
        return {"ok": False, "error": "parse error: %s" % e}
    return _quality_json(d)


# ---------------------------------------------------------------------------
# live speed test
#
# networkQuality buffers everything when its output is a pipe — nothing appears until the run
# ends ~20-35s later, which is why the gauge could only jump to a final number. Attached to a
# pty it prints a progress line about four times a second:
#
#     Downlink: 306.527 Mbps, 316 RPM - Uplink: 264.333 Mbps, 910 RPM
#
# so the needle can follow the real measurement instead of a made-up animation. `-s` runs the
# two directions one after the other, which is what gives a download phase and then an upload
# phase, the way any other speed test behaves. `-c<file>` still writes the authoritative JSON,
# so the final numbers come from the same place they always did.
# ---------------------------------------------------------------------------
_speed_lock = threading.Lock()
_speed = {"running": False, "phase": "", "down": 0.0, "up": 0.0,
          "result": None, "error": None, "started": 0.0}

_PROGRESS_RE = re.compile(
    r"Downlink:\s*([\d.]+)\s*Mbps,\s*(\d+)\s*RPM\s*-\s*Uplink:\s*([\d.]+)\s*Mbps,\s*(\d+)\s*RPM")


def _quality_json(d):
    """Shape networkQuality's JSON into the fields the dashboard uses.

    Parallel runs report one combined `responsiveness`; sequential runs report `dl_`/`ul_`
    separately and no combined figure. Take the worse of the two when that's all there is —
    a report should quote the number the user will actually feel.
    """
    to_mbps = lambda bps: round(bps / 1_000_000, 1) if isinstance(bps, (int, float)) else None
    resp = d.get("responsiveness")
    if not isinstance(resp, (int, float)):
        halves = [v for v in (d.get("dl_responsiveness"), d.get("ul_responsiveness"))
                  if isinstance(v, (int, float))]
        resp = min(halves) if halves else None
    return {
        "ok": True,
        "download_mbps": to_mbps(d.get("dl_throughput")),
        "upload_mbps": to_mbps(d.get("ul_throughput")),
        "responsiveness_rpm": resp,
        "base_rtt_ms": round(d["base_rtt"], 1) if isinstance(d.get("base_rtt"), (int, float)) else None,
    }


def _speed_worker():
    """Run a sequential test under a pty, publishing progress as it goes."""
    import pty
    import select
    import tempfile

    fd_tmp, path = tempfile.mkstemp(suffix=".json")
    os.close(fd_tmp)
    try:
        pid, fd = pty.fork()
        if pid == 0:                       # child — becomes networkQuality
            try:
                os.execvp("networkQuality", ["networkQuality", "-s", "-c" + path])
            finally:
                os._exit(127)
        deadline = time.time() + 90
        try:
            while time.time() < deadline:
                r, _, _ = select.select([fd], [], [], 0.5)
                if not r:
                    continue
                try:
                    chunk = os.read(fd, 4096)
                except OSError:            # pty closes with the child
                    break
                if not chunk:
                    break
                for line in chunk.replace(b"\r", b"\n").split(b"\n"):
                    m = _PROGRESS_RE.search(line.decode("utf-8", "replace"))
                    if not m:
                        continue
                    down, up = float(m.group(1)), float(m.group(3))
                    with _speed_lock:
                        _speed["down"] = down
                        _speed["up"] = up
                        # -s finishes the download before it starts the upload, so any upload
                        # movement means the download half is done and final.
                        _speed["phase"] = "upload" if up > 0 else "download"
        finally:
            try:
                os.close(fd)
            except OSError:
                pass
            try:
                os.waitpid(pid, 0)
            except OSError:
                pass

        with open(path) as f:
            payload = json.load(f)
        result = _quality_json(payload)
        with _speed_lock:
            _speed["result"] = result
            _speed["phase"] = "done"
    except Exception as e:                 # noqa: BLE001 - any failure ends the run visibly
        with _speed_lock:
            _speed["error"] = str(e) or "speed test failed"
            _speed["phase"] = "error"
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
        with _speed_lock:
            _speed["running"] = False


def action_speed_start():
    with _speed_lock:
        if _speed["running"]:
            return {"ok": True, "already": True}
        _speed.update({"running": True, "phase": "starting", "down": 0.0, "up": 0.0,
                       "result": None, "error": None, "started": time.time()})
    threading.Thread(target=_speed_worker, daemon=True).start()
    return {"ok": True, "already": False}


def action_speed_progress():
    with _speed_lock:
        s = dict(_speed)
    s["elapsed"] = round(time.time() - s["started"], 1) if s["started"] else 0
    s["ok"] = True
    return s


def action_ping(host, count):
    host = (host or "1.1.1.1").strip()
    # Both callers pass a gateway IP or 1.1.1.1. Constrain it to hostname characters and
    # reject a leading hyphen so the value can never be read as a ping flag.
    if not re.match(r"^(?!-)[A-Za-z0-9._:-]{1,253}$", host):
        return {"ok": False, "host": host, "error": "invalid host"}
    count = str(max(1, min(int(count or 5), 20)))
    rc, out, err = run(["ping", "-c", count, "-t", "10", host], 20)
    res = {"ok": rc == 0, "host": host}
    stats = re.search(r"(\d+) packets transmitted, (\d+) (?:packets )?received", out)
    if stats:
        res["transmitted"] = int(stats.group(1))
        res["received"] = int(stats.group(2))
    loss = re.search(r"([\d.]+)% packet loss", out)
    if loss:
        res["loss_pct"] = float(loss.group(1))
    rtt = re.search(r"= ([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)", out)
    if rtt:
        res["min_ms"] = float(rtt.group(1))
        res["avg_ms"] = float(rtt.group(2))
        res["max_ms"] = float(rtt.group(3))
    if not res["ok"] and "avg_ms" not in res:
        res["error"] = err or "host unreachable"
    return res


def action_open(app_key):
    name = LAUNCHABLE.get(app_key)
    if not name:
        return {"ok": False, "error": "unknown app"}
    rc, _, err = run(["open", "-a", name], 8)
    if rc != 0:
        return {"ok": False, "error": err or ("%s not installed?" % name)}
    return {"ok": True, "app": name}
