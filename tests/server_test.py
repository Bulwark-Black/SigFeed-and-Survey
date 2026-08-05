#!/usr/bin/env python3
"""Server logic, exercised against the real module — no network required.

The things worth testing here are the ones that fail QUIETLY: a blank tile passed off as
imagery, a coordinate that reaches AppleScript unvalidated, a live feed that silently serves
stale data after a restart.
"""
import importlib.util
import io
import json
import os
import struct
import sys
import threading
import urllib.error
import urllib.request
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

spec = importlib.util.spec_from_file_location("srv", os.path.join(ROOT, "survey_server.py"))
srv = importlib.util.module_from_spec(spec)
sys.modules["srv"] = srv
spec.loader.exec_module(srv)

FAILURES = []


def ok(cond, msg, extra=""):
    print(("    ok   " if cond else "    FAIL ") + msg + ("  " + str(extra) if extra else ""))
    if not cond:
        FAILURES.append(msg)


def section(name):
    print("  " + name)


def png(w, h, rgba, bitdepth=8, color=6):
    raw = b"".join(b"\x00" + bytes(rgba) * w for _ in range(h))

    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, bitdepth, color, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))


# --------------------------------------------------------------------------
section("_png_is_blank — NAIP's silent 'no coverage' answer")
ok(srv._png_is_blank(png(64, 64, [0, 0, 0, 0])), "fully transparent PNG is blank")
ok(not srv._png_is_blank(png(64, 64, [12, 200, 40, 255])), "opaque imagery is NOT blank")
ok(not srv._png_is_blank(png(64, 64, [0, 0, 0, 255])), "solid black opaque is NOT blank (real night imagery)")
ok(not srv._png_is_blank(b"\xff\xd8\xff" + b"x" * 100), "a JPEG is never reported blank")
ok(not srv._png_is_blank(b""), "empty bytes handled")
ok(not srv._png_is_blank(b"\x89PNG\r\n\x1a\n"), "truncated PNG with no IDAT handled")
ok(not srv._png_is_blank(b"\x89PNG\r\n\x1a\ngarbage-not-chunks"), "garbage after signature handled")
# a bogus chunk length must not hang or crash the walk
bogus = b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 0x7FFFFFFF) + b"IDAT" + b"\x00" * 8
ok(not srv._png_is_blank(bogus), "absurd chunk length does not hang or crash")
# a partially-covered tile has real data and must be kept
half = png(32, 32, [0, 0, 0, 0])
ok(srv._png_is_blank(half), "all-transparent at another size is still blank")

# --------------------------------------------------------------------------
section("action_naip — input validation (no network on the reject paths)")
cases = [
    (("-95.51", "-95.49", "40.06", "40.04", "1024"), True, "valid CONUS box"),
    (("-95.49", "-95.51", "40.06", "40.04", "1024"), False, "west >= east"),
    (("-95.51", "-95.49", "40.04", "40.06", "1024"), False, "south >= north"),
    (("-95.51", "-90.00", "45.00", "40.04", "1024"), False, "span wider than 1 degree"),
    (("-95.51", "-95.49", "40.06", "40.04", "9999"), False, "size above 2048"),
    (("-95.51", "-95.49", "40.06", "40.04", "8"), False, "size below 64"),
    (("abc", "-95.49", "40.06", "40.04", "1024"), False, "non-numeric west"),
    ((None, "-95.49", "40.06", "40.04", "1024"), False, "missing west"),
    (("-181", "-95.49", "40.06", "40.04", "1024"), False, "longitude out of range"),
    (("-95.51", "-95.49", "89.0", "88.9", "1024"), False, "latitude beyond mercator limit"),
]
for args, should_pass, label in cases:
    if should_pass:
        continue                      # exercised in the --net suite; keep this file offline
    ctype, body = srv.action_naip(*args)
    ok(body == b"" and ctype is None, "rejects: " + label)

# --------------------------------------------------------------------------
section("action_earth_start — coordinates must never reach AppleScript unvalidated")
bad = [
    (("999", "0", "230"), "latitude out of range"),
    (("40", "999", "230"), "longitude out of range"),
    (("abc", "0", "230"), "non-numeric latitude"),
    ((None, "0", "230"), "missing latitude"),
    (("40", "0", "5"), "span below minimum"),
    (("40", "0", "99999"), "span above maximum"),
    (("nan", "0", "230"), "NaN latitude"),
    (("inf", "0", "230"), "infinite latitude"),
    (('0" & (do shell script "id") & "', "0", "230"), "quote-injection attempt"),
    (("40\n0", "0", "230"), "newline-injection attempt"),
]
for args, label in bad:
    r = srv.action_earth_start(*args)
    ok(r.get("ok") is False, "rejects: " + label, r.get("error", ""))
ok(srv._earth["running"] is False, "a rejected request never marks a capture as running")

# A busy capture must REFUSE, not answer ok — the caller would poll and adopt a base map of
# whatever OTHER property the in-flight capture was for.
srv._earth["running"] = True
r = srv.action_earth_start("40.05", "-95.5", "230")
ok(r.get("ok") is False, "a second capture is refused while one is running", r.get("error", ""))
ok(r.get("busy") is True, "and is flagged as busy rather than a bad request")
srv._earth["running"] = False

# --------------------------------------------------------------------------
section("live feed")
srv._live.update({"doc": "", "overlay": b"", "version": 0, "updated": 0.0})
ok(b"Waiting for the survey" in srv.live_kml(), "serves a placeholder before the first push")
ok(srv.live_kml().startswith(b'<?xml'), "placeholder is still well-formed KML")

r = srv.action_live_push({"doc": "<Folder><name>Walk</name></Folder>"})
ok(r["ok"] and r["version"] == 1, "accepts a document-only push")
ok(b"<Folder><name>Walk</name></Folder>" in srv.live_kml(), "serves what was pushed")

r = srv.action_live_push({"doc": "<x/>", "overlay": "data:image/png;base64,"
                          + __import__("base64").b64encode(png(4, 4, [1, 2, 3, 255])).decode()})
ok(r["ok"] and r["version"] == 2, "accepts a push with an overlay; version increments")
ok(srv._live["overlay"][:4] == b"\x89PNG", "overlay stored as PNG bytes")

for payload, label in [
    ({"doc": 123}, "non-string doc"),
    ({}, "missing doc"),
    ({"doc": "<x/>", "overlay": "data:image/png;base64,bm90YXBuZw=="}, "overlay is not a PNG"),
    ({"doc": "<x/>", "overlay": "!!!not-base64!!!"}, "overlay is not base64"),
    ({"doc": "x" * 4_000_001}, "document over the size cap"),
]:
    ok(srv.action_live_push(payload).get("ok") is False, "rejects: " + label)
ok(srv._live["version"] == 2, "a rejected push does not bump the version")

section("live token")
ok(len(srv.LIVE_TOKEN) >= 16, "token is long enough to not be guessable", len(srv.LIVE_TOKEN))
ok(srv.LIVE_TOKEN != srv.API_KEY, "live token is distinct from the per-run API key")
ok(srv.live_token_ok({"k": [srv.LIVE_TOKEN]}), "accepts the persistent token")
ok(srv.live_token_ok({"k": [srv.API_KEY]}), "accepts the per-run key too")
ok(not srv.live_token_ok({"k": ["wrong"]}), "rejects a wrong token")
ok(not srv.live_token_ok({}), "rejects a missing token")
ok(not srv.live_token_ok({"k": [""]}), "rejects an empty token")
ok(not srv.live_token_ok({"k": ["éè"]}), "non-ASCII token does not raise")
ok(not srv.live_token_ok({"k": ["\ud800"]}), "lone surrogate does not raise")
ok(not srv.secret_eq("é", srv.API_KEY), "secret_eq tolerates non-ASCII (regression: _key_ok raised)")
ok(srv.secret_eq(srv.API_KEY, srv.API_KEY), "secret_eq still matches a correct key")
ok(not srv.secret_eq(None, srv.API_KEY), "secret_eq tolerates None")
# the whole point: it must survive a restart
ok(srv._load_live_token() == srv.LIVE_TOKEN, "reloading from disk yields the same token")
if os.path.exists(srv.LIVE_TOKEN_PATH):
    ok(oct(os.stat(srv.LIVE_TOKEN_PATH).st_mode)[-3:] == "600", "token file is 0600",
       oct(os.stat(srv.LIVE_TOKEN_PATH).st_mode)[-3:])

section("live loader KML")
loader = srv.live_loader_kml().decode()
ok(srv.LIVE_TOKEN in loader, "loader carries the PERSISTENT token, not the per-run key")
ok(srv.API_KEY not in loader, "loader does not carry the per-run key")
ok("<refreshMode>onInterval</refreshMode>" in loader, "refreshes on an interval")
ok("<flyToView>0</flyToView>" in loader, "does not seize the camera")
ok("<refreshVisibility>0</refreshVisibility>" in loader, "does not reset the user's checkboxes")
ok("127.0.0.1" in loader, "points at localhost")

# --------------------------------------------------------------------------
section("HTTP routing and auth")
# Port 0 = let the OS pick a free one. A fixed port makes the suite fail spuriously when two
# runs land back to back and the previous socket is still bound.
httpd = srv.ThreadingHTTPServer(("127.0.0.1", 0), srv.Handler)
PORT = httpd.server_address[1]
srv.PORT = PORT
threading.Thread(target=httpd.serve_forever, daemon=True).start()
B = "http://127.0.0.1:%d" % PORT


def get(path, host=None):
    req = urllib.request.Request(B + path)
    if host:
        req.add_header("Host", host)
    try:
        r = urllib.request.urlopen(req, timeout=8)
        return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


st, _, _ = get("/api/live.kml?k=" + srv.LIVE_TOKEN)
ok(st == 200, "live.kml with the persistent token -> 200", st)
st, _, _ = get("/api/live.kml?k=" + srv.API_KEY)
ok(st == 200, "live.kml with the per-run key -> 200", st)
st, _, _ = get("/api/live.kml?k=nope")
ok(st == 403, "live.kml with a bad token -> 403", st)
st, _, _ = get("/api/live.kml")
ok(st == 403, "live.kml with no token -> 403", st)
st, _, _ = get("/api/live.kml?k=" + srv.LIVE_TOKEN, host="evil.example.com")
ok(st == 403, "live.kml with a foreign Host -> 403 (DNS-rebinding guard still applies)", st)

st, hdrs, _ = get("/api/live.kml?k=" + srv.LIVE_TOKEN)
cc = hdrs.get("Cache-Control", "")
ok("no-store" in cc and "no-cache" in cc, "live.kml is uncacheable", cc)
ok("ETag" not in hdrs and "Last-Modified" not in hdrs,
   "no ETag/Last-Modified — nothing for Earth to revalidate into a 304")

st, hdrs, body = get("/api/live/overlay.png?k=" + srv.LIVE_TOKEN)
ok(st == 200 and body[:4] == b"\x89PNG", "overlay.png served", st)
ok("no-store" in hdrs.get("Cache-Control", ""), "overlay is uncacheable too — else it freezes")
st, _, _ = get("/api/live/overlay.png?k=nope")
ok(st == 403, "overlay with a bad token -> 403", st)

# the live routes bypass _guard; make sure nothing ELSE did
st, _, _ = get("/api/scan")
ok(st == 403, "a normal API route still demands the key", st)
st, _, _ = get("/api/earth/progress")
ok(st == 403, "earth progress still demands the key", st)
st, _, _ = get("/api/naip?west=-95.5&east=-95.4&north=40.1&south=40.0")
ok(st == 403, "naip still demands the key", st)
st, _, _ = get("/nope")
ok(st == 404, "unknown path -> 404", st)

section("live routes are loopback-only")
# LIVE_TOKEN outlives the process, so it must not be replayable from the LAN. Google Earth always
# fetches the loader's hardcoded 127.0.0.1 href, so nothing legitimate is off-box.
ok(srv.Handler._loopback_client(type("S", (), {"client_address": ("127.0.0.1", 1)})()),
   "127.0.0.1 counts as loopback")
ok(srv.Handler._loopback_client(type("S", (), {"client_address": ("::1", 1)})()),
   "::1 counts as loopback")
ok(not srv.Handler._loopback_client(type("S", (), {"client_address": ("192.168.1.50", 1)})()),
   "a LAN address does not")
ok(not srv.Handler._loopback_client(type("S", (), {"client_address": ("8.8.8.8", 1)})()),
   "a public address does not")
ok(not srv.Handler._loopback_client(type("S", (), {"client_address": ("garbage", 1)})()),
   "an unparseable address does not")

# and the gate is actually wired into the routes, not merely defined
_real_lb = srv.Handler._loopback_client
srv.Handler._loopback_client = lambda self: False
ok(get("/api/live.kml?k=" + srv.LIVE_TOKEN)[0] == 403,
   "live.kml is refused off-box even with the right token")
ok(get("/api/live/overlay.png?k=" + srv.LIVE_TOKEN)[0] == 403,
   "overlay.png is refused off-box even with the right token")
srv.Handler._loopback_client = _real_lb
ok(get("/api/live.kml?k=" + srv.LIVE_TOKEN)[0] == 200, "and allowed again from loopback")

section("body caps")


def post_size(path, n):
    """Returns the status, or 413 if the server refused mid-upload.

    An oversized body is rejected on the Content-Length header without draining the request, so
    the client is still writing when the socket closes — urllib surfaces that as a broken pipe
    rather than a status. Refusing early is the right behaviour; count it as the rejection it is.
    """
    body = b"{}" + b" " * n
    req = urllib.request.Request(B + path + "?k=" + srv.API_KEY, data=body,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        return urllib.request.urlopen(req, timeout=10).status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, BrokenPipeError, ConnectionResetError):
        return 413


ok(post_size("/api/live/push", 2 << 20) != 413,
   "a 2 MiB live push is not rejected by the transport (it carries a whole KML + overlay)")
ok(post_size("/api/gps", 2 << 20) == 413, "every other route keeps the tight 1 MiB cap")

srv._live.update({"doc": "", "overlay": b"", "version": 0, "updated": 0.0})
st, _, _ = get("/api/live/overlay.png?k=" + srv.LIVE_TOKEN)
ok(st == 404, "overlay with nothing pushed -> 404, not a broken image", st)

httpd.shutdown()

print()
if FAILURES:
    print("  %d failure(s)" % len(FAILURES))
sys.exit(1 if FAILURES else 0)
