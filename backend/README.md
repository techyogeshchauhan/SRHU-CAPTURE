# Campus Capture API (FastAPI + MongoDB)

The backend stores everything in one MongoDB database: users and their
credentials, events, media and document metadata, notifications, generated
reports, and the uploaded file bytes themselves (GridFS). Login tokens are JWTs
issued by this service. Outbound email (verification links, password resets,
Dean credentials, event decisions) goes over SMTP.

## Setup

```powershell
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env      # then edit the values
```

Required settings in `.env`:

| Variable                                                                            | Purpose                                                              |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `MONGODB_URI`                                                                     | Connection string, e.g.`mongodb://localhost:27017`                 |
| `MONGODB_DB_NAME`                                                                 | Database name (default`campus_capture`)                            |
| `JWT_SECRET_KEY`                                                                  | Long random secret used to sign login tokens (32+ chars recommended) |
| `FRONTEND_URL`                                                                    | Public origin of the React app, used in email links and CORS         |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL` | Mail server used for all outbound email                              |

Optional: `REQUIRE_EMAIL_VERIFICATION=false` lets new accounts sign in without
confirming their email (handy before SMTP is configured). `SMTP_USE_SSL=true`
switches from STARTTLS (587) to implicit TLS (465).

## First run

```powershell
.venv\Scripts\python scripts\init_db.py                       # create indexes
.venv\Scripts\python scripts\create_superadmin.py --email superadmin@example.com --name "Super Admin"
.venv\Scripts\python run.py                                   # http://localhost:8000
```

`run.py` listens on `0.0.0.0:8000`, so phones and laptops on the same network
can reach the API through the frontend's LAN address. If you start uvicorn by
hand, pass the host explicitly. Without it uvicorn binds to 127.0.0.1 only and
every other device gets "Failed to fetch" on login and signup:

```powershell
.venv\Scripts\uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

On Windows, allow the API through Windows Firewall for devices on the same
private network by running this once in an Administrator PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\allow-lan-firewall.ps1
```

The helper allows only TCP ports 8000 and 8001 from the local subnet on the
Private network profile. Port 8001 is used by the current frontend `.env`; the
default `run.py` backend uses port 8000. It does not open the database port.

On a second device, open the frontend using the host computer's IPv4 address
from `ipconfig`, for example `http://192.168.1.20:5173`. Do not use
`localhost:5173` on the second device; `localhost` always means that device
itself. The development frontend maps its configured loopback API address to
the host name in the page URL, and the development CORS pattern accepts private
LAN origins.

Settings are read from `.env` at startup; restart the server after editing it.

`create_superadmin.py` prompts for a password when `--password` /
`SUPERADMIN_PASSWORD` is not supplied. Deans are created from the superadmin
console; teachers register themselves and confirm their email.

### Upgrading from the `admin` role

The top role used to be called `admin`. Login now rejects that value, so run
the migration before (or together with) deploying this version. It is safe to
run more than once:

```powershell
.venv\Scripts\python scripts\migrate_admin_to_superadmin.py
```

## Useful commands

```powershell
.venv\Scripts\python -m unittest discover -t . -s tests   # unit tests
.venv\Scripts\python scripts\smtp_diagnostic.py           # check SMTP reachability + credentials
```

The suite never touches the database in `.env`. `tests/__init__.py` redirects it
to a throwaway local one, and `app/database.py` applies the same redirect even
when the package is not imported (`unittest discover tests`, without `-t .`,
loads the test modules as top-level names and skips it). Point it elsewhere with
`TEST_MONGODB_URI` / `TEST_MONGODB_DB_NAME`, or set
`ALLOW_TESTS_ON_CONFIGURED_DB=1` to opt out deliberately.

This matters because the tests fake only some collections: `audit_logs` and the
index declarations were never faked, so before this a plain test run wrote rows
and created indexes on whatever cluster `.env` pointed at.

`GET /health` reports whether MongoDB answers and whether SMTP is configured.

## Logs

Application logs are written to files and stdout, never to MongoDB. They go to
`LOG_DIR` (default `logs/` next to where the server starts), and the directory
is git-ignored:

| File           | Contents                                                            |
| -------------- | ------------------------------------------------------------------- |
| `app.log`    | Everything at`LOG_LEVEL` and up: application, uvicorn, tracebacks |
| `error.log`  | Warnings and errors only                                            |
| `access.log` | One line per HTTP request                                           |
| `audit.log`  | One JSON line per audited action: user, event and bulk changes      |

Each file rotates at `LOG_FILE_MAX_MB` (default 10) and keeps
`LOG_FILE_BACKUP_COUNT` old copies (default 5), so the directory stays under
about 4 × 6 × 10 MB. `LOG_TO_FILES=false` keeps stdout only. On Railway the disk
is wiped on every deploy, so use the Railway log viewer (stdout) there.

The `audit_logs` collection is kept as well. It is application data rather than
a log: the Super Admin *Audit Logs* page and the Dean's *Recent Activity* panel
read from it.

## Collections

| Collection                           | Contents                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                            | `name`, `email` (unique), `password_hash`, `role` (`teacher` / `dean` / `superadmin`), verification and reset token hashes |
| `events`                           | Event submissions keyed by`teacher_id` with the lifecycle `status`                                                                   |
| `event_media`, `event_documents` | Metadata for uploads; bytes live in the`uploads` GridFS bucket and are served from `/files/{id}`                                     |
| `notifications`                    | In-app notifications per`user_id`                                                                                                      |
| `event_reports`                    | One generated report per`event_id`                                                                                                     |
| `upload_sessions`                  | Direct browser-to-R2 uploads in flight: what was authorised, so the object can be verified, recorded or freed                           |

## Deploying: backend on Railway, frontend on Vercel

The repository holds both apps, so each platform is pointed at its own folder.

### 1. Database

Railway has no data of its own, so use **MongoDB Atlas** (free M0 cluster) or
Railway's MongoDB template.

- Atlas: *Network Access* → allow `0.0.0.0/0` (Railway has no fixed outbound
  IP), then copy the `mongodb+srv://...` connection string.
- Railway MongoDB: use the `MONGO_URL` it provides.

### 2. Backend on Railway

1. *New Project* → *Deploy from GitHub repo* → this repository.
2. Service → *Settings*:
   - **Root Directory**: `backend`
   - **Config file path**: `/backend/railway.json`. Railway does not look inside
     the root directory for it. The file sets the start command
     (`python run.py`) and the `/health` health check. `Procfile` gives the
     same start command as a fallback.
3. *Settings → Networking → Generate Domain*, e.g. `srhu-capture-api.up.railway.app`.
4. *Variables*:

| Variable                                                       | Value                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`                                                | Atlas / Railway connection string                                                                            |
| `MONGODB_DB_NAME`                                            | `campus_capture`                                                                                           |
| `JWT_SECRET_KEY`                                             | a new long random string (not the local one)                                                                 |
| `FRONTEND_URL`                                               | the Vercel URL, e.g.`https://srhu-capture.vercel.app`                                                      |
| `CORS_ORIGIN_REGEX`                                          | `^https://srhu-capture(-[a-z0-9-]+)?\.vercel\.app$` (admits preview deployments; replaces the LAN default) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | the same SMTP settings as your local`.env`                                                                 |
| `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`                        | From address                                                                                                 |
| `REQUIRE_EMAIL_VERIFICATION`                                 | `true`                                                                                                     |
| `R2_*`                                                       | optional, see`.env.example`; without them uploads go to GridFS                                             |
| `R2_DIRECT_UPLOAD_ENABLED`                                   | `true` (default): the browser uploads straight to R2; `false` posts files through the API instead          |

**Direct uploads.** With R2 configured, photos, videos and documents go from
the browser straight to R2 through pre-signed URLs, so a large video never
meets the Cloudflare proxy's request-size limit. The bucket needs a CORS rule
for the frontend origins; run this once, and again whenever `FRONTEND_URL` or
`CORS_ORIGINS` change (it prints the change and asks for `--apply`):

    python scripts/configure_r2.py            # dry run
    python scripts/configure_r2.py --apply    # add --origin for preview URLs

It also adds a lifecycle rule that aborts abandoned multipart uploads.
Unfinished uploads are swept by the API itself; `scripts/sweep_upload_sessions.py`
does the same from a scheduler.

Do not set `PORT`: Railway provides it, and `run.py` uses it, turns auto-reload
off and trusts Railway's proxy headers so file links come out as `https://`.

**Email on Railway.** Email is sent over SMTP only. Railway blocks outbound
SMTP (ports 25/465/587) on the Free, Trial and Hobby plans, where sends fail
with `[Errno 101] Network is unreachable`; they go through on the Pro plan.
Locally, SMTP works with no restriction.

Check the deployment at `https://<railway-domain>/health`: it should report
`"database": "connected"` and `"email": "configured"`.

**First superadmin.** Run the scripts from your machine against the production
database (PowerShell):

```powershell
$env:MONGODB_URI = "<production connection string>"
.venv\Scripts\python scripts\migrate_admin_to_superadmin.py   # only if old data has "admin" users
.venv\Scripts\python scripts\create_superadmin.py --email you@srhu.edu.in --name "Super Admin"
Remove-Item Env:MONGODB_URI
```

### 3. Frontend on Vercel

1. *Add New Project* → this repository.
2. **Root Directory**: `frontend`. Vercel detects Vite (build `npm run build`,
   output `dist`). `frontend/vercel.json` rewrites every path to `index.html`,
   so links such as `/verify-email?token=...` open correctly.
3. *Environment Variables*: `VITE_API_BASE_URL` = `https://<railway-domain>`
   (no trailing slash). Vite bakes it in at build time, so **redeploy** after
   changing it.
4. Put the final Vercel URL back into Railway's `FRONTEND_URL`. Email links
   and CORS both use it.
