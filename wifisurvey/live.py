"""The live coverage feed Google Earth polls while a property is being walked."""

import base64
import binascii
import hmac
import os
import secrets
import tempfile
import threading
import time
from datetime import datetime

from .config import API_KEY, PORT
from .earth import EARTH_BUNDLE
from .util import run

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


LIVE_TOKEN_PERSISTED = False


def _load_live_token():
    """Read the persistent live-feed token, creating it if absent.

    Sets LIVE_TOKEN_PERSISTED. If the home directory is unwritable the token silently becomes
    per-run again, which quietly reintroduces the failure it exists to prevent: Google Earth
    keeps its NetworkLink across restarts, the old token 403s, and it goes on redrawing its last
    frame with nothing saying it is frozen. Callers announce that rather than let it pass.
    """
    global LIVE_TOKEN_PERSISTED
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
            LIVE_TOKEN_PERSISTED = True
            return tok
    except OSError:
        pass
    tok = secrets.token_urlsafe(18)
    try:
        fd = os.open(LIVE_TOKEN_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(tok)
        LIVE_TOKEN_PERSISTED = True
    except OSError:
        LIVE_TOKEN_PERSISTED = False    # works for this run; will not survive a restart
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
            '<name>WiFi Survey live (%s)</name>%s</Document></kml>' % (stamp, doc)).encode("utf-8")


def live_loader_kml():
    """The tiny file Google Earth actually opens. Written fresh every time, so it always carries
    the current run's key — that is what stops a saved copy from 403ing after a restart.

    flyToView 0 and refreshVisibility 0 matter: without them Earth seizes the camera and resets
    the technician's own layer checkboxes every few seconds while they are trying to work.
    """
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2"><NetworkLink>'
            '<name>WiFi Survey live coverage</name>'
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
