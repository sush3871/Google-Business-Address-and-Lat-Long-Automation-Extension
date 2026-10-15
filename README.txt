Store Coordinate Batch for Chrome — v5.2.0

UPDATE
1. Finish or pause the old run and download its results.
2. Extract this ZIP. Replace files in the EXISTING unpacked-extension folder.
3. In the ICICI Chrome profile, open chrome://extensions and click Reload.
4. Refresh Business Manager and reopen the extension dashboard.
5. Keep queue/history. For a previously completed ATM whose pin/details are wrong,
   use its Queue again button to explicitly permit a new update. Completed saves
   are never repeated merely because Google's display is delayed.
6. Test a small batch before the full file; download and inspect the Excel results.
For a new install, enable Developer mode and Load unpacked the folder containing
manifest.json. Do not enable two versions simultaneously.

TWO UPDATE OPTIONS
1. Correct name, address, city, state and PIN, then set coordinates.
   Compare each provided field against its own editor control. Save a changed
   business name separately. Enter address lines, state, PIN and city (city last).
   Re-read the location draft to catch autofill overwriting an earlier field.
   Save location details, wait and reopen the location editor before setting the
   requested Excel pin. Address edits invalidate previous pin completion/history
   before Save, so an interrupted address update cannot bypass the final pin step.
   If Google says the address cannot be found, set the pin and submit the address
   and pin together. A missing field is reported and does not suppress coordinates.
   After every ATM has been attempted, perform ONE read-only final check of name,
   all address lines, city, state, PIN and exposed saved coordinate fields.
   The check pass never changes fields or repeats Save.
2. Only set latitude/longitude and check details on the first visit.
   No name/address/city/state/PIN writes and NO automatic second pass.
Option 3 has been removed from the UI and rejected by the run policy. Address
edits can change the pin, so both update modes require valid final coordinates.
A remembered old option 3 is not restored. Choose one of the two current options.
The separate Re-check all ATMs button remains strictly read-only.

FIELD FIXES
- Nested combobox wrappers and inputs count as one control.
- Semantic address autocomplete attributes and more label variants are recognized.
- Editable autocomplete inputs can be typed; readonly dropdowns are selected.
- Native/custom state dropdowns match abbreviations such as MH to Maharashtra.
- State/PIN/city draft values are rechecked after autofill before Save.
- Failures remain visible in per-field results; missing fields are never called OK.
Input column names include Store code, Business name, Street address / Address
line 1, Street address line 2/3, City / Locality, State / Administrative area,
PIN / Postal code, Latitude and Longitude. Existing India-coordinate guard remains.
Line 1 over 80 characters spills into lines 2/3. Overlong total addresses are
reported without truncation. Empty secondary lines are cleared in option 1;
blank primary address/city/state/PIN values do not erase those fields.

COORDINATE FIXES AND VERIFICATION
Both modes explicitly apply the requested geolocation for each ATM and check
that Chrome actually returns that location before using the map. Allow Location
for business.google.com when Chrome asks; denied/incorrect geolocation is logged
as an error and no pin Save is attempted.
The map is activated with the existing drag method and then recentered using
Current location again. The final position is no longer left to two approximate
drags. If exposed numeric draft coordinates disagree by over 2 metres, the tool
stops that submission rather than knowingly saving the wrong position.
A completed Save is a SUBMISSION, not proof of public Google Maps publication.
Some Google layouts do not expose numeric pin fields. In those layouts, exact
pin verification remains UNCONFIRMED. Requested coordinates are never copied
into the Saved latitude/longitude columns as though they were observed.
Option 1's final check reads exposed saved fields until three readings stabilize;
its existing 5-metre result tolerance is retained. Option 2 has no post-save pass;
use Re-check all ATMs manually if you want later saved-coordinate checks.
Delayed or mismatching final checks never trigger automatic updates.

BACKGROUND WINDOW AND STOP / START
The extension uses its own Chrome window. Do not minimize it or interact with
its editor while running. A location permission prompt or map-point calibration
may require your attention. Keep the window visible enough for Chrome to render.
The floating Stop/Start button and dashboard controls preserve the current
business and operation. Changing tabs within the worker window pauses the run;
working in a different window does not. Unknown Save outcomes require the
existing manual review control before retry, preventing duplicate submissions.

VALIDATION
44 local tests: 34 regression cases plus 10 field/coordinate cases, using mocked
Chrome APIs, synthetic field controls and simulated Google responses. Coverage
includes native/custom dropdowns, nested city controls, PIN autofill, save order,
invalidated pin history, geolocation mismatch/denial, map recenter order, rejected
wrong draft pins, two-mode isolation, read-only checks, Stop/Start and Excel export.
Commands: node tests/regression.cjs
          node tests/fields-and-pin.cjs
JavaScript syntax and generated Excel structure also checked.
No signed-in Google Business Manager session was available for live end-to-end
validation. Google layout, map behavior and account-specific permissions still
need a small live test. This ZIP includes source code and tests, without embedded
repository history or generated test-result files.
