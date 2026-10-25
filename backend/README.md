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
about 4 × 6 × 10 MB. `LOG_TO_FILES=false` keeps stdout only (for a host whose
disk does not survive a redeploy; read the logs from stdout there).

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

## Deploying on your own server (nginx)

The repository holds both apps: the API (`backend/`) runs as a service behind
nginx, and the frontend (`frontend/`) is built once and served by nginx as
static files. Give the API its own hostname (e.g. `api.campus.example.edu`):
API paths such as `/teacher/events` share their first segment with app pages
such as `/teacher/dashboard`, so the two cannot share one host.

### 1. Database

MongoDB **4.0 or newer as a replica set** -- MongoDB Atlas or your own. Event
type management moves events in a transaction, which a standalone server cannot
run. Allow the server's IP to connect and note the connection string.

### 2. Backend

    cd backend
    python -m venv .venv
    .venv/bin/pip install -r requirements.txt
    # then create backend/.env with the variables below (see Setup)

| Variable                                                       | Value                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `MONGODB_URI`                                                | the connection string                                                                                        |
| `MONGODB_DB_NAME`                                            | `campus_capture`                                                                                           |
| `JWT_SECRET_KEY`                                             | a new long random string (not the local one)                                                                 |
| `FRONTEND_URL`                                               | the site's HTTPS origin, e.g.`https://campus.example.edu`                                                  |
| `CORS_ORIGINS` / `CORS_ORIGIN_REGEX`                         | only for extra frontend origins; leave empty otherwise                                                       |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | the same SMTP settings as your local`.env`                                                                 |
| `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`                        | From address                                                                                                 |
| `REQUIRE_EMAIL_VERIFICATION`                                 | `true`                                                                                                     |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | optional; without them uploads go to GridFS                                                   |
| `R2_DIRECT_UPLOAD_ENABLED`                                   | `true` (default): the browser uploads straight to R2; `false` posts files through the API instead          |

Run it as a service with `PORT` set: `run.py` then turns auto-reload off and,
behind nginx on the same machine, trusts nginx's `X-Forwarded-*` headers, so
file links come out as `https://` (`FORWARDED_ALLOW_IPS` narrows who is
trusted; the default covers localhost and private networks). A systemd unit:

    # /etc/systemd/system/campus-capture.service
    [Unit]
    Description=Campus Capture API
    After=network.target

    [Service]
    WorkingDirectory=/srv/campus-capture/backend
    Environment=PORT=8000
    ExecStart=/srv/campus-capture/backend/.venv/bin/python run.py
    Restart=on-failure
    User=www-data

    [Install]
    WantedBy=multi-user.target

Logs go to `backend/logs/` (see *Logs* above) as well as the journal.

**Direct uploads.** With R2 configured, photos, videos and documents go from
the browser straight to R2 through pre-signed URLs, so a large video never
passes through nginx or the API. The bucket needs a CORS rule for the frontend
origins; run this once, and again whenever `FRONTEND_URL` or `CORS_ORIGINS`
change (it prints the change and asks for `--apply`):

    python scripts/configure_r2.py            # dry run
    python scripts/configure_r2.py --apply    # add --origin for any other site origin

It also adds a lifecycle rule that aborts abandoned multipart uploads.
Unfinished uploads are swept by the API itself; `scripts/sweep_upload_sessions.py`
does the same from a scheduler (e.g. cron).

**Email.** Email is sent over SMTP only, so the server must be allowed to make
outbound connections on the SMTP port (usually 587); a campus firewall may
need a rule. `scripts/smtp_diagnostic.py` tests the connection from the server.

Check the deployment at `https://<api-host>/health`: it should report
`"database": "connected"` and `"email": "configured"`.

**First superadmin.** Run the scripts against the production database:

```bash
cd backend
.venv/bin/python scripts/migrate_admin_to_superadmin.py   # only if old data has "admin" users
.venv/bin/python scripts/create_superadmin.py --email you@srhu.edu.in --name "Super Admin"
```

### 3. Frontend

    cd frontend
    npm ci
    VITE_API_BASE_URL=https://api.campus.example.edu npm run build

`VITE_API_BASE_URL` is the API's address with no trailing slash. Vite bakes it
into the build, so **rebuild** after changing it. Copy `frontend/dist/` to the
web root (below, `/srv/campus-capture/frontend/dist`).

### 4. nginx

    # The site: the built frontend. try_files sends every unknown path to
    # index.html, so links such as /verify-email?token=... and a refresh on
    # any page open the app instead of a 404.
    server {
        server_name campus.example.edu;
        root /srv/campus-capture/frontend/dist;
        location / { try_files $uri /index.html; }
        location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; }
    }

    # The API.
    server {
        server_name api.campus.example.edu;
        # Uploads posted through the API (R2 direct uploads off, or no R2):
        # at least MAX_UPLOAD_SIZE_MB (default 200).
        client_max_body_size 210m;
        location / {
            proxy_pass http://127.0.0.1:8000;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_read_timeout 300s;
        }
    }

Add HTTPS to both (e.g. `certbot --nginx`). `FRONTEND_URL` must be the site's
final `https://` origin: email links and CORS both use it.
