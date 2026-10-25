"""Application logging: stdout plus size-rotated log files, never the database.

Four files under ``LOG_DIR``:

- ``app.log``    everything the application and uvicorn log at LOG_LEVEL and up
- ``error.log``  warnings and errors only, so problems are not buried in noise
- ``access.log`` uvicorn's one-line-per-request access log
- ``audit.log``  one JSON line per audited action (user, event and bulk
                 changes) -- see ``app.services.audit_service``

Each file rotates at LOG_FILE_MAX_MB and keeps LOG_FILE_BACKUP_COUNT old copies
(``app.log.1`` ... ``app.log.N``), so the directory never grows past a fixed
size. stdout is kept too: the systemd journal and ``docker logs`` read it.

``RotatingFileHandler`` assumes one writing process. ``run.py`` starts a single
uvicorn worker (the reloader's parent process never imports the app), which is
what this is built for; running several workers against one LOG_DIR would need
a per-worker directory or an external rotator instead.
"""

from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

CONSOLE_FORMAT = "%(levelname)s:     %(name)s - %(message)s"
FILE_FORMAT = "%(asctime)s %(levelname)-8s %(name)s [pid %(process)d] - %(message)s"
AUDIT_FORMAT = "%(asctime)s %(message)s"

AUDIT_LOGGER = "app.audit"

# Marks the handlers this module installed, so configuring twice (tests, a
# re-imported app) replaces them instead of writing every line twice.
_OWNED = "_campus_capture_log_handler"


def _own(handler: logging.Handler) -> logging.Handler:
    setattr(handler, _OWNED, True)
    return handler


def _remove_owned(logger: logging.Logger) -> None:
    for handler in list(logger.handlers):
        if getattr(handler, _OWNED, False):
            logger.removeHandler(handler)
            handler.close()


def _rotating(path: Path, level: int, fmt: str, max_bytes: int, backups: int) -> logging.Handler:
    handler = RotatingFileHandler(
        path,
        maxBytes=max_bytes,
        backupCount=backups,
        encoding="utf-8",
        # The file is opened on the first record, not at import time.
        delay=True,
    )
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(fmt))
    return _own(handler)


def configure_logging(settings) -> Path | None:
    """Install console and rotating-file logging. Returns the log directory,
    or None when file logging is off or the directory cannot be created."""
    level = logging.getLevelName(settings.log_level)
    root = logging.getLogger()
    uvicorn_logger = logging.getLogger("uvicorn")
    access_logger = logging.getLogger("uvicorn.access")
    audit_logger = logging.getLogger(AUDIT_LOGGER)

    for logger in (root, uvicorn_logger, access_logger, audit_logger):
        _remove_owned(logger)

    root.setLevel(level)
    # Keep a console handler unless something (a test runner) already set one.
    if not root.handlers:
        console = logging.StreamHandler()
        console.setFormatter(logging.Formatter(CONSOLE_FORMAT))
        root.addHandler(_own(console))
    logging.getLogger("pymongo").setLevel(logging.WARNING)
    # Audit lines are always recorded, whatever LOG_LEVEL says.
    audit_logger.setLevel(logging.INFO)

    if not settings.log_to_files:
        return None

    log_dir = Path(settings.log_dir).expanduser()
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        logging.getLogger(__name__).error(
            "log_dir_unavailable dir=%s error=%s -- logging to stdout only", log_dir, error
        )
        return None

    max_bytes = settings.log_file_max_mb * 1024 * 1024
    backups = settings.log_file_backup_count

    app_file = _rotating(log_dir / "app.log", level, FILE_FORMAT, max_bytes, backups)
    error_file = _rotating(log_dir / "error.log", logging.WARNING, FILE_FORMAT, max_bytes, backups)
    root.addHandler(app_file)
    root.addHandler(error_file)

    # uvicorn's loggers do not propagate to the root, so they get the same
    # files directly: startup, shutdown and unhandled-exception tracebacks
    # land in app.log / error.log, and the request log in access.log.
    # (When uvicorn runs without its own logging config they do propagate,
    # and the root handlers already cover them.)
    if not uvicorn_logger.propagate:
        uvicorn_logger.addHandler(app_file)
        uvicorn_logger.addHandler(error_file)
    access_logger.addHandler(
        _rotating(log_dir / "access.log", logging.INFO, FILE_FORMAT, max_bytes, backups)
    )

    # Audit lines also reach the root (stdout and app.log) by propagation.
    audit_logger.addHandler(
        _rotating(log_dir / "audit.log", logging.INFO, AUDIT_FORMAT, max_bytes, backups)
    )
    return log_dir.resolve()
