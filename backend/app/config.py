from urllib.parse import urlsplit

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


# Localhost and the private LAN ranges -- 10.0.0.0/8, 172.16.0.0/12,
# 192.168.0.0/16 and the carrier-grade NAT / Tailscale range 100.64.0.0/10
# (100.64-100.127.x.x; the rest of 100.* is public address space).
#
# For development only: put it in a local .env as CORS_ORIGIN_REGEX when you
# need to open the site from a phone or another laptop on the same Wi-Fi.
# Never set it on a public deployment -- combined with allow_credentials it
# trusts any page served from a private address or from localhost.
LAN_CORS_ORIGIN_REGEX = (
    r"^https?://("
    r"localhost|127\.0\.0\.1"
    r"|10(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}"
    r"|172\.(1[6-9]|2\d|3[01])(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}"
    r"|192\.168(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}"
    r"|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}"
    r")(:\d{1,5})?$"
)


class Settings(BaseSettings):
    """Application settings, read from the environment and the backend .env file.

    MongoDB is the only data store: it holds users, credentials, events, media
    metadata, notifications, reports and (through GridFS) the uploaded files.
    """

    # ------------------------------------------------------------------
    # MongoDB
    # ------------------------------------------------------------------
    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_db_name: str = "campus_capture"

    # ------------------------------------------------------------------
    # Authentication (JWT issued by this service)
    # ------------------------------------------------------------------
    jwt_secret_key: str
    jwt_algorithm: str = "HS256"
    # The longest a single token may live.
    access_token_expire_minutes: int = 60 * 24 * 7
    # Sign-out after inactivity. Tokens are issued for this long (when it is
    # shorter than the above) and the frontend renews them only while someone
    # is using the page, so a session left idle this long is refused here --
    # not just hidden by the browser. 0 turns the idle limit off.
    session_idle_minutes: int = 30
    # /auth/refresh keeps a session alive, but never past this many days after
    # the password was last entered (the token's ``auth_time``).
    session_max_age_days: int = 30

    # In-memory per-IP / per-email throttling of the auth endpoints. Only turn
    # this off for local load tests.
    rate_limit_enabled: bool = True

    # When True, a newly registered account must confirm its email address
    # before it can sign in. Requires SMTP to be configured.
    require_email_verification: bool = True
    email_verification_expire_hours: int = 24
    password_reset_expire_minutes: int = 60
    # How long a Dean's "set your password" invitation link stays valid.
    teacher_invite_expire_days: int = 7

    # The host of every event. The platform serves SST (School of Science &
    # Technology) only, so the event form no longer asks for a host
    # department or school; an event without one is reported as this.
    default_host_department: str = "SST"

    # ------------------------------------------------------------------
    # SMTP (outbound email)
    # ------------------------------------------------------------------
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from_email: str | None = None
    smtp_from_name: str = "Campus Capture SRHU"
    # STARTTLS on the submission port (587). Set SMTP_USE_SSL=true for
    # implicit TLS on port 465 instead.
    smtp_use_tls: bool = True
    smtp_use_ssl: bool = False
    smtp_timeout_seconds: int = 20

    # Master switch for outbound email. With EMAIL_DELIVERY_ENABLED=false no
    # SMTP connection is ever opened, whatever the SMTP_* settings say: every
    # message is written to EMAIL_OUTBOX_DIR as an .eml file instead, so the
    # whole application (invitations, resets, verification) can be exercised
    # without mailing a real person. Those files contain live links -- keep
    # this for development and testing, never for production.
    email_delivery_enabled: bool = True
    email_outbox_dir: str = "email_outbox"

    # How long the file download links printed in an Event Manager report keep
    # working. A report is a document people keep, so these are long-lived
    # signed links rather than the few-hour links the app itself uses.
    report_link_expiry_days: int = Field(default=365, ge=1, le=3650)

    # ------------------------------------------------------------------
    # Logging
    # ------------------------------------------------------------------
    # Application logs go to stdout (the platform's log viewer) and to
    # size-rotated files under LOG_DIR -- never to MongoDB. Each file is
    # capped at LOG_FILE_MAX_MB and keeps LOG_FILE_BACKUP_COUNT rotated
    # copies, so disk use is bounded: app.log, error.log, access.log and
    # audit.log together never exceed 4 x (1 + backups) x max size.
    log_level: str = "INFO"
    log_to_files: bool = True
    log_dir: str = "logs"
    log_file_max_mb: int = Field(default=10, ge=1, le=1024)
    log_file_backup_count: int = Field(default=5, ge=1, le=100)

    # ------------------------------------------------------------------
    # Reports
    # ------------------------------------------------------------------
    # Printed under the university name on the generated report letterhead.
    report_school: str = "School of Science and Technology"

    # ------------------------------------------------------------------
    # Uploads (Cloudflare R2, or MongoDB GridFS when R2 is not configured)
    # ------------------------------------------------------------------
    # Backstop for any single file, whatever its kind.
    max_upload_size_mb: int = 200

    # Per-event limits (PRD 7 / 8 / 9 / 11). Photos are capped per file and by
    # count; videos and documents by their combined size, because "10 videos of
    # 20 MB" and "2 videos of 100 MB" cost the same storage and the teacher
    # should be free to choose.
    max_photos_per_event: int = 10
    max_photo_size_mb: int = 20
    # Videos are budgeted by combined size, but a single oversized file still has
    # to be refused before it is spooled, so it carries a per-file cap too.
    max_video_size_mb: int = 200
    max_video_total_mb: int = 200
    max_documents_total_mb: int = 15
    # No per-document size cap; this only stops an unbounded number of tiny
    # files from being attached.
    max_documents_per_event: int = 50

    # ------------------------------------------------------------------
    # Cloudflare R2 (S3-compatible object storage for uploads)
    # ------------------------------------------------------------------
    # When configured, new photos, videos and documents go to R2 instead of
    # GridFS. Files already in GridFS keep being served from /files/{id}.
    r2_account_id: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None
    r2_bucket_name: str | None = None
    # Public base URL (r2.dev or custom domain) for a public bucket. Empty
    # means the bucket is private and pre-signed URLs are issued instead.
    r2_public_url: str | None = None
    r2_signed_url_expiry: int = 6 * 60 * 60
    # Overrides the endpoint derived from R2_ACCOUNT_ID. Only for pointing the
    # API at a local S3-compatible server in development and tests.
    r2_endpoint: str | None = None

    # Direct browser-to-R2 uploads. The browser asks the API for pre-signed
    # PUT URLs and sends the bytes straight to R2, so a video never passes
    # through the Cloudflare proxy (and its request-size limit) or this
    # server. Set R2_DIRECT_UPLOAD_ENABLED=false to fall back to posting files
    # through the API. Needs the bucket CORS rule from scripts/configure_r2.py.
    r2_direct_upload_enabled: bool = True
    # How long one pre-signed PUT URL works. The browser asks for a fresh one
    # when a URL expires mid-upload, so this only bounds a leaked URL.
    r2_upload_url_expiry: int = Field(default=60 * 60, ge=60, le=7 * 24 * 60 * 60)
    # How long an upload may take from start to finish. Sessions older than
    # this are aborted and their bytes deleted by the sweep.
    r2_upload_session_ttl_minutes: int = Field(default=6 * 60, ge=5, le=7 * 24 * 60)
    # Every direct upload is an R2 multipart upload, because its part URLs die
    # when the upload completes -- a plain pre-signed PUT URL would still let
    # its holder overwrite the verified object until it expired. Files up to
    # the threshold go up as one part; larger ones in parts of
    # R2_MULTIPART_PART_SIZE_MB, sent in parallel and each retried alone. R2
    # requires every part but the last to be at least 5 MB and equal-sized.
    r2_multipart_threshold_mb: int = Field(default=16, ge=5, le=5 * 1024)
    r2_multipart_part_size_mb: int = Field(default=8, ge=5, le=5 * 1024)

    # ------------------------------------------------------------------
    # Frontend / CORS
    # ------------------------------------------------------------------
    # The public frontend origin used for all server-generated email links.
    frontend_url: str
    # Optional extra origins, for example an alternate local development address.
    cors_origins: str | None = None
    # Origins matched by pattern, on top of FRONTEND_URL and CORS_ORIGINS.
    #
    # Empty by default, so a deployment admits only the origins it was told
    # about. LAN_CORS_ORIGIN_REGEX below is the development pattern: set
    # CORS_ORIGIN_REGEX to it in a local .env to reach the API from a phone on
    # the same Wi-Fi. It is not the default because shipping it meant every
    # production deployment also trusted every private-network and localhost
    # origin, with allow_credentials on.
    #
    # In production set it to something like
    # ^https://srhu-capture(-[a-z0-9-]+)?\.vercel\.app$ to admit Vercel
    # preview deployments, or leave it empty.
    cors_origin_regex: str | None = None

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("log_level")
    @classmethod
    def validate_log_level(cls, value: str) -> str:
        level = value.strip().upper()
        if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("LOG_LEVEL must be DEBUG, INFO, WARNING, ERROR or CRITICAL")
        return level

    @field_validator("frontend_url")
    @classmethod
    def validate_frontend_url(cls, value: str) -> str:
        normalized = value.strip().rstrip("/")
        parsed = urlsplit(normalized)

        if (
            parsed.scheme not in {"http", "https"}
            or not parsed.netloc
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
            or parsed.username
            or parsed.password
        ):
            raise ValueError(
                "FRONTEND_URL must be an absolute frontend origin without a path, "
                "query, fragment, or credentials"
            )

        return normalized

    @field_validator("jwt_secret_key")
    @classmethod
    def validate_jwt_secret_key(cls, value: str) -> str:
        if len(value.strip()) < 16:
            raise ValueError("JWT_SECRET_KEY must be at least 16 characters long")
        return value.strip()

    # ------------------------------------------------------------------
    # Derived helpers
    # ------------------------------------------------------------------
    @property
    def allowed_cors_origins(self) -> list[str]:
        configured_origins = self.cors_origins.split(",") if self.cors_origins else []
        origins = [self.frontend_url, *configured_origins]
        return list(
            dict.fromkeys(
                origin.strip().rstrip("/")
                for origin in origins
                if origin.strip()
            )
        )

    @property
    def frontend_url_is_insecure(self) -> bool:
        """True when email links would travel as plain http to a non-local host.

        Verification and reset tokens sit in those links' query strings, so on
        anything but a developer's own machine the frontend must be https.
        """
        parsed = urlsplit(self.frontend_url)
        return parsed.scheme == "http" and (parsed.hostname or "") not in {
            "localhost",
            "127.0.0.1",
            "::1",
        }

    @property
    def smtp_configured(self) -> bool:
        return bool(self.smtp_host and self.smtp_from_email)

    @property
    def smtp_missing_variables(self) -> list[str]:
        """Names of the SMTP settings that still need a value."""
        return [
            name
            for name, value in (
                ("SMTP_HOST", self.smtp_host),
                ("SMTP_FROM_EMAIL", self.smtp_from_email),
            )
            if not value
        ]

    @property
    def r2_configured(self) -> bool:
        return bool(
            self.r2_account_id
            and self.r2_access_key_id
            and self.r2_secret_access_key
            and self.r2_bucket_name
        )

    @property
    def r2_endpoint_url(self) -> str:
        if self.r2_endpoint:
            return self.r2_endpoint.rstrip("/")
        return f"https://{self.r2_account_id}.r2.cloudflarestorage.com"

    @property
    def r2_direct_upload_available(self) -> bool:
        return self.r2_configured and self.r2_direct_upload_enabled

    @property
    def max_upload_size_bytes(self) -> int:
        return self.max_upload_size_mb * 1024 * 1024

    @property
    def max_photo_size_bytes(self) -> int:
        return self.max_photo_size_mb * 1024 * 1024

    @property
    def max_video_total_bytes(self) -> int:
        return self.max_video_total_mb * 1024 * 1024

    @property
    def max_documents_total_bytes(self) -> int:
        return self.max_documents_total_mb * 1024 * 1024

    def frontend_route(self, path: str) -> str:
        """Build a frontend route without introducing duplicate slashes."""
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Frontend routes must start with one slash")
        return f"{self.frontend_url}{path}"

    @property
    def login_url(self) -> str:
        return self.frontend_route("/login")

    def email_verification_url(self, token: str) -> str:
        return self.frontend_route(f"/verify-email?token={token}")

    def password_reset_url(self, token: str) -> str:
        return self.frontend_route(f"/reset-password?token={token}")

    def teacher_invite_url(self, token: str) -> str:
        return self.frontend_route(f"/accept-invite?token={token}")


settings = Settings()
