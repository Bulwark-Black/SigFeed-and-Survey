const fs = require("fs");
const path = require("path");

// The app is a set of ES modules under js/. These tests pull individual functions out by name
// and evaluate them, rather than importing, so that a function only ever exported because a test
// wanted it does not quietly widen a module's public surface. Import and export lines are
// stripped: what is under test is the function body, not the module wiring (check.sh verifies
// that the import graph resolves).
// import/export statements wrap across lines, so dropping only the line that STARTS one leaves
// its continuation behind and SRC stops being parseable JavaScript. Track the statement instead.
function wiringFilter() {
  let inWiring = false;
  return (l) => {
    if (!inWiring && !/^\s*(import\s|export\s*\{)/.test(l)) return true;
    inWiring = !/;\s*$/.test(l);      // a wiring statement runs until its semicolon
    return false;
  };
}

const JS_DIR = path.join(__dirname, "..", "js");
const SRC = fs.readdirSync(JS_DIR)
  .filter((f) => f.endsWith(".js"))
  .sort()
  .map((f) => fs.readFileSync(path.join(JS_DIR, f), "utf8"))
  .join("\n")
  .split("\n")
  .filter(wiringFilter())
  .join("\n");

// Brace-balanced extraction. Good enough because every target is a top-level declaration and
// none of them contain a brace inside a string or regex literal.
function grab(name) {
  const decl = "function " + name + "(";
  const i = SRC.indexOf(decl);
  if (i < 0) throw new Error("no js module declares a function named " + name);
  let depth = 0, started = false;
  for (let j = i; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) return SRC.slice(i, j + 1); }
  }
  throw new Error("unbalanced braces in " + name);
}

// Scan to the semicolon that ends the STATEMENT, not the first one encountered — several of
// these consts are IIFEs whose bodies contain semicolons of their own.
function grabConst(name) {
  const m = SRC.match(new RegExp("^const\\s+" + name + "\\s*=", "m"));
  if (!m) throw new Error("no js module declares a const named " + name);
  const start = m.index;
  let depth = 0;
  for (let j = start; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) return SRC.slice(start, j + 1);
  }
  throw new Error("no statement end found for const " + name);
}

let failures = 0;
function ok(cond, msg, extra) {
  console.log((cond ? "    ok   " : "    FAIL ") + msg + (extra ? "  " + extra : ""));
  if (!cond) failures++;
}
function section(name) { console.log("  " + name); }
function done() {
  if (failures) console.log("  " + failures + " failure(s)");
  process.exit(failures ? 1 : 0);
}

module.exports = { SRC, grab, grabConst, ok, section, done };
