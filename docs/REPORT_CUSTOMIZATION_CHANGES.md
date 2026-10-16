# Report customization across Dean and Event Manager panels

Date: 2026-10-15

## Git safety and scope

Branch `main`, HEAD `607232cf8d663669ddd56ce3ab45f7740c0bc992`. The initial worktree contained existing uncommitted Gallery/Research and typography work. A hash inventory of 356 existing nonignored files and the initial Git status were saved before editing. Only the ten existing files listed below changed during this task; no existing nonignored files were removed. No commit, push, reset, revert, stash, dependency upgrade, authentication change, or database schema change was performed.

## Result

Every existing report-download entry point in these two panels opens the same Report Customization modal before requesting a PDF:

- Dean All Events row actions, expanded details drawer, and selected-event/bulk actions, including the shared grouped-list fallbacks.
- Dean Event Details report button.
- Event Manager dashboard row actions, My Events row and selection actions, and Event Details.

All seven section cards remain visible. They start selected only when the saved event data supports them. Unavailable sections are unchecked, disabled, and explain why. Select All cannot enable missing sections, Deselect All disables PDF generation, and a failed availability request blocks generation with Retry/Cancel controls. Closing and reopening the modal resets the choices and reloads saved data.

Availability uses existing authenticated detail/upload APIs rather than incomplete list rows. At most five events are loaded concurrently. The Event Manager detail API includes uploads; Dean uploads use their existing separate media/documents routes. Request cancellation prevents closed dialogs from accepting late results.

| Section | Availability |
| --- | --- |
| Event Details & Organization | Saved basic event information, such as title, type or organizer. |
| Date, Time & Venue | At least one saved date, time or venue. |
| Event Description & Objectives | Nonblank description text after removing the legacy metadata comment. |
| Participation & Social Links | Supplied participant metadata, including zero, or a saved social link. |
| Photographs & Images | Existing photos in the persisted report-photo selection, or the default first four when no choice was saved. An explicitly cleared choice stays empty. |
| Uploaded Notices | Notice documents, including legacy documents without a category. |
| Uploaded Attachments | Report documents, videos, or photo links when photographs are included. The existing rule that excluding photographs also excludes their attachment links is preserved. |

Consolidated reports offer a section when any selected eligible event supplies it. Each event contributes only the supplied content for the selected sections. Missing sections are omitted rather than filled with placeholders. The existing eligible-event filtering and maximum-size handling are preserved.

The existing customization API contract is reused: single-event PDF requests use POST with explicit section flags; bulk requests contain `event_ids` and `customization`. `include_documents` follows the notice/attachment choices. Dean Event Details passes the same flags to both its report-generation and download requests, preventing a stored default report from overriding the new choice.

The PDF no longer includes the basic Event Name row merely because schedule or participation was selected. Customized Event Manager PDFs omit empty optional fields, and customized PDFs omit an empty description even if a caller explicitly requests it. A zero participant count remains valid supplied data. Legacy no-customization behavior, report letterhead/sign-off, approval metadata, authorization and draft-report safeguards are preserved.

A related UI gate was corrected: recorded Event Manager events now expose the report controls as well as the previously supported approved states. This is scoped to report controls; no event lifecycle or approval behavior changed.

The shared modal uses existing Sora/Inter typography, theme tokens, button classes, responsive scrolling and footer styles. Other role screens and their report controls were not changed.

## Files changed

| Existing file | Reason |
| --- | --- |
| `frontend/src/components/common/ReportCustomizationModal.jsx` | Load section availability, disable missing sections, sanitize selection, reset on reopen, show loading/errors/retry and share styling. |
| `frontend/src/hooks/useEventReportDownload.js` | Dean single/bulk download actions now request customization and generate only after confirmation. |
| `frontend/src/components/dean/SubmissionsGroupedList.jsx` | Render the shared modal for fallback row/bulk actions. |
| `frontend/src/pages/dean/AllEvents.jsx` | Render the modal used by row, drawer and selected-event actions. |
| `frontend/src/pages/dean/EventDetails.jsx` | Open customization first; pass selected flags through generation and download; reuse the shared PDF download service. |
| `frontend/src/pages/teacher/TeacherDashboard.jsx` | Event Manager dashboard report button opens customization; show report errors in the modal; support recorded events. |
| `frontend/src/pages/teacher/MyEvents.jsx` | Supply selected event IDs for availability and preserve single/bulk options and draft safeguards; support recorded events. |
| `frontend/src/pages/teacher/EventDetails.jsx` | Supply event ID and role API, show modal errors, and support recorded events. |
| `backend/app/routers/event_manager.py` | Customized report entries omit empty optional fields. |
| `backend/app/services/managed_report_pdf.py` | Respect basic-details exclusion, omit empty customized descriptions, and retain zero participant counts. |

| New file | Reason |
| --- | --- |
| `frontend/src/utils/reportSections.js` | Shared availability and selection rules. |
| `frontend/src/services/reportSections.js` | Load saved event and upload data through existing role APIs. |
| `frontend/tests/unit/reportSections.test.js` | Ten tests for metadata, zero counts, missing data, photo selections, attachment dependencies, consolidated availability and API loading failures. |
| `frontend/tests/report-customization.spec.js` | Twenty browser tests for report entry points, desktop/mobile layouts, disabled selections, downloads, bulk reports, dark theme, uploads, retry/cancel and draft safeguards. |
| `backend/tests/test_report_section_selection.py` | Six real PDF and API regression tests for section exclusion, missing content, zero counts, consolidated output and explicit choices overriding stored defaults. |
| `docs/REPORT_CUSTOMIZATION_CHANGES.md` | This report. |

## Validation

- **139 frontend unit tests passed** across 15 files (`npm run test:unit`).
- **68 Chromium checks passed together:** 20 new report checks plus the existing 48 panel typography checks. The report suite was rerun after the final modal and error-reset adjustments: **20 passed**.
- **104 focused backend tests ran: 102 passed, 2 pre-existing failures.** All six new backend tests passed. The suites exercise the real FastAPI handlers and PDF builder with in-memory collections, including existing report authorization and draft validation.
- Existing backend failures: `GenerateWithoutSocialLinkTests.test_generated_body_says_not_provided` and `ReportAttachmentChoiceTests.test_empty_description_still_has_its_section`. Both were reproduced with the committed baseline PDF implementation loaded in memory, without modifying workspace files. Their old placeholder expectations conflict with existing missing-data behavior; they were not changed to conceal the failures.
- **Production build passed** with 748 modules, using a separate temporary output directory to avoid the previously observed Windows lock in `frontend/dist`.
- New/shared report helpers, modal and tests passed scoped Oxlint without warnings. Broader linting of the touched pages reported existing unused-variable/effect/memoization warnings; unrelated code was preserved.
- **Postman local HTTP checks:** both customized PDF endpoints returned 200 with PDF bytes (three assertions each; exit 0). Empty selection returned the expected 400 and validation message (two assertions passed; CLI exit 1 because of the HTTP error status). No workspace results were published (`--no-report-events`).
- The CLI's raw JSON file/stdin handling differed from its help text. Passing JSON as a direct subprocess argument worked. A sanitized CLI-gap feedback report, containing no project data or credentials, was submitted under the Postman Bootstrap skill.
- PDFs from both role endpoints were extracted and rendered. A schedule-only choice included date/time/venue and excluded basic organizer data, description, participation, photos, notices and attachments. Representative light/mobile and dark modal screenshots were visually reviewed.
- `git diff --check` passed. Existing-file comparison confirmed the ten intended changes and no missing files. Nothing was staged or committed.

Browser interaction tests use isolated in-browser API fixtures. Separate FastAPI/PDF tests and the loopback-only HTTP fixture verify real backend output using in-memory collections. Production data, hosted services and Firefox/WebKit were not exercised. Test PDFs and screenshots are verification artifacts, not changes to user data.

Artifacts and initial status: `C:\Users\yc993\AppData\Local\Temp\srhu-report-customization-415f51a9`.

## Relevant commands

From `frontend`, with the development server at port 5183:

```powershell
npm run test:unit
$env:PW_BASE_URL = 'http://127.0.0.1:5183'
node node_modules/@playwright/test/cli.js test tests/report-customization.spec.js tests/panel-typography.spec.js --project=chromium --workers=2 --reporter=list
```

From `backend`:

```powershell
python -m unittest tests.test_event_report tests.test_event_manager tests.test_report_section_selection -q
```

The two baseline test failures remain documented above. No implementation blockers remain; all changes are uncommitted for review.
