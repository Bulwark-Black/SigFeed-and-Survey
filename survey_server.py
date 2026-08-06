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

import ipaddress
import json
import os
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# Re-exported so `import survey_server` still exposes the whole back end as one surface:
# this stays the entry point, and the tests address it as one module.
from wifisurvey.cellular import action_cellular
from wifisurvey.config import API_KEY, HOST, JS_MODULE_RE, PORT, SCRIPT_DIR, STATIC
from wifisurvey.earth import (
    EARTH_BUNDLE, EARTH_SPAN_MAX_M, EARTH_SPAN_MIN_M, _earth,
    _earth_lock, action_earth_progress, action_earth_start
)
from wifisurvey.gps import action_gps_config, action_gps_latest, action_gps_push, lan_ip
from wifisurvey.imagery import (
    ESRI_NO_DATA_MD5, _merc_m, _png_is_blank, action_geocode,
    action_naip, action_tile
)
from wifisurvey.live import (
    LIVE_REFRESH_S, LIVE_TOKEN, LIVE_TOKEN_PATH, LIVE_TOKEN_PERSISTED,
    _live, _live_lock, _load_live_token, action_live_open,
    action_live_push, live_kml, live_loader_kml, live_token_ok,
    secret_eq
)
from wifisurvey.util import UA, run
from wifisurvey.wifi import (
    action_open, action_ping, action_quality, action_scan,
    action_speed_progress, action_speed_start
)

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
            self._send_json({"ok": False, "error": "missing or bad key. Reload the dashboard"}, 403)
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
        # The front end is a handful of ES modules under js/. The name pattern allows no dot and
        # no slash, so "..", absolute paths and nested lookups are simply unexpressible rather
        # than filtered, which is the same posture as the rest of this server.
        if JS_MODULE_RE.fullmatch(u.path):
            if not self._host_ok():
                return self.send_error(403)
            return self._send_file(os.path.join("js", os.path.basename(u.path)))
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
        print("It's probably already running. Open http://localhost:%d" % PORT)
        raise SystemExit(1)
    print("WiFi Survey mission-control:  http://localhost:%d" % PORT)
    print("On your phone (same Wi-Fi):   http://%s:%d" % (lan_ip(), PORT))
    print("Phone GPS bridge: the exact URL to paste is on the GPS page.")
    if not LIVE_TOKEN_PERSISTED:
        print("Note: couldn't save %s, so the Google Earth live view will need re-opening\n"
              "      from the dashboard after every restart of this server." % LIVE_TOKEN_PATH)
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
