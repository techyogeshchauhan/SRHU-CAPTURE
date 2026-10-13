import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders

from app.config import settings
from app.database import ensure_indexes, ping
from app.logging_config import configure_logging
from app.routers import (
    auth,
    dean_teachers,
    directory,
    event_manager,
    events,
    files,
    reports,
    superadmin,
    users,
)


# Application log lines (registration, email_sent, audit, errors, ...) go to
# stdout and to size-rotated files under LOG_DIR -- never to the database.
LOG_DIR = configure_logging(settings)

logger = logging.getLogger(__name__)


# ============================================================
# LIFESPAN
# ============================================================

INDEX_RETRY_INITIAL_SECONDS = 5
INDEX_RETRY_MAX_SECONDS = 300


def _retry_indexes_forever(stop: threading.Event) -> None:
    """Keep trying ensure_indexes() with exponential backoff until it succeeds.

    The unique email index is what stops two concurrent registrations creating
    the same account, so a first boot against an unreachable or empty database
    must not leave the app running without it for the life of the process.
    """
    delay = INDEX_RETRY_INITIAL_SECONDS
    attempt = 1
    while not stop.wait(delay):
        attempt += 1
        try:
            ensure_indexes()
            logger.info(
                "mongodb_indexes_ready db=%s attempt=%d", settings.mongodb_db_name, attempt
            )
            return
        except Exception as error:  # pragma: no cover - depends on the environment
            logger.error("mongodb_index_setup_failed attempt=%d error=%s", attempt, error)
            delay = min(delay * 2, INDEX_RETRY_MAX_SECONDS)


def _warn_about_insecure_settings() -> None:
    if settings.frontend_url_is_insecure:
        logger.warning(
            "frontend_url_insecure url=%s -- verification and password reset links "
            "carry one-time tokens and will be sent as plain http. Set FRONTEND_URL "
            "to the https address of the deployed frontend.",
            settings.frontend_url,
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Create MongoDB indexes on startup without blocking a misconfigured boot."""
    if LOG_DIR:
        logger.info("log_files_ready dir=%s", LOG_DIR)
    _warn_about_insecure_settings()

    stop_retrying = threading.Event()
    try:
        ensure_indexes()
        logger.info("mongodb_indexes_ready db=%s", settings.mongodb_db_name)
    except Exception as error:  # pragma: no cover - depends on the environment
        logger.error("mongodb_index_setup_failed error=%s -- retrying in background", error)
        threading.Thread(
            target=_retry_indexes_forever,
            args=(stop_retrying,),
            name="mongodb-index-retry",
            daemon=True,
        ).start()
    try:
        yield
    finally:
        stop_retrying.set()


# ============================================================
# FASTAPI APP
# ============================================================

app = FastAPI(
    title="Campus Capture API",
    description="Backend API for Campus Capture SRHU (MongoDB)",
    version="2.0.0",
    lifespan=lifespan,
)


# ============================================================
# GLOBAL ERROR HANDLERS
# ============================================================

@app.exception_handler(413)
async def request_entity_too_large(_request: Request, _exc: Exception):
    """Return a JSON 413 instead of an HTML page.

    uvicorn / h11 can reject an oversized body before it even reaches the
    route handler and produce a plain-text or HTML 413. Cloudflare's proxy
    also returns a 413 for payloads above its plan limit. Either way the
    browser sees a response without CORS headers, which turns the XHR error
    handler's status into 0 and shows a generic 'Network error'.

    This handler catches app-level 413 exceptions and normalises them to
    JSON. The Cloudflare case still cannot be caught here (the response
    never reaches the app), but it is handled in the frontend by inspecting
    xhr.status before falling back to the generic error message.
    """
    return JSONResponse(
        status_code=413,
        content={"detail": "The uploaded file is too large for this server. Please check the file size limits."},
    )


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_cors_origins,
    allow_origin_regex=settings.cors_origin_regex or None,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Lets the page read the file name of a download (a generated report):
    # without it the browser hides the header on a cross-origin response and
    # the page could only guess a name.
    expose_headers=["Content-Disposition"],
)


# ============================================================
# CACHING
# ============================================================

class NoStoreByDefault:
    """Send ``Cache-Control: no-store`` unless the route chose its own policy.

    Almost every answer here is one person's data -- their events, profile,
    notifications -- and none said anything about caching, which left it to
    the browser's judgement. On a shared computer that data could then outlive
    the sign-out in the disk cache. Routes that do set the header keep it:
    signed file links cache privately until they expire, and report PDFs
    already say ``private, no-store``.

    Plain ASGI rather than ``@app.middleware("http")``: only the headers are
    touched, so there is no reason to pass every file download and video
    range through BaseHTTPMiddleware's extra stream.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_default(message):
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message).setdefault("Cache-Control", "no-store")
            await send(message)

        await self.app(scope, receive, send_with_default)


app.add_middleware(NoStoreByDefault)


# ============================================================
# ROUTERS
# ============================================================

# Superadmin APIs
app.include_router(superadmin.router)

# Registration, login, email verification and password reset
app.include_router(auth.router)

# Current-user profile APIs
app.include_router(users.router)

# Teacher + Dean Event APIs
app.include_router(directory.router)

app.include_router(events.router)

# Dean Report APIs
app.include_router(reports.router)

# Dean management of Teacher accounts (/dean/teachers)
app.include_router(dean_teachers.router)

# Uploaded files served from GridFS
app.include_router(files.router)

# Event Manager role: events recorded and reported without Dean review
app.include_router(event_manager.router)


# ============================================================
# ROOT
# ============================================================

@app.get("/")
def root():
    return {
        "message": "Campus Capture API is running"
    }


# ============================================================
# HEALTH CHECK
# ============================================================

@app.get("/health")
def health_check():
    """Unauthenticated liveness probe (Railway's healthcheck path).

    Returns only "ok" or "degraded" -- always with HTTP 200 so a database blip
    does not make the platform restart the service. The reasons (database
    unreachable, missing SMTP variables) go to the server log, not to anyone
    who can reach the URL.
    """
    problems = []

    if not ping():
        problems.append("database=unreachable")

    missing_email = settings.smtp_missing_variables
    if missing_email:
        problems.append("email=unconfigured missing=" + ",".join(missing_email))
        if settings.require_email_verification:
            problems.append("registration=unavailable")

    if problems:
        logger.warning("health_degraded %s", " ".join(problems))
        return {"status": "degraded"}
    return {"status": "ok"}
