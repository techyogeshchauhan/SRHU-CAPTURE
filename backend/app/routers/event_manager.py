"""Event Manager role: the Teacher panel's event API, without the Dean.

The Event Manager uses the Teacher panel's screens (frontend
components/teacher/panel.jsx), so this router mirrors the teacher endpoints in
routers/events.py path for path and response for response -- ``/event-manager``
in place of ``/teacher`` -- with one difference: there is no review. Where a
teacher's submission goes to the Dean as ``pending``, an Event Manager's is
``recorded`` at once; nothing is announced to anyone, and a recorded event
stays editable.

On top of that, reports: one event, or several in one PDF, generated directly,
with up to four chosen photos and a download link for every file.

The events live in their own collections (`managed_events`,
`managed_event_media`, `managed_event_documents`), so the teacher, Dean and
superadmin flows never see them.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import StreamingResponse
from pymongo import ASCENDING, DESCENDING

from app.config import settings
from app.database import (
    event_reports,
    fs,
    managed_event_documents,
    managed_event_media,
    managed_events,
)
from app.models.documents import (
    new_document_document,
    new_history_entry,
    new_media_document,
    upload_name_key,
)
from app.routers.events import (
    _cap_error,
    _direct_upload_response,
    _ensure_bytes_under_cap,
    _ensure_direct_upload_fits,
    _ensure_under_cap,
    _size_cap_error,
    paginate,
)
from app.schemas.event_manager import (
    ManagedBulkDeleteRequest,
    ManagedReportRequest,
    ReportPhotosRequest,
)
from app.schemas.events import BulkEventIdsRequest, EventCreateRequest, EventUpdateRequest, draft_details_error
from app.schemas.reports import ReportCustomizationOptions
from app.schemas.uploads import DirectUploadSignRequest, DirectUploadStartRequest
from app.services import direct_upload, report_files
from app.services.event_fields import many_with_legacy_metadata, with_legacy_metadata
from app.services.event_types import resolve_event_type
from app.services.managed_report_pdf import (
    ReportEntry,
    attachment_for,
    build_managed_report_pdf,
    prepare_photo,
)
from app.services.report_pdf import split_description
from app.services.storage_service import (
    absolute_url,
    absolutize,
    check_file_signature,
    content_disposition,
    delete_stored,
    inspect_document,
    inspect_media,
    peek_head,
    safe_file_name,
    save_upload,
    stream_upload,
)
from app.services.upload_config_service import REQUIREMENT_FIELDS, get_upload_limits
from app.utils.file_names import report_file_name
from app.utils.auth import get_current_user, require_role
from app.utils.serializers import serialize, serialize_many, to_object_id, utc_now


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/event-manager", tags=["Event Manager"])

ROLE = "event_manager"
RECORDED = "recorded"


def manager_dep(authorization: str | None = Header(default=None)) -> dict:
    return require_role(get_current_user(authorization), ROLE)


# ============================================================
# HELPERS
# ============================================================

def _own_event_or_404(event_id: str, user: dict) -> dict:
    object_id = to_object_id(event_id)
    event = managed_events.find_one({"_id": object_id, "owner_id": user["id"]}) if object_id else None
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")
    return event


def _list_media(request: Request, event_key: str) -> list[dict]:
    cursor = managed_event_media.find({"event_id": event_key}).sort("created_at", ASCENDING)
    return [absolutize(request, item, "media_url") for item in serialize_many(cursor)]


def _list_documents(request: Request, event_key: str) -> list[dict]:
    cursor = managed_event_documents.find({"event_id": event_key}).sort("created_at", ASCENDING)
    return [absolutize(request, item, "file_url") for item in serialize_many(cursor)]


def _report_photo_ids(event: dict) -> list[str]:
    """The photos the report shows: the saved choice, or the first few uploaded."""
    return report_files.report_photo_ids(event, managed_event_media)


def _evidence(label: str) -> tuple:
    if label == "document":
        return managed_event_documents, {}
    return managed_event_media, {"media_type": "image" if label == "photo" else "video"}


def _ensure_recordable(event: dict) -> None:
    """The teacher's evidence rule (ensure_submittable): whichever kinds the
    Super Admin marked mandatory must be attached before the event is saved."""
    event_key = str(event["_id"])
    limits = get_upload_limits()
    for label, flag in REQUIREMENT_FIELDS.items():
        if not limits.get(flag):
            continue
        collection, query = _evidence(label)
        if collection.count_documents({"event_id": event_key, **query}) < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"At least one {label} is required before saving the event.",
            )


def _event_values(payload: EventCreateRequest, user: dict) -> dict:
    return {
        "event_name": payload.event_name,
        "event_date": payload.event_date,
        "end_date": payload.end_date,
        "event_type": resolve_event_type(payload.event_type, created_by=user["id"]),
        "location": payload.location,
        "description": payload.description,
        "social_network_url": payload.social_network_url,
        "start_time": payload.start_time,
        "end_time": payload.end_time,
        "organizer": payload.organizer,
        "coordinator_contact": payload.coordinator_contact,
    }


def _public_event(event: dict) -> dict:
    item = with_legacy_metadata(serialize(dict(event)))
    report_files.with_report_photos(item, event, managed_event_media)
    return item


# ============================================================
# EVENTS (mirrors /teacher/events)
# ============================================================

@router.get("/events")
def list_events(
    skip: int | None = Query(default=None, ge=0),
    limit: int | None = Query(default=None, ge=1, le=1000),
    user: dict = Depends(manager_dep),
):
    event_list, total = paginate(
        managed_events, {"owner_id": user["id"]}, "created_at", DESCENDING, skip, limit
    )
    many_with_legacy_metadata(event_list)
    return {
        "success": True,
        "events": event_list,
        "total": total,
        "count": len(event_list),
        "has_more": (skip or 0) + len(event_list) < total,
        "skip": skip or 0,
        "limit": limit,
    }


@router.post("/events", status_code=status.HTTP_201_CREATED)
def create_event(payload: EventCreateRequest, user: dict = Depends(manager_dep)):
    # As for teachers: save a draft, attach the files, then save it for real.
    if not payload.save_as_draft:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Save the event first, attach its photos and documents, then save it.",
        )
    now = utc_now()
    document = {
        **_event_values(payload, user),
        "owner_id": user["id"],
        "owner_name": user.get("name"),
        "owner_email": user.get("email"),
        "status": "draft",
        "report_photo_ids": None,
        "history": [new_history_entry(action="created", status="draft", actor=user)],
        "created_at": now,
        "updated_at": now,
    }
    document["_id"] = managed_events.insert_one(document).inserted_id
    return {"success": True, "message": "Draft saved", "event": serialize(document)}


@router.post("/events/bulk-record")
def bulk_record_events(payload: BulkEventIdsRequest, user: dict = Depends(manager_dep)):
    """Record the selected drafts in one request -- each with the checks the
    form's Save runs (mandatory uploads, saved details still valid). A draft
    that fails them is reported with the reason; the others are recorded."""
    wanted: list[ObjectId] = []
    results: list[dict] = []
    for value in payload.event_ids:
        object_id = to_object_id(value)
        if object_id is None:
            results.append({"event_id": value, "event_name": None, "status": "not_found", "reason": "Event not found."})
        elif object_id not in wanted:
            wanted.append(object_id)
    found = {row["_id"]: row for row in managed_events.find({"_id": {"$in": wanted}, "owner_id": user["id"]})}

    for object_id in wanted:
        event = found.get(object_id)
        if not event:
            results.append({"event_id": str(object_id), "event_name": None, "status": "not_found", "reason": "Event not found."})
            continue
        row = {"event_id": str(object_id), "event_name": event.get("event_name")}
        if event.get("status") != "draft":
            results.append({**row, "status": "skipped", "reason": "Already recorded."})
            continue
        try:
            _ensure_recordable(event)
        except HTTPException as error:
            results.append({**row, "status": "skipped", "reason": error.detail})
            continue
        problem = draft_details_error(event)
        if problem:
            results.append({**row, "status": "skipped", "reason": f"Complete the event details first. {problem}"})
            continue
        now = utc_now()
        recorded = managed_events.find_one_and_update(
            {"_id": object_id, "owner_id": user["id"], "status": "draft"},
            {
                "$set": {"status": RECORDED, "recorded_at": now, "updated_at": now},
                "$push": {"history": new_history_entry(
                    action=RECORDED, status=RECORDED, from_status="draft", actor=user,
                )},
            },
            return_document=True,
        )
        if recorded:
            results.append({**row, "status": "recorded", "reason": None})
        else:
            results.append({**row, "status": "skipped", "reason": "This event changed meanwhile. Reload and try again."})

    count = sum(1 for r in results if r["status"] == "recorded")
    logger.info("managed_events_bulk_recorded count=%d owner=%s", count, user["id"])
    return {
        "success": True,
        "requested_count": len(results),
        "recorded_count": count,
        "skipped_count": len(results) - count,
        "results": results,
        "message": f"{count} event{'s' if count != 1 else ''} recorded.",
    }


@router.post("/events/bulk-delete")
def bulk_delete_events(payload: ManagedBulkDeleteRequest, user: dict = Depends(manager_dep)):
    """Delete the selected events, with their files, in one request.

    Every id is resolved in one query and only the caller's own events are
    touched; the response accounts for each id (deleted, or not found).
    """
    wanted: list[ObjectId] = []
    results: list[dict] = []
    for value in payload.event_ids:
        object_id = to_object_id(value)
        if object_id is None:
            results.append({"event_id": value, "event_name": None, "status": "not_found"})
        elif object_id not in wanted:
            wanted.append(object_id)

    found = {row["_id"]: row for row in managed_events.find(
        {"_id": {"$in": wanted}, "owner_id": user["id"]}, {"event_name": 1}
    )}
    for object_id in wanted:
        row = found.get(object_id)
        results.append({
            "event_id": str(object_id),
            "event_name": row.get("event_name") if row else None,
            "status": "deleted" if row else "not_found",
        })

    ids = list(found)
    keys = [str(object_id) for object_id in ids]
    if ids:
        managed_events.delete_many({"_id": {"$in": ids}, "owner_id": user["id"]})
        for collection in (managed_event_media, managed_event_documents):
            for row in collection.find({"event_id": {"$in": keys}}):
                delete_stored(row)
            collection.delete_many({"event_id": {"$in": keys}})
        try:
            event_reports.delete_many({"event_id": {"$in": keys}})
        except Exception:
            pass
    logger.info("managed_events_bulk_deleted count=%d owner=%s", len(ids), user["id"])

    deleted = len(ids)
    return {
        "success": True,
        "requested_count": len(results),
        "deleted_count": deleted,
        "not_found_count": len(results) - deleted,
        "results": results,
        "message": f"{deleted} event{'s' if deleted != 1 else ''} deleted permanently.",
    }


@router.get("/events/{event_id}")
def get_event(event_id: str, request: Request, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    key = str(event["_id"])
    return {
        "success": True,
        "event": _public_event(event),
        "media": _list_media(request, key),
        "documents": _list_documents(request, key),
    }


@router.patch("/events/{event_id}")
def update_event(event_id: str, payload: EventUpdateRequest, user: dict = Depends(manager_dep)):
    """Save a draft (`save_as_draft`), or save the event: recorded at once."""
    event = _own_event_or_404(event_id, user)
    previous = event.get("status")

    if payload.save_as_draft and previous != "draft":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This event has already been saved and can no longer be a draft.",
        )

    changes = {**_event_values(payload, user), "updated_at": utc_now()}
    update: dict = {"$set": changes}
    if payload.save_as_draft:
        changes["status"] = "draft"
    else:
        _ensure_recordable(event)
        changes["status"] = RECORDED
        if previous != RECORDED:
            changes["recorded_at"] = utc_now()
        update["$push"] = {
            "history": new_history_entry(
                action=RECORDED if previous != RECORDED else "updated",
                status=RECORDED,
                from_status=previous,
                actor=user,
            )
        }

    updated = managed_events.find_one_and_update(
        {"_id": event["_id"], "owner_id": user["id"]}, update, return_document=True
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")
    return {
        "success": True,
        "message": "Draft saved" if payload.save_as_draft else "Event saved",
        "event": serialize(updated),
    }


@router.delete("/events/{event_id}")
def delete_event(event_id: str, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    key = str(event["_id"])
    managed_events.delete_one({"_id": event["_id"]})
    for collection in (managed_event_media, managed_event_documents):
        for row in collection.find({"event_id": key}):
            delete_stored(row)
        collection.delete_many({"event_id": key})
    try:
        event_reports.delete_many({"event_id": key})
    except Exception:
        pass
    logger.info("managed_event_deleted id=%s owner=%s", key, user["id"])
    return {"success": True, "message": "Event deleted successfully"}


# ============================================================
# MEDIA AND DOCUMENTS (mirrors /teacher/events/{id}/media|documents)
# ============================================================

def _record(collection, document: dict, stored: dict, cap_query: dict, cap, kind: str, cap_bytes) -> None:
    """Insert the record for bytes just stored; roll both back if a race
    pushed the event past a cap (the later upload loses, as for teachers)."""
    try:
        inserted = collection.insert_one(document).inserted_id
    except Exception:
        delete_stored(stored)
        raise
    document["_id"] = inserted

    def roll_back() -> None:
        collection.delete_one({"_id": inserted})
        delete_stored(stored)

    if cap is not None:
        ids = [row["_id"] for row in collection.find(cap_query, {"_id": 1}).sort("_id", ASCENDING)]
        if inserted in ids[cap:]:
            roll_back()
            raise _cap_error(cap, kind)
    if cap_bytes is not None:
        running = 0
        for row in collection.find(cap_query, {"_id": 1, "file_size": 1}).sort("_id", ASCENDING):
            running += row.get("file_size") or 0
            if row["_id"] == inserted:
                if running > cap_bytes:
                    roll_back()
                    raise _size_cap_error(cap_bytes, kind)
                break


@router.get("/events/{event_id}/media")
def get_media(event_id: str, request: Request, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    media = _list_media(request, str(event["_id"]))
    return {"success": True, "event_id": event_id, "media": media, "total": len(media)}


@router.post("/events/{event_id}/media", status_code=status.HTTP_201_CREATED)
def upload_media(
    event_id: str,
    request: Request,
    file: UploadFile = File(...),
    user: dict = Depends(manager_dep),
):
    event = _own_event_or_404(event_id, user)
    event_key = str(event["_id"])

    info = inspect_media(file)
    media_type = info["kind"]
    is_image = media_type == "image"
    limits = get_upload_limits()
    cap = limits["max_photos_per_event"] if is_image else limits.get("max_videos_per_event")
    cap_bytes = limits["max_photo_total_bytes"] if is_image else limits["max_video_total_bytes"]
    per_file = limits["max_photo_size_bytes"] if is_image else limits["max_video_size_bytes"]
    cap_query = {"event_id": event_key, "media_type": media_type}
    _ensure_under_cap(managed_event_media, cap_query, cap, media_type)

    buffer, size = stream_upload(file, per_file, what="Photos" if is_image else "Videos")
    try:
        check_file_signature(info["extension"], peek_head(buffer))
        _ensure_bytes_under_cap(managed_event_media, cap_query, size, cap_bytes, media_type)
        file_name = safe_file_name(file.filename)
        stored = save_upload(
            buffer, file_name=file_name, content_type=info["content_type"],
            kind="media", event_id=event_key, teacher_id=user["id"],
        )
    finally:
        buffer.close()

    document = new_media_document(
        event_id=event_key, storage=stored["storage"], object_key=stored["object_key"],
        file_id=stored["file_id"], file_name=file_name, media_url=stored["url"],
        media_type=media_type, content_type=info["content_type"], file_size=size,
        original_name=file.filename,
    )
    _record(managed_event_media, document, stored, cap_query, cap, media_type, cap_bytes)
    return {
        "success": True,
        "message": "Media uploaded successfully",
        "media": absolutize(request, serialize(document), "media_url"),
    }


@router.get("/events/{event_id}/documents")
def get_documents(event_id: str, request: Request, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    documents = _list_documents(request, str(event["_id"]))
    return {"success": True, "event_id": event_id, "documents": documents, "total": len(documents)}


@router.post("/events/{event_id}/documents", status_code=status.HTTP_201_CREATED)
def upload_document(
    event_id: str,
    request: Request,
    file: UploadFile = File(...),
    category: str = Form(default="notice"),
    user: dict = Depends(manager_dep),
):
    cat_param = request.query_params.get("category")
    if cat_param:
        category = cat_param

    event = _own_event_or_404(event_id, user)
    event_key = str(event["_id"])

    info = inspect_document(file)
    limits = get_upload_limits()
    cap = limits["max_documents_per_event"]
    cap_bytes = limits["max_documents_total_bytes"]
    cap_query = {"event_id": event_key}
    _ensure_under_cap(managed_event_documents, cap_query, cap, "document")

    buffer, size = stream_upload(file, cap_bytes, what="Documents")
    try:
        check_file_signature(info["extension"], peek_head(buffer))
        _ensure_bytes_under_cap(managed_event_documents, cap_query, size, cap_bytes, "document")
        file_name = safe_file_name(file.filename)
        stored = save_upload(
            buffer, file_name=file_name, content_type=info["content_type"],
            kind="documents", event_id=event_key, teacher_id=user["id"],
        )
    finally:
        buffer.close()

    document = new_document_document(
        event_id=event_key, storage=stored["storage"], object_key=stored["object_key"],
        file_id=stored["file_id"], file_name=file_name, file_url=stored["url"],
        file_type=info["content_type"], file_size=size, original_name=file.filename,
        category=category,
    )
    _record(managed_event_documents, document, stored, cap_query, cap, "document", cap_bytes)
    return {
        "success": True,
        "message": "Document uploaded successfully",
        "document": absolutize(request, serialize(document), "file_url"),
    }


@router.get("/events/{event_id}/uploads/check-name")
def check_upload_names(
    event_id: str,
    file_name: list[str] = Query(default=[]),
    kind: str = Query(default="media", pattern="^(media|documents)$"),
    user: dict = Depends(manager_dep),
):
    """Which of these names the event already has (the "same name?" prompt)."""
    event = _own_event_or_404(event_id, user)
    collection = managed_event_media if kind == "media" else managed_event_documents
    results: dict[str, bool] = {}
    for raw in file_name:
        key = upload_name_key(raw, raw)
        if not key:
            continue
        results[raw] = collection.find_one({
            "event_id": str(event["_id"]),
            "$or": [{"name_key": key}, {"file_name": raw}],
        }) is not None
    return {"success": True, "duplicates": results, "any": any(results.values())}


def _delete_file(collection, record_id: str, event: dict, not_found: str) -> dict:
    """Delete one file. A recorded event keeps its last file of a mandatory
    kind -- the rule that let it be saved -- as a pending teacher event does."""
    record = collection.find_one({"_id": to_object_id(record_id), "event_id": str(event["_id"])})
    if not record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=not_found)

    if event.get("status") == RECORDED:
        label = "document" if collection is managed_event_documents else (
            "photo" if record.get("media_type") == "image" else "video"
        )
        if get_upload_limits().get(REQUIREMENT_FIELDS[label]):
            _, query = _evidence(label)
            if collection.count_documents({"event_id": str(event["_id"]), **query}) <= 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"A saved event must keep at least one {label}. Upload another first.",
                )

    collection.delete_one({"_id": record["_id"]})
    delete_stored(record)
    return record


@router.delete("/events/{event_id}/media/{media_id}")
def delete_media(event_id: str, media_id: str, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    record = _delete_file(managed_event_media, media_id, event, "Media not found")
    if event.get("report_photo_ids"):
        managed_events.update_one(
            {"_id": event["_id"]}, {"$pull": {"report_photo_ids": str(record["_id"])}}
        )
    return {"success": True, "message": "Media deleted successfully"}


@router.delete("/events/{event_id}/documents/{document_id}")
def delete_document(event_id: str, document_id: str, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    _delete_file(managed_event_documents, document_id, event, "Document not found")
    return {"success": True, "message": "Document deleted successfully"}


# ============================================================
# DIRECT UPLOADS (mirrors /teacher/events/{id}/uploads)
# ============================================================

UPLOAD_SCOPE = "event_manager"


@router.post("/events/{event_id}/uploads")
def start_direct_upload(
    event_id: str,
    payload: DirectUploadStartRequest,
    background_tasks: BackgroundTasks,
    user: dict = Depends(manager_dep),
):
    event = _own_event_or_404(event_id, user)
    if not direct_upload.available():
        return {"success": True, "direct": False}

    event_key = str(event["_id"])
    info = direct_upload.inspect_declared(payload.kind, payload.file_name, payload.content_type)
    collection = managed_event_documents if info["media_type"] == "document" else managed_event_media
    _ensure_direct_upload_fits(collection, event_key, info, payload.size, get_upload_limits())

    started = direct_upload.start_session(
        scope=UPLOAD_SCOPE,
        owner_id=user["id"],
        event_key=event_key,
        kind=payload.kind,
        info=info,
        file_name=safe_file_name(payload.file_name),
        original_name=payload.file_name,
        size=payload.size,
        category=payload.category,
    )
    background_tasks.add_task(direct_upload.sweep_if_due)
    return {"success": True, "direct": True, **started}


@router.post("/events/{event_id}/uploads/{session_id}/sign")
def sign_direct_upload(
    event_id: str,
    session_id: str,
    payload: DirectUploadSignRequest | None = None,
    user: dict = Depends(manager_dep),
):
    _own_event_or_404(event_id, user)
    session = direct_upload.active_session(
        session_id, scope=UPLOAD_SCOPE, owner_id=user["id"], event_id=event_id
    )
    return {
        "success": True,
        **direct_upload.sign_urls(session, payload.part_numbers if payload else None),
    }


@router.post("/events/{event_id}/uploads/{session_id}/complete", status_code=status.HTTP_201_CREATED)
def complete_direct_upload(
    event_id: str,
    session_id: str,
    request: Request,
    user: dict = Depends(manager_dep),
):
    session = direct_upload.claim_session(
        session_id, scope=UPLOAD_SCOPE, owner_id=user["id"], event_id=event_id
    )
    try:
        event = _own_event_or_404(event_id, user)
    except HTTPException:
        direct_upload.discard(session)
        raise

    media_type = session["media_type"]
    caps = direct_upload.caps_for(media_type, get_upload_limits())
    direct_upload.finalize_object(session, per_file_bytes=caps["per_file_bytes"], what=caps["what"])

    collection = managed_event_documents if media_type == "document" else managed_event_media
    document, stored = direct_upload.new_record(session)
    try:
        # Deletes the object itself whenever it refuses the record.
        _record(
            collection, document, stored,
            direct_upload.cap_query(str(event["_id"]), media_type),
            caps["cap"], media_type, caps["cap_bytes"],
        )
    except Exception:
        direct_upload.finish(session, direct_upload.FAILED)
        raise
    direct_upload.finish(session, direct_upload.COMPLETED, record_id=document["_id"])

    return _direct_upload_response(request, document)


@router.delete("/events/{event_id}/uploads/{session_id}")
def abort_direct_upload(event_id: str, session_id: str, user: dict = Depends(manager_dep)):
    """Cancel an unfinished upload; works even after the event was deleted."""
    aborted = direct_upload.abort_session(
        session_id, scope=UPLOAD_SCOPE, owner_id=user["id"], event_id=event_id
    )
    return {"success": True, "aborted": aborted}


# ============================================================
# REPORT PHOTOS AND REPORTS
# ============================================================

@router.put("/events/{event_id}/report-photos")
def set_report_photos(event_id: str, payload: ReportPhotosRequest, user: dict = Depends(manager_dep)):
    event = _own_event_or_404(event_id, user)
    chosen = report_files.clean_report_choice(payload.photo_ids, str(event["_id"]), managed_event_media)
    managed_events.update_one(
        {"_id": event["_id"]}, {"$set": {"report_photo_ids": chosen, "updated_at": utc_now()}}
    )
    return {"success": True, "message": "Report photos saved.", "report_photo_ids": chosen}


# Signed with this scope so a link from an Event Manager report opens only
# files from the Event Manager's collections.
LINK_SCOPE = "managed"


def _download_link(request: Request, kind: str, file_id: str, exp: int) -> str:
    sig = report_files.link_signature(LINK_SCOPE, kind, file_id, exp)
    return absolute_url(request, f"/event-manager/files/{kind}/{file_id}?exp={exp}&sig={sig}")


def _report_entry(request: Request, event: dict, exp: int, customization: dict | None = None) -> ReportEntry:
    opts = customization or {}
    inc_photos = opts.get("include_photos", True)
    selected_pids = opts.get("selected_photo_ids")

    key = str(event["_id"])
    media = list(managed_event_media.find({"event_id": key}).sort("_id", ASCENDING))
    documents = list(managed_event_documents.find({"event_id": key}).sort("_id", ASCENDING))
    by_id = {str(row["_id"]): row for row in media}

    photos, failures = [], 0
    if inc_photos:
        if selected_pids:
            pids = [
                pid for pid in selected_pids
                if pid in by_id and by_id[pid].get("media_type") == "image"
            ]
        else:
            pids = _report_photo_ids(event)
        for pid in pids:
            row = by_id.get(pid)
            if not row:
                failures += 1
                continue
            data = report_files.read_file_bytes(row, fs)
            prepared = prepare_photo(data) if data else None
            del data
            if prepared:
                photos.append(prepared)
            else:
                failures += 1

    attachments = [
        attachment_for(
            kind,
            row,
            row.get("original_name") or row.get("file_name") or "file",
            _download_link(request, kind, str(row["_id"]), exp),
        )
        for kind, row in report_files.report_attachment_rows(media, documents, opts)
    ]

    # The form keeps department and expected participants in the description's
    # metadata blob, exactly as the teacher form does.
    item = with_legacy_metadata(serialize(dict(event)))
    description, meta = split_description(item.get("description"))
    item["description"] = description
    item["expected_participants"] = meta.get("expectedParticipants")
    item["department"] = meta.get("department") or settings.default_host_department
    return ReportEntry(
        event=item,
        photos=photos,
        photo_failures=failures,
        attachments=attachments,
        recorded_by={"name": event.get("owner_name"), "email": event.get("owner_email")},
        customization=opts,
    )


def _pdf_response(buffer, file_name: str) -> StreamingResponse:
    return StreamingResponse(
        buffer,
        media_type="application/pdf",
        headers={
            "Content-Disposition": content_disposition("attachment", file_name, "Event_Report.pdf"),
            "Cache-Control": "private, no-store",
        },
    )


def _report_file_name(name: str | None) -> str:
    """The event's title as the file name: "IEEE Conference.pdf"."""
    return report_file_name(name)


def _record_reports(events: list[dict], customization: dict | None, user: dict) -> None:
    """Note that these events have a report, so the Dean's page shows it as
    generated -- for a consolidated report as much as a single one."""
    now = utc_now()
    for event in events:
        key = str(event["_id"])
        report_doc = {
            "event_id": key,
            "report_title": f"Event Report - {event.get('event_name')}",
            "report_content": f"Event Report for {event.get('event_name')}",
            "generated_at": now,
            "generated_by": user.get("id"),
        }
        if customization:
            report_doc["customization"] = customization
        try:
            event_reports.replace_one({"event_id": key}, report_doc, upsert=True)
        except Exception as exc:  # the PDF is already built; do not fail the download
            logger.warning("managed_report_status_not_recorded id=%s error=%s", key, exc)
        managed_events.update_one(
            {"_id": event["_id"]},
            {"$set": {"report_generated_at": now, "updated_at": now}},
        )


@router.api_route("/events/{event_id}/report", methods=["GET", "POST"])
def event_report(
    event_id: str,
    request: Request,
    payload: ReportCustomizationOptions | None = None,
    user: dict = Depends(manager_dep),
    include_basic_details: bool | None = Query(default=None),
    include_schedule_venue: bool | None = Query(default=None),
    include_description: bool | None = Query(default=None),
    include_other_info: bool | None = Query(default=None),
    include_photos: bool | None = Query(default=None),
    include_documents: bool | None = Query(default=None),
    include_notices: bool | None = Query(default=None),
    include_reports: bool | None = Query(default=None),
):
    """The report for one event -- generated directly, with optional customization."""
    event = _own_event_or_404(event_id, user)

    customization = report_files.resolve_customization(
        payload,
        {
            "include_basic_details": include_basic_details,
            "include_schedule_venue": include_schedule_venue,
            "include_description": include_description,
            "include_other_info": include_other_info,
            "include_photos": include_photos,
            "include_documents": include_documents,
            "include_notices": include_notices,
            "include_reports": include_reports,
        },
    )

    exp = report_files.links_expiry()
    entry = _report_entry(request, event, exp, customization=customization)
    pdf = build_managed_report_pdf(
        [entry],
        links_valid_until=datetime.fromtimestamp(exp, tz=timezone.utc),
        customization=customization,
    )
    logger.info("managed_report_generated events=1 owner=%s", user["id"])
    _record_reports([event], customization, user)
    return _pdf_response(pdf, _report_file_name(event.get("event_name")))


@router.post("/reports")
def multi_event_report(payload: ManagedReportRequest, request: Request, user: dict = Depends(manager_dep)):
    """One consolidated report for several events, in the order given."""
    wanted: list[ObjectId] = []
    for value in payload.event_ids:
        object_id = to_object_id(value)
        if object_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid event id.")
        if object_id not in wanted:
            wanted.append(object_id)
    found = {row["_id"]: row for row in managed_events.find({"_id": {"$in": wanted}, "owner_id": user["id"]})}
    missing = len(wanted) - len(found)
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{missing} of the selected events could not be found.",
        )

    customization = report_files.resolve_customization(payload.customization)

    exp = report_files.links_expiry()
    entries = [_report_entry(request, found[oid], exp, customization=customization) for oid in wanted]
    pdf = build_managed_report_pdf(
        entries,
        links_valid_until=datetime.fromtimestamp(exp, tz=timezone.utc),
        prepared_by={"name": user.get("name"), "email": user.get("email")},
        customization=customization,
    )
    logger.info("managed_report_generated events=%d owner=%s", len(entries), user["id"])
    _record_reports([found[oid] for oid in wanted], customization, user)
    name = (
        _report_file_name(entries[0].event.get("event_name"))
        if len(entries) == 1
        else report_file_name(f"Consolidated_Event_Report_{utc_now():%Y-%m-%d}")
    )
    return _pdf_response(pdf, name)



# ============================================================
# DOWNLOAD LINKS (printed in reports)
# ============================================================

@router.get("/files/{kind}/{file_id}")
def download_file(
    kind: str,
    file_id: str,
    exp: int = Query(...),
    sig: str = Query(..., max_length=128),
):
    """A file from an Event Manager report. The signature is the credential:
    the link is opened from a PDF, without the app's login token."""
    object_id = to_object_id(file_id)
    if not report_files.valid_link(LINK_SCOPE, kind, object_id, exp, sig):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This download link has expired or is invalid.")

    collection = managed_event_media if kind == "media" else managed_event_documents
    return report_files.download_response(collection.find_one({"_id": object_id}), fs)
