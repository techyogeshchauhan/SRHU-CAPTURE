# Platform performance audit and optimization

Date: 2026-10-16. Scope: existing React/Vite frontend and FastAPI/MongoDB backend, including Teacher, Event Manager, Dean, and Super Admin pages.

## Git safety

- Branch: `main`; HEAD: `607232cf8d663669ddd56ce3ab45f7740c0bc992` (`feat: add schemas for report customization and managed report PDF generation service no. of participint`).
- The initial worktree already contained 144 status entries, including prior Gallery, Research, report, typography, and organizer changes. File hashes and the initial status were recorded outside the repository before this audit.
- Existing work was preserved. No reset, revert, stash, clean, commit, push, dependency upgrade, database migration, or deployment was performed. This audit did not pull over the dirty worktree.
- This document lists only changes made during this performance task. Other files shown by `git status` predate it.

## Audit findings

| Area | Existing behavior inspected | Outcome |
| --- | --- | --- |
| Route loading | Role pages already use `React.lazy`/Suspense; charts already have separate bundles. | Retained. Deferred the noncritical Bulk Onboard modal as well. |
| Shared API/auth | Concurrent authenticated GET sharing, recent `/auth/me` confirmation, and directory/upload-limit caches already exist. | Retained; no duplicate replacement cache added. |
| Teacher/Event Manager dashboards | Loaded every owned event to calculate KPI totals and show six recent events. | Added opt-in aggregated counts plus a six-event window. |
| Teacher reminders | Loaded the owner's entire event history although only today/tomorrow matter. | Narrowed dates/statuses and response fields at the API boundary. |
| My Events | Client-side merging of browser drafts, filters, sorting, and selection; both responsive layouts rendered every matching row. | Memoized merging/filtering; render 25/50/100 rows per page with shared pagination. Full matching-set bulk selection is preserved. |
| Dean Events | Server paging existed, but the grouped screen requested 1,000 rows and could not load the rest. | Starts at 100; explicit incremental loading preserves loaded rows, counts and filters. |
| Dean Dashboard | Separate KPI query and full event read support program mix and the oldest-waiting review queue. | Retained full-data behavior; see remaining limits. |
| Gallery | Album server pagination, database media tally/cover aggregation, cursor media loading, lazy images and on-demand detail/document requests already exist. | Retained; shared video previews now defer metadata requests until near the viewport. |
| Research | Record pagination, debounced filters, overview reuse across pages, explicit refresh after mutations, lazy evidence and route loading already exist. | Retained and regression-tested. Fixed a browser test's asynchronous request-count assertion. |
| Archive / Teachers | Server-side paging/filtering and lazy expanded-row documents already exist. | Retained. Existing pagination backend tests exercised. |
| Admin Users / Events / Audit Logs | Server paging and debounced search existed, but superseded requests could update a newer search. | Shared abort/latest-read hook prevents stale results and updates after unmount. |
| Media detail/viewer | Images already lazy-load, but every mounted video tile/filmstrip requested metadata. | Viewport-gated previews; the active player still loads immediately. |
| Database | Owner/date/status and compound owner+created indexes, media event indexes, research indexes and bounded list queries already exist. | Reused them; no index/schema mutation. Dashboard aggregation returns one small result rather than serializing the entire owned set. |

No blanket removal of API requests was performed: independent statistics, analytics, notifications and list reads have different purposes. Existing filters, sort choices, authorization and mutation paths were retained.

## API and behavior changes

- `GET /teacher/events?dashboard=true` and `GET /event-manager/events?dashboard=true` return six recent events plus a `dashboard` object with `all`, `draft`, `pending`, `approved`, `rejected`, and `recorded` totals. One scoped MongoDB `$facet` computes counts and the recent window. Mixed BSON/ISO timestamps are normalized for ordering; empty updated timestamps fall back to creation time. Recent events retain full fields required by existing actions.
- Teacher reads retain owner and nonarchived scope. Manager reads retain their existing owner scope. Role checks run before either new mode. Ordinary unflagged and paginated list contracts remain available.
- `GET /teacher/events?reminders=true` returns only the owner's nonarchived events on today's/tomorrow's campus date, excluding draft/rejected statuses. Description metadata remains available for reminder time labels. Notification polling frequency and visibility rules are unchanged.
- My Events page size and navigation affect rendering, not selection scope: "Select all matching events" still covers filtered records on other pages. Search/status/date changes reset the current page, and deletion clamps the page to a valid range. Local drafts still participate in the same sorting and filters.
- Dean Events appends deduplicated rows using `skip=<loaded count>&limit=100`. Filter changes start from zero; full server totals remain visible. A failed append retains previous rows and can be retried. Bulk actions operate on selected loaded events, as stated on screen.
- Admin cancellation affects reads only. Existing create/edit/delete requests remain unchanged.

## Measured comparisons

Local fixture measurements used real FastAPI handlers/JWT authorization with disposable in-memory collections, not production latency/load benchmarks. Before/after payloads compare the existing full-list contract with the new bounded contract on the same fixture; Dean compares the former `limit=1000` request with `limit=100`. JSON sizes include response metadata.

| Request | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Teacher dashboard events | 120 rows / 190,690 bytes | 6 rows / 9,707 bytes | 95% fewer rows; 94.9% fewer bytes |
| Event Manager dashboard events | 121 rows / 191,423 bytes | 6 rows / 9,731 bytes | 95.0% fewer rows; 94.9% fewer bytes |
| Dean first event load | 203 rows / 339,277 bytes | 100 rows / 169,212 bytes | 50.7% fewer rows; 50.1% fewer bytes |

- Dean's first 100 events match the old response prefix and the full total remains identical. Browser checks load subsequent windows with skips 100 and 200; a 1,200-event backend fixture checks bounded dashboard reads/counts.
- My Events now mounts at most the chosen window in each responsive representation. With the initial 25-row setting and 120 matching records, the two layouts render 50 row/card instances instead of 240; browser checks confirm 25 visible selectable events at desktop and mobile widths, then 50 after changing page size.
- Production build emits a separate Bulk Onboard module of approximately 14.8 KB uncompressed. Browser traffic confirms no modal module request before opening it and one request on opening. This is deferred work, not a claim that total application bundle size fell by that amount.
- A 100-video fixture confirms the last off-screen preview has no `src` until scrolled near the viewport; the active viewer retains its video source and controls. Original video bytes are unchanged.

## Files changed in this task

| Files | Purpose |
| --- | --- |
| `backend/app/services/event_dashboard.py` (new) | Shared bounded aggregation/count/status response. |
| `backend/app/routers/events.py`, `backend/app/routers/event_manager.py` | Authorized opt-in dashboard/reminder modes. |
| `frontend/src/pages/teacher/TeacherDashboard.jsx` | Use complete server counts with six recent records; preserve local drafts and old-response fallback. |
| `frontend/src/components/NotificationBell.jsx` | Request the narrowed reminder data. |
| `frontend/src/pages/teacher/MyEvents.jsx` | Memoized merge/filter, pagination, accurate matching-selection labels. |
| `frontend/src/pages/dean/AllEvents.jsx` | 100-row initial window and retryable incremental loading. |
| `frontend/src/hooks/useLatestRead.js` (new) | Abort superseded/unmounted table reads. |
| `frontend/src/pages/superadmin/UserManagement.jsx`, `Events.jsx`, `AuditLogs.jsx` | Guard stale responses; Users also lazily imports Bulk Onboard. |
| `frontend/src/components/common/LazyVideoPreview.jsx` (new), `MediaGallery.jsx` | Defer tile and filmstrip metadata loads; preserve active-player behavior. |
| `backend/tests/fake_aggregation.py` (new), `test_event_manager.py`, `test_research.py`, `gallery_research_browser_server.py` | Strict isolated aggregation support for existing fixtures and route tests. |
| `backend/tests/test_platform_performance.py` (new) | Counts, bounded reads, auth, archive/owner scope, legacy timestamps, reminder window tests. |
| `backend/tests/platform_performance_browser_server.py` (new) | Disposable role/event/video fixture; real handlers, no application lifespan or configured database writes. |
| `backend/tests/fixtures/platform-latency.js`, `platform-latency.sim.yaml` (new) | Local Postman slow/fast HTTP responses for stale-search browser checks. |
| `frontend/tests/platform-performance.spec.js` (new) | Dashboard requests, responsive pagination/selection, Dean incremental loading/retry, admin races, lazy modal/video checks. |
| `frontend/tests/performance.spec.js` | Wait for asynchronous request counts instead of racing URL updates. |
| `PERFORMANCE_OPTIMIZATION.md` (new) | This audit, measurements, validation and limits. |

## Validation

Commands run from `backend` or `frontend` respectively. Temporary browser servers bound only to loopback; test mutations used disposable fake collections. The configured MongoDB check below was explicitly read-only, without app startup/index creation.

| Check | Result |
| --- | --- |
| `python -m unittest tests.test_pagination tests.test_event_manager tests.test_notifications -q` | 106 passed. |
| `python -m unittest tests.test_platform_performance tests.test_dean_gallery tests.test_research tests.test_event_manager -q` | 131 passed after final backend change. |
| Frontend Vitest suite | 172 passed. Includes shared GET and existing report/organizer/filter helpers. |
| Chromium `platform-performance.spec.js` | 12 passed: real role endpoints and responsive workflows; admin delayed-search cases use the local HTTP simulation. |
| Chromium `panel-typography.spec.js` + `report-customization.spec.js` | 119 passed. These existing tests use controlled API responses and verify UI/report integration, not production PDF latency. |
| Chromium `gallery-research.spec.js` | 7 passed with the isolated real-handler fixture: albums/viewer/navigation, Research create/edit/submit, manager submissions, category routes and access restrictions. |
| Chromium `performance.spec.js` | 4 passed. Research overview/pagination/debounce/error-retry/mutation scenarios; final combined run with the 12 new platform checks: 16 passed, including Dean append failure/retry. |
| Postman request assertions against the real local FastAPI handlers | Dashboard modes return 200, six records and full 120/121 counts; reminders return the narrowed contract without draft/rejected rows. Nine assertions passed across three successful requests (exit 0). Wrong-role dashboard request returned expected 403 with its assertion passed; CLI exit 1 reflects the non-2xx HTTP status. |
| Configured MongoDB, read-only | The actual aggregation ran on both collections; totals matched `count_documents`. Sample scopes contained 0 active teacher events and 31 manager events; returned 0 and 6 respectively. No records/indexes were written. |
| Production Vite build | Passed; lazy modal chunk emitted and existing chart splitting retained. |
| Scoped project Oxlint | No errors; existing unused-import/effect/dependency warnings remain. |
| `git diff --check` and initial-file hash comparison | No whitespace errors; no baseline file removed. Existing unrelated work retained. |

Initial browser runs exposed ambiguous selectors (hidden responsive duplicates/document navigation responses) and assertions racing asynchronous requests. Test synchronization/selectors were corrected; production behavior was not changed to satisfy those assertions. An attempted npm command forwarded build flags incorrectly under PowerShell, and an ESLint attempt found no ESLint config: the final checks used the installed Vite CLI and this repository's actual Oxlint tool. No dependency was installed or upgraded for these checks.

Local evidence/logs and initial file hashes: `C:\Users\yc993\AppData\Local\Temp\srhu-platform-performance-ek8ayvi1`. Tokens in temporary fixture sessions are disposable test credentials; do not publish those session files.

## Remaining limits

- My Events still fetches the full owned event set to preserve exact existing browser-draft merging, client date/search semantics, totals and global filtered bulk actions. Rendering is bounded; network size is not. A complete server migration needs shared filter/selection contracts and draft reconciliation rather than silently selecting only one server page.
- Dean Dashboard still reads all events for program mix and oldest-waiting review data. A dedicated aggregate plus paginated review-queue contract would be a separate improvement; truncating this read would change existing behavior. This report does not claim every platform request is now paginated.
- Deep offset paging and merging teacher/managed sources can still read up to `skip + limit` records per source. Existing regex searches may scan large filtered sets. No production `explain`/concurrent-load benchmark or speculative new indexes were introduced.
- Counts necessarily inspect the full matching scope. The dashboard pipeline normalizes dates and sorts within that scope, so reduced network/serialization work is proven; proportional database CPU/latency savings are not claimed.
- Lazy media avoids off-screen requests but does not shrink original image/video files. Large original uploads and PDF photo downloads remain bandwidth-sensitive; no thumbnail storage/compression or report pipeline changes were made here.
- Browser validation was Chromium at desktop/mobile widths on isolated data. Production CDN/mobile-network timings, other browser engines and production-scale load were not measured. Earlier unrelated broad-suite failures documented in previous work were not treated as performance bugs or silently fixed.
- No deployment was performed. Changes are uncommitted and require the usual application restart/build to run outside the test servers.
