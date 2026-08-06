#!/bin/bash
# Double-click to launch the WiFi Site Survey dashboard.
cd "$(dirname "$0")" || exit 1
URL="http://127.0.0.1:8765"

# Already running? Open it rather than starting a second copy, which just prints a bind error
# next to a browser window that works — confusing enough to look like a crash.
if lsof -ti tcp:8765 >/dev/null 2>&1; then
  echo "Already running. Opening the dashboard."
  open "$URL"
  exit 0
fi

# /usr/bin/python3 on a stock Mac is a stub that pops the Command Line Tools installer instead
# of running anything, so check that it actually executes rather than that the file exists.
if ! python3 -c 'import sys' >/dev/null 2>&1; then
  echo "Python 3 isn't ready on this Mac."
  echo "Run this once:   xcode-select --install"
  echo "Then double-click this file again."
  echo
  echo "Press any key to close."
  read -r -n 1
  exit 1
fi

# Wait until the server actually accepts a connection before opening the browser — a fixed
# sleep raced it on a cold start and landed the tech on "connection refused".
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null --max-time 1 "$URL"; then open "$URL"; exit 0; fi
    sleep 0.25
  done
  echo "Server didn't come up. See the messages above."
) &

echo "WiFi Site Survey, starting…  (close this window or Ctrl+C to stop)"
exec python3 survey_server.py
