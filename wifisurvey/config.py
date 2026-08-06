"""Runtime configuration: bind address, per-run API key, and what may be served or launched."""

import os
import re
import secrets

HOST = "0.0.0.0"  # bind LAN-wide so a phone can POST its GPS to this Mac
PORT = 8765
# The repo root, not this package directory: dashboard.html, run-sheet.html and js/ all sit
# beside survey_server.py, one level up from here.
SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# New every run: nothing to store, and a stale bookmark simply stops working.
API_KEY = secrets.token_urlsafe(9)

# Apps the dashboard is allowed to launch, mapped to their macOS app names.
LAUNCHABLE = {
    "netspot": "NetSpot",
    "wifi-explorer": "WiFi Explorer",
    "wireless-diagnostics": "Wireless Diagnostics",
}

STATIC = {"/": "dashboard.html", "/run-sheet.html": "run-sheet.html"}
JS_MODULE_RE = re.compile(r"/js/[a-z][a-z0-9_-]*\.js")
