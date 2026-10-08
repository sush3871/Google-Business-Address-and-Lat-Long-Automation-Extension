Store Coordinate Batch for Chrome — v4.9.0

INSTALL / UPDATE
1. Extract this ZIP to a permanent folder.
2. Open chrome://extensions and turn on Developer mode.
3. If updating the existing extension, replace the files in its existing folder
   and press Reload on its card. This preserves its queue/history.
   For a new install, choose Load unpacked and select the folder with manifest.json.
4. Refresh the Business Manager page, close any old dashboard tab and reopen the extension. Keep the existing queue/history. Do not Clear queue or Queue again just because
   Google is still showing the old values. Previously saved v4.6 field records
   are honored, even when its old verification marked the row incomplete.
5. Open your business list at business.google.com, sign in, and close editors.

THREE RUN OPTIONS
1) Set coordinates + correct address if not matched
   Sets pending pin coordinates, compares street lines 1–3, locality, state and
   PIN, and saves only mismatched address fields. Addresses can still be processed
   if coordinates were completed earlier. Invalid coordinates are skipped and
   reported; address work can continue.
2) Only set latitude / longitude + check address match
   Saves pending coordinates. Never types or clears address fields. Checks the address during the first visit and saves the coordinates.
   Finishes after the last ATM: NO automatic refresh/revisit/check pass.
   Address checks use the existing list/editor information from that first visit.
3) Only correct address details (no coordinate changes)
   Compares and corrects address fields. Never opens Adjust map, clicks the
   current-location button, or sets a geolocation override. Latitude/Longitude
   columns may be absent or blank.
Business names are read/check-only in all three modes.
Re-check all ATMs runs the same detailed read-only pass again, including rows
checked earlier. It reads name, all address lines, city, state and PIN from the
profile fields. It never saves, types into fields, or moves map pins.

SHEET INPUT
Supported: ODS, CSV, TSV, XLSX. Store code is required. Latitude and Longitude
are required only for coordinate changes. Existing India coordinate guard remains.
Optional: Business name, Street address (or Address line 1), Street address line 2,
Street address line 3, Locality, Administrative area, Postal code.
Line 1 stays in line 1 up to 80 characters; overflow goes into lines 2 and 3.
Supplied lines 2/3 follow the overflow. Addresses exceeding three lines of 80
characters are reported, not truncated or saved. Empty lines 2/3 clear existing
text in address-edit modes; already-empty fields are left alone. Blank primary
address, locality, state and PIN are not used to erase those fields.
Duplicate sheet rows are skipped. One store ID with multiple businesses is still
processed for each matching business. Verification-required listings are skipped.

RESULTS / RESUMING
Option 2 is single-pass. The following two passes apply only to options 1 and 3:
PASS 1: Attempt updates for every eligible ATM before starting any final checks.
PASS 2: Refresh once, revisit all ATMs and read name/address/city/state/PIN only.
Submission completion is separate from verification. A saved change that has not
yet appeared is reported as Not reflected / mismatch, never automatically saved
again. A failed check also cannot reset submission completion. Successfully saved
fields remain protected even if another field failed and needs a later retry.
One mismatched shared business makes the combined check a mismatch. Unreadable
fields are not reported as matches. All street lines participate in verification.
Coordinate status records the submission workflow; it is NOT independent proof
of the final public Google Maps pin. Google may review updates before publication.
In address-only mode, coordinate status is left unchanged (it may say Not done yet).
The exported Run option column distinguishes the chosen operation.
Download Excel for original columns plus checks, previous values, updates,
refreshed values, verification summary and notes. Original input is unchanged.
ON-PAGE STOP / START
A floating ATM batch control appears at the bottom-right of Business Manager.
Stop suspends further browser actions and changes to Start. Start continues the
same live run, business, shared-business target and operation; earlier businesses
are not revisited. Switching tabs or leaving the business window also suspends it.
Return to Business Manager and press Start; returning alone does not resume.
Keep the editor as it is while stopped. A request already sent to Google cannot
be cancelled; resume continues after that request instead of sending Save again.
The dashboard Stop button also toggles to Start / resume current ATM.
Pause after current store retains its separate meaning: finish the current ATM,
then end the run. The saved cursor allows the next Start to continue there.
Current row/target/mode/phase are saved locally. After a worker/browser interruption,
Start resumes from that business, discarding unsaved editor state and repeating
only its unfinished work. If the interruption happened at Save and its outcome
is unknown, the existing I reviewed it control must be used before resuming.
Do not import a new sheet, clear history, or manually change the editor while a
live run is suspended. Completed batches remain completed; Start does not requeue them.
If Save is interrupted, manually review the business and close the editor, then
use I reviewed it before resuming. Never assume an interrupted Save failed.
Queue again reruns a completed store. Clear check results removes only check results; it does not reset update history.
Only explicit Queue again authorizes another update of a completed ATM.
Keep the business tab foreground and avoid manual clicks/scrolling during runs.

NEW IN 4.9
- Floating Stop / Start controls on the Business Manager page.
- Live suspension preserves the exact current business and step.
- Switching tabs/windows pauses instead of treating the business as an error.
- Persistent row/target/phase cursor for interrupted-run recovery.
- UI wait timeouts exclude suspended time.
- Pending Save operations are never replayed merely because Stop was pressed.

NEW IN 4.8
- Coordinate-only mode checks addresses on the first visit and then stops.
- No automatic second pass in option 2. Manual Re-check all ATMs is still available.
- Options 1 and 3 retain their separate post-update read-only check pass.

NEW IN 4.7
- Finish the complete update pass before the separate read-only check pass.
- Never reset saved/completed flags because Google still displays old values.
- Preserve saved fields on partial retries and upgrade from v4.6.
- Re-check all ATMs always checks again, without any mutation.

BUG FIXES RETAINED FROM 4.6
- Explicit, validated run permissions replace the old checkbox/ambiguous buttons.
- Address-only imports no longer require valid coordinate columns.
- Changed coordinates invalidate cached target coordinate completion on reimport.
- Combined mode can complete address work when coordinates are already done.
- Long address verification no longer dereferences a missing expected field.
- Refreshed checks cover all three address lines and all processed businesses.
- Failed/unreadable verification is reported separately from completed submissions.
- Address-only Save interruptions persist a manual-review marker.
- Pause now finishes the current store as the button promises.
- Indian-script addresses are compared as text instead of empty token lists.
- Missing fields are reported in update summaries; export includes run mode.

VALIDATION
21 local regression tests cover run-mode isolation with mocked Chrome/page APIs,
imports, changed-coordinate history, long addresses, shared-business mismatches,
interrupted Save handling, Unicode matching, Excel generation, update/check pass
ordering, coordinate-only completion without a second pass, repeated read-only checks, protection against stale Google values, Stop/Start gates, tab-switch suspension,
same-step continuation and cursor-based restart. JavaScript
syntax checked; generated workbook also opened and verified with openpyxl.
Not live-tested against a signed-in Google Business Manager account. UI selectors
and Google save/review behavior still need verification on your account.
To rerun the included local tests: node tests/regression.cjs
