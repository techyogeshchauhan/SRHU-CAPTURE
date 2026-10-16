# Gallery and Research integration changes

Date: 15 October 2026 (Asia/Calcutta)

## Baseline and preservation

- Highlighted baseline and current HEAD: `607232cf8d663669ddd56ce3ab45f7740c0bc992`
  (`feat: add schemas for report customization and managed report PDF generation service no. of participint`).
- Branch: `main`. Local HEAD matches the existing `origin/main` reference.
- Initial Git status: **20 modified tracked files, 68 untracked files**, nothing
  staged, no conflicts. Counts use individual files, not collapsed directories.
- Inspected status, recent history, tracked diffs, the handover, and the previous
  inspection report at `docs/GALLERY_RESEARCH_CHANGES.md` before making changes.
- Preserved a SHA-256 manifest of all **350 existing nonignored files**, initial
  status, and HEAD under
  `C:\Users\yc993\AppData\Local\Temp\srhu-gallery-research-integration-20261015-180852`.
  This manifest verifies preservation; it is not a content backup.
- Only the five existing files listed below changed during this task. The other
  **345 baseline files remain byte-for-byte unchanged**. No baseline files were
  deleted. All 20 tracked modifications present at the start remain unchanged.
- No reset, revert, stash, clean, checkout, commit, or push was performed. The
  baseline commit and history were not altered.

The Gallery/Research implementation was already present in the working tree.
It was reused, with small fixes for reproduced failures; no second implementation
or new database structure was introduced. Existing work outside this task was
preserved, including pre-existing changes in Events, Teachers, and shared files.

## Files changed by this task

| File | Change and reason |
| --- | --- |
| `backend/scripts/seed_research_demo.py` | Removed the retired `project` category from the generated category mix. The existing generator indexed active categories and raised `KeyError: 'project'`. Existing legacy project records and their display support were left intact. |
| `backend/scripts/seed_research_ui_demo.py` | Added `office: "India (IPO)"` to generated patent details, satisfying the existing required field. No generator was run against application data. |
| `frontend/src/components/dean/GalleryAlbumDialog.jsx` | Ignore keyboard events originating in a different dialog, such as the overlaid photo viewer. Previously a viewer arrow key also switched the album underneath it. The shared media viewer was not changed. |
| `frontend/src/hooks/useTableQuery.js` | Added reading, writing, and clearing of Gallery's `media` query field. Gallery already used `query.media`, but the shared hook omitted it, so Photos/Videos filters did nothing. The field defaults to an empty string; existing callers without this filter keep their normal query behavior. This is the only shared runtime utility changed in this task. |
| `backend/tests/test_upload_limits.py` | Corrected the bounds assertion to exclude the boolean `research_evidence_required` switch from numeric bounds, and asserted the existing Research evidence defaults and numeric ranges. No limits API behavior was changed. |
| `backend/tests/gallery_research_browser_server.py` **(new)** | Isolated loopback browser fixture using the real application routes, login/password verification, JWT authentication, and authorization, with in-memory collections and sample album images. Closes the MongoDB client and skips startup migrations/indexing so browser checks cannot write to the application database. |
| `frontend/tests/gallery-research.spec.js` **(new)** | Seven Chromium workflow checks, including desktop/mobile Gallery behavior, Research create/edit/submit/record, Dean visibility, and anonymous/wrong-role access. Explicit opt-in to the local fixture avoids running these writes against a shared API. |
| `GALLERY_RESEARCH_CHANGES.md` **(new)** | This report. The earlier report under `docs/` was preserved. |

## Integration reviewed and verified

### Gallery

- Existing `/dean/gallery` frontend route and Dean navigation are registered in
  `frontend/src/App.jsx` and the existing shell.
- Gallery reuses `GalleryAlbumCard`, `GalleryAlbumDialog`, `EventMediaSections`,
  `MediaGallery`, date utilities, and pagination.
- Existing backend routes `GET /dean/gallery`, `GET /dean/gallery/photos`, and
  `GET /dean/events/{id}/media` use the application's bearer authentication and
  event-viewer role checks. The existing Events router was not edited.
- Existing event/media collections supply albums. API tests cover draft/archive
  exclusion, teacher/manager sources, date/type/media filters, paging, and signed
  covers. Browser checks cover image albums, empty-section suppression, zoom,
  keyboard photo navigation, album navigation, mobile modal sizing, filter
  persistence after reload, and clearing filters.

### Research

- Existing Teacher and Event Manager list/new/details/edit routes, Dean list and
  category/details routes, and their role guards are already registered.
- Existing `research.py`, `research_tools.py`, `research_showcases.py`, request
  schemas, category definitions, frontend services/hooks, and Research components
  were reused. No production routers, auth code, models, schemas, or database
  initialization were changed during this task.
- Current data architecture uses `research_records` with embedded evidence and a
  separate `research_showcases` collection. Existing indexes and upload settings
  remain as supplied in the working tree.
- Backend tests cover ownership, role boundaries, draft visibility, stale-edit
  conflicts, submission/verification rules, evidence validation and limits, bulk
  actions, tools/exports, DOI handling, reminders, and showcases.
- Chromium checks perform real HTTP requests to the actual application endpoints:
  create a patent draft, reload its values into Edit, save, read it back through
  the API, and submit/record it. Teacher submissions remain `submitted`; Event
  Manager submissions become `verified`, and subsequent manager edits preserve
  acceptance. Dean screens show the manager submissions under category routes.
- Browser sessions use tokens obtained through the real `/auth/login` endpoint.
  `/auth/me` and ProtectedRoute run normally. Anonymous API calls return 401;
  teacher access to Dean APIs returns 403, and the frontend routes a signed-in
  teacher away from Dean Gallery. Another teacher's list excludes these records.

Research analytics/showcase page files exist but are not mounted as additional
frontend screens; some analytics/import URLs intentionally redirect to Records.
No new navigation or removed-feature restoration was inferred from those files.

## Tests and results

Backend tests ran with `TEST_MONGODB_URI=mongodb://127.0.0.1:27017`,
`TEST_MONGODB_DB_NAME=campus_capture_test`, and
`ALLOW_TESTS_ON_CONFIGURED_DB=0`. The browser fixture uses fake collections,
local sample accounts, and local images; email is disabled. No application seed,
cleanup, migration, or production-data operation was run.

| Check | Result |
| --- | --- |
| Before fixes: `python -m pytest tests/test_research_demo_seed.py tests/test_research_ui_seed.py -q --tb=short` | 3 passed, 7 failed, reproducing the two generator defects. |
| Gallery/Research backend: `python -m pytest tests/test_dean_gallery.py tests/test_research.py tests/test_research_tools.py tests/test_research_showcases.py tests/test_research_demo_seed.py tests/test_research_ui_seed.py -q --tb=short` | **113 passed**, 10 subtests passed; exit 0. All 7 earlier Research demo failures resolved. |
| Final entire backend suite: `python -m pytest tests -q --tb=short` | **926 passed, 6 failed**, 184 subtests passed, 93 warnings; exit 1; 61.13 seconds. All six remaining failures are listed separately below. |
| Frontend: `npm run test:unit` | **129 passed across 14 files**, including the Gallery/Research unit tests; exit 0. |
| Chromium: dedicated `gallery-research.spec.js` command below | **7 passed**; exit 0; 21.8 seconds. Gallery at 1440px/390px, teacher Research at 1440px, manager Research at 1440px/390px, access restrictions, Dean category/details views. |
| Build: `node node_modules/vite/bin/vite.js build --emptyOutDir false` | **Passed**, 746 modules transformed; exit 0. Existing ignored build output was not emptied. |
| Scoped lint: `node node_modules/oxlint/bin/oxlint tests/gallery-research.spec.js src/hooks/useTableQuery.js src/components/dean/GalleryAlbumDialog.jsx` | Exit 0; two existing `react(set-state-in-effect)` warnings in the dialog, no errors. |
| `git diff --check` and baseline hash audit | Passed; only the intended five existing files differ, with no baseline files missing. |

Browser screenshots were saved in ignored `frontend/test-results/`. Desktop and
mobile album screenshots and the mobile Research detail screenshot were visually
inspected. Chromium was downloaded into Playwright's user cache because the
required browser runtime was missing; package manifests and lockfiles were not
changed.

### Reproduce the browser validation

Use three terminals. These ports are dedicated to the isolated fixture.

```powershell
# Terminal 1, from backend/
python -m tests.gallery_research_browser_server

# Terminal 2, from frontend/
$env:VITE_API_BASE_URL='http://127.0.0.1:8765'
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5179 --strictPort

# Terminal 3, from frontend/
$env:PW_BASE_URL='http://127.0.0.1:5179'
$env:GALLERY_RESEARCH_TEST_API='http://127.0.0.1:8765'
node node_modules/@playwright/test/cli.js test tests/gallery-research.spec.js --project=chromium --workers=1 --reporter=list
```

Restart the fixture server before a fresh complete run: its records are kept in
memory for the serial scenarios. If Chromium is missing, install the existing
runner's runtime with `node node_modules/@playwright/test/cli.js install chromium`.
Stop the fixture and Vite processes when finished. The processes started for this
task were stopped after validation.

## Remaining failures outside Gallery/Research

These were not repaired or used to change unrelated functionality:

| Test | Observed result |
| --- | --- |
| `test_bulk_drafts.py::BulkDraftTests::test_event_manager_bulk_record` | Expects `recorded`; existing approval workflow stores `pending`. |
| `test_deploy_config.py::MongoImportTests::test_import_does_not_resolve_srv_dns` | Installed PyMongo rejects the test's `mongodb+srv://nonexistent.invalid/` URI during import. |
| `test_direct_upload.py::EventManagerDirectUploadTests::test_round_trip_records_in_the_managed_collections` | Expects `recorded`; existing approval workflow returns `pending`. |
| `test_event_report.py::GenerateWithoutSocialLinkTests::test_generated_body_says_not_provided` | Expected `Not provided` text is absent. |
| `test_event_report.py::ReportAttachmentChoiceTests::test_empty_description_still_has_its_section` | Expected empty Event Description section is absent from the generated report. |
| `test_uploads.py::StreamingTests::test_dynamic_photo_size_limit` | Expected photo-specific size message differs from the existing server-wide upload-cap response. |

## Limits and final Git status

- No Gallery/Research test or browser blocker remains in the isolated environment.
- Real MongoDB/GridFS/R2 persistence, SMTP delivery, live Crossref, video playback,
  Firefox, WebKit, and deployed-environment behavior were not exercised by these
  browser checks. Signed URLs/evidence/tool behavior has local API-test coverage.
- The entire backend suite remains red on the six out-of-scope failures above;
  this report does not claim all existing functionality passed every check.
- Final branch/HEAD remain `main` / `607232c`; no staged changes or conflicts.
- Final working tree: **22 modified tracked files, 71 untracked files**. The
  increase from the initial status is two tracked files changed for Gallery/
  Research support/tests and three new files. The other task edits are in files
  that were already untracked.
- No commit or push was made.

## Follow-up: four Gallery cards per row

On 15 October 2026, capped the Dean Gallery album grid at four columns by removing
the five- and six-column overrides in `frontend/src/pages/dean/Gallery.jsx`.
All media, Photos, and Videos share this grid, including its loading placeholders.
The existing two-column mobile and three-column tablet layouts are preserved.
The album dialog and other modules were not changed in this follow-up.

Validation: frontend production build and `git diff --check` passed. No commit or
push was made. The Git counts and preservation audit above describe the preceding
integration task; this follow-up additionally changes the Gallery page and report.
