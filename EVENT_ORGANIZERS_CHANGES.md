# Multiple Event Manager organizers

Date: 16 October 2026 (Asia/Calcutta). No commit or push performed.

## Behavior and compatibility

The Event Manager Create/Edit Event form now selects one or more organizers
using the existing coordinator directory combobox. Each selected name appears
as a removable chip. Guest organizers can be added by name; the existing
optional contact number and Save to directory flow remain available. Selecting
additional organizers does not overwrite the first automatically filled contact
or a manually entered contact. The Teacher form retains its single-name input.

At least one organizer is required for a complete event. The frontend blocks
progress with no selection, and both create/edit APIs reject empty arrays,
blank names and invalid types. Names are trimmed and deduplicated without
changing their selected order. Requests permit up to 20 organizers, each at
most 120 characters; the combined label may exceed the former single-name
120-character limit. The existing partial local-draft behavior remains intact.

The Manager API accepts an additive `organizers` array. It is authoritative
when both representations are supplied. MongoDB event documents retain the
ordered array and a canonical `organizer` string joined with `; `. Existing
detail pages, searches, exports and PDF readers therefore retain their string
contract and display all selected names. No backfill or schema migration is
needed. A legacy request containing only `organizer` is accepted as one name;
an existing event without the array opens as one selection, without splitting
punctuation inside names. Browser drafts and duplicate-event drafts preserve
the array. The shared event reader prefers the array when it is present.

Manager bulk submission validates against the same extended request schema,
so a valid combined label longer than 120 characters can still be submitted.
Teacher validation, ownership, approval restrictions, report customization and
event lifecycle rules remain unchanged.

## Files changed for this feature

| File | Reason |
| --- | --- |
| `backend/app/schemas/event_manager.py` | Manager-only multiple-organizer contract, limits, normalization and legacy compatibility. |
| `backend/app/schemas/events.py` | Let stored-draft validation use the caller's request schema; Teacher default unchanged. |
| `backend/app/routers/event_manager.py` | Persist array/display string on create/edit and validate bulk drafts consistently. |
| `frontend/src/components/common/OrganizerPicker.jsx` | Directory/guest selection, removable chips and name/count validation, using the existing combobox/styles. |
| `frontend/src/utils/organizers.js` | Shared normalization, display label and legacy loading. |
| `frontend/src/pages/teacher/CreateEvent.jsx` | Enable multiple selection only for the Manager panel; load/save names and retain optional contact/directory behavior. |
| `frontend/src/utils/draftStorage.js` | Preserve selected arrays in browser drafts and duplicated events. |
| `frontend/src/utils/eventFields.js` | Display the full organizer array through the existing shared field reader. |
| `backend/tests/test_event_organizers.py` | API persistence, legacy/edit validation, ownership, bulk submission and PDF regressions. |
| `backend/tests/organizer_browser_server.py` | Isolated real-route/auth workflow fixture with all collections in memory. |
| `frontend/tests/event-organizers.spec.js` | Desktop/mobile create/edit/reload, required selection, directory behavior, both-role details/PDFs and Teacher regression. |
| `frontend/tests/unit/organizers.test.js` | Name order/deduplication, legacy punctuation, full display and fallback. |
| `EVENT_ORGANIZERS_CHANGES.md` | Contract, implementation, verification and remaining issues. |

The preceding performance work is separately recorded in `docs/PERFORMANCE_AUDIT.md`.

## Verification

- **89 focused backend tests passed**: new organizer cases, Event Manager,
  report approval, report sections and download recovery.
- **172 frontend unit tests passed**.
- **126 browser checks passed**: seven organizer workflow checks plus 119
  existing typography/report regressions, including desktop/mobile coverage.
- Browser-generated Manager and Dean PDFs were downloaded, parsed and rendered.
  Both contain **Dr. Rao, Dr. Verma and Guest Organizer**; the rendered organizer
  row was inspected. Report customization still precedes both downloads.
- **8 Postman assertions passed across 4 requests**: normalized create, empty
  selection rejected with 422, stored selection read-back and Teacher denial
  with 403. Expected error responses yield CLI exit 1 while assertions pass.
- **85 additional shared backend tests passed; 2 time-dependent cases skipped**:
  approval workflow, Dean visibility, event/type/directory validation. Skips
  concern tests requiring an earlier hour at the start of the local day.
- Production build and `git diff --check` passed. Scoped lint has no errors;
  existing unused-helper, callback-dependency and state-in-effect warnings were
  left outside this feature's scope.

The test servers close the real Mongo client and replace all collection handles;
all create/edit/delete/report metadata writes are disposable in-memory writes.
No live user events, uploads or coordinator records were altered. Browser/API
logs, downloaded PDFs and screenshots are under
`C:\Users\yc993\AppData\Local\Temp\srhu-performance-lvh54cxt`.

## Separate existing test expectation mismatches

A wider 202-test backend run produced **197 passes, 3 failures and 2 skips**.
The failures are separate from organizer validation:

1. `test_bulk_drafts.BulkDraftTests.test_event_manager_bulk_record` expects the
   former `recorded` state; the existing approval workflow produces `pending`.
   This pending behavior was present during the initial source inspection and
   was preserved.
2. `test_event_report.GenerateWithoutSocialLinkTests.test_generated_body_says_not_provided`
   expects placeholder text that the current optional-section implementation
   omits.
3. `test_event_report.ReportAttachmentChoiceTests.test_empty_description_still_has_its_section`
   expects an empty description section that the current implementation omits.

The report builder/router hashes match the start-of-audit baseline. Those report
output behaviors were not changed here. These expectations were documented
without changing unrelated approval/report behavior or weakening the tests.
Firefox/WebKit and live production writes were not tested.
