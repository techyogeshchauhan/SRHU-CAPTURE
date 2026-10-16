# Deployed ZIP versus local Gallery and Research

Date: 15 October 2026 (Asia/Calcutta)

## Result

The supplied ZIP is an older source snapshot with no Gallery or Research implementation. The local working tree contains both modules, including the four-card desktop Gallery layout. The local tree also includes pre-existing changes outside those modules; deploying the whole tree would include those differences too.

This is a static comparison of the user-supplied archive, not verification of a live deployment URL. No archive instruction files, scripts, hooks, binaries, or dependency code were executed.

## Baselines

- Archive: `C:\Users\yc993\Downloads\SRHU-CAPTURE.zip`.
- Archive SHA-256: `4fe457f67eb5543991535bda11d0905c1a5a4811ff966b498c73532a9bfa2644`.
- Archive `.git/HEAD` points to `main`; both archived `main` and `origin/main` point to `ca13964afa5b4e548ac01bf38bc4a92e7c8ca348`.
- Local branch/HEAD: `main` / `607232cf8d663669ddd56ce3ab45f7740c0bc992`.
- All 233 compared archive source files match the archived commit when CRLF/LF differences are ignored; the finding is supported by source content as well as Git metadata.
- Local main contains three later commits: `a9fc03c` (backend/event dashboard work), `b71031f`, and `607232c` (report customization and managed report PDF work).

## Module comparison

| Area | Supplied deployed ZIP | Local working tree |
| --- | --- | --- |
| Gallery page/cards/dialog | Absent | Dean Gallery page, album card/dialog, helpers, tests present |
| Gallery routing/navigation | No Gallery route or Dean navigation link | `/dean/gallery` and Dean navigation registered |
| Gallery API | No `/dean/gallery` or `/dean/gallery/photos` endpoints | Both endpoints added to the existing Events router; event/media collections reused |
| Gallery cards per row | No Gallery grid | Four columns at large widths, three at tablet widths, two on mobile; shared by All media/Photos/Videos |
| Research frontend | Absent | Teacher/Event Manager forms, lists/details; Dean list/category/details; shared components/services/hooks |
| Research backend | Absent | Research records, tools, showcase routers; schemas and services |
| Research database integration | No Research collection handles/indexes | `research_records`, embedded evidence, `research_showcases`, and associated indexes |
| Research settings/notifications | Absent | Evidence limits/settings, Research notification types and email templates |
| Research startup behavior | Absent | Startup can settle waiting manager-handled Research submissions using `_settle_manager_research()` |
| Module tests | No dedicated Gallery/Research tests | Backend/unit tests and isolated Chromium workflow checks |

## Authentication and dependencies

The following match after line-ending normalization:

- `backend/app/routers/auth.py`: unchanged.
- `backend/app/utils/auth.py`: unchanged.
- `backend/app/utils/security.py`: unchanged.
- `frontend/src/context/AuthContext.jsx`: unchanged.
- `frontend/src/components/common/ProtectedRoute.jsx`: unchanged.
- `frontend/src/services/auth.js`: unchanged.
- `frontend/src/services/session.js`: unchanged.
- `frontend/package.json`: unchanged.
- `frontend/package-lock.json`: unchanged.
- `backend/requirements.txt`: unchanged.

This confirms reuse of the existing authentication code and dependency versions. It does not establish that deployment environment variables or installed runtime versions are identical.

## Differences that must not be mistaken for module-only additions

- Later committed Event Manager approval/routing, Events/Dashboard views, and report-generation changes already exist in local `main`; they were not introduced by this ZIP comparison.
- Existing uncommitted `frontend/src/utils/constants.js` changes lock archived event editing. This is outside Gallery/Research behavior.
- Existing uncommitted email service changes include an administrator password-reset email helper alongside Research-specific templates.
- Research integration also touches shared areas: teacher/admin account deletion guards, navigation shells, upload configuration, shared media display, and modal styling. These are integration changes with effects outside standalone page files.
- The existing local source and committed history were preserved. No attempt was made to remove these differences or replace local files from the ZIP.

## Source comparison counts

Compared `.py`, `.js`, `.jsx`, `.css`, `.json`, `.ts`, and `.tsx` files under backend app/scripts/tests and frontend src/tests. Excluded Git internals, dependencies, build output, logs, environment files, swap files, and binary assets. CRLF/LF-only differences are not treated as functional changes.

| Category | Files |
| --- | ---: |
| Shared archive/local source files | 233 |
| Equivalent content after line-ending normalization | 192 |
| Of those, line endings differ | 186 |
| Shared files with content changes | 41 |
| Local-only source files | 70 |
| Archive-only source files | 0 |

### Shared files with content changes

Classification compares the archive, local committed HEAD, and current local working tree. It describes provenance, not whether a change belongs in a future deployment.

| File | Difference from ZIP |
| --- | --- |
| `backend/app/config.py` | Working-tree difference |
| `backend/app/database.py` | Working-tree difference |
| `backend/app/main.py` | Working-tree difference |
| `backend/app/models/documents.py` | Working-tree difference |
| `backend/app/routers/dean_teachers.py` | Working-tree difference |
| `backend/app/routers/event_manager.py` | Committed baseline difference |
| `backend/app/routers/events.py` | Committed baseline + working-tree differences |
| `backend/app/routers/reports.py` | Committed baseline difference |
| `backend/app/routers/superadmin.py` | Working-tree difference |
| `backend/app/schemas/reports.py` | Committed baseline difference |
| `backend/app/schemas/superadmin.py` | Working-tree difference |
| `backend/app/services/email_service.py` | Working-tree difference |
| `backend/app/services/managed_report_pdf.py` | Committed baseline difference |
| `backend/app/services/upload_config_service.py` | Working-tree difference |
| `backend/tests/test_event_manager.py` | Committed baseline difference |
| `backend/tests/test_upload_limits.py` | Working-tree difference |
| `frontend/src/App.jsx` | Working-tree difference |
| `frontend/src/components/NotificationBell.jsx` | Committed baseline difference |
| `frontend/src/components/common/MediaGallery.jsx` | Working-tree difference |
| `frontend/src/components/dean/DeanShell.jsx` | Working-tree difference |
| `frontend/src/components/dean/EventsTable.jsx` | Committed baseline difference |
| `frontend/src/components/dean/SubmissionsGroupedList.jsx` | Committed baseline difference |
| `frontend/src/components/teacher/Lifecycle.jsx` | Committed baseline difference |
| `frontend/src/components/teacher/ProgressTimeline.jsx` | Committed baseline difference |
| `frontend/src/components/teacher/TeacherShell.jsx` | Working-tree difference |
| `frontend/src/components/teacher/icons.jsx` | Working-tree difference |
| `frontend/src/components/teacher/panelConfig.js` | Committed baseline difference |
| `frontend/src/hooks/useEventReportDownload.js` | Committed baseline difference |
| `frontend/src/hooks/useTableQuery.js` | Working-tree difference |
| `frontend/src/index.css` | Working-tree difference |
| `frontend/src/pages/dean/AllEvents.jsx` | Committed baseline difference |
| `frontend/src/pages/dean/DeanDashboard.jsx` | Committed baseline difference |
| `frontend/src/pages/dean/EventDetails.jsx` | Committed baseline difference |
| `frontend/src/pages/superadmin/settings/tabs.js` | Working-tree difference |
| `frontend/src/pages/teacher/EventDetails.jsx` | Committed baseline difference |
| `frontend/src/pages/teacher/MyEvents.jsx` | Committed baseline difference |
| `frontend/src/pages/teacher/TeacherDashboard.jsx` | Committed baseline difference |
| `frontend/src/utils/constants.js` | Working-tree difference |
| `frontend/src/utils/dates.js` | Working-tree difference |
| `frontend/src/utils/eventFields.js` | Committed baseline difference |
| `frontend/src/utils/uploadLimits.js` | Working-tree difference |

### Local-only source files

These include Gallery/Research implementation and tests, plus some source files from the later committed baseline. Presence alone is not a recommendation to deploy every helper or demo script.

- `backend/app/routers/research.py`
- `backend/app/routers/research_showcases.py`
- `backend/app/routers/research_tools.py`
- `backend/app/schemas/research.py`
- `backend/app/services/research_analytics.py`
- `backend/app/services/research_categories.py`
- `backend/app/services/research_doi.py`
- `backend/app/services/research_identifiers.py`
- `backend/app/services/research_pdf.py`
- `backend/app/services/research_reminders.py`
- `backend/app/services/research_spreadsheets.py`
- `backend/scripts/cleanup_research_dashboard_test.py`
- `backend/scripts/cleanup_research_e2e.py`
- `backend/scripts/cleanup_research_ui_demo.py`
- `backend/scripts/import_research_dashboard_test.py`
- `backend/scripts/record_event_manager_research.py`
- `backend/scripts/seed_doi_test.py`
- `backend/scripts/seed_research_demo.py`
- `backend/scripts/seed_research_e2e.py`
- `backend/scripts/seed_research_ui_demo.py`
- `backend/tests/gallery_research_browser_server.py`
- `backend/tests/test_dean_gallery.py`
- `backend/tests/test_event_manager_approval_workflow.py`
- `backend/tests/test_research.py`
- `backend/tests/test_research_demo_seed.py`
- `backend/tests/test_research_showcases.py`
- `backend/tests/test_research_tools.py`
- `backend/tests/test_research_ui_seed.py`
- `frontend/src/components/common/MultiSelectDropdown.jsx`
- `frontend/src/components/dean/GalleryAlbumCard.jsx`
- `frontend/src/components/dean/GalleryAlbumDialog.jsx`
- `frontend/src/components/research/AddFacultyModal.jsx`
- `frontend/src/components/research/CategoryIcon.jsx`
- `frontend/src/components/research/EvidencePanel.jsx`
- `frontend/src/components/research/EvidenceQueue.jsx`
- `frontend/src/components/research/ResearchAnalytics.jsx`
- `frontend/src/components/research/ResearchChips.jsx`
- `frontend/src/components/research/ResearchFacts.jsx`
- `frontend/src/components/research/ResearchFilters.jsx`
- `frontend/src/components/research/ResearchNav.jsx`
- `frontend/src/components/research/ResearchNotices.jsx`
- `frontend/src/components/research/ResearchRow.jsx`
- `frontend/src/components/research/ResearchTimeline.jsx`
- `frontend/src/components/research/ShowcaseView.jsx`
- `frontend/src/components/research/useResearchQuery.js`
- `frontend/src/components/research/useShellProfile.js`
- `frontend/src/hooks/useResearchCategories.js`
- `frontend/src/pages/dean/Gallery.jsx`
- `frontend/src/pages/dean/Research.jsx`
- `frontend/src/pages/dean/ResearchAnalytics.jsx`
- `frontend/src/pages/dean/ResearchDetails.jsx`
- `frontend/src/pages/dean/ResearchShowcase.jsx`
- `frontend/src/pages/dean/ResearchShowcases.jsx`
- `frontend/src/pages/superadmin/settings/ResearchLimitsTab.jsx`
- `frontend/src/pages/teacher/Research.jsx`
- `frontend/src/pages/teacher/ResearchAnalytics.jsx`
- `frontend/src/pages/teacher/ResearchDetails.jsx`
- `frontend/src/pages/teacher/ResearchForm.jsx`
- `frontend/src/pages/teacher/ResearchShowcase.jsx`
- `frontend/src/pages/teacher/ResearchShowcases.jsx`
- `frontend/src/services/research.js`
- `frontend/src/utils/galleryAlbums.js`
- `frontend/src/utils/research.js`
- `frontend/tests/dean-department.spec.js`
- `frontend/tests/gallery-research.spec.js`
- `frontend/tests/unit/deanResearchDelete.test.js`
- `frontend/tests/unit/eventFields.test.js`
- `frontend/tests/unit/galleryAlbums.test.js`
- `frontend/tests/unit/research.test.js`
- `frontend/tests/unit/researchEvidenceQueue.test.js`

## Validation and files changed in this comparison

- Read ZIP metadata and source bytes directly; did not extract or copy archive files over the project.
- Compared source content against both archived Git commit metadata and local Git blobs, ignoring CRLF/LF-only differences.
- No tests, builds, server launches, migrations, or deployment actions were needed or run for this static comparison. Earlier test results are recorded in `GALLERY_RESEARCH_CHANGES.md`; they were not rerun here.
- The only new project file is this comparison report. All pre-existing project files were hash-checked for preservation.
- No application code changed; nothing staged, committed, pushed, or deployed.
