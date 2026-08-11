# Corrections

This project has published statements that were not true. They are recorded here
rather than quietly removed, because a tool whose whole job is to put honest
numbers in front of a paying client should be honest about its own.

Every entry below has been fixed in the working tree. Where a commit message was
also wrong, it has been corrected in place and the original wording is quoted
here so the record survives the rewrite.

---

## 1. Fabricated accuracy measurements (README)

**Introduced in `91290ea`. Removed in `5cf1f36`.**

The README said:

> Those are real measurements, not estimates: flat Missouri farmland came out at
> 0.6 ft, a wooded Florida suburb at 24 ft, and a Colorado mountainside at 50 ft.

**This was false. No field measurements were ever taken.** The three figures are
unit-test fixtures:

| README claim | Actual source |
|---|---|
| 0.6 ft | `worst_m: 0.19` in `tests/credit.test.js` |
| 24 ft | `worst_m: 7.35` in `tests/credit.test.js` |
| 50 ft | `worst_m: 15.2` in `tests/credit.test.js` |

converted at 3.28084 ft/m. "Missouri farmland" and "Florida suburb" were labels
on NAIP coverage-probe boxes in `tests/imagery_test.py`. **"Colorado" appeared
nowhere in the repository at all.**

The 0.6 ft figure could never have come from a real capture: the code reports
anything at or under 5 ft as the bound "under 5 ft" and never prints a
sub-5-foot number.

The commit message for `91290ea` repeated the claim, saying the accuracy table
was "measured, not estimated" with the same three figures.

**What is true:** the accuracy figure is measured per capture. Google Earth is
probed on a 9x9 grid (81 terrain points across the frame), a Mercator box is
fitted to the corners, and the reported number is the worst residual between a
probe's true position and where the fitted box predicts it. That mechanism is
real and is what the README now describes. No field validation figures are
published, because none were taken.

The test fixtures have since been relabelled with terrain descriptions instead of
place names, so they cannot be mistaken for field sites again.

---

## 2. Overstated safety claim about ES module bindings

**Introduced in `51f1871`, repeated in `b01307e`. Corrected in `0910c58`.**

Both commit messages, and a comment in `js/state.js`, claimed that assigning to
an imported binding produces **"a hard parse error"**, and that this made a
missed state write impossible to ship.

**This was false.** An imported binding is read-only, but `points = x` still
parses. `node --check` exits 0 on it. V8 raises a `TypeError` only on the line
that runs, and most state writes in this codebase sit inside a `try/catch`, so a
missed write was swallowed. In `poll()` it surfaced as "Backend offline. Is the
server running?" against a perfectly healthy server, with nothing logged.

The 20 missed writes that were genuinely caught during the split were caught by
the free-variable check, which is a different mechanism.

**What is true:** the setter table is a convention that gives every write to
shared state one greppable shape. It is not self-enforcing. `check.sh` now
enforces it with a check that flags assignment to an imported binding, and that
check was verified by reintroducing the fault.

---

## 3. Claims about NAIP capture dates

**Fixed in `5cf1f36` and the commit that follows this file.**

The README, a comment in `js/basemap.js`, and a header comment in
`wifisurvey/imagery.py` all said the NAIP source "carries a real capture date"
and that the tool prints it.

**This was false.** The NAIP request is `f=image`, which returns rendered pixels
and no metadata. Nothing in the code has ever known when NAIP imagery was flown,
and no date is stored, displayed, or printed for it.

Related: for a **Google Earth** base map the report does print a date, but that
date is when the capture was run, taken from the Mac's clock. It is not when the
imagery was flown. The docs now say so explicitly.

---

## 4. False statements in the generated client report

**Fixed in the commit that adds this file.**

These printed into the PDF handed to a paying client.

- **LTE data labelled as 5G.** When the gateway reported no 5G signal, the
  findings fell back to the LTE SINR but still printed it under the label
  "5G SINR". The label now follows the number.
- **A tolerance the capture did not meet.** The stated positional accuracy was
  rounded to whole feet *before* being compared against the 5 ft threshold, so a
  capture measured at 5.4 ft printed as "accurate to under 5 ft". The comparison
  now uses the unrounded value.
- **"Adding an AP won't help."** Given for low-SNR findings. A closer access
  point does raise the signal; it just cannot lower the noise. Reworded.
- **"Every room we surveyed has reliable coverage."** Printed whenever zero
  readings fell below the dead-zone threshold, which is not the same claim.
- **"of the home covered well."** Labelled two different figures, neither of
  which knows anything about the parts of the home nobody walked.
- **"The RF environment is clean."** Printed when no neighbour shared the exact
  surveyed channel. Adjacent-channel overlap and non-Wi-Fi interference are not
  assessed at all.
- **"Relief measured across N ft of ground and tree height."** The probe grid
  samples bare terrain only. It never touches a canopy.
- **A methodology paragraph** asserting one reading per room at a device height
  of about 1 m. The app neither enforces nor records either.
- **A map legend** stating that routers are marked with a 📡 symbol. They are
  drawn as a blue dot with a name label.

---

## 5. Other corrected claims

- `survey_server.py` described the JSON content-type check as blocking
  cross-origin form posts. It does not: `text/plain` is CORS-safelisted and is
  accepted, and a request with no `Content-Type` skips the check entirely. It is
  a typo guard. The API key is what actually stops a cross-origin POST.
- `wifisurvey/live.py` said the loader file carries "the current run's key". It
  carries the persistent `LIVE_TOKEN`, and that persistence is precisely what
  keeps Google Earth working across a restart.
- `js/cellular.js` said both grade palettes "pass AA on the surface they are
  for". The print palette's Good green is 4.08:1 on white, below the 4.5:1
  threshold at the sizes actually used.
- `js/earth.js` cited a 1 MiB body cap for the live push. That route's cap is
  8 MiB. It also carried a stale comment claiming that floating the overlay above
  the canopy keeps it visible, directly contradicting the measured finding
  recorded immediately below it.
- `js/core.js` said the speed dial's needle "never pegs". Above 2000 Mbps it does.
- The in-app Guide said this app is "not cellular". It has a full cellular page
  that feeds the score and prints an antenna-placement table into the PDF.
- The printable run sheet told the user to leave the app in "Easy mode", a
  control that no longer exists.
- `PLAN-aerial-and-earth.md` presented a one-off manual georeference check as if
  it were reproducible, and quoted a ground-width figure that did not match the
  frame it described.

---

## How this is meant to be prevented

`./check.sh` and `./test.sh` catch broken code and wrong answers. Neither can
catch a confident sentence, which is why both problems above survived multiple
commits.

The working rule now: a number, a place, a measurement, or a safety property does
not go into documentation, a comment, a commit message, or the client report
until it has been traced to the code or the test that produces it. If it came
from a fixture, it is labelled as a fixture. If a claim asserts that something is
enforced or impossible, the failure case gets executed to prove it.
