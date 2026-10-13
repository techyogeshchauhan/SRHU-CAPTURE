"""MongoDB connection, collections and index management.

Every piece of persistent state lives in one MongoDB database:

    users            accounts, roles and password hashes
    events           events submitted by teachers
    event_media      photo / video metadata (file bytes live in GridFS)
    event_documents  supporting document metadata (file bytes live in GridFS)
    notifications    in-app notifications for teachers
    event_reports    generated report records
    uploads.*        GridFS buckets holding the uploaded file bytes
"""

import logging
import os
import sys

import certifi
from gridfs import GridFS
from pymongo import ASCENDING, DESCENDING, MongoClient
from pymongo.errors import ConfigurationError, OperationFailure, PyMongoError

from app.config import settings


logger = logging.getLogger(__name__)

def _test_runner_active() -> bool:
    """True when this process was started by a test runner.

    uvicorn never imports unittest or pytest, so this is False in production.
    """
    return "unittest" in sys.modules or "pytest" in sys.modules


def _resolve_target(uri: str, db_name: str) -> tuple[str, str]:
    """Keep the test suite off whatever database the deployment is configured for.

    tests/__init__.py redirects the suite to a throwaway database, but
    ``python -m unittest discover tests`` loads the modules as top-level names
    and never imports the package, so the bootstrap silently does not run. The
    suite fakes only some collections -- audit_logs and the index declarations
    were never faked -- so the gap meant ordinary test runs wrote rows and
    created indexes on the real, shared cluster.

    Rather than fail the documented command, redirect it and say so loudly. Set
    ALLOW_TESTS_ON_CONFIGURED_DB=1 to opt out, e.g. for an integration run
    deliberately pointed at a scratch cluster.
    """
    if not _test_runner_active():
        return uri, db_name
    if os.environ.get("ALLOW_TESTS_ON_CONFIGURED_DB") == "1":
        return uri, db_name

    safe_uri = os.environ.get("TEST_MONGODB_URI", "mongodb://localhost:27017")
    safe_db = os.environ.get("TEST_MONGODB_DB_NAME", "campus_capture_test")
    if (uri, db_name) != (safe_uri, safe_db):
        logger.warning(
            "test runner detected: using %s/%s instead of the configured database. "
            "Run the suite as `python -m unittest discover -t . -s tests` to set "
            "this up explicitly, or set ALLOW_TESTS_ON_CONFIGURED_DB=1 to override.",
            safe_uri.split("@")[-1],
            safe_db,
        )
    return safe_uri, safe_db


def _uses_tls(uri: str) -> bool:
    lowered = uri.lower()
    return lowered.startswith("mongodb+srv://") or "tls=true" in lowered or "ssl=true" in lowered


# One client per process; pymongo manages the connection pool internally.
# TLS connections (MongoDB Atlas is always mongodb+srv://) verify against
# certifi's CA bundle, because slim container images such as Railway's often
# ship without a current system bundle and the handshake then fails.
#
# connect=False defers everything network-related -- including the SRV DNS
# lookup of a mongodb+srv:// URI -- to the first operation. Without it an
# unreachable DNS server or Atlas cluster made importing this module (and so
# the whole app and every test module) raise ConfigurationError, instead of
# starting degraded and reporting it on /health.
_MONGODB_URI, _MONGODB_DB_NAME = _resolve_target(
    settings.mongodb_uri, settings.mongodb_db_name
)

client: MongoClient = MongoClient(
    _MONGODB_URI,
    connect=False,
    serverSelectionTimeoutMS=5000,
    tz_aware=True,
    **({"tlsCAFile": certifi.where()} if _uses_tls(_MONGODB_URI) else {}),
)

db = client[_MONGODB_DB_NAME]

users = db["users"]
events = db["events"]
event_media = db["event_media"]
event_documents = db["event_documents"]
notifications = db["notifications"]
event_reports = db["event_reports"]
# Event categories a teacher may choose from. Seeded with the built-in set and
# extended by teachers at create-event time (PRD 4 / 14).
event_types = db["event_types"]
# Coordinator contact cards: name + mobile, not user accounts (PRD 5).
faculty_coordinators = db["faculty_coordinators"]
# Super Admin configurable upload limits
upload_config = db["upload_config"]
# Audit logs for sensitive system/admin actions
audit_logs = db["audit_logs"]
# Master registry for academic departments
departments = db["departments"]
# Event Manager role: events recorded directly (no Dean review), and their
# photos/videos and documents -- the same record shapes as the teacher
# collections, kept apart so nothing in the teacher, Dean or superadmin flows
# ever sees them.
managed_events = db["managed_events"]
managed_event_media = db["managed_event_media"]
managed_event_documents = db["managed_event_documents"]
# In-flight direct browser-to-R2 uploads (app.services.direct_upload): what the
# API authorised, so the object can be verified, recorded, or cleaned up.
upload_sessions = db["upload_sessions"]

# Uploaded file bytes are stored in GridFS so that MongoDB remains the single
# store for the application, including media and documents.
fs = GridFS(db, collection="uploads")



def _ensure_ttl_index(collection, *, field: str, name: str, expire_after_seconds: int) -> None:
    """Create a TTL index, replacing one that exists with different options.

    MongoDB refuses to re-create an index under the same name with a different
    `expireAfterSeconds` (IndexOptionsConflict, codes 85/86), which would turn
    a change of policy into a failed boot.
    """
    try:
        collection.create_index(
            [(field, ASCENDING)],
            name=name,
            expireAfterSeconds=expire_after_seconds,
        )
    except OperationFailure as error:
        if error.code not in (85, 86):
            raise
        logger.info("ttl_index_recreating collection=%s name=%s", collection.name, name)
        collection.drop_index(name)
        collection.create_index(
            [(field, ASCENDING)],
            name=name,
            expireAfterSeconds=expire_after_seconds,
        )


def ensure_indexes() -> None:
    """Create the indexes the application relies on. Safe to call repeatedly."""
    users.create_index([("email", ASCENDING)], unique=True, name="email_unique")
    users.create_index([("role", ASCENDING)], name="role")
    # Serves the faculty-coordinator directory, which lists staff who published
    # a mobile number. Sparse: most accounts have none, and the query that uses
    # it always requires the field to be present.
    users.create_index([("phone", ASCENDING)], name="phone", sparse=True)
    users.create_index(
        [("verification_token_hash", ASCENDING)],
        name="verification_token",
        sparse=True,
    )
    users.create_index(
        [("reset_token_hash", ASCENDING)],
        name="reset_token",
        sparse=True,
    )
    users.create_index(
        [("invite_token_hash", ASCENDING)],
        name="invite_token",
        sparse=True,
    )

    events.create_index([("teacher_id", ASCENDING)], name="teacher")
    events.create_index([("status", ASCENDING)], name="status")
    events.create_index([("event_date", ASCENDING)], name="event_date")
    events.create_index([("event_type", ASCENDING)], name="event_type")
    events.create_index([("created_at", DESCENDING)], name="created_at")
    # The teacher list sorts its own events by recency; the single-field
    # "teacher" index above cannot serve the sort, so paging it would scan.
    events.create_index(
        [("teacher_id", ASCENDING), ("created_at", DESCENDING)],
        name="teacher_created",
    )
    # Serves the archive listing. Sparse: only shelved events carry the field,
    # and live events are found through the status/created_at indexes.
    events.create_index(
        [("archived_at", DESCENDING)],
        name="archived_at",
        sparse=True,
    )

    event_media.create_index([("event_id", ASCENDING)], name="event")
    event_documents.create_index([("event_id", ASCENDING)], name="event")

    # Serves the duplicate-name check the upload wizard runs before sending
    # bytes (PRD 10).
    event_media.create_index(
        [("event_id", ASCENDING), ("name_key", ASCENDING)],
        name="event_name",
    )
    event_documents.create_index(
        [("event_id", ASCENDING), ("name_key", ASCENDING)],
        name="event_name",
    )

    notifications.create_index(
        [("user_id", ASCENDING), ("created_at", DESCENDING)],
        name="user_created",
    )
    notifications.create_index(
        [("user_id", ASCENDING), ("is_read", ASCENDING)],
        name="user_unread",
    )

    # PRD 13: a notification disappears an hour after it is opened. The router
    # stamps `expires_at` when marking one read, and this index deletes the
    # document once that moment passes (expireAfterSeconds=0 means "at the
    # time in the field"). Unread notifications have no `expires_at`, and TTL
    # ignores documents whose indexed field is missing or not a date, so they
    # are never swept. Notifications read before this shipped also lack the
    # field and so survive -- deliberately, rather than being purged on deploy.
    _ensure_ttl_index(
        notifications,
        field="expires_at",
        name="read_ttl",
        expire_after_seconds=0,
    )

    event_reports.create_index(
        [("event_id", ASCENDING)],
        unique=True,
        name="event_unique",
    )

    event_types.create_index(
        [("key", ASCENDING)],
        unique=True,
        name="key_unique",
    )

    faculty_coordinators.create_index(
        [("name_key", ASCENDING)],
        unique=True,
        name="name_unique",
    )

    audit_logs.create_index([("created_at", DESCENDING)], name="created_at")
    audit_logs.create_index([("action", ASCENDING)], name="action")
    audit_logs.create_index([("actor_id", ASCENDING)], name="actor")
    audit_logs.create_index([("target_id", ASCENDING)], name="target")

    # The settings document is a singleton keyed by `key`. Without a unique index
    # two concurrent first-time saves can each upsert their own copy, after which
    # find_one returns an arbitrary one and the limits appear to flip at random.
    upload_config.create_index([("key", ASCENDING)], unique=True, name="key_unique")

    departments.create_index([("name", ASCENDING)], unique=True, name="name_unique")
    departments.create_index([("code", ASCENDING)], unique=True, name="code_unique", sparse=True)
    departments.create_index([("is_active", ASCENDING)], name="is_active")

    managed_events.create_index(
        [("owner_id", ASCENDING), ("created_at", DESCENDING)],
        name="owner_created",
    )
    for collection in (managed_event_media, managed_event_documents):
        collection.create_index([("event_id", ASCENDING)], name="event")
        collection.create_index(
            [("event_id", ASCENDING), ("name_key", ASCENDING)],
            name="event_name",
        )

    # The sweep looks for unfinished uploads past their deadline.
    upload_sessions.create_index(
        [("status", ASCENDING), ("expires_at", ASCENDING)],
        name="status_expires",
    )
    # A finished session is kept a while for diagnosis, then dropped. The
    # field is only stamped once a session is finished (see direct_upload), so
    # the TTL can never remove a session whose bytes still need cleaning up.
    _ensure_ttl_index(
        upload_sessions,
        field="purge_at",
        name="purge_ttl",
        expire_after_seconds=0,
    )

    # Imported here rather than at module scope: the service imports this
    # module for its collection handle, so a top-level import would cycle.
    from app.services.event_types import seed_default_event_types

    seed_default_event_types()


def ping() -> bool:
    """Return True when the MongoDB server answers."""
    try:
        client.admin.command("ping")
        return True
    except (PyMongoError, ConfigurationError) as error:
        logger.error("mongodb_ping_failed error=%s", error)
        return False
