"""Test package bootstrap.

Importing this package pins the database the suite may touch. It runs before any
test module -- and therefore before ``app.config`` reads ``.env`` -- because
``python -m unittest discover tests`` imports the package first.

This matters: ``TestClient(app)`` boots the real application against the real
configuration, and the suite fakes only *some* collections. ``audit_logs`` in
particular was never faked, so every superadmin test wrote a real row into
whatever ``MONGODB_URI`` pointed at. With a hosted cluster in ``.env`` that meant
the shared database. Environment variables outrank ``.env`` in pydantic-settings,
so setting them here redirects the suite to a local throwaway database; if no
local mongod is running the tests fail loudly instead of quietly polluting a
shared one.
"""

import os

os.environ["MONGODB_URI"] = os.environ.get(
    "TEST_MONGODB_URI", "mongodb://localhost:27017"
)
os.environ["MONGODB_DB_NAME"] = "campus_capture_test"

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")

# Never the real R2 bucket: a developer's .env may hold live credentials, and
# an unfaked storage call would then write to (or delete from) production.
# Blank, R2 counts as unconfigured and storage falls back to the throwaway
# test database's GridFS; suites that test R2 fake its client themselves.
for _r2_setting in (
    "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET_NAME", "R2_PUBLIC_URL", "R2_ENDPOINT",
):
    os.environ[_r2_setting] = ""

# Nor a real mail server: invitation and reset emails sent from a background
# thread reached the SMTP host in .env. Suites that test email fake
# email_service themselves.
for _smtp_setting in ("SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL"):
    os.environ[_smtp_setting] = ""

# Photo previews write to storage; the suites that test them turn them on
# with storage faked (tests/test_media_previews.py).
os.environ["MEDIA_PREVIEWS_ENABLED"] = "false"
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")
os.environ.setdefault("REQUIRE_EMAIL_VERIFICATION", "false")

# Pinned so assertions about the deployment ceiling do not depend on whatever a
# developer happens to have in .env (which overrides the 200 MB code default).
os.environ.setdefault("MAX_UPLOAD_SIZE_MB", "200")

# Log to the console only: the suite must not leave app.log / audit.log files
# behind in the working tree. test_logging_config covers the file handlers.
os.environ["LOG_TO_FILES"] = "false"
