"""Small shared primitives: subprocess and HTTP calls.

The constant-time secret compare lives in live.py, next to the token it guards.
"""

import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request

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
