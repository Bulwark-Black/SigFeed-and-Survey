"""Driving Google Earth Pro over AppleScript to capture a georeferenced base map."""

import base64
import math
import os
import tempfile
import threading
import time
from datetime import datetime

from .util import run

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
            raise RuntimeError("Couldn't talk to Google Earth Pro. Is it installed?")
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
        raise RuntimeError("Google Earth returned an inside-out view. Try again.")

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
            raise RuntimeError("Google Earth hasn't loaded imagery here yet. Try again.")
        if min(p[4] for p in pts) < -50.0:
            raise RuntimeError("This view is mostly water. Google Earth returns sea-floor depth "
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
                               "(off by %.0f%%), so it is not being used." % (skew * 100))

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
                    "error": "A capture is already running. Wait for it to finish."}
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
