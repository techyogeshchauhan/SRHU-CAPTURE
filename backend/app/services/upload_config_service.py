"""Dynamic photo, video and document upload limits configured by the Super Admin.

Alongside the limits it holds whether each upload kind is mandatory before an
event can be submitted for approval (``*_required``), since those are part of
the same "what must a teacher attach" policy and are edited on the same page.

The whole settings surface lives in one MongoDB document, ``{"key": "upload_limits"}``
in the ``upload_config`` collection. Absence of that document means "use the
defaults from config.py", which is why :func:`reset_upload_limits` deletes it
rather than writing the defaults into it -- otherwise a later change to
``MAX_PHOTOS_PER_EVENT`` in the environment could never take effect again.

:func:`get_upload_limits` runs on every single upload request, so the document is
held in a short-lived process-local cache. Writes invalidate it explicitly; the
TTL only bounds how long a second worker can serve a stale value.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from app.config import settings
from app.database import upload_config
from app.schemas.superadmin import LIMIT_BOUNDS
from app.utils.serializers import utc_now

logger = logging.getLogger(__name__)

CONFIG_KEY = "upload_limits"

# How long a worker may serve a value it has not re-read. Writes go through this
# module and invalidate immediately, so this only matters across processes.
CACHE_TTL_SECONDS = 30.0

# Defaults match the hardcoded settings in config.py. `None` means "no cap":
# photos have no combined budget and videos no count limit unless one is set.
DEFAULT_UPLOAD_LIMITS: dict[str, Any] = {
    "max_photos_per_event": settings.max_photos_per_event,
    "max_photo_size_mb": settings.max_photo_size_mb,
    "max_photo_total_mb": None,
    "max_videos_per_event": None,
    "max_video_size_mb": settings.max_video_size_mb,
    "max_video_total_mb": settings.max_video_total_mb,
    "max_documents_per_event": settings.max_documents_per_event,
    "max_documents_total_mb": settings.max_documents_total_mb,
    # Whether a kind must have at least one upload before submission. The
    # defaults are the original PRD rule: a photo and a document, video optional.
    "photos_required": True,
    "videos_required": False,
    "documents_required": True,
}

# upload kind -> the flag that makes it mandatory.
REQUIREMENT_FIELDS: dict[str, str] = {
    "photo": "photos_required",
    "video": "videos_required",
    "document": "documents_required",
}

# The two fields a stored `None` must be able to override a default for. Every
# other field falls back to its default when the stored value is missing.
NULLABLE_FIELDS = ("max_photo_total_mb", "max_videos_per_event")

# (state, expires_at). Kept even once expired so a database blip can serve the
# last known good values instead of silently widening the limits.
_cache: tuple[dict[str, Any], float] | None = None


def invalidate_cache() -> None:
    """Drop the cached document. Called by every write in this module."""
    global _cache
    _cache = None


def _merge(doc: dict[str, Any] | None) -> dict[str, Any]:
    limits: dict[str, Any] = dict(DEFAULT_UPLOAD_LIMITS)
    if doc:
        for field in DEFAULT_UPLOAD_LIMITS:
            if field in doc and doc[field] is not None:
                limits[field] = doc[field]
        # These two are meaningfully null, so an explicit stored null wins.
        for field in NULLABLE_FIELDS:
            if field in doc:
                limits[field] = doc[field]

    mb = 1024 * 1024
    limits["max_photo_size_bytes"] = limits["max_photo_size_mb"] * mb
    limits["max_photo_total_bytes"] = (
        limits["max_photo_total_mb"] * mb
        if limits["max_photo_total_mb"] is not None
        else None
    )
    limits["max_video_size_bytes"] = limits["max_video_size_mb"] * mb
    limits["max_video_total_bytes"] = limits["max_video_total_mb"] * mb
    limits["max_documents_total_bytes"] = limits["max_documents_total_mb"] * mb
    return limits


def _load_state() -> dict[str, Any]:
    """Return {"limits", "updated_at", "updated_by"}, cached for CACHE_TTL_SECONDS."""
    global _cache

    now = time.monotonic()
    if _cache is not None and now < _cache[1]:
        return _cache[0]

    try:
        doc = upload_config.find_one({"key": CONFIG_KEY})
    except Exception as exc:
        # Fail closed: keep serving the last known good configuration rather than
        # reverting to defaults, which would silently *raise* a tightened limit.
        if _cache is not None:
            logger.warning("Upload limits unreadable, serving cached values: %s", exc)
            return _cache[0]
        logger.warning("Upload limits unreadable and uncached, using defaults: %s", exc)
        return {"limits": _merge(None), "updated_at": None, "updated_by": None}

    state = {
        "limits": _merge(doc),
        "updated_at": doc.get("updated_at") if doc else None,
        "updated_by": doc.get("updated_by") if doc else None,
    }
    _cache = (state, now + CACHE_TTL_SECONDS)
    return state


def get_upload_limits() -> dict[str, Any]:
    """The effective limits, including derived ``*_bytes`` values for enforcement."""
    return dict(_load_state()["limits"])


def get_public_upload_limits() -> dict[str, Any]:
    """The effective limits as the UI consumes them: counts and megabytes only."""
    limits = _load_state()["limits"]
    return {field: limits[field] for field in DEFAULT_UPLOAD_LIMITS}


def get_config_metadata() -> dict[str, Any]:
    """Who last changed the settings, and when. Both null while using defaults."""
    state = _load_state()
    return {"updated_at": state["updated_at"], "updated_by": state["updated_by"]}


def get_limit_bounds() -> dict[str, Any]:
    """The min/max the API accepts per field, served so the form cannot drift."""
    return {field: dict(bound) for field, bound in LIMIT_BOUNDS.items()}


def update_upload_limits(data: dict[str, Any], user_id: str) -> dict[str, Any]:
    """Persist new upload limits. Returns the public limits plus their metadata."""
    now = utc_now()
    doc_to_save: dict[str, Any] = {"key": CONFIG_KEY}
    for field in DEFAULT_UPLOAD_LIMITS:
        doc_to_save[field] = data.get(field)
    doc_to_save["updated_at"] = now
    doc_to_save["updated_by"] = str(user_id)

    upload_config.update_one({"key": CONFIG_KEY}, {"$set": doc_to_save}, upsert=True)
    invalidate_cache()

    return {
        "limits": get_public_upload_limits(),
        "updated_at": now,
        "updated_by": str(user_id),
    }


def reset_upload_limits(user_id: str) -> dict[str, Any]:
    """Drop the stored document so the environment defaults apply again."""
    upload_config.delete_one({"key": CONFIG_KEY})
    invalidate_cache()

    return {
        "limits": get_public_upload_limits(),
        "updated_at": None,
        "updated_by": None,
    }
