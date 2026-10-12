Store Coordinate Batch for Chrome — v5.1.1

INSTALL / UPDATE
1. Finish or pause the old extension's run. Download its existing result first.
2. Extract this ZIP to C:\StoreCoordinateBatch. The inner folder contains manifest.json.
3. Use the Chrome profile signed into the ICICI Business Manager account.
4. Open chrome://extensions and turn on Developer mode.
5. For an existing unpacked install, replace the files inside its EXISTING extension
   folder with these files, then click Reload. This preserves its queue/history.
   For a new install, click Load unpacked and select the folder with manifest.json.
   Do not leave two versions enabled at once.
6. Refresh the Business Manager list tab, then open the extension dashboard.
7. Load ATM-pending.xlsx and choose its worksheet. Click Load into queue.
8. Choose option 1: Correct business name + address, then set coordinates.
9. Start. After both passes finish, click Download Excel (.xlsx).

OPTION 1 — ORDER FOR EACH BUSINESS
- Compare and save Business name if it differs.
- Compare Street address lines 1–3, City, State and PIN; change mismatches.
- Save the address form separately, wait 5 seconds, reopen location editing.
- Set the pin to the input Excel Latitude/Longitude, wait 5 seconds for the
  current-location action, finish map positioning, then save and await completion.
- A newly saved address can move a pin completed earlier. Option 1 reapplies
  the requested pin once in that case. A mismatch in the final check never does.
- Move to the next store. Unsupported or failed fields are reported. Incomplete
  address fields are reported. An explicit Google address-not-found warning
  allows the Excel pin correction before address submission.
- After ALL update attempts, refresh once and perform ONE read-only pass over
  name, address lines, city, state and PIN. This pass never types, saves or moves
  a pin. It reports mismatches without retrying updates.

OTHER OPTIONS
2. Set coordinates; check name/address without changing them. One update pass.
3. Correct name and address details; no coordinate changes. Final read-only pass.
Re-check all ATMs repeats only the read-only pass.
Stop / Start suspends and resumes the current operation; switching tabs inside
its worker window pauses it. Do not interact with the worker page during a run.

EXCEL RESULTS AND COORDINATE LIMITATION
Input columns remain unchanged. Additional columns show each field's update,
old value, result after refresh, errors, skips and checks.
Saved latitude / Saved longitude are OBSERVED values, separate from the requested
input coordinates. During the final refreshed check, if Google exposes unique
labelled Latitude and Longitude fields, the extension waits for three stable
readings and reports distance from the requested pin. <=5 metres is OK.
If those fields are unavailable (including map-only editors), it leaves saved
coordinates blank and reports Unconfirmed. It does NOT use map viewport centres,
copy input coordinates as observed values, or claim the actual pin is verified.
Google review/propagation may last longer than this run. A completed Save is a
submission, not proof of public Google Maps publication. Delayed changes remain
mismatches or unconfirmed and never cause an automatic rewrite.
Use the read-only button later to check again without resubmitting changes.
For shared store codes, every profile is identified by its listing link and
gets separate results. Unverified/duplicate/unavailable listings are skipped.

UPGRADE BEHAVIOUR
Old address completion records no longer suppress a missing name update.
Previously submitted fields are not typed again simply because the old value
is still visible. An interrupted name/address Save requires manual review before
resuming, preventing an automatic duplicate submission.

VALIDATION
35 automated regression tests cover run modes, save order, read-only final pass,
name-save interruption, upgrade history, resume, coordinate readback and exports.
Run with Node: node tests/regression.cjs
Live Google Business Manager was not available for end-to-end validation.
Test a small batch first and inspect the field-by-field results.
Source code is included: worker.js, runpolicy.js, dashboard.js, match.js,
sheetio.js, xlsxout.js, page-controls.js and dashboard HTML/CSS.

ADDRESS CANNOT BE FOUND — v5.1.1
If Google shows “Address can’t be found”, option 1 retains the entered address,
sets the Excel latitude/longitude using Adjust map, presses Done, then submits
the address and pin together. The same fallback handles this validation after
an address Save attempt. It never repeats a completed save automatically.
The location-review form's Confirm button is supported as well as Save.
The final read-only check records an address mismatch if it still did not update.
Option 3 still never changes coordinates.
