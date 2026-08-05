// Pull named functions straight out of app.js and evaluate them, so the tests exercise the
// SHIPPED source rather than a copy that can quietly drift out of step with it.
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

// Brace-balanced extraction. Good enough because every target is a top-level declaration and
// none of them contain a brace inside a string or regex literal.
function grab(name) {
  const decl = "function " + name + "(";
  const i = SRC.indexOf(decl);
  if (i < 0) throw new Error("app.js has no function named " + name);
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
  if (!m) throw new Error("app.js has no const named " + name);
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
