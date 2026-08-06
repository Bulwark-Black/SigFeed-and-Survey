"""Phone GPS bridge. A GPS-broadcast app on the phone posts fixes here."""

import socket
import threading
import time
from datetime import datetime

from .config import API_KEY, PORT

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
        return {"ok": False, "error": "lat/lon out of range. Check the URL template in your GPS app"}
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
