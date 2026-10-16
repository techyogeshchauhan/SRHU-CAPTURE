# Event Manager event type management

Contract: existing `GET /event-types` and `POST /event-types` remain compatible.
All new endpoints require an authenticated Event Manager. Only the creator of
a custom type may rename or delete it. Built-in types are protected.

| Method and path | Request | Successful response |
| --- | --- | --- |
| GET `/event-types/manage` | none | `event_types`: records with `id`, `name`, `is_default`, `can_manage` |
| GET `/event-types/{id}/usage` | none | `total`, `teacher_events`, `managed_events` |
| PATCH `/event-types/{id}` | `{"name":"New name"}` | previous names, canonical `event_type`, `events_moved`, refreshed `event_types` |
| DELETE `/event-types/{id}` | `{"destination_id":"existing-id"}` or `{"destination_id":null}` for Uncategorized | previous names, destination `event_type`, `events_moved`, refreshed `event_types` |

The delete destination field is mandatory. A destination must exist and differ
from the source. Names follow the existing 60-character validation. Errors:
401 unauthenticated; 403 wrong role, non-owner, or protected type; 404 unknown
type/destination; 409 duplicate name, invalid destination, or concurrent change;
422 invalid request; 503 database/transaction support unavailable.

Renaming preserves associations; deletion moves **all** matching server events,
including drafts and archived events, across the shared Teacher and Event Manager
collections. Events, files, ownership, approval status and history are preserved.
The move and catalog change commit in one MongoDB transaction. MongoDB must be a
replica set or sharded deployment; on a standalone server management fails safely
without partial reassignment or deletion. Existing event saves remain supported.

Historical names are retained as catalog aliases so stale forms and browser-local
drafts resolve to the current destination on save. Event writes participate in
the catalog transaction lock to prevent concurrent saves orphaning associations.
Local-only drafts are not counted or rewritten on the server.

The Event Manager's event form exposes management beside the existing type picker.
The shared modal requires an explicit destination and confirmation before deletion.
Frontend cache refreshes after a successful change; errors leave the modal open.

## Git safety and scope

- Baseline: `607232cf8d663669ddd56ce3ab45f7740c0bc992` on `main`
  (`feat: add schemas for report customization and managed report PDF generation service no. of participint`).
- Initial status: 108 entries, including existing Gallery, Research, report,
  typography and other work. That work was inspected and preserved. No pull,
  reset, stash, clean, revert, commit or push was performed for this task.
- Before editing, SHA-256 hashes were recorded for every existing nonignored
  tracked/untracked file. Final comparison: only the eight existing files below
  changed; five files were added; no existing file disappeared. All other file
  hashes remain unchanged. HEAD is still the baseline commit.
- No dependencies, authentication rules, global styles, or database connection
  settings were changed. Optional catalog fields `aliases` and `usage_revision`
  support historical names and concurrent saves; no schema migration is needed.

## Files changed

| File | Reason |
| --- | --- |
| `backend/app/routers/directory.py` | Authenticated management, usage, rename and delete routes; explicit creation fails if the type cannot persist; reserve Uncategorized. |
| `backend/app/services/event_type_management.py` (new) | Owner/default validation; cross-collection atomic reassignment, completeness check, rollback, destination validation. |
| `backend/app/services/event_types.py` | Historical name resolution and transaction-aware catalog locking for event saves. |
| `backend/app/routers/event_manager.py` | Join catalog locking when creating/updating an event, retaining existing approval rules. |
| `backend/app/routers/events.py` | Same locking for Teacher saves because both roles use the shared catalog; optional session in the existing update helper. |
| `frontend/src/components/common/ManageEventTypesModal.jsx` (new) | Shared styled management modal, edit validation, usage loading/retry, mandatory destination and deletion confirmation. |
| `frontend/src/components/common/EventTypeSelect.jsx` | Management entry point and update the current selection after successful changes. |
| `frontend/src/pages/teacher/CreateEvent.jsx` | Enable management only for the Event Manager panel in the reused event form. |
| `frontend/src/services/directory.js` | New API calls and shared catalog cache refresh after successful changes. |
| `frontend/src/hooks/useEventTypes.js` | Keep mounted dropdowns/filters synchronized with the refreshed catalog. |
| `backend/tests/test_event_type_management.py` (new) | Disposable replica-set integration and authenticated API tests. |
| `frontend/tests/event-type-management.spec.js` (new) | Opt-in browser tests using a disposable account and real API; a failed-delete response is simulated in one test. |
| `docs/EVENT_TYPE_MANAGEMENT.md` (new) | API contract, safety, implementation, validation and operational limits. |

## Validation (2026-10-15)

All database mutations used an isolated local MongoDB 8.0 replica set on port
27028, with disposable databases. The configured application database was not
used. Browser testing used separate API/Vite processes on ports 8766/5183.

- Backend regression: **158 passed** across `test_event_types`,
  `test_event_type_management`, `test_event_manager`, `test_event_lifecycle`,
  `test_event_history`, `test_event_mandatory_uploads`,
  `test_event_manager_report_approval`, and `test_report_section_selection`.
- The **15 new backend tests** cover real bearer authentication, owner and role
  checks, protected types, validation, all statuses in both collections, exact
  preservation of other event fields, zero-event deletion, Uncategorized reuse,
  historical aliases, escaped names, rollback after second-collection failure,
  incomplete-move rejection, unavailable transaction support and concurrent save.
  All 15 passed again after final error-handling changes.
- Frontend unit regression: **157 passed**.
- New Chromium tests: **6 passed** against the real local API. Rename and delete
  to both destination options worked at 1440px and 390px in light/dark themes.
  Cancellation retained the source; destination selection was required; duplicate
  names and server failures preserved the current selection and displayed errors.
  Saved events retained their draft status and details. Screenshots were inspected.
- Existing Chromium regression: **106 passed, 7 skipped** across typography,
  report customization, Gallery and Research browser suites. Seven Gallery/
  Research tests require their separate browser-server fixture and were skipped
  by that suite's existing environment guard.
- Postman CLI: **8/8 HTTP assertions passed** for management list, usage, rename,
  duplicate name (409), omitted destination (422), self-destination (409),
  non-owner (403), and deletion to Uncategorized. `--no-report-events` was used;
  nothing was published to a Postman workspace. Expected 4xx responses cause CLI
  exit 1 even when their assertions pass.
- Production Vite build: **passed**, output directed to a temporary directory
  so existing `frontend/dist` files were preserved.
- Focused lint: **passed** for new modal, picker, service and browser tests.
  Broader touched-file lint retained two existing warnings: unused `nextDayOf`
  in the event form and state-in-effect in the existing event-type hook.
- `git diff --check`: **passed**. No failures in the executed final suites.
  The entire backend suite and remote deployment were not exercised.

Re-run new backend integration tests with `TEST_EVENT_TYPES_URI` pointed at a
disposable replica set:

```powershell
python -m unittest tests.test_event_type_management -q
```

For browser integration tests, set `EVENT_TYPE_TEST_SESSION` to a local JSON file
containing a **disposable** account's `access_token` and `user` (plus
`other_type_id` for the optional Postman checks), `EVENT_TYPE_TEST_API` to its API,
and `PW_BASE_URL` to the matching frontend. The tests create types and draft
events in that test account; never point them at production.

```powershell
node node_modules/@playwright/test/cli.js test event-type-management.spec.js --project=chromium
```

## Operational limits

- A standalone MongoDB deployment cannot perform the management transaction;
  it returns 503 and retains the type and events. Configure a replica set or
  sharded deployment before using edit/delete. Existing event saves retain their
  standalone fallback. Unsupported transaction behavior is covered by tests.
- Ownerless legacy custom types remain protected; ownership is never inferred
  or assigned to the current caller.
- Real-API browser runs also logged an existing notification reminder check
  returning "Teacher access required" for Event Managers. It did not affect
  type management; notification behavior was left unchanged.
- Historical names remain aliases of the renamed type or deletion destination.
  This intentionally prevents stale forms from recreating a removed type.
- Usage counts are informational snapshots. Confirmation moves all current
  associations within the transaction, including new saves that raced with it.
- Browser-local unsaved drafts remain local and unchanged; saving resolves their
  historical type names through aliases. They are not included in server counts.
- No production data, deployed application, commits or remote branches changed.
