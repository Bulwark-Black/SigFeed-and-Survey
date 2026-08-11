"""Base-map imagery: geocoding, the Esri tile proxy, and USDA NAIP."""

import hashlib
import json
import math
import zlib
import urllib.error
import urllib.parse
import urllib.request

from .util import UA, http_get_bytes, http_json

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
# USDA NAIP — public-domain aerial imagery, no key.
#
# No capture date: the request is f=image, which returns rendered pixels and no metadata, so
# nothing here knows when the imagery was flown. Don't claim one without fetching it.
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
