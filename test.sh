#!/bin/bash
# Test suite. No install, no dependencies — node and python3, both already on the Mac.
#   ./test.sh            run everything
#   ./test.sh --net      also run the tests that hit Esri / NAIP over the network
#
# check.sh catches syntax and dangling references. This catches wrong ANSWERS: coordinate
# maths that lands a reading in the neighbour's yard, a zip Google Earth can't open, a blank
# tile passed off as imagery.
cd "$(dirname "$0")" || exit 1
fail=0
NET=0
[ "$1" = "--net" ] && NET=1

echo "→ coordinate maths (app.js)"
node tests/geo.test.js || fail=1

echo "→ KMZ writer (app.js)"
node tests/kmz.test.js || fail=1

echo "→ KML/KMZ export contents (app.js)"
node tests/export.test.js || fail=1

echo "→ server logic (survey_server.py)"
python3 tests/server_test.py || fail=1

if [ $NET -eq 1 ]; then
  echo "→ live imagery sources (network)"
  python3 tests/imagery_test.py || fail=1
else
  echo "→ live imagery sources: skipped (run ./test.sh --net to include)"
fi

echo
[ $fail -eq 0 ] && echo "PASS" || echo "FAIL"
exit $fail
