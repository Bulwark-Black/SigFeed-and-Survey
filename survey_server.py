#!/usr/bin/env python3
"""
WiFi Site Survey - local mission-control backend.

Zero third-party dependencies; any Python 3.9+ works. Serves a
dashboard and exposes small JSON endpoints that shell out to native macOS
tools:

  system_profiler SPAirPortDataType  -> live signal / noise / channel / rate
  networkQuality                     -> download / upload throughput + latency
  ping                               -> latency + packet loss
  open -a <App>                      -> launch NetSpot / WiFi Explorer / etc.

Binds LAN-wide, not localhost: the phone GPS bridge and the phone view of the
dashboard both need to reach this Mac from another device on the same Wi-Fi.

That makes the trust boundary the local network, so:
  * /api/* requires the key printed at startup. The dashboard gets it injected
    when it is served; the GPS URL shown on the GPS page already carries it.
  * The Host header is checked, which is what stops a web page the technician
    happens to be browsing from reaching this server by rebinding a DNS name.
  * POSTs must be application/json, so a cross-origin form post can't reach an
    endpoint without first passing a CORS preflight (which is never answered).
Anyone already on the same LAN who can load the dashboard can read the key from
it — that is inherent to serving the UI to a phone. The key is aimed at the
realistic attack, which is a malicious web page, not a hostile guest network.
"""

import base64
import binascii
import hashlib
import hmac
import ipaddress
import json
import math
import os
import re
import secrets
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
import zlib
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "0.0.0.0"  # bind LAN-wide so a phone can POST its GPS to this Mac
PORT = 8765
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# New every run: nothing to store, and a stale bookmark simply stops working.
API_KEY = secrets.token_urlsafe(9)

# Apps the dashboard is allowed to launch, mapped to their macOS app names.
LAUNCHABLE = {
    "netspot": "NetSpot",
    "wifi-explorer": "WiFi Explorer",
    "wireless-diagnostics": "Wireless Diagnostics",
}

STATIC = {"/": "dashboard.html", "/app.js": "app.js", "/run-sheet.html": "run-sheet.html"}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def run(cmd, timeout):
    """Run a command, return (rc, stdout, stderr); never raises."""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out after %ss" % timeout
    except Exception as e:  # noqa: BLE001 - surface anything as an error string
        return 1, "", str(e)


def http_json(method, url, headers=None, body=None, timeout=8):
    """Minimal JSON HTTP call. Returns (status, text); raises on transport error."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:  # 401/403/etc still carry a body
        return e.code, e.read().decode("utf-8", "replace")


# Browser-like UA so Nominatim/Esri don't 403 a bare urllib client.
UA = "Mozilla/5.0 (Macintosh) wifi-survey/1.0"


def http_get_bytes(url, timeout=10):
    """GET raw bytes with a browser-like User-Agent.

    Returns (status, content_type, body); never raises. On any failure
    returns (0, '', b''). Used to proxy map tiles same-origin so the
    composed survey canvas stays untainted and exports to PDF.
    """
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:  # keep the code; body may be an error page
        try:
            return e.code, e.headers.get("Content-Type", ""), e.read()
        except Exception:  # noqa: BLE001
            return e.code, "", b""
    except Exception:  # noqa: BLE001 - transport/timeout/DNS/etc
        return 0, "", b""


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


def is_private_host(host):
    """True if `host` is a literal IP on a private/loopback range.

    Gateways live on the LAN, so a name or public address is always either a
    mistake or an attempt to point this server somewhere it has no business
    fetching (cloud metadata endpoints being the usual target).
    """
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        return False
    # Link-local is deliberately NOT allowed: no home gateway self-assigns a 169.254 address,
    # and that range is where cloud metadata services sit.
    return (addr.is_private or addr.is_loopback) and not addr.is_link_local


def action_cellular(ip, username, password):
    """Pull LTE/5G signal from a T-Mobile Home Internet gateway via the TMI API.
    Works across Sagemcom 5688W / Arcadyan KVD21 / Sercomm G4AR-G4SE."""
    ip = (ip or "192.168.12.1").strip()
    username = (username or "admin").strip()
    if not is_private_host(ip):
        return {"ok": False, "error": "gateway address must be a private LAN IP (e.g. 192.168.12.1)"}
    base = "http://%s" % ip

    # Newer firmware needs a bearer token; older/simpler setups answer unauthenticated.
    token, login_error = None, None
    if password:
        try:
            st, body = http_json(
                "POST", base + "/TMI/v1/auth/login",
                body={"username": username, "password": password}, timeout=8)
            if st == 200:
                token = (json.loads(body).get("auth") or {}).get("token")
            else:
                login_error = "login returned HTTP %s" % st
        except Exception as e:  # noqa: BLE001
            login_error = str(e)

    headers = {"Authorization": "Bearer %s" % token} if token else {}
    try:
        st, body = http_json("GET", base + "/TMI/v1/gateway?get=all", headers=headers, timeout=8)
    except Exception as e:  # noqa: BLE001
        return {"ok": False,
                "error": "Can't reach the gateway at %s. Is the Mac on the gateway's Wi-Fi? (%s)" % (ip, e)}
    if st == 401 or st == 403:
        return {"ok": False, "error": "Gateway rejected the password (HTTP %s). Check the admin password." % st}
    if st != 200:
        return {"ok": False, "error": "Gateway returned HTTP %s%s"
                % (st, " — " + login_error if login_error else "")}
    try:
        d = json.loads(body)
    except ValueError:
        return {"ok": False, "error": "Gateway replied but not in the expected format (unusual model/firmware)."}

    sig = d.get("signal") or {}
    dev = d.get("device") or {}

    def norm(x):
        if not isinstance(x, dict):
            return None
        bands = x.get("bands") or x.get("band")
        if isinstance(bands, list):
            bands = ", ".join(str(b) for b in bands)
        return {"rsrp": x.get("rsrp"), "rsrq": x.get("rsrq"),
                "rssi": x.get("rssi"), "sinr": x.get("sinr"), "bands": bands}

    return {
        "ok": True,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "model": dev.get("friendlyName") or dev.get("model") or "T-Mobile Gateway",
        "lte": norm(sig.get("4g")),
        "nr": norm(sig.get("5g")),
    }


# ---------------------------------------------------------------------------
# phone GPS bridge — a phone GPS-broadcast app POSTs here; the frontend reads latest
# ---------------------------------------------------------------------------
_gps_lock = threading.Lock()
_gps_fix = None  # {"lat","lon","acc","ts","epoch"}


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:  # noqa: BLE001
        return "127.0.0.1"


def _num(src, *keys):
    for k in keys:
        v = src.get(k)
        if v not in (None, ""):
            try:
                return float(v)
            except (ValueError, TypeError):
                pass
    return None


def action_gps_push(params, body):
    """Accept a GPS fix from a phone app via query params (GPSLogger) or JSON body (OwnTracks)."""
    src = {}
    for k, v in (params or {}).items():
        src[k.lower()] = v[0] if isinstance(v, list) else v
    if isinstance(body, dict):
        for k, v in body.items():
            src[str(k).lower()] = v
    lat = _num(src, "lat", "latitude")
    lon = _num(src, "lon", "lng", "long", "longitude")
    acc = _num(src, "acc", "accuracy", "hdop")
    if lat is None or lon is None:
        return {"ok": False, "error": "no lat/lon in request"}
    # The GPSLogger URL template is hand-typed by the technician, so a mistyped placeholder or
    # an app sending microdegrees otherwise stores a "valid" fix that quietly puts readings in
    # the wrong hemisphere — the GPS badge still reads fresh and nothing downstream notices.
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return {"ok": False, "error": "lat/lon out of range — check the URL template in your GPS app"}
    global _gps_fix
    with _gps_lock:
        _gps_fix = {"lat": lat, "lon": lon, "acc": acc,
                    "ts": datetime.now().isoformat(timespec="seconds"), "epoch": time.time()}
    return {"ok": True}


def action_gps_latest():
    with _gps_lock:
        fix = dict(_gps_fix) if _gps_fix else None
    if not fix:
        return {"ok": True, "fix": None}
    fix["age_sec"] = round(time.time() - fix.pop("epoch"), 1)
    return {"ok": True, "fix": fix}


def action_gps_config():
    ip = lan_ip()
    base = "http://%s:%d" % (ip, PORT)
    return {"ok": True, "lan_ip": ip, "port": PORT,
            "gpslogger_url": base + "/api/gps?k=" + API_KEY + "&lat=%LAT&lon=%LON&acc=%ACC&time=%TIME",
            "owntracks_url": base + "/api/gps?k=" + API_KEY}


def _geocode_census(q):
    """US street address -> hit dict or None, via the free US Census geocoder.

    No API key. Best-in-class for rural US street addresses (returns the exact
    house, not a hamlet centroid). US-only by design; Nominatim is the global
    fallback. Never raises — any transport/parse/shape problem returns None.
    """
    url = ("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
           "?address=%s&benchmark=Public_AR_Current&format=json"
           % urllib.parse.quote(q))
    headers = {"User-Agent": UA, "Accept-Language": "en"}
    try:
        status, text = http_json("GET", url, headers=headers, timeout=10)
    except Exception:  # noqa: BLE001 - http_json can raise on transport error
        return None
    if status != 200:
        return None
    try:
        data = json.loads(text)
    except ValueError:
        return None
    try:
        matches = data["result"]["addressMatches"]
    except (KeyError, TypeError):
        return None
    if not isinstance(matches, list) or not matches:
        return None
    m = matches[0]
    try:
        coords = m["coordinates"]
        return {"ok": True,
                "lat": float(coords["y"]),   # y = latitude
                "lon": float(coords["x"]),   # x = longitude
                "name": m.get("matchedAddress", q),
                "source": "census",
                "precise": True}
    except (KeyError, TypeError, ValueError):
        return None


def _geocode_nominatim(q):
    """Address -> hit dict or None, via OpenStreetMap Nominatim (global fallback).

    Requires a real User-Agent and rate-limits hard; we proxy it server-side so
    the browser never hits it directly. Never raises. `precise` is True only
    when the match resolves to an actual building/house (has a house number, or
    an addresstype of house/building/residential) — a hamlet/town/city centroid
    is NOT precise, so the frontend can warn instead of mislead.
    """
    url = ("https://nominatim.openstreetmap.org/search?q=%s"
           "&format=json&limit=1&addressdetails=1" % urllib.parse.quote(q))
    headers = {"User-Agent": UA, "Accept-Language": "en"}
    try:
        status, text = http_json("GET", url, headers=headers, timeout=10)
    except Exception:  # noqa: BLE001 - http_json can raise on transport error
        return None
    if status != 200:
        return None
    try:
        arr = json.loads(text)
    except ValueError:
        return None
    if not isinstance(arr, list) or not arr:
        return None
    hit = arr[0]
    try:
        lat = float(hit["lat"])
        lon = float(hit["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    addr = hit.get("address") or {}
    has_house_number = bool(isinstance(addr, dict) and addr.get("house_number"))
    precise = has_house_number or hit.get("addresstype") in {"house", "building", "residential"}
    return {"ok": True,
            "lat": lat,
            "lon": lon,
            "name": hit.get("display_name", q),
            "source": "osm",
            "precise": bool(precise)}


def action_geocode(q):
    """Address -> {ok, lat, lon, name, source, precise}.

    Tries the US Census geocoder first (free, no key, exact on rural US street
    addresses), then falls back to OpenStreetMap Nominatim (global). `precise`
    tells the client whether we pinned the actual building vs. only an area
    centroid, so the UI can warn instead of silently centering on the wrong
    place. Returns {"ok": False} on empty query or when both services miss.
    """
    q = (q or "").strip()
    if not q:
        return {"ok": False}
    hit = _geocode_census(q)
    if hit:
        return hit
    hit = _geocode_nominatim(q)
    if hit:
        return hit
    return {"ok": False}


# Esri answers a tile it has no imagery for with HTTP 200 and a valid JPEG - a 2521-byte
# grey "no data" square, byte-identical every time. Treating that as a hit paints blank
# squares into a client's report with nothing to say they aren't real ground.
#
# Matched by exact digest, not by size: a genuine open-ocean tile at z12 is 1660 bytes,
# SMALLER than the placeholder, so any "suspiciously small" rule blanks out waterfront
# properties. If Esri ever reissues the placeholder this check stops firing rather than
# start eating real imagery, which is the direction to fail in.
ESRI_NO_DATA_MD5 = "f27d9de7f80c13501f470595e327aa6d"


def action_tile(z, x, y):
    """Fetch one Esri World Imagery tile -> (content_type, bytes) or (None, b'').

    Slippy-map (z,x,y) with Esri's z/y/x PATH order (row before col).
    Imagery (c) Esri - attribution is required by the Esri terms of use and
    is rendered on the composed aerial in the client/report.

    A tile Esri has no imagery for comes back as (None, b'') like any other miss, so the
    browser sees an image error and leaves a gap it can count.
    """
    try:
        z = int(z); x = int(x); y = int(y)
    except (TypeError, ValueError):
        return None, b""
    if not (0 <= z <= 21):
        return None, b""
    n = 1 << z
    if not (0 <= x < n and 0 <= y < n):
        return None, b""
    url = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
           "World_Imagery/MapServer/tile/%d/%d/%d" % (z, y, x))  # z / y / x
    status, ctype, body = http_get_bytes(url, timeout=10)
    if status != 200 or not body:
        return None, b""
    if hashlib.md5(body).hexdigest() == ESRI_NO_DATA_MD5:
        return None, b""
    if not ctype:
        ctype = "image/jpeg"
    return ctype, body


# ---------------------------------------------------------------------------
# USDA NAIP — public-domain aerial imagery, no key, real capture dates
#
# Served as one bbox render rather than z/x/y tiles, so it can't go through action_tile(). The
# caller passes the exact lat/lon box it wants and gets back a picture of precisely that box,
# which makes the georeference correct by construction — nothing to fit or measure.
# ---------------------------------------------------------------------------
NAIP_URL = ("https://imagery.nationalmap.gov/arcgis/rest/services/"
            "USGSNAIPPlus/ImageServer/exportImage")


def _merc_m(lat, lon):
    """lat/lon -> EPSG:3857 metres, the projection NAIP's ImageServer speaks."""
    x = lon * 20037508.34 / 180.0
    y = math.log(math.tan((90.0 + lat) * math.pi / 360.0)) / (math.pi / 180.0) * 20037508.34 / 180.0
    return x, y


_PNG_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def _png_is_blank(body):
    """True when a PNG is entirely transparent — NAIP's answer for 'no coverage here'.

    ArcGIS returns JPEG where the render is fully opaque and PNG where any of it is
    transparent, so a wholly-transparent PNG means the request fell outside NAIP (it is
    CONUS-only). Getting this wrong is silent: a miss puts a blank base map under a client's
    readings with no error anywhere.

    Every scanline carries a leading filter-type byte, and that byte is NOT zero for filters
    1-4. So testing the whole decompressed stream for zeros — which is what this used to do —
    reports a genuinely blank image as real imagery the moment the encoder picks any filter but
    None. Esri happens to emit filter 0 today, which is an undocumented tie-break in someone
    else's encoder, not a contract.

    Skipping the filter byte and testing the rest of the scanline is exact for this question,
    with no predictor arithmetic: for an all-zero image every predictor reads only zeros, so
    Filt(x) = 0 - 0 = 0 under all five filter types. And the converse holds — all-zero filtered
    data reconstructs to an all-zero image whatever the filters were. So blank IFF the data
    bytes are zero.
    """
    try:
        if body[:8] != b"\x89PNG\r\n\x1a\n":
            return False
        n = len(body)
        i, ihdr, idat = 8, None, b""
        while i + 12 <= n:
            ln = int.from_bytes(body[i:i + 4], "big")
            if ln > 0x7FFFFFFF or i + 12 + ln > n:      # bogus length: refuse, don't walk off
                return False
            tag = body[i + 4:i + 8]
            if tag == b"IHDR":
                if ln != 13:
                    return False
                ihdr = body[i + 8:i + 21]
            elif tag == b"IDAT":
                if ihdr is None:
                    return False
                idat += body[i + 8:i + 8 + ln]
            elif tag == b"IEND":
                break
            i += 12 + ln
        if ihdr is None or not idat:
            return False

        w = int.from_bytes(ihdr[0:4], "big")
        h = int.from_bytes(ihdr[4:8], "big")
        depth, ctype, comp, fmethod, interlace = ihdr[8], ihdr[9], ihdr[10], ihdr[11], ihdr[12]
        # Anything exotic is somebody else's image, not a NAIP no-coverage render. Say "not
        # blank" rather than guess — that direction only ever keeps real imagery.
        if comp or fmethod or interlace:
            return False
        if ctype not in (4, 6) or depth not in (8, 16):   # must carry an alpha channel
            return False
        if not (0 < w <= 65536 and 0 < h <= 65536):
            return False

        stride = w * _PNG_CHANNELS[ctype] * (depth // 8)
        raw = zlib.decompress(idat, bufsize=min((stride + 1) * h + 64, 1 << 26))
        if len(raw) != (stride + 1) * h:
            return False
        return all(not any(raw[r * (stride + 1) + 1:(r + 1) * (stride + 1)]) for r in range(h))
    except (zlib.error, IndexError, ValueError, MemoryError):
        return False


def action_naip(west, east, north, south, size):
    """Render one NAIP image covering exactly [west,east]x[south,north] -> (ctype, bytes)."""
    try:
        west = float(west); east = float(east)
        north = float(north); south = float(south)
        size = int(size)
    except (TypeError, ValueError):
        return None, b""
    if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
        return None, b""
    if not (64 <= size <= 2048):
        return None, b""
    # NAIP is CONUS + a little; a request far outside just comes back empty, but bounding the
    # span here keeps a typo from asking for a continent-sized render.
    if (east - west) > 1.0 or (north - south) > 1.0:
        return None, b""

    x0, y0 = _merc_m(south, west)
    x1, y1 = _merc_m(north, east)
    # match the pixel grid to the box's own shape so the image can't come back stretched
    h = max(1, int(round(size * (y1 - y0) / (x1 - x0))))
    url = (NAIP_URL + "?bbox=%f,%f,%f,%f&bboxSR=3857&imageSR=3857&size=%d,%d"
           "&format=jpgpng&f=image" % (x0, y0, x1, y1, size, h))
    status, ctype, body = http_get_bytes(url, timeout=45)
    if status != 200 or not body:
        return None, b""
    # the service answers errors as JSON with a 200
    if body[:2] != b"\xff\xd8" and body[:4] != b"\x89PNG":
        return None, b""
    if _png_is_blank(body):
        return None, b""
    return (ctype or "image/jpeg"), body


# ---------------------------------------------------------------------------
# Google Earth Pro capture
#
# Drives the locally installed Google Earth Pro to a nadir view of a property and turns the
# resulting screenshot into a georeferenced base map. Everything here is empirical, measured
# against GE Pro 7.3.7.1155 on macOS 15.6 — none of it is a documented API contract, so every
# assumption is checked at runtime rather than trusted.
# ---------------------------------------------------------------------------
EARTH_APP = "Google Earth Pro"      # the Apple Events name. "Google Earth" fails with -2753,
                                    # even though the System Events PROCESS is named that.
EARTH_BUNDLE = "/Applications/Google Earth Pro.app"
EARTH_K = 1.1547005                 # 2*tan(30deg): ground_width / requested_distance, hFOV is
                                    # a fixed 60 deg regardless of window shape
EARTH_DEADLINE_S = 150              # whole-job wall clock
EARTH_SPAN_MIN_M = 40.0
EARTH_SPAN_MAX_M = 2000.0           # beyond ~1.5 km the measured span droops off the linear model

_earth_lock = threading.Lock()
_earth = {"running": False, "phase": "", "result": None, "error": None, "started": 0.0}


def _earth_tell(body, timeout=45):
    """Run one AppleScript against Google Earth. Returns stdout, raises RuntimeError."""
    script = 'tell application "%s"\n%s\nend tell' % (EARTH_APP, body)
    rc, out, err = run(["osascript", "-e", script], timeout)
    if rc:
        msg = (err or out or "osascript failed").strip()
        if "-1743" in msg or "Not authorized" in msg:
            raise RuntimeError("macOS hasn't allowed this to control Google Earth yet. "
                               "Approve the prompt ON THE MAC itself, then try again.")
        if "-2753" in msg or "-1728" in msg:
            raise RuntimeError("Couldn't talk to Google Earth Pro — is it installed?")
        raise RuntimeError(msg)
    return out.strip()


def _earth_view():
    """GetViewInfo -> dict. Only used to confirm the camera actually went where we asked."""
    raw = _earth_tell("GetViewInfo")
    out = {}
    for part in raw.split(","):
        if ":" in part:
            k, v = part.split(":", 1)
            try:
                out[k.strip()] = float(v)
            except ValueError:
                pass
    return out


def _earth_point(u, v):
    """GetPointOnTerrain at normalized device coords -> (lat, lon, elev).

    NDC is [-1,+1] with (0,0) at the viewport centre and +Y UP. Values outside that range are
    SILENTLY CLAMPED, not rejected — passing pixel coords returns the corner point with no error,
    which looks entirely plausible and is completely wrong. The returned list is
    latitude FIRST, which is the opposite of the KML/GeoJSON order.
    """
    raw = _earth_tell("GetPointOnTerrain {%.10f, %.10f}" % (u, v))
    vals = [float(x) for x in raw.replace(",", " ").split()]
    if len(vals) < 3:
        raise RuntimeError("GetPointOnTerrain returned %r" % raw)
    return vals[0], vals[1], vals[2]


def _earth_fly(lat, lon, dist, deadline):
    """Staged descent to a nadir view, settling at each stage.

    Flying straight to the target distance at a cold site renders a blank grey viewport while
    GetStreamingProgress happily reports 100 and GetPointOnTerrain returns elevation 0.0
    indefinitely. Streaming progress is NOT a readiness signal. Descending in stages and waiting
    for the centre elevation to stop changing is what actually works.
    """
    for stage in (8000.0, max(2000.0, dist), dist):
        stage = max(stage, dist)
        _earth_tell("SetViewInfo {latitude:%.10f, longitude:%.10f, distance:%.4f, "
                    "tilt:0.0, azimuth:0.0} speed 6" % (lat, lon, stage))
        prev, stable = None, 0
        while time.time() < deadline:
            time.sleep(1.2)
            try:
                z = round(_earth_point(0.0, 0.0)[2], 3)
            except RuntimeError:
                z = None
            progress = 0
            try:
                progress = int(_earth_tell("GetStreamingProgress", timeout=20) or 0)
            except (RuntimeError, ValueError):
                pass
            if z is not None and progress >= 100 and z == prev:
                stable += 1
                if stable >= 2:
                    break
            else:
                stable = 0
            prev = z
        else:
            raise RuntimeError("Google Earth never finished loading imagery for this location.")


def _merc_y(lat_deg):
    """Web-Mercator Y in [0,1], matching the client's mercWorldY at z=0."""
    r = math.radians(max(-85.05112878, min(85.05112878, lat_deg)))
    return (1 - math.asinh(math.tan(r)) / math.pi) / 2


def _inv_merc_y(y):
    return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y))))


def _earth_probe_grid(n=9):
    """Sample the frame on an n x n NDC grid -> list of (u, v, lat, lon, elev)."""
    pts = []
    for j in range(n):
        v = -1.0 + 2.0 * j / (n - 1)
        for i in range(n):
            u = -1.0 + 2.0 * i / (n - 1)
            lat, lon, elev = _earth_point(u, v)
            # [0,0,0] is the ray-missed-terrain sentinel. It collides with a real point in the
            # Gulf of Guinea, which no property survey will ever be at.
            if lat == 0.0 and lon == 0.0 and elev == 0.0:
                raise RuntimeError("Google Earth couldn't find ground in part of this view.")
            pts.append((u, v, lat, lon, elev))
    return pts


def _earth_fit(pts):
    """Fit a Mercator LatLonBox to the corners, then MEASURE how well it predicts the interior.

    The projection model itself is worth about a millimetre; everything real is relief
    displacement, which is radial from the nadir point and proportional to each object's own
    height. That is not a smooth function of image position, so no warp can remove it — which is
    exactly why this measures the error and reports it instead of trying to correct it.
    """
    corner = {(round(u), round(v)): (lat, lon) for u, v, lat, lon, _ in pts
              if abs(abs(u) - 1) < 1e-9 and abs(abs(v) - 1) < 1e-9}
    sw, se, nw, ne = corner[(-1, -1)], corner[(1, -1)], corner[(-1, 1)], corner[(1, 1)]
    box = {
        "west":  (sw[1] + nw[1]) / 2,
        "east":  (se[1] + ne[1]) / 2,
        "south": (sw[0] + se[0]) / 2,
        "north": (nw[0] + ne[0]) / 2,
    }
    if not (box["west"] < box["east"] and box["south"] < box["north"]):
        raise RuntimeError("Google Earth returned an inside-out view — try again.")

    my_n, my_s = _merc_y(box["north"]), _merc_y(box["south"])
    worst, total, cnt = 0.0, 0.0, 0
    for u, v, lat, lon, _ in pts:
        fx, fy = (u + 1) / 2.0, (1 - v) / 2.0
        pred_lon = box["west"] + fx * (box["east"] - box["west"])
        pred_lat = _inv_merc_y(my_n + fy * (my_s - my_n))
        dy = (pred_lat - lat) * 111320.0
        dx = (pred_lon - lon) * 111320.0 * math.cos(math.radians(lat))
        d = math.hypot(dx, dy)
        worst = max(worst, d)
        total += d * d
        cnt += 1
    elevs = [p[4] for p in pts]
    return box, {
        "worst_m": round(worst, 2),
        "rms_m": round(math.sqrt(total / cnt), 2),
        "relief_m": round(max(elevs) - min(elevs), 1),
        "probes": cnt,
    }


def _earth_worker(lat, lon, span_m):
    tmp = None
    try:
        if not os.path.isdir(EARTH_BUNDLE):
            raise RuntimeError("Google Earth Pro isn't installed in /Applications.")
        deadline = time.time() + EARTH_DEADLINE_S

        with _earth_lock:
            _earth["phase"] = "opening Google Earth"
        rc, _, err = run(["open", "-a", EARTH_BUNDLE], 30)
        if rc:
            raise RuntimeError("Couldn't open Google Earth Pro: %s" % (err or rc))
        _earth_tell("GetCurrentVersion", timeout=60)     # also waits out a cold launch

        with _earth_lock:
            _earth["phase"] = "flying to the property"
        _earth_fly(lat, lon, span_m / EARTH_K, deadline)

        view = _earth_view()
        if abs(view.get("latitude", lat) - lat) > 0.01 or abs(view.get("longitude", lon) - lon) > 0.01:
            raise RuntimeError("Google Earth didn't go where it was asked.")

        with _earth_lock:
            _earth["phase"] = "measuring the ground"
        pts = _earth_probe_grid(9)
        # A cold frame reports elevation exactly 0.0 everywhere. Genuine sea level is possible but
        # it is never EXACTLY zero across all 81 probes.
        if all(p[4] == 0.0 for p in pts):
            raise RuntimeError("Google Earth hasn't loaded imagery here yet — try again.")
        if min(p[4] for p in pts) < -50.0:
            raise RuntimeError("This view is mostly water — Google Earth returns sea-floor depth "
                               "there, which can't be used to position a map.")
        box, acc = _earth_fit(pts)

        with _earth_lock:
            _earth["phase"] = "taking the picture"
        fd, tmp = tempfile.mkstemp(suffix=".jpg", prefix="ge_capture_")
        os.close(fd)
        _earth_tell('SaveScreenShot "%s"' % tmp)
        # SaveScreenShot returns true even when it writes nothing at all — verified against a
        # nonexistent directory, a relative path and a tilde path. Never trust its return value.
        if not os.path.exists(tmp) or os.path.getsize(tmp) < 1024:
            raise RuntimeError("Google Earth reported success but didn't save a picture.")
        with open(tmp, "rb") as fh:
            blob = fh.read()

        img_w = img_h = 0
        rc, out, _ = run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", tmp], 10)
        if rc == 0:
            for line in out.splitlines():
                if "pixelWidth:" in line:
                    img_w = int(line.split(":")[1])
                elif "pixelHeight:" in line:
                    img_h = int(line.split(":")[1])
        if img_w <= 0 or img_h <= 0:
            raise RuntimeError("Couldn't read the captured picture's size.")

        # The NDC square IS the image rectangle, so the ground aspect and the pixel aspect must
        # agree. If Google ever changes the projection or a HiDPI display doubles the pixels, this
        # is what catches it — refuse rather than ship a silently misaligned base map.
        ground_h = (box["north"] - box["south"]) * 111320.0
        ground_w = (box["east"] - box["west"]) * 111320.0 * math.cos(math.radians(lat))
        if ground_w <= 0 or ground_h <= 0:
            raise RuntimeError("Google Earth returned a degenerate view.")
        skew = abs((ground_h / ground_w) / (float(img_h) / img_w) - 1.0)
        if skew > 0.05:
            raise RuntimeError("The picture's shape doesn't match the ground it covers "
                               "(off by %.0f%%) — not using it." % (skew * 100))

        with _earth_lock:
            _earth["result"] = {
                "image": "data:image/jpeg;base64," + base64.b64encode(blob).decode("ascii"),
                "bounds": {"west": box["west"], "east": box["east"],
                           "north": box["north"], "south": box["south"], "z": 19},
                "accuracy": acc,
                "img_w": img_w, "img_h": img_h,
                "span_m": round(ground_w, 1),
                "lat": lat, "lon": lon,
                "captured": datetime.now().isoformat(timespec="seconds"),
            }
            _earth["phase"] = "done"
    except Exception as e:  # noqa: BLE001 — every failure reaches the technician as text
        with _earth_lock:
            _earth["error"] = str(e)
            _earth["phase"] = "failed"
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass
        with _earth_lock:
            _earth["running"] = False


def action_earth_start(lat, lon, span):
    """Kick off a capture. lat/lon/span are coerced to float and range-checked HERE, before they
    can reach an AppleScript string — a float literal cannot carry a quote or a newline, so
    there is nothing left to escape. Out-of-range latitude is not merely wrong: SetViewInfo
    wraps it over the pole and silently moves the camera somewhere else entirely.
    """
    try:
        lat = float(lat); lon = float(lon); span = float(span)
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad coordinates"}
    if not (-85.0 <= lat <= 85.0 and -180.0 <= lon <= 180.0):
        return {"ok": False, "error": "coordinates out of range"}
    if not (EARTH_SPAN_MIN_M <= span <= EARTH_SPAN_MAX_M):
        return {"ok": False, "error": "area must be between %d and %d metres across"
                                      % (EARTH_SPAN_MIN_M, EARTH_SPAN_MAX_M)}
    if not all(map(math.isfinite, (lat, lon, span))):
        return {"ok": False, "error": "bad coordinates"}

    with _earth_lock:
        # One Google Earth, one camera. A second capture would fly it away mid-probe and the
        # first would georeference its picture against ground it is no longer looking at.
        #
        # This must REFUSE, not report success. The speed test can answer "already running"
        # because re-attaching to it gives you the same test — here it would not: the caller
        # asked for a different property, then polls and adopts whatever the in-flight capture
        # returns, putting another address's imagery under this survey's readings.
        if _earth["running"]:
            return {"ok": False, "busy": True,
                    "error": "A capture is already running — wait for it to finish."}
        _earth.update({"running": True, "phase": "starting", "result": None,
                       "error": None, "started": time.time()})
    threading.Thread(target=_earth_worker, args=(lat, lon, span), daemon=True).start()
    return {"ok": True, "already": False}


def action_earth_progress():
    with _earth_lock:
        s = dict(_earth)
    s["elapsed"] = round(time.time() - s["started"], 1) if s["started"] else 0
    s["ok"] = True
    return s


# ---------------------------------------------------------------------------
# Live view in Google Earth
#
# Google Earth polls this server while the survey is being walked, so coverage appears on the
# imagery in real time. The browser owns all the geometry (it lives in localStorage, not here)
# and pushes finished KML; this side only holds the latest push and serves it uncached.
# ---------------------------------------------------------------------------
_live_lock = threading.Lock()
_live = {"doc": "", "overlay": b"", "version": 0, "updated": 0.0}

# The live feed needs a credential that OUTLIVES the process, and API_KEY deliberately doesn't.
#
# Google Earth keeps a NetworkLink in Temporary Places once it's loaded, and re-opening the same
# file does NOT replace it. So after a server restart the old link keeps polling with the old key,
# gets 403s, and just goes on drawing its last good frame — a silently stale coverage map, which
# is the worst possible failure for something a technician is reading decisions off. Verified:
# Earth sat there showing a previous run's overlay indefinitely.
#
# So this one token persists, 0600, and only the two read-only live routes accept it. API_KEY
# stays per-run for everything else, which is where its "a stale bookmark just stops working"
# rationale actually holds.
LIVE_TOKEN_PATH = os.path.join(os.path.expanduser("~"), ".wifi-survey-live-token")


def _load_live_token():
    try:
        with open(LIVE_TOKEN_PATH, "r") as fh:
            tok = fh.read().strip()
        if len(tok) >= 16:
            # O_CREAT's mode only applies when the file is created, so a file that already
            # existed keeps whatever mode it had. Tighten it every time we read it.
            try:
                os.chmod(LIVE_TOKEN_PATH, 0o600)
            except OSError:
                pass
            return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(18)
    try:
        fd = os.open(LIVE_TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(tok)
    except OSError:
        pass        # unwritable home: the token still works for this run
    return tok


LIVE_TOKEN = _load_live_token()


def secret_eq(supplied, secret):
    """Constant-time compare that tolerates ANY input.

    hmac.compare_digest raises TypeError on str arguments containing non-ASCII, and the value
    here comes straight off the query string — so `?k=é` raised instead of returning false.
    Comparing the UTF-8 bytes keeps the timing property and accepts anything a client can send.
    """
    return hmac.compare_digest(str(supplied or "").encode("utf-8", "surrogatepass"),
                               secret.encode("utf-8"))


def live_token_ok(query):
    """Either credential opens the live feed: the per-run key for the dashboard's own fetches,
    the persistent token for the NetworkLink Google Earth holds across restarts."""
    supplied = (query.get("k", [None])[0] or "")
    return secret_eq(supplied, LIVE_TOKEN) or secret_eq(supplied, API_KEY)

LIVE_REFRESH_S = 3      # a refresh rebuilds the feature tree, which shuts any open balloon;
                        # 1s is possible but makes placemarks impossible to read while walking


def action_live_push(body):
    doc = body.get("doc")
    if not isinstance(doc, str) or len(doc) > 4_000_000:
        return {"ok": False, "error": "bad document"}
    png = b""
    raw = body.get("overlay")
    if isinstance(raw, str) and raw:
        try:
            png = base64.b64decode(raw.split(",", 1)[-1], validate=True)
        except (ValueError, binascii.Error):
            return {"ok": False, "error": "bad overlay"}
        if png[:4] != b"\x89PNG":
            return {"ok": False, "error": "overlay must be a PNG"}
    with _live_lock:
        _live["doc"] = doc
        _live["overlay"] = png
        _live["version"] += 1
        _live["updated"] = time.time()
        return {"ok": True, "version": _live["version"]}


def live_kml():
    with _live_lock:
        doc, version, updated = _live["doc"], _live["version"], _live["updated"]
    if not doc:
        doc = "<Folder><name>Waiting for the survey…</name></Folder>"
    stamp = datetime.fromtimestamp(updated).strftime("%H:%M:%S") if updated else "not started"
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            '<name>WiFi Survey — live (%s)</name>%s</Document></kml>' % (stamp, doc)).encode("utf-8")


def live_loader_kml():
    """The tiny file Google Earth actually opens. Written fresh every time, so it always carries
    the current run's key — that is what stops a saved copy from 403ing after a restart.

    flyToView 0 and refreshVisibility 0 matter: without them Earth seizes the camera and resets
    the technician's own layer checkboxes every few seconds while they are trying to work.
    """
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><NetworkLink>'
            '<name>WiFi Survey — live coverage</name>'
            '<open>1</open><flyToView>0</flyToView><refreshVisibility>0</refreshVisibility>'
            '<Link><href>http://127.0.0.1:%d/api/live.kml?k=%s</href>'
            '<refreshMode>onInterval</refreshMode><refreshInterval>%d</refreshInterval>'
            '</Link></NetworkLink></kml>' % (PORT, LIVE_TOKEN, LIVE_REFRESH_S)).encode("utf-8")


_live_open_n = 0


def action_live_open():
    """Write the loader and hand it to Google Earth.

    The filename has to be NEW each time. Opening a path Google Earth has already loaded is a
    silent no-op — it keeps the NetworkLink it made the first time and does not re-read the file,
    so pressing the button again appears to do nothing at all. Verified: re-opening a used path
    produced zero polls, a fresh name produced one every 3s immediately.

    Because LIVE_TOKEN persists, an entry made on any earlier run keeps working, so in practice
    this is pressed once. Old loader files are cleaned up; the entries themselves live in Google
    Earth's Temporary Places, where only the technician can remove them.
    """
    global _live_open_n
    if not os.path.isdir(EARTH_BUNDLE):
        return {"ok": False, "error": "Google Earth Pro isn't installed in /Applications."}
    tmp = tempfile.gettempdir()
    for stale in os.listdir(tmp):
        if stale.startswith("wifi_survey_live_") and stale.endswith(".kml"):
            try:
                os.unlink(os.path.join(tmp, stale))
            except OSError:
                pass
    _live_open_n += 1
    path = os.path.join(tmp, "wifi_survey_live_%d_%d.kml" % (int(time.time()), _live_open_n))
    try:
        # 0600: this file carries the persistent token in its href, and TMPDIR is world-readable
        # when unset. A plain open() would leave it 0644.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(live_loader_kml())
    except OSError as e:
        return {"ok": False, "error": "Couldn't write the Google Earth file: %s" % e}
    rc, _, err = run(["open", "-a", EARTH_BUNDLE, path], 30)
    if rc:
        return {"ok": False, "error": "Couldn't open Google Earth: %s" % (err or rc)}
    return {"ok": True, "refresh": LIVE_REFRESH_S}


# ---------------------------------------------------------------------------
# http
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet console
        pass

    def _host_ok(self):
        """Reject a Host header that isn't an address this server could legitimately be at.

        A web page can make the browser send requests here, but it cannot forge the Host
        header — so requiring an IP or localhost blocks the DNS-rebinding route, where an
        attacker's domain is repointed at 127.0.0.1 to reach this API from their page.
        """
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if host in ("localhost", "127.0.0.1", "::1", ""):
            return True
        try:
            ipaddress.ip_address(host)
            return True          # a bare IP can't be rebound
        except ValueError:
            return False

    def _key_ok(self, query):
        supplied = (query.get("k", [None])[0] or self.headers.get("X-Survey-Key") or "")
        return secret_eq(supplied, API_KEY)

    def _loopback_client(self):
        """True only for a request that came from this Mac itself.

        The live routes accept a credential that OUTLIVES the process, which the per-run API_KEY
        deliberately does not. Confining them to loopback means that token can't be replayed from
        the LAN — and nothing legitimate is lost, because Google Earth always fetches the loader's
        hardcoded http://127.0.0.1 href from this same machine.
        """
        try:
            ip = ipaddress.ip_address(self.client_address[0])
        except (ValueError, IndexError):
            return False
        # ::ffff:127.0.0.1 is loopback in substance, and older Pythons say it isn't. The server
        # is AF_INET today so this cannot arise, but the failure it would cause — Google Earth
        # silently locked out of the live feed — is worth one line to rule out for good.
        mapped = getattr(ip, "ipv4_mapped", None)
        return bool(ip.is_loopback or (mapped is not None and mapped.is_loopback))

    def _guard(self, path, query, need_json=False):
        """Common checks for /api/*. Returns True when the request may proceed."""
        if not self._host_ok():
            self._send_json({"ok": False, "error": "bad Host header"}, 403)
            return False
        if need_json:
            ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype and ctype not in ("application/json", "text/plain"):
                self._send_json({"ok": False, "error": "expected application/json"}, 415)
                return False
        if not self._key_ok(query):
            self._send_json({"ok": False, "error": "missing or bad key — reload the dashboard"}, 403)
            return False
        return True

    def _send_json(self, obj, code=200):
        payload = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_bytes(self, data, ctype, code=200, no_store=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        if no_store:
            # Google Earth caches a NetworkLink's response at the HTTP layer and will happily
            # redraw a stale copy forever. This trio is what makes each refresh a real fetch.
            # Note there is deliberately no ETag or Last-Modified anywhere: this server extends
            # BaseHTTPRequestHandler, not SimpleHTTPRequestHandler, so nothing adds them for us
            # and nothing negotiates a 304.
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(data)

    def _send_file(self, filename):
        path = os.path.join(SCRIPT_DIR, filename)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        ctype = "text/html" if filename.endswith(".html") else "application/javascript"
        with open(path, "rb") as f:
            body = f.read()
        # Hand the page this run's API key. Same-origin script can read it; a cross-origin
        # page cannot read this response at all, which is what makes the key worth having.
        if filename.endswith(".html"):
            # live-token too: Google Earth keeps a NetworkLink across restarts, so anything it
            # fetches has to be addressed with the credential that survives them.
            body = body.replace(
                b"<head>",
                b'<head>\n<meta name="survey-key" content="%s">'
                b'\n<meta name="live-token" content="%s">'
                % (API_KEY.encode(), LIVE_TOKEN.encode()), 1)
        self.send_response(200)
        self.send_header("Content-Type", "%s; charset=utf-8" % ctype)
        self.send_header("Content-Length", str(len(body)))
        # never cache the app shell/JS — otherwise browsers serve a stale copy after edits
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.end_headers()
        self.wfile.write(body)

    # Any uncaught handler error used to close the socket with no response at all, which the
    # browser reports as a network failure — so a server bug looked like a Wi-Fi problem and
    # sent the technician off checking the wrong thing.
    def do_GET(self):
        try:
            self._route_get()
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": "server error: %s" % e}, 500)

    def do_POST(self):
        try:
            self._route_post()
        except Exception as e:  # noqa: BLE001
            self._send_json({"ok": False, "error": "server error: %s" % e}, 500)

    def _route_get(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path in STATIC:
            if not self._host_ok():
                return self.send_error(403)
            return self._send_file(STATIC[u.path])
        if not u.path.startswith("/api/"):
            return self.send_error(404)
        # The live feed is checked before _guard because Google Earth carries the persistent
        # token, not this run's API key. Host is still verified, and both routes are read-only.
        if u.path in ("/api/live.kml", "/api/live/overlay.png"):
            if not self._host_ok():
                return self.send_error(403)
            if not self._loopback_client():
                return self.send_error(403)
            if not live_token_ok(q):
                return self.send_error(403)
            if u.path == "/api/live.kml":
                return self._send_bytes(live_kml(),
                                        "application/vnd.google-earth.kml+xml", no_store=True)
            with _live_lock:
                png = _live["overlay"]
            if not png:
                return self.send_error(404)
            return self._send_bytes(png, "image/png", no_store=True)
        if not self._guard(u.path, q):
            return
        if u.path == "/api/scan":
            return self._send_json(action_scan())
        if u.path == "/api/quality":
            return self._send_json(action_quality())
        if u.path == "/api/quality/start":
            return self._send_json(action_speed_start())
        if u.path == "/api/quality/progress":
            return self._send_json(action_speed_progress())
        if u.path == "/api/ping":
            return self._send_json(action_ping(q.get("host", [None])[0], q.get("count", [5])[0]))
        if u.path == "/api/gps":  # phone app pushes a fix via query params (GPSLogger GET)
            return self._send_json(action_gps_push(q, {}))
        if u.path == "/api/gps/latest":
            return self._send_json(action_gps_latest())
        if u.path == "/api/gps/config":
            return self._send_json(action_gps_config())
        if u.path == "/api/geocode":
            return self._send_json(action_geocode(q.get("q", [""])[0]))
        if u.path == "/api/naip":
            ctype, body = action_naip(q.get("west", [""])[0], q.get("east", [""])[0],
                                      q.get("north", [""])[0], q.get("south", [""])[0],
                                      q.get("size", [1024])[0])
            if body:
                return self._send_bytes(body, ctype)
            return self.send_error(502)
        if u.path == "/api/earth/start":
            return self._send_json(action_earth_start(q.get("lat", [None])[0],
                                                      q.get("lon", [None])[0],
                                                      q.get("span", [230])[0]))
        if u.path == "/api/earth/progress":
            return self._send_json(action_earth_progress())
        if u.path == "/api/tile":  # Esri World Imagery proxy (Imagery (c) Esri)
            ctype, body = action_tile(q.get("z", [""])[0], q.get("x", [""])[0], q.get("y", [""])[0])
            if body:
                return self._send_bytes(body, ctype)
            return self.send_error(502)
        self.send_error(404)

    def _route_post(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if not u.path.startswith("/api/"):
            return self.send_error(404)
        if not self._guard(u.path, q, need_json=True):
            return
        length = int(self.headers.get("Content-Length", 0) or 0)
        # A GPS fix is a few hundred bytes, but a live push carries the whole survey document
        # plus a base64 overlay. At 1 MiB the transport rejected pushes that action_live_push
        # would have accepted, and the client swallowed the 413 — so Google Earth went on
        # redrawing the last frame it got, with nothing saying it had frozen.
        cap = (8 << 20) if u.path == "/api/live/push" else (1 << 20)
        if length > cap:
            return self._send_json({"ok": False, "error": "body too large"}, 413)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
        if u.path == "/api/live/push":
            return self._send_json(action_live_push(body))
        if u.path == "/api/live/open":
            return self._send_json(action_live_open())
        if u.path == "/api/open":
            return self._send_json(action_open(body.get("app")))
        if u.path == "/api/cellular":
            return self._send_json(
                action_cellular(body.get("ip"), body.get("username"), body.get("password")))
        if u.path == "/api/gps":  # phone app POSTs a fix (OwnTracks JSON, or form-encoded)
            form = {}
            if not body:
                try:
                    form = {k: v[0] for k, v in parse_qs(raw.decode("utf-8", "replace")).items()}
                except Exception:  # noqa: BLE001
                    form = {}
            action_gps_push(q, body or form)
            # OwnTracks HTTP mode expects a JSON array response (list of commands, usually empty)
            return self._send_json([])
        self.send_error(404)


def main():
    try:
        srv = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as e:
        print("Couldn't start on port %d: %s" % (PORT, e))
        print("It's probably already running — open http://localhost:%d" % PORT)
        raise SystemExit(1)
    print("WiFi Survey mission-control:  http://localhost:%d" % PORT)
    print("On your phone (same Wi-Fi):   http://%s:%d" % (lan_ip(), PORT))
    print("Phone GPS bridge — the exact URL to paste is on the GPS page.")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
