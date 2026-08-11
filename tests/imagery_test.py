#!/usr/bin/env python3
"""Live imagery sources. Needs the network — run via ./test.sh --net

These are the checks that catch a provider changing under us: Esri reissuing its 'no data'
placeholder, NAIP moving its endpoint, or either starting to answer with something that is a
valid image but not actually ground.
"""
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# the back end is a package next to survey_server.py; loading the entry point by path
# does not put its directory on sys.path
sys.path.insert(0, ROOT)
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


section("Esri tile proxy")
# Real imagery at these; placeholder at the z21 urban/rural ones. Tile coords are z/x/y here
# (action_tile flips to Esri's z/y/x path order internally).
REAL = [
    (19, 100426, 187196, "rural Montana z19"),
    (19, 83857, 202648, "urban SF z19"),
    (21, 401704, 748787, "rural Montana z21"),
    (12, 341, 1991, "mid-Pacific ocean z12 (1660 B — a size heuristic would kill this)"),
    (10, 384, 422, "open ocean z10"),
]
PLACEHOLDER = [
    (21, 466605, 858685, "rural Texas z21"),
    (21, 423564, 769991, "rural Wyoming z21"),
    (21, 335431, 810593, "urban SF z21"),
]
for z, x, y, label in REAL:
    ctype, body = srv.action_tile(z, x, y)
    ok(bool(body) and len(body) > 500, "serves real imagery: " + label,
       "%d bytes" % len(body) if body else "EMPTY")
for z, x, y, label in PLACEHOLDER:
    ctype, body = srv.action_tile(z, x, y)
    ok(body == b"", "rejects the 'no data' placeholder: " + label,
       "%d bytes leaked" % len(body) if body else "")

# If Esri ever reissues the placeholder this hash stops matching and blanks start shipping.
import hashlib
import urllib.request
u = ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/"
     "MapServer/tile/21/858685/466605")
try:
    raw = urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": srv.UA}),
                                 timeout=20).read()
    got = hashlib.md5(raw).hexdigest()
    ok(got == srv.ESRI_NO_DATA_MD5,
       "the known placeholder digest still matches what Esri serves",
       "got %s, expected %s" % (got[:12], srv.ESRI_NO_DATA_MD5[:12]))
except Exception as e:  # noqa: BLE001
    ok(False, "could not fetch the placeholder to re-verify its digest", str(e)[:60])

section("USDA NAIP")
# Deliberately NOT labelled with place names. These are coverage probes, not field sites, and
# earlier labels ("Missouri farmland", "Florida suburb") ended up quoted in the README as if they
# were measurements taken at those places. Describe the terrain, name no location.
COVERED = [
    (-95.51, -95.49, 40.06, 40.04, "rural cropland"),
    (-80.21, -80.19, 26.06, 26.04, "coastal suburb"),
    (-111.05, -111.03, 45.69, 45.67, "mountain west"),
]
for w, e, n, s, label in COVERED:
    ctype, body = srv.action_naip(w, e, n, s, 512)
    good = bool(body) and (body[:2] == b"\xff\xd8" or body[:4] == b"\x89PNG")
    ok(good, "serves imagery: " + label, "%d bytes" % len(body) if body else "EMPTY")

for w, e, n, s, label in [(2.30, 2.32, 48.87, 48.85, "Paris — outside NAIP coverage")]:
    ctype, body = srv.action_naip(w, e, n, s, 512)
    ok(body == b"", "rejects the blank out-of-coverage render: " + label,
       "%d bytes leaked" % len(body) if body else "")

# the aspect of the returned image must match the aspect of the box, or the base map is stretched
try:
    from PIL import Image
    import io
    import math
    w, e, n, s = -95.51, -95.49, 40.06, 40.04
    ctype, body = srv.action_naip(w, e, n, s, 512)
    if body:
        im = Image.open(io.BytesIO(body))
        x0, y0 = srv._merc_m(s, w)
        x1, y1 = srv._merc_m(n, e)
        want = (y1 - y0) / (x1 - x0)
        got = im.size[1] / im.size[0]
        ok(abs(got - want) / want < 0.01, "returned image aspect matches the requested box",
           "%.4f vs %.4f" % (got, want))
except ImportError:
    print("    --   image aspect check skipped (no PIL)")

print()
if FAILURES:
    print("  %d failure(s)" % len(FAILURES))
sys.exit(1 if FAILURES else 0)
