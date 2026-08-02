#!/bin/bash
# Pre-push sanity checks. No install, no dependencies — just the tools already on the Mac.
#   ./check.sh
# Catches the failure modes a no-build project can't otherwise catch: a syntax error
# in app.js, a $("id") that no longer exists, and an onclick pointing at a deleted function.
cd "$(dirname "$0")" || exit 1
fail=0

echo "→ app.js syntax"
if command -v node >/dev/null 2>&1; then
  node --check app.js && echo "  ok" || fail=1
else
  echo "  (node not installed — skipped)"
fi

echo "→ survey_server.py syntax"
if python3 -m py_compile survey_server.py; then echo "  ok"; else fail=1; fi
rm -rf __pycache__

echo "→ DOM ids referenced by app.js but missing from the HTML"
python3 - <<'PY' || fail=1
import re, sys
js = open("app.js").read()
html = open("dashboard.html").read() + open("run-sheet.html").read()
have  = set(re.findall(r'id="([^"]+)"', html))
have |= set(re.findall(r'''\.id\s*=\s*["']([A-Za-z0-9_-]+)''', js))  # created at runtime
have |= set(re.findall(r'''id=\\?["']([A-Za-z0-9_-]+)''', js))       # built in innerHTML strings
want = set(re.findall(r'\$\("([^"]+)"\)', js))
missing = sorted(want - have)
print("  MISSING: " + ", ".join(missing) if missing else "  ok (%d ids checked)" % len(want))
sys.exit(1 if missing else 0)
PY

echo "→ inline handlers pointing at functions that don't exist"
python3 - <<'PY' || fail=1
import re, sys
js   = open("app.js").read()
html = open("dashboard.html").read()
defined  = set(re.findall(r'function\s+([A-Za-z0-9_$]+)', js))
defined |= set(re.findall(r'(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function|\()', js))
called = set()
for attr in re.findall(r'\son[a-z]+="([^"]+)"', html):
    # bare calls only — skip method calls (preceded by a dot) and JS keywords
    called |= set(re.findall(r'(?<![.\w])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(', attr))
builtin = {"if","for","while","return","this","alert","confirm","prompt","parseInt",
           "parseFloat","Number","String","Boolean","Array","Object","JSON","Math","event"}
missing = sorted(c for c in called - defined - builtin if not hasattr(__builtins__, c))
missing = [m for m in missing if m not in dir(__import__("builtins"))]
print("  MISSING: " + ", ".join(missing) if missing else "  ok (%d handlers checked)" % len(called))
sys.exit(1 if missing else 0)
PY

echo "→ CSS classes styled but never referenced"
python3 - <<'PY'
import re
html = open("dashboard.html").read()
style, body = html.split("</style>")[0], html.split("</style>")[1] + open("app.js").read()
styled = set(re.findall(r'\.([a-z][a-z0-9-]{2,})(?=[\s,{:.\[])', style))
# every token that appears in any class="..." / classList call / template literal
used = set()
for chunk in re.findall(r'class(?:Name)?\s*=\s*["\'`]([^"\'`]*)', body):
    used |= set(chunk.split())
for m in re.findall(r'classList\.[a-z]+\(([^)]*)\)', body):
    used |= set(re.findall(r'[A-Za-z0-9_-]+', m))
used |= set(re.findall(r'["\'`]([a-z][a-z0-9-]{2,})["\'`]', body))
dead = sorted(c for c in styled - used if c not in ("hidden", "on"))
print("  %d orphan candidate(s)%s" % (len(dead), (": " + ", ".join(dead)) if dead else ""))
PY

[ $fail -eq 0 ] && echo "PASS" || echo "FAIL"
exit $fail
