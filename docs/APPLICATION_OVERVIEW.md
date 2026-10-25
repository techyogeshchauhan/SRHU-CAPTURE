# Campus Capture SRHU — Application Overview

A guide for a developer joining this project: what the application is for, who uses it, every feature it has, and how the code is laid out.

*Written 24 October 2026 from the code on `main` (HEAD `9db6a20`). Where the code and an older doc in `docs/` disagree, this document follows the code.*

---

## Contents

1. [Purpose](#1-purpose)
2. [Roles at a glance](#2-roles-at-a-glance)
3. [Core workflows](#3-core-workflows)
4. [Features by role](#4-features-by-role)
5. [Cross-cutting features](#5-cross-cutting-features)
6. [Architecture and tech stack](#6-architecture-and-tech-stack)
7. [Repository layout](#7-repository-layout)
8. [Data model](#8-data-model)
9. [API map](#9-api-map)
10. [Local setup](#10-local-setup)
11. [Configuration reference](#11-configuration-reference)
12. [Testing](#12-testing)
13. [Deployment](#13-deployment)
14. [Maintenance scripts](#14-maintenance-scripts)
15. [Conventions and pitfalls](#15-conventions-and-pitfalls)
16. [Known gaps and loose ends](#16-known-gaps-and-loose-ends)
17. [Further reading](#17-further-reading)

---

## 1. Purpose

**Campus Capture** is a web application for **Shri Ram Himalayan University (SRHU)**, School of Science & Technology (SST). It does two things:

1. **Event documentation and approval.** Faculty record the academic, cultural and other events they run, and upload the photos, videos and documents (notices, reports) that prove them. The Dean reviews each event: approves it, rejects it, revokes an approval or asks for changes. Approved events can be turned into a formal **PDF report** on the university letterhead.
2. **Research portfolio.** Faculty research (journal papers, conference papers, patents, books and other achievements), each record backed by evidence files. The Dean verifies it, and the portfolio can be exported, including as a **NAAC Criterion III** workbook.

The goal is one verified, searchable record of what the school did, for accreditation (NAAC/NIRF), annual reports and the Dean's oversight. Today that information is scattered across email and shared drives.

The platform serves **SST only**. There is no department registry. Every event is hosted by `DEFAULT_HOST_DEPARTMENT` (default `SST`).

---

## 2. Roles at a glance

There are four roles, stored in `users.role`. Each person holds exactly one. There is **no `admin` role**: it was renamed to `superadmin`, and `scripts/migrate_admin_to_superadmin.py` migrates old data.

| Role | Key | How the account is created | Home page | What they do |
|---|---|---|---|---|
| **Teacher** | `teacher` | Self-registers and verifies their email, or is invited by a Dean, or is bulk-onboarded by the Super Admin | `/teacher/dashboard` | Proposes events and submits them for Dean approval. Keeps their own research portfolio. |
| **Event Manager** | `event_manager` | Created by the Super Admin, who sends an invite link | `/event_manager/dashboard` | Records events (also Dean-approved), **generates event PDF reports**, manages event types, and keeps the research portfolio **for every teacher** |
| **Dean** | `dean` | Created by the Super Admin with a temporary password, or a teacher promoted by a Dean | `/dean/dashboard` | Reviews events, verifies research, manages teacher accounts, generates reports, browses the gallery |
| **Super Admin** | `superadmin` | `scripts/create_superadmin.py` | `/superadmin/dashboard` | Manages accounts, upload limits, the audit log and the system-wide event list |

Frontend role colours and labels are in `frontend/src/components/common/roles.js`. Route guarding is done by `ProtectedRoute` (`allowedRoles`) on the client and by `require_role` / `dean_dep` / `superadmin_dep` on the server.

---

## 3. Core workflows

### 3.1 Event lifecycle (Teacher → Dean)

```
 Teacher                          Dean
 ───────                          ────
 draft ──submit──► pending ──┬─approve────────► approved ──stage──► completed
   ▲                         ├─reject─────────► rejected
   │                         └─request changes► (pending, with remarks)
   │                                   approved ──revoke──► revoked
   └──── edit + resubmit ◄── rejected / revoked / changes requested
```

- **Statuses** (`backend/app/models/documents.py`): `draft · submitted · pending · under_review · approved · in_progress · completed · published · rejected · revoked`. Event Manager events can also carry the legacy `recorded` status.
- The status sets that drive behaviour:
  - `TEACHER_EDITABLE_STATUSES`: the teacher may still edit or delete the event.
  - `APPROVED_STAGES` (`approved, published, in_progress, completed`): gates reports and revocation.
  - `DEAN_PROGRESS_STAGES` (`approved, completed`): the delivery stages. `in_progress` is legacy.
- **Reject ≠ revoke.** *Reject* means the event was never approved. It is only possible from a reviewable status and writes `rejection_reason`. *Revoke* withdraws an existing approval. It is only possible from an approved stage and writes `revocation_reason` and `revoked_at`. Do not merge the two.
- **Archiving is not a status.** It sets `archived_at`, and the event keeps its status. Restoring clears `archived_at`.
- Every transition appends to the event's embedded `history` array. The teacher sees this history as "Event progress".
- Drafts are never visible to the Dean. Archived events are hidden from normal Dean lists.
- The Dean can **approve directly out of `rejected`/`revoked`** to reconsider a refusal, without waiting for a resubmission.

### 3.2 Event Manager events

The Event Manager uses **the same screens as the Teacher** (see `PanelProvider` / `EVENT_MANAGER_PANEL` in `frontend/src/components/teacher/panelConfig.js`). The differences are:

- Events live in their own collections (`managed_events`, `managed_event_media`, `managed_event_documents`) and API (`/event-manager/...`).
- Events still go through Dean approval: draft → pending → Dean decision. The Dean sees them alongside teacher events, can filter by source, and can review, archive or delete them.
- **Event Managers generate PDF reports themselves.** Teachers cannot. Every event created now carries a server-set `report_approval_required: true`, so a report is available only in an approved stage. Older approved or `recorded` events keep their report access. The full contract is in `docs/EVENT_MANAGER_REPORT_APPROVAL.md`.
- An Event Manager event can have **multiple organizers**, picked from the coordinator directory or added as guests. They are stored as an `organizers` array plus a `; `-joined `organizer` string. See `EVENT_ORGANIZERS_CHANGES.md`.
- An Event Manager can **rename or delete custom event types**. When a type is deleted, its events are moved to a chosen destination type in one MongoDB transaction, which needs a replica set. See `docs/EVENT_TYPE_MANAGEMENT.md`.

### 3.3 Research lifecycle

```
 draft ──submit──► submitted ──┬─verify──────────► verified ──unverify──► (back for review)
   ▲                           ├─request changes─► changes_requested
   │                           └─reject──────────► rejected
   └──────── edit + resubmit ◄─┘
```

- **Verification** (draft/submitted/verified...) and **outcome** (for example a patent's filed → published → granted) are separate fields and must never be merged.
- A record belongs to a faculty member (`faculty_id`) and remembers who entered it (`created_by`).
- **What an Event Manager submits is recorded immediately as `verified`**, with `verified_by.role == "event_manager"`. The Dean has no decision to make on it. The same goes for any record the Event Manager has *handled*: entered it, edited it, added evidence or acted on it (`handled_by_manager`). At startup, `_settle_manager_research()` records any older Event Manager submissions still waiting for the Dean.
- **Only a teacher's own, untouched submission goes to the Dean** for a decision.
- **Current product decision (Oct 2026): no verification step in the Dean's UI for now.** The Dean's Research page lists only Event Manager records (`status=event_manager`) and shows no verification status. The decision screen still exists on the record page, so a teacher's submission can be decided by following its notification link. See §16.
- When an Event Manager deletes a non-draft record, it is only hidden from the Event Manager (`manager_removed_at`) and stays visible to the Dean. Drafts are deleted for good.
- A teacher can **flag** a record an Event Manager entered for them as wrong. Whoever entered it is notified.
- Deletion is only allowed from `draft` or `rejected`. The Dean can also delete records.
- **Categories** (`backend/app/services/research_categories.py`) are served to the forms by `GET /research/categories`. The frontend never keeps its own copy.

  | Key | Label | Outcomes |
  |---|---|---|
  | `journal` | Journal publication | accepted · in press · published |
  | `conference` | Conference paper / presentation | accepted · presented · published in proceedings |
  | `patent` | Patent | filed · published · granted · refused · abandoned |
  | `book` | Book / book chapter | accepted · published |
  | `other` | Other achievement | recorded |
  | `project` *(legacy, read-only)* | Research project / grant | — |

- **Reminders** (`research_reminders.py`) flag outcomes that are probably out of date, such as a patent pending for more than 18 months or a paper still "in press". They appear in an "Outcomes due" panel and as notifications.

---

## 4. Features by role

### 4.1 Teacher

| Area | Features |
|---|---|
| **Account** | Register (name, email, designation, password) → email verification link → sign in. Forgot/reset password. Accept a Dean's invitation link to set a password. Edit profile (name, phone, department). Change password. |
| **Dashboard** | Their event counts by status, recent events, notifications. |
| **Create Event** (3-step wizard) | **Details**: name, type (pick one, or add a new type inline), dates, 12-hour start/end time picker, venue, description, No. of Participants, social-media link, faculty coordinator (autocomplete from the directory, auto-fills the mobile number, can add a new coordinator to the directory). **Images & Documents**: up to 10 photos plus documents. **Videos**: up to the combined size cap. Past dates and times are rejected (in Asia/Kolkata time). Save as draft or submit. The wizard warns about duplicate file names (a warning only; storage keys can never collide). The Super Admin can make photos, videos or documents mandatory before submission. |
| **Drafts** | Saved in the browser (`utils/draftStorage.js`) and/or on the server (`save_as_draft`). Bulk submit and bulk delete. |
| **My Events** | Filterable, paginated list. Edit or withdraw while editable. Resubmit after rejection, revocation or a change request. Duplicate an event into a new draft. |
| **Event Details** | All fields, media gallery with lightbox, documents, progress timeline showing the Dean's remarks, and report-photo selection (choose which photos appear in the PDF). |
| **Research** | Own portfolio: create or edit records (with "Fill from DOI" lookup and a duplicate warning), attach evidence files, submit to the Dean, see the Dean's decision and history, export their register to Excel, download their research CV (PDF). |
| **Notifications** | Bell with unread count. Read, read all, clear. Emails are also sent for Dean decisions. |

### 4.2 Event Manager

Everything the Teacher panel offers for events (same UI), plus:

| Area | Features |
|---|---|
| **Reports** | "Download Report" on the dashboard, My Events and Event Details. Opens the **Report Customization** modal (see 5.4), then generates a PDF. Multiple events can be selected for a **consolidated report**. Disabled (not hidden) for ineligible events. |
| **Organizers** | Multi-select organizer chips (up to 20). |
| **Event types** | "Manage" next to the type picker: rename or delete types they created (built-in types are protected), with usage counts and a mandatory destination type when deleting. |
| **Research** | Sees and maintains **every** teacher's records. Can add a faculty member (which creates and invites a teacher account), bulk-record drafts, bulk-delete, and filter by category (`/event_manager/research/category/:category`). Records are verified as soon as they are submitted. |

### 4.3 Dean

| Area | Features |
|---|---|
| **First login** | A Dean created with a temporary password (`must_change_password`) is sent straight to the profile page to set a new one. |
| **Dashboard** | KPI cards, "Programs by type" chart, a **review queue** tab (pending events, with inline approve/reject). |
| **All Events** | Teacher and Event Manager events together, with source shown and filterable. Status tabs with server-side counts, search, event type, date range, pagination, select-all across pages (`/dean/events/ids`). Bulk archive and bulk delete. Row and bulk report downloads. |
| **Event Details** | Approve (with remarks), reject (with reason), revoke (with reason), request changes, move to *completed*, archive or restore, permanent delete, edit the social-media link, view uploaded documents, generate or download the report (customizable). |
| **Archive** | The archived events, with restore. |
| **Gallery** | Photo and video albums, one per event, newest first. Period filter, Photos/Videos filter, album dialog with zoom, filmstrip and download. |
| **Research** | The records the Event Manager has submitted, with no verification status. Five clickable KPI cards (`/dean/research/overview`), category pages (`/dean/research/category/:category`), a research-date period filter plus a custom date range, and search and filters. Record details with evidence. Delete (single or bulk). Download any faculty member's research CV. The record page also has a decision box (**verify / request changes / reject / unverify**) for a teacher's own submission, reached from its notification. A Dean cannot decide on their own record. |
| **Teachers** | Teacher accounts only. List with search and status. **Add** a teacher (sends an invitation email; the Dean never sees or sets a password). **Import** a roster from `.xlsx`/`.csv` with a preview step (column headers can be in any order or missing; 500 rows max). Resend invite, edit, activate/deactivate, **remove/restore** (hidden and signed out, data kept), permanent delete (only for teachers with no events), bulk remove/delete, **send a password-reset link**, **promote to Dean**, and an activity feed of Dean-panel actions. |

### 4.4 Super Admin

| Area | Features |
|---|---|
| **Dashboard** | System KPIs and analytics charts (Recharts): events by status bucket, by type, over time, users by role. Counts include Event Manager events, exclude drafts and archived events. |
| **Events** | Every event in the system, with the same filters as the Dean. Delete. **CSV export** (`events_naac_nirf_<date>.csv`) honouring the current filters, with options to include drafts and archived events. |
| **User Management** | All users. Make Dean / make Teacher, activate/deactivate, edit profile, reset password (temporary password emailed), delete (cascades their data). **Bulk onboard teachers** from a pasted list or an uploaded file, and send credentials. |
| **Create Dean** | Creates the account and emails a temporary password. |
| **Create Event Manager** | Creates the account and emails an invite link (can be resent). |
| **Audit Logs** | Filterable log of sensitive actions (user changes, deletions, bulk operations, Dean-panel actions tagged `via: dean_panel`). |
| **Settings** | Upload limits in three tabs: **Uploads** (photo count and size, video per-file and total size, optional video count), **Documents** (count, total MB), **Research** (evidence files, total MB). Toggles for which kinds are **mandatory** (photos, videos, documents, research evidence). Bounds come from the API. "Reset to defaults" drops the override. Cached server-side for 30 s. |

---

## 5. Cross-cutting features

### 5.1 Authentication and sessions

- JWTs (HS256) are issued by the API (`app/utils/security.py`, `app/routers/auth.py`).
- **Idle timeout:** 30 minutes by default (`SESSION_IDLE_MINUTES`). The frontend calls `/auth/refresh` only while the user is active. A session can never be renewed past `SESSION_MAX_AGE_DAYS` (30) after the password was last entered.
- `token_version` on the user is embedded in tokens. Incrementing it signs the user out everywhere. Logout, password reset and change, and account changes such as promotion or removal all do this.
- In-memory rate limiting on auth endpoints, per IP and per email (`RATE_LIMIT_ENABLED`).
- Email verification is required (`REQUIRE_EMAIL_VERIFICATION`). Unverified sign-ins are refused, and verification can be resent.
- `/login` and `/register` are `PublicOnlyRoute`s. Reaching them with Back/Forward while signed in ends the session (`EndSessionOnHistoryReturn`).
- After login, a stored "from" location is honoured only when it is inside the user's own role area (`postLoginPath`).

### 5.2 Uploads and storage

| Kind | Default limit | Accepted formats |
|---|---|---|
| Photos | 10 per event, 20 MB each | JPG, PNG, WEBP, GIF |
| Videos | 200 MB combined per event (per-file cap 200 MB) | MP4, WEBM, MOV |
| Documents | 15 MB combined, max 50 files | PDF, DOC/DOCX, XLS/XLSX, PPT/PPTX, TXT, CSV |
| Research evidence | 5 files, 10 MB combined per record | photos + documents |

- Every file is checked three ways: its **extension**, its **declared MIME type**, and its **magic bytes**. The stored content-type is always the canonical one. SVG and HTML are never accepted.
- **Storage backend:** Cloudflare **R2** when `R2_*` variables are set, otherwise MongoDB **GridFS**. The switch is inside `storage_service.save_upload()`. R2 objects are private and served through pre-signed URLs. GridFS files are served from `/files/{id}` with HMAC-signed links.
- **Direct uploads:** with R2 configured, the browser uploads straight to R2 using pre-signed multipart part URLs (`services/directUpload.js` ↔ `services/direct_upload.py`). The flow is: start (validate and check caps) → sign parts → complete (verify size, type and magic bytes, then record). Abandoned upload sessions are swept. When R2 is not available, files are posted through the API.
- Uploads are **streamed** (`stream_upload` spools to disk past 2 MB). Never read a whole upload into memory.
- Caps are enforced **twice**: before the upload and again after the insert, to handle concurrent uploads.
- The Super Admin can change the limits at runtime (5.4 above). The frontend reads them from `GET /upload-limits`.

### 5.3 Notifications and email

- **In-app:** the `notifications` collection, per user, shown in the bell (`NotificationBell.jsx`). Notifications expire through a TTL index on `expires_at`. Types cover event decisions (`approved`, `rejected`, `revoked`, `needs_changes`, `progress`), the Dean's queue (`submitted`, `resubmitted`), and research (`research_verified`, `research_changes`, `research_flagged`, `research_reminder`, ...).
- **Email** (`app/services/email_service.py`, SMTP): verification, password reset, invitations (teacher and Event Manager), Dean/teacher credentials, event status changes, research status changes, and a notice when someone tries to register with an address that already exists.
- `EMAIL_DELIVERY_ENABLED=false` writes every message to `EMAIL_OUTBOX_DIR` as `.eml` files instead of sending it. Use this for development; those files contain live links.

### 5.4 Event PDF reports

- Built with ReportLab: `services/report_pdf.py` (letterhead, styles, Devanagari font support) and `services/managed_report_pdf.py` (event entries, justified photo grid, attachment links).
- The letterhead shows the SRHU name and `REPORT_SCHOOL`. Reports include the approval record and a reference number, and pages are numbered.
- **Report Customization modal** (`ReportCustomizationModal.jsx`). There are seven sections, each available only if the event has data for it: Event Details & Organization · Date, Time & Venue · Description & Objectives · Participation & Social Links · Photographs · Uploaded Notices · Uploaded Attachments. A photo selection can be passed in. Consolidated reports offer a section if any selected event has data for it. See `docs/REPORT_CUSTOMIZATION_CHANGES.md`.
- Who can generate reports: the **Dean** (any approved, non-archived event: `/dean/events/{id}/generate-report`, or several at once via `/dean/reports`) and the **Event Manager** (their own eligible events). A social-media link is optional.
- Attachment links printed in a report are long-lived signed links (`REPORT_LINK_EXPIRY_DAYS`, default 365).

### 5.5 Research tools

| Tool | Endpoint(s) | Who | In the UI? |
|---|---|---|---|
| DOI lookup ("Fill from DOI") | `GET /research/doi` | Teacher, Event Manager | Yes, in the research form |
| Duplicate check | `POST /research/duplicates` | Teacher, Event Manager | Yes, in the research form |
| Register export (.xlsx) | `GET /research/export.xlsx`, `/dean/...` | Dean, Event Manager (all), Teacher (own) | Yes, on the Teacher/Event Manager Research page |
| Research CV (PDF) | `GET /research/faculty/{id}/cv.pdf`, `/dean/...` | Dean (anyone), Teacher (self) | Yes |
| Outcomes due / reminders | `GET /research/outcomes-due`, `POST /research/reminders/check` | Teacher, Event Manager | Panel yes; the reminder check is API-only |
| NAAC Criterion III workbook | `GET /research/export/naac.xlsx`, `/dean/...` | Dean, Event Manager | **Not reachable** (see §16) |
| Analytics | `GET /research/analytics`, `/dean/...` | Dean, Event Manager, Teacher | **Not reachable** (see §16) |
| Showcases (curated collections of verified records sent to the Dean, with PDF) | `/research/showcases...`, `/dean/research/showcases...` | Authors build, Dean views | **Not reachable** (see §16) |
| Spreadsheet import | `/research/import/template.xlsx`, `/research/import/preview`, `/research/import` | Event Manager | **Not reachable**: the route redirects |

### 5.6 Audit and logging

- **Audit trail** (`audit_logs` collection, `services/audit_service.py`): application data, shown on the Super Admin's Audit Logs page and the Dean's activity panel.
- **Application logs:** stdout plus size-rotated files under `LOG_DIR` (`app.log`, `error.log`, `access.log`, `audit.log`). Never stored in MongoDB.
- `GET /health` returns `{"status": "ok"}` or `{"status": "degraded"}`, always with HTTP 200. The reasons go only to the server log.

### 5.7 UI conventions

- Dates are shown as **DD-MM-YYYY** (`DateInputDMY`) and times in 12-hour format (`TimePicker12h`). They are stored as `"YYYY-MM-DD"` and `"HH:MM"` strings.
- Light and dark themes (`data-theme` on `<html>`), applied before first paint by a script in `index.html`.
- Each role area is lazy-loaded, so a teacher never downloads the Dean or Super Admin code.
- The "Himovation" design: an SRHU Prussian Blue header and sidebar forming one L-shaped piece, with the Sora and Inter fonts. See `docs/himovation-theme-spec.md` and `.claude/skills/campus-capture-theme/SKILL.md`.

---

## 6. Architecture and tech stack

```
 Browser (React SPA, served by nginx)
     │  HTTPS + Bearer JWT                    direct multipart PUT (pre-signed)
     ▼                                                  │
 FastAPI (behind nginx, run.py) ────────────────────────┼──► Cloudflare R2 (media, docs)
     │                                                  │
     ├──► MongoDB (Atlas / replica set)  users, events, research, notifications,
     │                                   audit, GridFS fallback for files
     └──► SMTP                           all outbound email
```

| Layer | Technology |
|---|---|
| Frontend | React 19, React Router 7, Vite 8, Tailwind CSS 4 (configured in CSS, no `tailwind.config.js`), Axios/fetch, Recharts. Plain JavaScript/JSX, no TypeScript. Linted with Oxlint. |
| Backend | Python 3.14, FastAPI, Uvicorn, Pydantic v2 + pydantic-settings, **synchronous PyMongo** (raw collections, no ODM), PyJWT, bcrypt, ReportLab (PDF), openpyxl (Excel), Pillow, boto3 (R2), httpx (DOI lookup) |
| Database | MongoDB. Event-type management needs transactions, so production should be a replica set (Atlas is one). |
| File storage | Cloudflare R2 (preferred) or GridFS |
| Hosting | Own server: the API as a systemd service (`python run.py`) behind nginx; nginx serves the built frontend with an SPA fallback to `index.html` |
| Tests | Backend: stdlib `unittest`. Frontend: Vitest (unit) and Playwright (e2e, Chromium) |

---

## 7. Repository layout

```
SRHU-CAPTURE/
├── backend/
│   ├── app/
│   │   ├── main.py            FastAPI app, middleware (CORS, no-store cache), routers, /health
│   │   ├── config.py          All settings (env / .env), see §11
│   │   ├── database.py        Mongo client, collections, ensure_indexes()
│   │   ├── models/documents.py  Roles, statuses, document builders: the domain source of truth
│   │   ├── routers/           auth, users, events (Teacher + Dean), event_manager, reports,
│   │   │                      dean_teachers, directory (event types, coordinators),
│   │   │                      files, research, research_tools, research_showcases, superadmin
│   │   ├── schemas/           Pydantic request models (validators never touch MongoDB)
│   │   ├── services/          storage, R2, direct upload, email, PDFs, research
│   │   │                      categories/analytics/DOI/reminders/spreadsheets, teacher import,
│   │   │                      upload config, audit, event types
│   │   └── utils/             auth deps, security (JWT, hashing), rate limit, serializers
│   ├── scripts/               init_db, create_superadmin, migrations, seeds, R2 config, ...
│   ├── tests/                 unittest suites + in-memory fakes + browser fixture servers
│   ├── run.py                 Entrypoint (0.0.0.0:8000, or $PORT in production)
│   └── requirements.txt
├── frontend/
│   ├── src/
│   │   ├── App.jsx            All routes (lazy role areas)
│   │   ├── context/AuthContext.jsx   Session state, refresh, idle sign-out
│   │   ├── pages/{auth,teacher,dean,superadmin}/
│   │   ├── components/{common,teacher,dean,superadmin,research,theme,landing}/
│   │   ├── services/          API clients (api.js, research.js, directUpload.js, ...)
│   │   ├── hooks/ utils/      Shared logic (uploadRules mirror backend limits, dates, ...)
│   │   └── index.css          Theme tokens + component classes
│   └── tests/                 Playwright specs + tests/unit (Vitest)
├── docs/                      PRD changes, feature change logs, bug reports, theme spec
└── .claude/skills/            Short project rule sheets (API, domain, theme, uploads); read these
```

Event Manager pages are the Teacher pages: `pages/teacher/*.jsx`, wrapped in `<PanelProvider panel={EVENT_MANAGER_PANEL}>`. Read `usePanel()` to see where behaviour differs.

---

## 8. Data model

MongoDB collections, declared in `backend/app/database.py`:

| Collection | Contents |
|---|---|
| `users` | name, email (unique), password_hash, role, phone, designation, department, is_active, email_verified, must_change_password, token_version, token hashes (verification, reset, invite) |
| `events` | Teacher events: `teacher_id`, fields, `status`, `archived_at`, embedded `history`, decision reasons, report-photo choice |
| `event_media`, `event_documents` | Upload metadata for teacher events (the bytes are in R2 or GridFS) |
| `managed_events`, `managed_event_media`, `managed_event_documents` | Event Manager events (`owner_id`) and their uploads |
| `event_reports` | Generated report state per event |
| `event_types` | Event categories (built-in seeds + custom), with `aliases` for renamed types |
| `faculty_coordinators` | Coordinator directory: name + mobile (contact cards, not accounts) |
| `notifications` | Per-user in-app notifications (TTL on `expires_at`) |
| `upload_config` | The Super Admin's upload-limit overrides |
| `upload_sessions` | Direct-to-R2 uploads in progress |
| `research_records` | Research records with embedded evidence and history |
| `research_showcases` | Curated record collections |
| `audit_logs` | Audit trail |
| `departments` | Legacy; the department registry was removed |
| `uploads.files` / `uploads.chunks` | GridFS bucket |

Fields that must never leave the server are listed in `USER_PRIVATE_FIELDS`. Indexes, including TTL indexes, are created at startup by `ensure_indexes()` (idempotent, retried in the background if MongoDB is down) and by `scripts/init_db.py`.

---

## 9. API map

The interactive docs are at **`/docs`** (Swagger) and `/redoc` on a running backend. The main groups:

| Prefix | Router | Purpose |
|---|---|---|
| `/auth/*` | `auth.py` | register, verify-email, resend-verification, login, me, refresh, logout, forgot/reset-password, accept-invite |
| `/users/me*` | `users.py` | profile read/update, change password |
| `/teacher/events*` | `events.py` | Teacher CRUD, resubmit, bulk submit/delete, media/documents, direct uploads, report photos |
| `/dean/events*`, `/dean/dashboard/stats`, `/dean/archive/events`, `/dean/gallery*` | `events.py` | Dean review: list/ids/details, approve/reject/revoke/request-changes/stage, archive/restore, delete, bulk archive/delete, gallery |
| `/dean/events/{id}/report-status`, `/social-link`, `/documents`, `/generate-report`, `/dean/reports`, `/reports/files/*` | `reports.py` | Dean report generation |
| `/dean/teachers*` | `dean_teachers.py` | Teacher account management, import, invite, promote |
| `/event-manager/*` | `event_manager.py` | Event Manager events, uploads, reports, signed file access |
| `/event-types*`, `/faculty/coordinators` | `directory.py` | Event type catalogue and management; coordinator directory |
| `/notifications*` (+ legacy `/teacher/notifications*`) | `events.py` | Notification bell |
| `/upload-limits` | `events.py` | Effective upload limits for the forms |
| `/files/{id}` | `files.py` | GridFS file serving (signed, supports Range) |
| `/research/*`, `/dean/research/*` | `research.py`, `research_tools.py`, `research_showcases.py` | Research records, Dean decisions, tools, showcases |
| `/superadmin/*` | `superadmin.py` | Dashboard stats/analytics, users, Deans, Event Managers, upload limits, audit logs, events + CSV export, bulk onboarding |

**Conventions:**

- `events.py`, `reports.py`, `directory.py` and the research routers use **literal paths with no router prefix**. The frontend hardcodes them.
- List responses look like `{ items..., total, count, has_more, skip, limit, counts }`. `total` is the size of the whole result set and `count` the size of the page. Use `paginate()`.

See `.claude/skills/campus-capture-api/SKILL.md` for the full list of conventions.

---

## 10. Local setup

**Prerequisites:** Python 3.14, Node 20+, and a local MongoDB (a single-node replica set if you want to test event-type rename/delete).

```powershell
# Backend
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
# create backend\.env (see §11; there is no .env.example in the repo)
.venv\Scripts\python scripts\init_db.py                 # indexes + default event types
.venv\Scripts\python scripts\create_superadmin.py --email you@example.com --name "Super Admin"
.venv\Scripts\python run.py                             # http://localhost:8000

# Frontend
cd frontend
npm install
# frontend\.env:  VITE_API_BASE_URL=http://localhost:8000
npm run dev                                              # http://localhost:5173
```

A minimal `backend/.env` for development:

```env
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB_NAME=campus_capture
JWT_SECRET_KEY=change-me-to-a-long-random-string
FRONTEND_URL=http://localhost:5173
REQUIRE_EMAIL_VERIFICATION=false     # or configure SMTP
EMAIL_DELIVERY_ENABLED=false         # write emails to ./email_outbox instead of sending
```

Then sign in as the Super Admin, create a Dean and an Event Manager, and register a teacher.

**Testing from a phone on the same Wi-Fi:** `run.py` binds to `0.0.0.0`. Set `CORS_ORIGIN_REGEX` to the LAN pattern documented in `config.py` (`LAN_CORS_ORIGIN_REGEX`), allow the port through the firewall (`scripts/allow-lan-firewall.ps1`), and open `http://<your-LAN-IP>:5173`. Never use the LAN pattern in production.

**Demo data:** `scripts/seed_research_demo.py` and `scripts/seed_research_ui_demo.py` create tagged demo research records, and matching `cleanup_*` scripts remove them. Run them only against a local database.

---

## 11. Configuration reference

The backend reads all settings from environment variables or `backend/.env` (`app/config.py`). The most important ones:

| Variable | Default | Notes |
|---|---|---|
| `MONGODB_URI`, `MONGODB_DB_NAME` | `mongodb://localhost:27017`, `campus_capture` | |
| `JWT_SECRET_KEY` | **required** | at least 16 characters |
| `FRONTEND_URL` | **required** | origin used in email links and CORS; must be https in production |
| `CORS_ORIGINS`, `CORS_ORIGIN_REGEX` | — | extra allowed origins / a pattern (e.g. a second site origin) |
| `SESSION_IDLE_MINUTES`, `SESSION_MAX_AGE_DAYS`, `ACCESS_TOKEN_EXPIRE_MINUTES` | 30, 30, 10080 | session policy |
| `REQUIRE_EMAIL_VERIFICATION` | true | needs SMTP |
| `SMTP_HOST/PORT/USER/PASSWORD/FROM_EMAIL/FROM_NAME`, `SMTP_USE_TLS`, `SMTP_USE_SSL` | port 587, STARTTLS | |
| `EMAIL_DELIVERY_ENABLED`, `EMAIL_OUTBOX_DIR` | true, `email_outbox` | false = write `.eml` files instead of sending |
| `MAX_*` upload settings | see §5.2 | defaults only; the Super Admin's settings override them at runtime |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_URL` | — | all four credentials enable R2; otherwise GridFS |
| `R2_DIRECT_UPLOAD_ENABLED` | true | browser → R2 multipart uploads |
| `REPORT_SCHOOL`, `DEFAULT_HOST_DEPARTMENT`, `REPORT_LINK_EXPIRY_DAYS` | SST defaults, 365 | report content |
| `LOG_LEVEL`, `LOG_TO_FILES`, `LOG_DIR`, `LOG_FILE_MAX_MB`, `LOG_FILE_BACKUP_COUNT` | INFO, true, `logs`, 10, 5 | |
| `RATE_LIMIT_ENABLED` | true | turn off only for load tests |

The frontend has a single variable: **`VITE_API_BASE_URL`**. It is baked in at build time, so rebuild after changing it.

---

## 12. Testing

```powershell
# Backend (from backend/). Uses a throwaway test database, never the one in .env.
.venv\Scripts\python -m unittest discover -t . -s tests

# Frontend (from frontend/)
npm run test:unit      # Vitest
npm run test:e2e       # Playwright (Chromium); several specs start fixture servers from backend/tests/*_browser_server.py
npm run lint           # Oxlint
npm run build
```

- Tests redirect MongoDB to a disposable database (`tests/__init__.py`, `TEST_MONGODB_URI`). To opt out on purpose, set `ALLOW_TESTS_ON_CONFIGURED_DB=1`.
- The collection fakes (`FakeEvents`, `FakeFiles`, `FakeEventTypes`, ...) support `find` with simple operators but **not aggregation pipelines**. In route code, prefer `find()` plus Python sums so it stays testable.
- `EVENT_PAYLOAD` in the tests computes a future date. Never hardcode an event date, because past dates are rejected.

---

## 13. Deployment

The full walk-through is in `backend/README.md` § *Deploying*. In short:

1. **MongoDB Atlas** (or another replica set). Allow the server's IP to connect.
2. **Backend**: a virtualenv from `backend/requirements.txt`, the variables from §11 in `backend/.env`, and `python run.py` as a systemd service with `PORT` set (auto-reload off, nginx's proxy headers trusted). Health check: `/health`. The server needs outbound SMTP (usually port 587) for email.
3. **Frontend**: `npm run build` with `VITE_API_BASE_URL` set to the API's own hostname, then serve `frontend/dist` from nginx with `try_files $uri /index.html`. `FRONTEND_URL` is the site's https origin.
4. **R2** (optional): run `python scripts/configure_r2.py --apply` to set the bucket CORS rule and the lifecycle rule for abandoned uploads. Re-run it whenever the frontend origins change.
5. Create the first Super Admin by running `scripts/create_superadmin.py` with `MONGODB_URI` pointed at production.

---

## 14. Maintenance scripts

All in `backend/scripts/`:

| Script | Purpose |
|---|---|
| `init_db.py` | Create indexes and seed default event types |
| `create_superadmin.py`, `create_event_manager.py` | Provision privileged accounts |
| `migrate_admin_to_superadmin.py` | One-time role rename (idempotent) |
| `migrate_in_progress_to_approved.py` | Move legacy `in_progress` events to `approved` |
| `repair_imported_teacher_names.py` | Fix names from older roster imports |
| `record_event_manager_research.py` | Mark Event Manager research submissions as recorded (also done at startup) |
| `configure_r2.py` | R2 bucket CORS and lifecycle rules (dry run unless `--apply`) |
| `sweep_upload_sessions.py` | Clean up abandoned direct uploads (the API also does this itself) |
| `smtp_diagnostic.py` | Check SMTP reachability and credentials |
| `setup_verify_test_tokens.py` | Test helper for email verification |
| `seed_*` / `cleanup_*` / `import_research_dashboard_test.py` | Demo and test data. **Local database only.** |
| `allow-lan-firewall.ps1` | Open ports 8000/8001 to the local subnet on Windows |

---

## 15. Conventions and pitfalls

These are the rules that past bugs came from. Each one is expanded in `.claude/skills/*/SKILL.md`.

- **Status vs. archive:** never write `status: "archived"`. Use `archived_at`.
- **Reject vs. revoke:** these are separate verbs, separate starting statuses and separate reason fields. To add a new Dean verb, add it to `DEAN_VERBS`.
- **Dates:** `"YYYY-MM-DD"` and `"HH:MM"` strings, compared **as strings**. "Today" is calculated in `Asia/Kolkata` (`campus_now()`), not UTC.
- **Validators never touch MongoDB.** Check shape in the schema and look data up in the router.
- **Limits live in two places.** `backend/app/config.py` / `upload_config_service.py` and `frontend/src/utils/uploadRules.js` must agree. So must the phone rules in `schemas/common.py` and `utils/phone.js`.
- **Uploads must stream.** Never read a whole file into memory.
- **Research categories are server-owned.** Never copy them into the frontend.
- **Colours** are RGB-triplet CSS tokens in `index.css`. Never hardcode a hex value in a component, and check both themes after any change.
- **No new npm dependencies for styling.** Icons are the inline SVGs in `components/teacher/icons.jsx`.

---

## 16. Known gaps and loose ends

Found while writing this document. Worth checking before building on these areas:

1. **Teacher research submissions have no list on the Dean's side.** The Dean's Research page shows only Event Manager records (an intentional "no verification for now" decision). A teacher's own submission sits in `submitted` and can only be opened from the Dean's notification. The teacher module was left to be "handled later". Decide this before extending the research workflow.
2. **Research Analytics, Showcases and the NAAC export have no route in the UI.** The backend endpoints exist and are tested, and so do the pages (`pages/{dean,teacher}/ResearchAnalytics.jsx`, `ResearchShowcase(s).jsx`) and `components/research/ResearchAnalytics.jsx` / `ShowcaseView.jsx`. But `App.jsx` registers no routes for them: `/dean/research/analytics` and `/event_manager/research/analytics` redirect to the Research list, and `ResearchNav` only shows "Records". The NAAC export button lives in the unrouted analytics component, so it is unreachable as well. Either wire them up or remove them.
3. **Research spreadsheet import** (`/research/import*`) has backend support, but its UI route redirects away.
4. **`POST /dean/research/bulk-verify`** and **`GET /dean/research/summary`** have no frontend callers.
5. **`backend/README.md`** tells you to copy `.env.example`, but that file is not in the repository. It also says `/health` reports `"database": "connected"`, while the endpoint actually returns only `{"status": "ok" | "degraded"}`.
6. **Event-type rename/delete needs MongoDB transactions.** On a standalone `mongod` it fails safely with a 503. Use a replica set locally if you work on it.
7. **`docs/REPORT_CUSTOMIZATION_CHANGES.md`** records two backend test failures that predate it (`GenerateWithoutSocialLinkTests.test_generated_body_says_not_provided`, `ReportAttachmentChoiceTests.test_empty_description_still_has_its_section`). Their expectations conflict with the current missing-data behaviour. Re-run the suite to see whether they still fail.
8. The `departments` collection and the `/superadmin/departments` route are leftovers. The route now redirects to the dashboard.

---

## 17. Further reading

| Document | Covers |
|---|---|
| `backend/README.md` | Setup, logs, collections, deployment on your own server (nginx) in detail |
| `.claude/skills/campus-capture-*/SKILL.md` | Short rule sheets: API, domain, theme, uploads |
| `docs/PRD-changes.md` | The original change requirements (18 Sep 2026) |
| `docs/AGENT-HANDOVER-CHANGELOG.md` | Gallery redesign, Research/Gallery merge, terminology changes |
| `docs/EVENT_MANAGER_REPORT_APPROVAL.md` | The report eligibility contract for Event Managers |
| `docs/REPORT_CUSTOMIZATION_CHANGES.md` | The report section modal |
| `docs/EVENT_TYPE_MANAGEMENT.md` | Event type rename/delete API and transaction design |
| `EVENT_ORGANIZERS_CHANGES.md` | Multiple organizers |
| `PERFORMANCE_OPTIMIZATION.md`, `docs/PERFORMANCE_AUDIT.md` | Performance work |
| `docs/himovation-theme-spec.md` | Visual design system |
| `docs/superadmin-functionality-gaps.md` | Known Super Admin gaps |
