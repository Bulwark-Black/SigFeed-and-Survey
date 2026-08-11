#!/bin/bash
# Pre-push sanity checks. No install, no dependencies — just the tools already on the Mac.
#   ./check.sh
# Catches the failure modes a no-build project can't otherwise catch: a syntax error
# in a js module, a $("id") that no longer exists, and an onclick pointing at a deleted function.
# For wrong ANSWERS rather than wrong syntax — coordinate maths, the KMZ writer, auth — see
# ./test.sh.
cd "$(dirname "$0")" || exit 1
fail=0

echo "→ js module syntax"
if command -v node >/dev/null 2>&1; then
  bad=0
  for f in js/*.js; do node --check "$f" || bad=1; done
  [ $bad -eq 0 ] && echo "  ok ($(ls js/*.js | wc -l | tr -d " ") modules)" || fail=1
else
  echo "  (node not installed, skipped)"
fi

echo "→ js module graph resolves (every import has a matching export)"
if command -v node >/dev/null 2>&1; then
  python3 - <<'PYEOF' || fail=1
import re, os, sys
exports, imports = {}, []
for f in sorted(os.listdir("js")):
    if not f.endswith(".js"): continue
    s = open("js/" + f, encoding="utf-8").read()
    ex = set()
    for m in re.finditer(r'export \{([^}]*)\}', s, re.S):
        ex |= {x.strip() for x in m.group(1).split(",") if x.strip()}
    exports[f[:-3]] = ex
    for m in re.finditer(r'import \{([^}]*)\} from "\./(\w+)\.js"', s, re.S):
        for n in (x.strip() for x in m.group(1).split(",")):
            if n: imports.append((f[:-3], m.group(2), n))
missing = [(a, b, n) for a, b, n in imports if n not in exports.get(b, set())]
print("  MISSING: " + ", ".join("%s wants %s from %s" % (a, n, b) for a, b, n in missing)
      if missing else "  ok (%d imports checked)" % len(imports))
sys.exit(1 if missing else 0)
PYEOF
fi

echo "→ js modules using a shared name they never imported, or assigning to an imported one"
python3 - <<'PYEOF' || fail=1
import re, os, sys
# Two ways a module can name something it cannot actually use, both invisible to node --check.
#
# Moving a function between modules without its dependencies leaves a free variable. Module
# scope is strict, so it throws at runtime, and a caller's own try/catch can swallow it into a
# misleading message. Nothing else here catches that: the import graph resolves fine.
#
# And an imported binding is read-only. `points = x` in an importing module parses cleanly and
# throws TypeError only on the line that runs, so a write missed by the setter-table rewrite
# reaches the nearest catch instead of a checker. poll()'s catch turns one into "Backend
# offline. Is the server running?" against a healthy server. This is the check that makes the
# `set.*` asymmetry in state.js actually load-bearing.
WRITE = r"\s*(?:=(?![=>])|[+\-*/%&|^]=|\*\*=|<<=|>>>?=|&&=|\|\|=|\?\?=|\+\+|--)"
def blank(src):
    out = list(src); i = 0; n = len(src)
    while i < n:
        c = src[i]
        if c == "/" and i+1 < n and src[i+1] == "/":
            j = src.find("\n", i); j = n if j < 0 else j
            for k in range(i, j): out[k] = " "
            i = j; continue
        if c == "/" and i+1 < n and src[i+1] == "*":
            j = src.find("*/", i+2); j = n if j < 0 else j+2
            for k in range(i, j):
                if src[k] != "\n": out[k] = " "
            i = j; continue
        if c in "\"'`":
            q = c; j = i+1
            while j < n:
                if src[j] == "\\": j += 2; continue
                if src[j] == q: j += 1; break
                if src[j] != "\n": out[j] = " "
                j += 1
            i = j; continue
        i += 1
    return "".join(out)

state = open("js/state.js").read()
m = re.search(r"export \{([^}]*)\};\s*$", state, re.S)
shared = {x.strip() for x in m.group(1).split(",") if x.strip()}
bad = []
nimp = 0
for f in sorted(os.listdir("js")):
    if not f.endswith(".js") or f == "state.js": continue
    src = open("js/" + f).read(); b = blank(src)
    imported = set()
    for im in re.finditer(r"import \{([^}]*)\} from", src, re.S):
        imported |= {x.strip() for x in im.group(1).split(",") if x.strip()}
    nimp += len(imported)
    declared = set(re.findall(r"^(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z0-9_$]+)", src, re.M))
    declared |= set(re.findall(r"(?:^|[;{(\s])(?:let|const|var)\s+([A-Za-z0-9_$]+)", b))
    for n in shared:
        if n in imported or n in declared: continue
        if re.search(r"(?<![.\w$])" + re.escape(n) + r"(?![\w$])", b):
            bad.append("%s uses %s" % (f, n))
    for n in sorted(imported):
        for w in re.finditer(r"(?<![.\w$])" + re.escape(n) + WRITE, b):
            bad.append("%s:%d assigns %s" % (f, b.count("\n", 0, w.start()) + 1, n))
print("  MISSING: " + ", ".join(bad) if bad
      else "  ok (%d shared names, %d imported bindings checked)" % (len(shared), nimp))
sys.exit(1 if bad else 0)
PYEOF

echo "→ python syntax"
# survey_server.py is now 327 of ~1650 lines; the package holds the rest, so compiling only the
# entry point checked a fifth of the back end.
if python3 -m py_compile survey_server.py wifisurvey/*.py tests/*.py; then
  echo "  ok ($(ls survey_server.py wifisurvey/*.py tests/*.py | wc -l | tr -d " ") files)"
else fail=1; fi
rm -rf __pycache__

echo "→ DOM ids referenced by the js modules but missing from the HTML"
python3 - <<'PY' || fail=1
import re, sys, os
js = "".join(open("js/"+f).read() for f in sorted(os.listdir("js")) if f.endswith(".js"))
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
import re, sys, os
js   = "".join(open("js/"+f).read() for f in sorted(os.listdir("js")) if f.endswith(".js"))
html = open("dashboard.html").read()
# Only what main.js puts on window is reachable from an inline handler. Matching any module
# function instead would accept ~200 names the browser cannot resolve, which is how a missing
# cancelLevelName survived: Escape during a floor rename threw ReferenceError.
main = open("js/main.js").read()
o = main.index("{", main.index("Object.assign(window, {"))
d = 0
for c in range(o, len(main)):
    if main[c] == "{": d += 1
    elif main[c] == "}":
        d -= 1
        if d == 0: break
else:
    sys.exit("  main.js: unterminated Object.assign(window, {...})")
block = re.sub(r"//[^\n]*", "", main[o+1:c])
defined = {n for n in (e.split(":")[0].strip() for e in block.split(","))
           if re.fullmatch(r"[A-Za-z0-9_$]+", n)}
called = set()
# Handlers are written in two places: the static HTML, and template strings inside the modules
# that build rows and tabs at runtime. Scanning only the HTML is why a missing cancelLevelName
# went unnoticed until someone pressed Escape mid-rename.
js_nc = re.sub(r"//[^\n]*", "", js)          # a comment showing onclick="foo()" is not a handler
# ${...} inside an attribute is evaluated while the markup is BUILT, not when it is clicked,
# so esc()/rate() in there are ordinary module calls and need no window exposure
js_nc = re.sub(r"\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", "0", js_nc)
# capture to the closing double quote: these handlers contain single quotes ('Enter'), so a
# class excluding them truncates the attribute before the function name is reached
for attr in re.findall(r'\son[a-z]+=\\?"([^"]*)"', js_nc):
    called |= set(re.findall(r'(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(', attr))
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
import re, os
html = open("dashboard.html").read()
style, body = html.split("</style>")[0], html.split("</style>")[1] + "".join(open("js/"+f).read() for f in sorted(os.listdir("js")) if f.endswith(".js"))
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
