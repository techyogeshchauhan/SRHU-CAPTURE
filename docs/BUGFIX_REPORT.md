# Teacher event authorization and report download investigation

## Scope and contract

Preserve the current dirty worktree and baseline commit `607232c`. Do not commit
or push. Existing routes and report customization payloads remain compatible.

- The reported Teacher Events failure was clarified as `GET /teacher/events`
  returning **403**, not 404. This endpoint remains Teacher-only. The Event
  Manager bell must not call it for its teacher-only reminder check.
- Successful authorized single/bulk report requests must return a complete PDF
  and download/open through the existing browser delivery flow.
- Generation failures must show a concise error, reset loading and permit retry.
- Existing/new event eligibility, section selection and ownership remain intact.

## Evidence before changes

The running API's OpenAPI document confirms `GET /teacher/events` and both report
download routes are registered. Local logs show the Event Manager's own event
request succeeding, followed by a separate `/teacher/events` request returning
403. `NotificationBell` folds all non-Dean roles into `teacher`, then uses that
presentation role to decide whether to fetch teacher events for reminders.

The logs also contain a completed Event Manager PDF build and HTTP 200 response.
The PDF path, response transfer and browser loading behavior are being profiled
separately so a successful server log is not mistaken for a completed download.

## Root causes

### Teacher Events: incorrect caller role, not a missing route

The user supplied the exact failing request:
`GET http://localhost:8001/teacher/events` → **403 Forbidden**.
`NotificationBell` used `currentUser.role === "dean" ? "dean" : "teacher"`
for presentation, then incorrectly reused that value for its teacher-only
event-day reminder effect. An Event Manager therefore made an unauthorized
teacher request on mounting the bell. The Event Manager's normal event list
already correctly uses `/event-manager/events`.

The reminder effect now checks the actual authenticated role. Teacher reminders
remain enabled for Teachers; Event Managers continue using their own events and
role-neutral notification feed. Backend authorization remains unchanged. No
404 fallback, new route alias or permission broadening was added.

### Report: stalled original-photo reads and an unbounded frontend await

The inspected Event Manager event has ten selected photographs. A read-only
reproduction called the actual report preparation path against its existing
storage. Repeated 15-second stack snapshots showed the request waiting in:

```text
event_manager._report_entry
  report_files.read_file_bytes
    botocore.response.StreamingBody.read
      urllib3 / http.client / ssl.read
```

This occurs **before** `build_managed_report_pdf`. The previous code fetched each
original photo serially with `get_object(...)["Body"].read()`, without a total
read deadline or explicit response closure. SDK retries and a slowly progressing
body could keep the request busy for a long time. A socket's inactivity timeout
does not bound a response that keeps trickling bytes.

The frontend awaited `apiFetch` and then `response.blob()` without an overall
deadline. Existing page handlers already had `finally` cleanup, but it could not
run until that awaited promise settled. That left “Generating PDF...” active.

Payload inspection found valid JSON section flags with the correct authenticated
POST routes. The single-event body is the customization object; consolidated
requests contain `event_ids` and `customization`. No payload/route rewrite was
needed. Logs also showed an earlier successful PDF build and HTTP 200: that
establishes that generation can succeed, not that every later body transfer or
browser download completes.

## Fixes

- Report photos load and resize in at most **four workers**, retaining selected
  order. Original bytes are released after each resize. Pending work is cancelled
  after a failure instead of continuing through the entire queued selection.
- R2 URLs are signed locally with the existing SDK; bounded streaming GETs use
  standard-library `read1`, which permits deadline checks between received chunks.
  Each read retains a 10-second socket idle timeout. The elapsed allowance is
  now 20 seconds plus transfer time at 64 KiB/s, capped at 180 seconds per photo
  and checked between reads. File-size metadata and response Content-Length
  both inform the allowance. This accommodates concurrent large camera originals
  without permitting an endless trickle. Signed URL lifetime covers the allowance.
- Storage response contexts close on success/failure. Content-Length mismatches
  are rejected. The reader does not emit signed query strings into HTTP client
  info logs. Uploads, file-serving and the shared R2 client remain unchanged.
- Storage connection/read failures produce **504** with
  `Could not load report photos. Please try again.`; upstream 5xx failures produce
  502. A timed-out selected photo cannot silently become a successful partial PDF.
  Existing handling of genuinely missing/corrupt photos remains compatible.
- All four frontend download methods share a **300-second deadline** covering
  token refresh, headers, error/PDF body reads and download preparation. Timeout
  aborts the report fetch and returns `Report download timed out. Please try again.`
  Caller `finally` blocks reset loading and re-enable Cancel/Generate.
- Late responses cannot trigger a download after timeout. HTTP errors remain
  readable; broken connections and invalid HTML/JSON “success” bodies produce
  concise errors. Only a body beginning `%PDF-` reaches browser delivery.
- Existing customization, section availability, report eligibility, ownership,
  filename handling and secure-download/LAN-viewer behavior are preserved.
- Event Manager server logs now distinguish request start, photo preparation,
  PDF byte count and elapsed time, making future delays easier to locate.

## Validation

| Check | Result |
| --- | --- |
| Backend focused suites | **82 passed**: recovery, report approval, Event Manager and section-selection tests. |
| Frontend unit suites | **168 passed**, including stalled headers/body, late-response suppression, invalid PDF and retry. |
| Existing browser regression (previous investigation) | **119 passed**; not rerun for this transfer-budget adjustment. |
| Actual source-photo browser download | **Passed**: all ten real R2 photos, 3-page PDF, HTTP 200, 151.127 seconds; isolated database snapshot. |
| New end-to-end browser cases | **16 passed** against real API handlers, real JWT authorization and real PDF generation with disposable in-memory records. |
| Postman follow-up HTTP assertions | **4 passed across 2 requests**: four slow 14 MiB photo downloads return a PDF; a stalled photo returns the expected concise 504. |
| Postman HTTP assertions (previous investigation) | **12 passed across 6 requests**; follow-up checks below cover the revised transfer budget. |
| Production Vite build | **Passed**, output directed to a temporary directory; existing dist files preserved. |
| Scoped lint / diff check | No errors; one pre-existing NotificationBell state-in-effect warning. `git diff --check` passed. |

The browser matrix verifies:

- Teachers receive 200 for list, detail, media and documents routes.
- The Event Manager bell issues no `/teacher/events` request. A deliberate direct
  request using an Event Manager JWT still receives 403.
- Event Manager and Dean reports produce actual downloaded PDF files, with
  `%PDF-` headers and `%%EOF` trailers. GridFS and HTTP-backed R2 photo paths work.
- A local Postman storage simulation serves real image bytes, stalls a response
  body, and continuously trickles bytes. Backend timeouts return JSON errors;
  loading resets and an explicitly customized retry without unavailable photos
  downloads a complete PDF. This retry is a user selection, not silent omission.
- Both roles recover from stalled report headers, incomplete response bodies,
  HTML proxy errors and invalid non-PDF 200 responses. Generate and Cancel are
  re-enabled, the error is visible, and a subsequent real API request downloads.
  Browser timeouts use Playwright's virtual clock to exercise the 300-second
  deadline without waiting five real minutes for each case.
- Selected-photo order, bounded concurrency, truncated photo detection, no report
  status write on failure, and successful retry are covered by backend tests.

There were fixture-only failures during test development (mock response objects
and a response-URL predicate after consolidating the simulation route); these
were corrected. The final executed suites above pass. The 16-case matrix adds four 14 MiB originals served over 28 seconds, beyond
the former 20-second limit, and is rerun after the size-based budget change. Representative error-state
screenshots were inspected.

Postman requests cover Teacher list 200, Event Manager Teacher-list denial 403,
both roles' single PDFs, consolidated R2/GridFS PDF and storage timeout 504.
Expected 4xx/5xx requests may have CLI exit 1 while their assertions pass.
`--no-report-events` / `--no-history` kept tests local; nothing was published.

## Files changed

| File | Purpose |
| --- | --- |
| `frontend/src/components/NotificationBell.jsx` | Gate teacher reminders on the authenticated role. |
| `frontend/src/services/eventManager.js` | Bounded full-request/body await, abort, PDF validation and concise errors. |
| `backend/app/services/report_files.py` | Bounded, closed streaming reads and concurrent ordered photo preparation. |
| `backend/app/routers/event_manager.py` | Use shared preparation and log report phases/timing. |
| `backend/app/routers/reports.py` | Use the same preparation for Dean PDFs. |
| `frontend/tests/unit/reportCustomization.test.js` | Use real PDF Blob fixtures and assert request cancellation signal. |
| `frontend/tests/unit/reportDownload.test.js` | Deadline, body, invalid response, retry and late-response tests. |
| `backend/tests/test_report_download_recovery.py` | Streaming, total read deadline, concurrency, truncated body and PDF retry tests. |
| `backend/tests/report_bugfix_browser_server.py` | Loopback fixture with real JWT/routes/PDF builder; real database handles replaced and closed. |
| `frontend/tests/report-bugfix.spec.js` | Sixteen end-to-end authorization/download/recovery checks, including large originals. |
| `backend/tests/fixtures/report-faults.js` | Local HTTP image/failure dependency for actual network client testing. |
| `backend/tests/fixtures/report-faults.sim.yaml` | Reusable Postman simulation definition. |
| `BUGFIX_REPORT.md` | Findings, fixes, evidence and limitations. |

## Reproduction commands

Start the local dependency simulation from the repository root:

```powershell
postman simulation run backend/tests/fixtures/report-faults.sim.yaml --port 4907 --no-history --output ndjson
```

Start the fixture backend from `backend` (writes only the temporary session file):

```powershell
$env:BUGFIX_SESSION_FILE = "$env:TEMP\srhu-bugfix-sessions.json"
python -m tests.report_bugfix_browser_server
```

From `frontend`, start Vite in one terminal and run tests in another:

```powershell
$env:VITE_API_BASE_URL = 'http://127.0.0.1:8767'
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5183 --strictPort
```

```powershell
$env:PW_BASE_URL = 'http://127.0.0.1:5183'
$env:BUGFIX_SESSION_FILE = "$env:TEMP\srhu-bugfix-sessions.json"
node node_modules/@playwright/test/cli.js test report-bugfix.spec.js --project=chromium
```

## Follow-up: large-photo failure from the supplied screenshot

The error was reproduced on event `6acf6323f080d899096c9d46` (IEEE Day
Celebration 2026). Its ten selected JPEG originals total **135,903,341 bytes**,
with individual files approximately 13-15 MB. The fixed 20-second photo budget
introduced during the earlier hang investigation was too short for these
healthy, actively transferring files. The generic 504 did not establish that
storage was unavailable. A single original downloaded completely in 8.75 seconds;
concurrent report reads and the browser's original-image requests share bandwidth.

A first size-based allowance (about 70-75 seconds for these files) prepared all
ten photos in a read-only builder test, but the detail-page browser run still
exceeded it while loading gallery originals simultaneously. Timeout diagnostics
showed approximately 10-12 MB already received when that allowance expired. The
final allowance accommodates this contention, with a 180-second per-photo cap
and unchanged 10-second socket inactivity timeout. The frontend has a five-minute
overall deadline and retains cancellation, error feedback and finally cleanup.
Selected photos are preserved; a storage timeout still fails instead of quietly
omitting them. Logs now include byte progress, size, elapsed time and exception
class without exposing signed URLs.

The read-only source-data builder produced a **3-page, 2,738,917-byte PDF** in
77.70 seconds with **all ten photographs**. PDF inspection found ten photograph
images on page 2 plus the existing logo on page 1. The photo page was rendered
and visually inspected; all ten are present with their orientations preserved.
The database was only queried. A separate loopback browser fixture uses a snapshot
of the source event/media with every database collection replaced by an in-memory
collection and the real Mongo client closed; it reads the actual R2 originals.
Its report metadata writes therefore cannot touch the live database.

**Final browser result:** the actual event's Report Customization modal generated
and downloaded `IEEE Day Celebration 2026.pdf` successfully in **151.127 seconds**,
with HTTP **200**, **2,738,915 bytes**, **3 pages** and **all ten photos** verified
in the downloaded file. The modal closed, the download control recovered and no
browser page errors occurred. Server logs recorded ten prepared photos at 147.724
seconds and a finished PDF at 149.606 seconds. This exercised the unchanged
frontend payload, actual backend report handler, real R2 originals, PDF builder
and browser download while the detail page loaded its gallery images. Only live
storage reads were performed; application database writes stayed in memory.

A SHA-256 comparison against the follow-up starting worktree confirmed that
only seven existing files changed and no existing files were removed. The initial
and final worktrees each have 130 status entries, including prior untracked work.
Only seven files changed during this follow-up: `report_files.py`,
`eventManager.js`, `test_report_download_recovery.py`,
`report_bugfix_browser_server.py`, `report-faults.js`, `report-bugfix.spec.js`,
and this report. No event/media data, original uploads, schema, authorization,
section-selection rules or unrelated module was changed.

## Safety and remaining limits

Git remains on `main` at `607232cf8d663669ddd56ce3ab45f7740c0bc992`, with the
pre-existing dirty worktree preserved. No pull/merge was attempted over this
dirty tree during the bug fix. No commit, push, stash, reset, dependency upgrade
or unrelated refactor was performed. Only our own loopback test services were
started/stopped; the user's application server was not restarted.

Large reports still depend on transferring the original photographs. The finite
limits intentionally return an error for an unavailable or persistently slow
connection. The complete backend suite and Firefox/WebKit were not run.
Follow-up logs, downloaded PDFs, renders and temporary build output are in
`C:\Users\yc993\AppData\Local\Temp\srhu-photo-fix-xx145u9b`.
