# Performance and API request audit

Audit date: 16 October 2026 (Asia/Calcutta).

## Safety and scope

Started on `main`, HEAD `607232cf8d663669ddd56ce3ab45f7740c0bc992`, with 130
pre-existing modified/untracked status entries. Recorded a SHA-256 baseline in
`C:\Users\yc993\AppData\Local\Temp\srhu-performance-lvh54cxt` before editing.
No reset, stash, pull/merge over the dirty tree, commit, push, dependency update,
database migration, new index or global styling change was performed.

Reviewed route loading, auth/profile reads, event dashboards/lists/details,
Gallery, Research, notifications, report customization/downloads, multipart
uploads and Super Admin data-loading patterns. Browser validation covers the
Dean/Event Manager pages in the existing typography/report matrix and dedicated
Research request tests. This is not a claim of a live production load test or
every administrative workflow being exercised.

## Verified issues and optimizations

### 1. Research pagination repeated an unchanged overview request

The Dean Research loader requested both records and overview whenever page or
page size changed. Overview parameters contain only filters, so those repeats
recalculated the same counts and academic years.

A production-build browser trace demonstrated **3 overview requests** for the
initial page, Next and a page-size change. After optimization the same sequence
makes **1 overview request**, while still making all **3 required record-page
requests**. Two of six list/overview calls are removed (33% for that sequence).

The component now retains only its current filter's overview promise/result.
Pagination reuses it. Filter changes, successful deletion (including moving back
from an emptied last page), Retry and component remount obtain fresh figures.
Failures are evicted, stale requests cannot evict newer requests, and obsolete
overview requests are aborted on filter change/unmount. No persistent or shared
cross-user cache was added.

### 2. Gallery calculated counts/covers by transferring every media row

The backend read every matching media identifier/kind into Python for tallies,
then read every photo on the selected albums to retain only the first cover.
The photo-wall route also serialized a whole event's media before slicing it.

The album routes now group counts and select the earliest photo in MongoDB,
returning only tallies and one cover per album. The wall applies skip/limit to
the database cursor before serialization. Authorization, filters, totals,
ordering, signed links, cross-source visibility and JSON shapes are preserved.

| Controlled dataset: 40 albums, 100 photos each, 25 albums/page | Before | After |
| --- | ---: | ---: |
| Media rows returned to the application | 6,500 | 65 |
| Media database operations | 2 | 2 |
| Returned albums / total photos | 25 / 4,000 | 25 / 4,000 |

This is a **99% reduction in returned media rows**, not a measured 99% latency
improvement. In-memory fixture times (76 ms before, 91 ms after) do not model
Atlas network/aggregation costs and are not offered as a speed benchmark.
All returned album names, photo/video counts, cover filenames and totals matched
the baseline. A separate read-only Atlas check on the real ten-photo event
confirmed the aggregation count and earliest cover match the old read path.

## Working mechanisms left unchanged

- Role pages are already lazy-loaded. Recharts is outside the initial page
  chunk; no dependency or route-loading rewrite was justified.
- Concurrent authenticated JSON GETs already share an in-flight request.
  Independent cancellation remains separate. Profile verification is reused
  briefly within the same session; startup still confirms authorization.
- Event-type, research-category and upload-limit lookups already share requests.
- Search inputs already debounce by 350 ms. Browser typing tests confirm one
  list/overview refresh after typing pauses.
- Notification polling stops in hidden tabs and runs every 30 seconds when
  visible. Teacher reminder checks are rate-limited and restricted to Teachers.
  No confirmed polling storm was found, so refresh behavior was preserved.
- Row documents and Gallery album media load on demand; album hover/open reuses
  its request. No bulk eager fetch of every album was introduced.
- Report availability checks need authorized event/upload data. Dean metadata
  generation and PDF download have distinct responsibilities; inspection found
  only the download builds the PDF, so the two calls were not mislabeled as
  duplicate PDF generation. Report customization is bounded to five event workers
  (Dean uploads add up to ten concurrent subrequests); multipart upload workers
  are also bounded. These working flows were left unchanged.
- Full event lists used for client-side draft merging, KPIs and grouped views
  were not truncated, which would change totals/selection behavior.

## Validation

| Check | Result |
| --- | --- |
| Gallery and Research backend suites | **70 passed**, including three new Gallery scaling/legacy/paging cases |
| Frontend unit suite | **168 passed** |
| Existing typography/report browser regressions | **119 passed**, production build, desktop/mobile cases |
| New Research request/freshness browser tests | **4 passed**: pagination, debounce/filter refresh, failure/retry, deletion/last-page invalidation |
| Postman requests against isolated real API handlers | **6 assertions passed across 3 requests**: Gallery albums, photo-wall paging, Research overview |
| Read-only actual MongoDB aggregation | Exact ten-photo tally and same earliest cover; no writes |
| Production builds before/after | Passed; 68 manifest entries; initial JS 323,321 bytes and CSS 121,694 bytes in both |
| Whitespace | `git diff --check` passed |

The initial pagination regression test failed with the measured 3-vs-1 request
count, then passed after the change. During test development, incorrect UI
locators and non-padded fixture timestamps were corrected; these were fixture
failures. Tests use disposable in-memory records with real auth/routes; mutations
never reach the live database. Postman publishing/history events were disabled.

Reproduce the dedicated browser test with `python -m tests.performance_browser_server`
from `backend`, setting `PERFORMANCE_SESSION_FILE` to a temporary JSON path.
Build/serve the frontend with `VITE_API_BASE_URL=http://127.0.0.1:8765` on port
5179, then run `performance.spec.js` with `PW_BASE_URL=http://127.0.0.1:5179` and
the same session-file variable. The fixture disables the application lifespan,
replaces all database collections and closes the real Mongo client.

## Files changed for this audit

- `backend/app/routers/events.py`: database-side Gallery tallies/covers and wall pagination.
- `frontend/src/pages/dean/Research.jsx`: reuse the current overview while paging, with explicit invalidation.
- `backend/tests/test_dean_gallery.py`: aggregation fake and scaling/legacy/paging regressions.
- `backend/tests/gallery_research_browser_server.py`: support Gallery aggregation in the existing isolated fixture.
- `backend/tests/performance_browser_server.py`: disposable populated Research browser fixture.
- `frontend/tests/performance.spec.js`: request-count and freshness regression tests.
- `PERFORMANCE_AUDIT.md`: findings, evidence and limits.

## Remaining limits and follow-up opportunities

Large original photos still dominate media-heavy pages: the previously inspected
ten-photo event contains about 136 MB of originals. Images use native lazy loading,
but near-viewport thumbnails can still download originals. No thumbnail storage
pipeline, upload recompression or original-file replacement was added in this
audit. Google Fonts is loaded through CSS with `display=swap`; production CDN/font
timing, static-asset cache/compression headers, LCP/INP/CLS and backend p95 under
concurrent real users were not measured. Database grouping reduces transfer size
but still scans matching indexed media; no production query plan/load benchmark
is claimed. These limits are separate from the proven request/row reductions.

The subsequently requested multi-organizer feature is a separate change and is
documented separately; it is not counted as a performance optimization.
