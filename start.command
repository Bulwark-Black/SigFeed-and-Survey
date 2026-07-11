#!/bin/bash
# Double-click to launch the WiFi Site Survey dashboard.
cd "$(dirname "$0")" || exit 1
# Open the browser a moment after the server comes up.
( sleep 1 && open "http://127.0.0.1:8765" ) &
echo "WiFi Site Survey — starting…  (close this window or Ctrl+C to stop)"
exec python3 survey_server.py
