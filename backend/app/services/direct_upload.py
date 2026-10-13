"""Direct browser-to-R2 uploads.

A file sent through the API has to pass the Cloudflare proxy in front of it,
which caps the request size. Here the API only authorises and verifies; the
bytes go from the browser straight to R2:

1. **start** -- the router validates the name, declared type and size and
   checks the event's caps exactly as for a proxied upload, then
   :func:`start_session` opens an R2 multipart upload and returns a pre-signed
   PUT URL per part.
2. The browser PUTs the parts to R2, reporting progress as it goes.
3. **sign** -- :func:`sign_urls` re-issues URLs that expired mid-upload.
4. **complete** -- :func:`claim_session` takes the session (only once), then
   :func:`finalize_object` assembles the parts and checks the object's size,
   type and magic bytes. The router records it with the same post-insert cap
   check and rollback as a proxied upload.
5. **abort** -- :func:`abort_session` frees whatever reached R2.

Uploads are always multipart, even a one-part photo: a part URL stops working
once its upload is completed or aborted, whereas a pre-signed ``PutObject`` URL
would let its holder overwrite the verified object -- say, with bytes that
fail the magic-byte check -- until the URL expired.

Every session lives in ``upload_sessions`` until its bytes are either recorded
or freed. :func:`sweep_expired_sessions` aborts the ones a browser abandoned,
and the bucket's lifecycle rule (``scripts/configure_r2.py``) is the backstop
for multipart parts R2 still holds.
"""

from __future__ import annotations

import logging
import math
import time
from datetime import timedelta
from types import SimpleNamespace

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import HTTPException, status

from app.config import settings
from app.database import (
    event_documents,
    event_media,
    managed_event_documents,
    managed_event_media,
    upload_sessions,
)
from app.models.documents import new_document_document, new_media_document
from app.services import r2_service
from app.services.storage_service import (
    check_declared_size,
    check_file_signature,
    content_disposition,
    delete_stored,
    inspect_document,
    inspect_media,
    safe_file_name,
    serving_policy,
)
from app.utils.serializers import to_object_id, utc_now


logger = logging.getLogger(__name__)

PENDING = "pending"          # parts may still be uploading
COMPLETING = "completing"    # a /complete request holds it
COMPLETED = "completed"      # recorded; the bytes belong to a media/document row
FAILED = "failed"            # refused on completion; bytes freed
ABORTED = "aborted"          # cancelled by the browser or the sweep; bytes freed

MB = 1024 * 1024
MAX_PARTS = 10_000           # S3/R2 limit per multipart upload
URLS_PER_RESPONSE = 100      # the browser asks for the rest through /sign
HEAD_BYTES = 1024            # what check_file_signature inspects

# A /complete request must never find its bytes deleted underneath it by the
# sweep, so claiming a session pushes its deadline at least this far out.
COMPLETION_GRACE = timedelta(minutes=15)
# Finished sessions are kept this long for diagnosis before the TTL drops them.
FINISHED_RETENTION = timedelta(days=7)
# The opportunistic sweep runs at most this often per process.
SWEEP_INTERVAL_SECONDS = 10 * 60
SWEEP_BATCH = 100

_last_sweep = 0.0


def available() -> bool:
    """True when uploads should go browser-to-R2 rather than through the API."""
    return settings.r2_direct_upload_available


def _storage_error() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Could not reach file storage. Please try again.",
    )


def _gone() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_410_GONE,
        detail="This upload has expired or was cancelled. Please upload the file again.",
    )


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")


def _mismatch() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="The uploaded file does not match the file that was selected. Please try again.",
    )


# ======================================================================
# Policy: what may be uploaded, and which caps apply
# ======================================================================

def inspect_declared(kind: str, file_name: str, content_type: str | None) -> dict:
    """Validate a declared name and type as the proxied routes do.

    Returns ``{"media_type", "extension", "content_type"}``, where
    ``media_type`` is ``image``, ``video`` or ``document`` and
    ``content_type`` is the canonical type for the extension.
    """
    # inspect_media/inspect_document read only these two attributes.
    declared = SimpleNamespace(filename=file_name, content_type=content_type or "")
    if kind == "documents":
        info = inspect_document(declared)
        return {"media_type": "document", **info}
    info = inspect_media(declared)
    return {
        "media_type": info["kind"],
        "extension": info["extension"],
        "content_type": info["content_type"],
    }


def caps_for(media_type: str, limits: dict) -> dict:
    """The count cap, combined budget and per-file limit for one kind --
    the same values the proxied upload routes read."""
    if media_type == "image":
        return {
            "cap": limits["max_photos_per_event"],
            "cap_bytes": limits["max_photo_total_bytes"],
            "per_file_bytes": limits["max_photo_size_bytes"],
            "what": "Photos",
        }
    if media_type == "video":
        return {
            "cap": limits.get("max_videos_per_event"),
            "cap_bytes": limits["max_video_total_bytes"],
            "per_file_bytes": limits["max_video_size_bytes"],
            "what": "Videos",
        }
    # Documents have no per-file cap (PRD 9): the budget is the ceiling.
    return {
        "cap": limits["max_documents_per_event"],
        "cap_bytes": limits["max_documents_total_bytes"],
        "per_file_bytes": limits["max_documents_total_bytes"],
        "what": "Documents",
    }


def cap_query(event_key: str, media_type: str) -> dict:
    if media_type == "document":
        return {"event_id": event_key}
    return {"event_id": event_key, "media_type": media_type}


def plan_parts(size: int) -> tuple[int, int]:
    """``(part_size, part_count)`` for a file of ``size`` bytes."""
    if size <= settings.r2_multipart_threshold_mb * MB:
        return size, 1
    part_size = settings.r2_multipart_part_size_mb * MB
    if math.ceil(size / part_size) > MAX_PARTS:
        part_size = math.ceil(size / MAX_PARTS / MB) * MB
    return part_size, math.ceil(size / part_size)


def _part_length(session: dict, part_number: int) -> int:
    if part_number < session["part_count"]:
        return session["part_size"]
    return session["size"] - session["part_size"] * (session["part_count"] - 1)


# ======================================================================
# Session lifecycle
# ======================================================================

def start_session(
    *,
    scope: str,
    owner_id: str,
    event_key: str,
    kind: str,
    info: dict,
    file_name: str,
    original_name: str | None,
    size: int,
    category: str = "notice",
) -> dict:
    """Open the multipart upload and its session; returns what the browser
    needs to send the bytes. The caller has already applied every check a
    proxied upload gets before its bytes are stored."""
    object_key = r2_service.build_object_key(
        event_id=event_key, kind=kind, file_name=safe_file_name(file_name)
    )
    _, disposition = serving_policy(info["content_type"])
    part_size, part_count = plan_parts(size)

    try:
        upload_id = r2_service.create_multipart_upload(
            object_key,
            content_type=info["content_type"],
            content_disposition=content_disposition(disposition, file_name),
            metadata={"event_id": event_key, "teacher_id": owner_id},
        )
    except (BotoCoreError, ClientError):
        logger.exception("Could not start R2 multipart upload %s", object_key)
        raise _storage_error()

    now = utc_now()
    session = {
        "scope": scope,
        "owner_id": owner_id,
        "event_id": event_key,
        "kind": kind,
        "category": category if category in ("notice", "report") else "notice",
        "media_type": info["media_type"],
        "extension": info["extension"],
        "content_type": info["content_type"],
        "file_name": file_name,
        "original_name": original_name,
        "size": size,
        "object_key": object_key,
        "upload_id": upload_id,
        "part_size": part_size,
        "part_count": part_count,
        "status": PENDING,
        "created_at": now,
        "expires_at": now + timedelta(minutes=settings.r2_upload_session_ttl_minutes),
    }
    try:
        session["_id"] = upload_sessions.insert_one(session).inserted_id
    except Exception:
        r2_service.abort_multipart_upload(object_key, upload_id=upload_id)
        raise

    logger.info(
        "direct_upload_started session=%s scope=%s event=%s type=%s size=%d parts=%d",
        session["_id"], scope, event_key, info["media_type"], size, part_count,
    )
    return {
        "session_id": str(session["_id"]),
        "expires_at": session["expires_at"],
        **sign_urls(session),
    }


def sign_urls(session: dict, part_numbers: list[int] | None = None) -> dict:
    """Fresh pre-signed PUT URLs for the given parts (default: the first
    :data:`URLS_PER_RESPONSE`, which for any file within the upload limits is
    all of them)."""
    count = session["part_count"]
    numbers = (
        sorted(set(part_numbers)) if part_numbers
        else list(range(1, min(count, URLS_PER_RESPONSE) + 1))
    )
    if any(n < 1 or n > count for n in numbers) or len(numbers) > URLS_PER_RESPONSE:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Part numbers must be between 1 and {count}, at most {URLS_PER_RESPONSE} at a time.",
        )
    expiry = settings.r2_upload_url_expiry
    try:
        parts = [
            {
                "part_number": n,
                "size": _part_length(session, n),
                "url": r2_service.presign_upload_part(
                    session["object_key"],
                    upload_id=session["upload_id"],
                    part_number=n,
                    content_length=_part_length(session, n),
                    expires_in=expiry,
                ),
            }
            for n in numbers
        ]
    except (BotoCoreError, ClientError):
        logger.exception("Could not sign R2 upload parts for %s", session["object_key"])
        raise _storage_error()
    return {
        "part_size": session["part_size"],
        "part_count": count,
        "url_expires_in": expiry,
        "parts": parts,
    }


def _session_filter(session_id: str, *, scope: str, owner_id: str, event_id: str) -> dict | None:
    """The query that pins a session to its owner and event, or None when
    either id is malformed."""
    session_oid = to_object_id(session_id)
    event_oid = to_object_id(event_id)
    if session_oid is None or event_oid is None:
        return None
    return {"_id": session_oid, "scope": scope, "owner_id": owner_id, "event_id": str(event_oid)}


def active_session(session_id: str, *, scope: str, owner_id: str, event_id: str) -> dict:
    """A pending, unexpired session owned by the caller (for /sign)."""
    query = _session_filter(session_id, scope=scope, owner_id=owner_id, event_id=event_id)
    session = upload_sessions.find_one(query) if query else None
    if not session:
        raise _not_found()
    if session["status"] != PENDING or session["expires_at"] <= utc_now():
        raise _gone()
    return session


def claim_session(session_id: str, *, scope: str, owner_id: str, event_id: str) -> dict:
    """Take a pending session for completion. Atomic, so a double-clicked or
    retried /complete can never record the same object twice."""
    query = _session_filter(session_id, scope=scope, owner_id=owner_id, event_id=event_id)
    if query is None:
        raise _not_found()

    now = utc_now()
    claimed = upload_sessions.find_one_and_update(
        {**query, "status": PENDING, "expires_at": {"$gt": now}},
        {"$set": {"status": COMPLETING, "claimed_at": now}},
        return_document=True,
    )
    if claimed:
        # Keep the sweep off it while this request runs.
        deadline = max(claimed["expires_at"], now + COMPLETION_GRACE)
        upload_sessions.update_one({"_id": claimed["_id"]}, {"$set": {"expires_at": deadline}})
        claimed["expires_at"] = deadline
        return claimed

    existing = upload_sessions.find_one(query)
    if not existing:
        raise _not_found()
    if existing["status"] == PENDING:
        # Expired before the browser finished: free it now, not at the sweep.
        abort_session(session_id, scope=scope, owner_id=owner_id, event_id=event_id)
        raise _gone()
    if existing["status"] in (COMPLETING, COMPLETED):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This upload has already been completed.",
        )
    raise _gone()


def release_session(session: dict) -> None:
    """Hand a claimed session back, after a failure the browser may retry."""
    upload_sessions.update_one(
        {"_id": session["_id"], "status": COMPLETING}, {"$set": {"status": PENDING}}
    )


def finalize_object(session: dict, *, per_file_bytes: int | None, what: str) -> int:
    """Assemble the upload and verify the object; returns its size.

    Raises 400 (and frees the bytes) when the object is not the file that was
    declared -- a different size or type, or contents that do not match the
    extension. Raises and releases the session when the browser can retry:
    parts still missing, or R2 unreachable.
    """
    key = session["object_key"]
    try:
        if not session.get("assembled"):
            parts = r2_service.list_parts(key, upload_id=session["upload_id"])
            by_number = {part["PartNumber"]: part for part in parts}
            expected = range(1, session["part_count"] + 1)
            missing = [n for n in expected if n not in by_number]
            if missing:
                release_session(session)
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"The upload is not finished: {len(missing)} of "
                        f"{session['part_count']} parts have not reached storage."
                    ),
                )
            if set(by_number) != set(expected) or any(
                by_number[n].get("Size") != _part_length(session, n) for n in expected
            ):
                discard(session, FAILED)
                raise _mismatch()

            r2_service.complete_multipart_upload(
                key, upload_id=session["upload_id"], parts=[by_number[n] for n in expected]
            )
            # The parts are now one object; a retry must not list them again.
            session["assembled"] = True
            upload_sessions.update_one({"_id": session["_id"]}, {"$set": {"assembled": True}})

        head = r2_service.head_object(key)
        head_bytes = r2_service.read_range(key, length=HEAD_BYTES) if head else b""
    except HTTPException:
        raise
    except (BotoCoreError, ClientError):
        logger.exception("Could not finalize direct upload %s", key)
        release_session(session)
        raise _storage_error()

    stored_type = (head or {}).get("ContentType", "").split(";")[0].strip().lower()
    if not head or head.get("ContentLength") != session["size"] or stored_type != session["content_type"]:
        discard(session, FAILED)
        raise _mismatch()

    try:
        check_declared_size(session["size"], per_file_bytes, what=what)
        check_file_signature(session["extension"], head_bytes)
    except HTTPException:
        discard(session, FAILED)
        raise
    return session["size"]


def new_record(session: dict) -> tuple[dict, dict]:
    """The media/document row for a verified object, and the ``stored``
    dict ``_record_upload`` rolls back with -- the shapes save_upload gives
    a proxied upload."""
    stored = {"storage": "r2", "object_key": session["object_key"], "file_id": None, "url": None}
    common = {
        "event_id": session["event_id"],
        "storage": "r2",
        "object_key": session["object_key"],
        "file_id": None,
        "file_name": session["file_name"],
        "file_size": session["size"],
        "original_name": session["original_name"],
    }
    if session["media_type"] == "document":
        document = new_document_document(
            **common,
            file_url=None,
            file_type=session["content_type"],
            category=session.get("category", "notice"),
        )
    else:
        document = new_media_document(
            **common,
            media_url=None,
            media_type=session["media_type"],
            content_type=session["content_type"],
        )
    return document, stored


def finish(session: dict, state: str, *, record_id=None) -> None:
    """Mark a claimed session finished. Its bytes are either recorded or
    already gone (``_record_upload`` deletes them when it rolls back)."""
    now = utc_now()
    changes = {"status": state, "finished_at": now, "purge_at": now + FINISHED_RETENTION}
    if record_id is not None:
        changes["record_id"] = str(record_id)
    upload_sessions.update_one({"_id": session["_id"]}, {"$set": changes})
    logger.info("direct_upload_%s session=%s", state, session["_id"])


def _free_bytes(session: dict) -> None:
    """Delete whatever of the session reached R2. Never raises."""
    try:
        if session.get("assembled"):
            # A failed delete is written to storage_orphans for a later sweep.
            delete_stored({"object_key": session["object_key"]})
        else:
            # A failed abort is left to the bucket's lifecycle rule.
            r2_service.abort_multipart_upload(session["object_key"], upload_id=session["upload_id"])
    except Exception:
        logger.exception("Could not free direct upload %s", session.get("object_key"))


def discard(session: dict, state: str = FAILED) -> None:
    """Free the session's bytes and mark it finished."""
    _free_bytes(session)
    finish(session, state)


def abort_session(session_id: str, *, scope: str, owner_id: str, event_id: str) -> bool:
    """Cancel a pending session (the browser gave up). True if one was
    cancelled; a session already completing or finished is left alone."""
    query = _session_filter(session_id, scope=scope, owner_id=owner_id, event_id=event_id)
    if query is None:
        return False
    session = upload_sessions.find_one_and_update(
        {**query, "status": PENDING}, {"$set": {"status": ABORTED}}, return_document=True
    )
    if not session:
        return False
    discard(session, ABORTED)
    return True


def _is_recorded(session: dict) -> bool:
    """Whether a media/document row already points at the session's object --
    true when a /complete got as far as the insert before it died."""
    if session["media_type"] == "document":
        collections = (event_documents, managed_event_documents)
    else:
        collections = (event_media, managed_event_media)
    query = {"event_id": session["event_id"], "object_key": session["object_key"]}
    return any(collection.find_one(query, {"_id": 1}) for collection in collections)


def sweep_expired_sessions(limit: int = SWEEP_BATCH) -> int:
    """Abort sessions past their deadline and free their bytes; returns how
    many were swept. A session whose object was already recorded is marked
    completed instead, so the sweep can never delete a file in use."""
    now = utc_now()
    swept = 0
    for session in upload_sessions.find(
        {"status": {"$in": [PENDING, COMPLETING]}, "expires_at": {"$lt": now}}
    ).limit(limit):
        taken = upload_sessions.find_one_and_update(
            {"_id": session["_id"], "status": session["status"], "expires_at": session["expires_at"]},
            {"$set": {"status": ABORTED}},
            return_document=True,
        )
        if not taken:
            continue
        if taken.get("assembled") and _is_recorded(taken):
            finish(taken, COMPLETED)
            continue
        discard(taken, ABORTED)
        swept += 1
    if swept:
        logger.info("direct_upload_sweep aborted=%d", swept)
    return swept


def sweep_if_due() -> None:
    """Run the sweep at most every SWEEP_INTERVAL_SECONDS per process. Called
    as a background task after an upload starts; never raises."""
    global _last_sweep
    now = time.monotonic()
    if now - _last_sweep < SWEEP_INTERVAL_SECONDS:
        return
    _last_sweep = now
    try:
        sweep_expired_sessions()
    except Exception:
        logger.exception("direct_upload_sweep_failed")
