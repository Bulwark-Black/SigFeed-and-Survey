#!/usr/bin/env python3
"""
WiFi Site Survey - local mission-control backend.

Zero third-party dependencies (macOS system Python 3.9 is fine). Serves a
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

import hmac
import ipaddress
import json
import os
import re
import secrets
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.error
import urllib.parse
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
    # networkQuality runs a real up/down test against Apple's servers (~15-25s).
    rc, out, err = run(["networkQuality", "-c"], 45)
    if rc != 0 or not out.strip():
        return {"ok": False, "error": err or "networkQuality failed (need internet?)"}
    try:
        d = json.loads(out)
    except ValueError as e:
        return {"ok": False, "error": "parse error: %s" % e}
    to_mbps = lambda bps: round(bps / 1_000_000, 1) if isinstance(bps, (int, float)) else None
    return {
        "ok": True,
        "download_mbps": to_mbps(d.get("dl_throughput")),
        "upload_mbps": to_mbps(d.get("ul_throughput")),
        "responsiveness_rpm": d.get("responsiveness"),
        "base_rtt_ms": round(d["base_rtt"], 1) if isinstance(d.get("base_rtt"), (int, float)) else None,
    }


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


def action_tile(z, x, y):
    """Fetch one Esri World Imagery tile -> (content_type, bytes) or (None, b'').

    Slippy-map (z,x,y) with Esri's z/y/x PATH order (row before col).
    Imagery (c) Esri - attribution is required by the Esri terms of use and
    is rendered on the composed aerial in the client/report.
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
    if not ctype:
        ctype = "image/jpeg"
    return ctype, body


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
        return hmac.compare_digest(supplied, API_KEY)

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

    def _send_bytes(self, data, ctype, code=200):
        self.send_response(code)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
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
            body = body.replace(b"<head>",
                                b'<head>\n<meta name="survey-key" content="%s">' % API_KEY.encode(), 1)
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
        if not self._guard(u.path, q):
            return
        if u.path == "/api/scan":
            return self._send_json(action_scan())
        if u.path == "/api/quality":
            return self._send_json(action_quality())
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
        if length > 1 << 20:            # a GPS fix is a few hundred bytes
            return self._send_json({"ok": False, "error": "body too large"}, 413)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            body = {}
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
