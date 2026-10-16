# Event Manager report approval requirement

Date: 2026-10-15

## Updated compatibility contract

This section supersedes the approval-only contract below. Existing Event Manager
events in approved stages, and legacy `recorded` events, retain report access.
Newly created events receive a server-controlled `report_approval_required: true`
marker. They require a current approved stage; `recorded` alone does not qualify.
Draft, pending, rejected, revoked and unknown states never qualify, regardless of
age, history or a previously generated report. No date cutoff or data migration
is needed; editing an existing event does not change its policy marker.

Every Event Manager report action displays only **Download Report**, without
inline restriction copy or restriction tooltips. Unavailable actions are disabled
and unclickable. Single and bulk API authorization, complete-selection validation,
customization and section selection remain in place. Non-draft API restrictions
use the generic error `Report unavailable.`; the former Dean-approval sentence
is removed from runtime code. Draft API validation remains compatible.

### Compatibility update validation

- **73 backend tests passed**: `test_event_manager_report_approval`,
  `test_event_manager`, `test_report_section_selection`. New cases cover existing
  eligible events on GET/POST and bulk PDF endpoints, no grandfathering of refused
  or pending events, server-owned policy creation and immutable policy on edits.
  A request supplying `report_approval_required: false` cannot bypass the new rule.
- **163 frontend unit tests passed**, including legacy/new recorded eligibility,
  mixed selections and the authoritative customization reload.
- **119 Chromium checks passed**, covering all Event Manager entry points at
  desktop/mobile sizes, uniform button labels, disabled actions (including forced
  clicks), no restriction text/tooltips, existing recorded and approved PDF
  downloads, existing-event consolidated reports, Dean regressions and typography.
- **30 Postman assertions passed across 10 local HTTP requests**: legacy recorded
  GET/POST, legacy approved, new approved and eligible bulk return PDFs; new draft,
  pending, marked-recorded, revoked and mixed-bulk requests return 400 and no PDF.
  The removed sentence appears in no response. Expected 400 responses produce CLI
  exit 1 while assertions pass. `--no-report-events` prevented workspace publishing.
- Production build and `git diff --check` passed. Focused lint has only the four
  pre-existing load-effect/dependency warnings in My Events and Dashboard.
- Backend HTTP checks use real handlers/PDF generation with in-memory storage and
  test identities. Browser checks use API fixtures. No production database,
  deployment, external email or hosted services were used. Temporary servers were
  stopped after validation. Firefox/WebKit were not rerun.

### Files in this compatibility update

| File | Change |
| --- | --- |
| `backend/app/routers/event_manager.py` | Server-controlled marker on creation and legacy recorded exception in single/bulk validation; generic unavailable error. |
| `frontend/src/utils/eventReportEligibility.js` | Mirror backend policy without overriding pending/refused/draft states with prior report history. |
| `frontend/src/components/common/EventReportButton.jsx` | Uniform Download Report label; native disabled control; remove inline explanations and restriction tooltips. |
| `frontend/src/pages/teacher/TeacherDashboard.jsx` | Use the text report button in Event Manager rows. |
| `frontend/src/pages/teacher/MyEvents.jsx` | Uniform row/bulk labels and no bulk restriction paragraph. |
| `backend/tests/test_event_manager_report_approval.py` | Existing/new eligibility matrix, customized PDFs, immutable new-event policy. |
| `frontend/tests/unit/eventReportEligibility.test.js` | Legacy/new policy and bulk selection cases. |
| `frontend/tests/unit/reportSections.test.js` | Legacy section loading and new-event recheck. |
| `frontend/tests/report-customization.spec.js` | Updated simple disabled states and existing-event download regressions. |
| `docs/EVENT_MANAGER_REPORT_APPROVAL.md` | Revised contract and this validation record. |

Git: `main`, unchanged HEAD `607232cf8d663669ddd56ce3ab45f7740c0bc992`.
The worktree already contained extensive uncommitted changes. A SHA-256 baseline
was taken before this update: only the ten existing files above changed, no files
were added or removed, and all other existing file hashes remain unchanged.
No pull, reset, stash, revert, commit or push was performed. No dependency changes,
bulk data migration or unrelated feature changes were made.

Validation artifacts: `C:\Users\yc993\AppData\Local\Temp\srhu-report-compat-vio54czq`.

## Prior implementation record (superseded by the compatibility contract above)

## Result and contract

Event Manager reports now require current Dean approval before PDF generation. Dashboard, My Events, Event Details and selected-event reports continue through the shared Report Customization modal and the existing PDF builder used by both roles.

| Current event state | Report behavior |
| --- | --- |
| `approved`, `in_progress`, `completed`, `published` | Customization and PDF download enabled. |
| `draft`, including browser-only drafts | Download disabled with a message to submit for Dean approval. |
| Pending review, rejected, revoked, legacy `recorded`, missing or unknown state | Download disabled with a Dean-approval message. |
| Bulk selection containing any blocked event | Entire report blocked; no silent partial selection. |

This requirement supersedes the earlier legacy-recorded exception documented in `REPORT_CUSTOMIZATION_CHANGES.md`. A recorded status, previous generated-report timestamp or historical approval does not substitute for current approval.

The existing authenticated endpoints and customization payloads remain:

- `GET` / `POST /event-manager/events/{event_id}/report`
- `POST /event-manager/reports` with `event_ids` and optional `customization`

Both entry points return HTTP 400 before reading report content, building a PDF or writing report status if any event is ineligible. Drafts retain the existing message:

> Draft events cannot be included in the report. Please select only non-draft events to generate the report.

Other blocked states return:

> Reports can be generated only after the Dean has approved the event.

Ownership and role checks are unchanged. The shared backend `APPROVED_STAGES` and corresponding frontend status helper define eligible stages. Dean endpoints and the event approval lifecycle were not changed.

## Frontend behavior

- A shared EventReportButton keeps blocked report options visible and disabled, with an inline explanation, tooltip and accessible description.
- The frontend applies the same rule to single and bulk selection, preserving the full selected set.
- Opening customization reloads the event and rechecks its current approval state. Stale approved list data cannot enable generation after revocation.
- Backend approval rejections during customization appear in the modal and disable further generation. Closing/reopening reloads availability.
- Section selection, missing-data disabling, photo choices, responsive styling and PDF delivery retain their existing behavior. Teacher report controls remain absent, as before.

## Files changed in this task

| File | Purpose |
| --- | --- |
| `backend/app/routers/event_manager.py` | Require approved stages before every single/bulk PDF build; preserve draft validation text. |
| `frontend/src/utils/eventReportEligibility.js` (new) | Shared single/bulk eligibility and messages. |
| `frontend/src/components/common/EventReportButton.jsx` (new) | Consistent disabled report controls and visible explanations. |
| `frontend/src/pages/teacher/TeacherDashboard.jsx` | Apply the rule to Event Manager dashboard row actions. |
| `frontend/src/pages/teacher/MyEvents.jsx` | Apply it to row and bulk actions; block mixed selections without dropping events. |
| `frontend/src/pages/teacher/EventDetails.jsx` | Apply it to report opening and execution. |
| `frontend/src/services/reportSections.js` | Recheck saved approval when loading Event Manager customization. |
| `frontend/src/components/common/ReportCustomizationModal.jsx` | Disable generation after a backend approval rejection. |
| `backend/tests/test_event_manager_report_approval.py` (new) | Endpoint state matrix, bulk atomicity, ownership/role checks, and real Dean approval/revocation transitions using in-memory collections. |
| `backend/tests/test_event_manager.py` | Report fixtures now explicitly enter the approved state; submission still becomes pending. |
| `backend/tests/test_report_section_selection.py` | Use approved Event Manager fixtures for PDF-content tests. |
| `frontend/tests/unit/eventReportEligibility.test.js` (new) | Approval-stage, blocked-state, stale-report, browser-draft and mixed-selection tests. |
| `frontend/tests/unit/reportSections.test.js` | Approved fixture and stale-approval loading check. |
| `frontend/tests/report-customization.spec.js` | Updated approved fixtures and 38 added browser cases for blocked states, mixed selection and approval changes. |
| `docs/EVENT_MANAGER_REPORT_APPROVAL.md` (new) | This implementation and validation record. |

## Validation

- **157 frontend unit tests passed**, across 16 files.
- **70 focused backend tests passed**: `tests.test_event_manager_report_approval`, `tests.test_event_manager`, and `tests.test_report_section_selection`.
- The seven new backend test methods include subtests for 12 blocked states against both single-report methods and mixed bulk requests, approved-stage downloads, prior-report revocation, and authorization.
- The integration test exercises real Dean approve/revoke handlers: pending report denied; manager self-approval denied; Dean approval succeeds; customized PDF succeeds; revocation invalidates the report and disables further downloads.
- **58 Chromium report cases passed** at 1440px and 390px, including all report entry points, disabled reasons, mixed bulk selections, stale approval before/during customization, approved downstream stages, retries, section choices and downloads.
- **48 existing Chromium typography cases passed**, including Dean, Event Manager, Teacher/Super Admin isolation, Gallery navigation and light/dark dialogs. Total browser checks: **106 passed**.
- **24 Postman assertions passed across eight local HTTP requests**: approved GET/POST/bulk return PDF bytes; draft/pending/recorded/revoked/mixed-bulk calls return the expected validation message and no PDF. Expected-400 requests have CLI exit 1 despite all three assertions passing; successful requests have exit 0. Tests used `--no-report-events` and published no workspace results.
- Production build passed with **750 modules**, using a separate temporary output directory to avoid the earlier Windows lock in `frontend/dist`.
- Scoped Oxlint passed; the three existing page load-effect warnings and missing-dependency warnings remain unrelated and unchanged. New shared report code and tests have no lint warnings.
- Representative mobile/desktop disabled-state screenshots were visually reviewed. Browser tests asserted that the document did not overflow horizontally.
- `git diff --check` passed.

All backend tests and the loopback HTTP fixture use in-memory collections and test identities; no production database, email or hosted services were used. Browser interaction checks use isolated API-shaped fixtures. Production and Firefox/WebKit were not retested for this change.

## Git safety

Branch `main`, HEAD `607232cf8d663669ddd56ce3ab45f7740c0bc992`. Before editing, the dirty worktree and 362 existing nonignored files were inventoried. The ten existing files listed above changed; no existing nonignored files were removed. Prior Gallery/Research integration, report customization, typography and compact Dean KPI work remain intact.

No commits, pushes, resets, reverts, stashes, dependency changes or database schema changes were made. Existing historical test failures documented in the previous report were not modified or represented as fixed; the focused suites listed here pass.

Initial status, logs, screenshots and build artifacts: `C:\Users\yc993\AppData\Local\Temp\srhu-report-approval-e1f434db`.

## Commands

From `frontend`:

```powershell
npm run test:unit
$env:PW_BASE_URL = 'http://127.0.0.1:5183'
node node_modules/@playwright/test/cli.js test tests/report-customization.spec.js tests/panel-typography.spec.js --project=chromium --workers=2 --reporter=list
```

From `backend`:

```powershell
python -m unittest tests.test_event_manager_report_approval tests.test_event_manager tests.test_report_section_selection -q
```

No implementation blockers remain. Changes are uncommitted for review.
