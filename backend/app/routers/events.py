import logging
import re
from datetime import date, timedelta

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Body,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from bson import ObjectId
from pymongo import ASCENDING, DESCENDING

from app.config import settings
from app.database import (
    event_documents,
    event_media,
    event_reports,
    events,
    managed_event_documents,
    managed_event_media,
    managed_events,
    notifications,
    users,
)
from app.models.documents import (
    APPROVED_STAGES,
    DEAN_PROGRESS_STAGES,
    LEGACY_PROGRESS_STAGES,
    TEACHER_EDITABLE_STATUSES,
    new_document_document,
    new_event_document,
    new_history_entry,
    upload_name_key,
    new_media_document,
    new_notification_document,
)
from app.schemas.events import (
    BulkEventIdsRequest,
    DeanBulkArchiveEventsRequest,
    DeanBulkDeleteEventsRequest,
    DeanDecisionBody,
    EventCreateRequest,
    EventUpdateRequest,
    NotificationCreateRequest,
    draft_details_error,
    future_schedule_error,
)
from app.schemas.event_manager import ReportPhotosRequest
from app.schemas.uploads import DirectUploadSignRequest, DirectUploadStartRequest
from app.services import email_service, report_files
from app.services.audit_service import log_audit_event
from app.services.event_types import resolve_event_type
from app.services.event_fields import (
    many_with_legacy_metadata,
    with_legacy_metadata,
)
from app.services import direct_upload
from app.services.storage_service import (
    absolutize,
    check_declared_size,
    check_file_signature,
    delete_event_cascade,
    delete_events_cascade,
    delete_stored,
    inspect_document,
    inspect_media,
    peek_head,
    read_upload,
    safe_file_name,
    save_upload,
    stream_upload,
)
from app.services.upload_config_service import (
    REQUIREMENT_FIELDS,
    get_public_upload_limits,
    get_upload_limits,
)
from app.utils.auth import check_dean, check_event_viewer, get_current_user, require_role
from app.utils.serializers import serialize, serialize_many, to_object_id, utc_now


router = APIRouter(
    tags=["Events", "Dean", "Teacher"]
)
logger = logging.getLogger(__name__)


# ============================================================
# HELPERS
# ============================================================

EVENT_PUBLIC_FIELDS = (
    "id",
    "teacher_id",
    "event_name",
    "event_date",
    "event_type",
    "location",
    "description",
    "social_network_url",
    "status",
    "rejection_reason",
    "submitted_at",
    "reviewed_at",
    "created_at",
    "updated_at",
)


def _should_include_managed_events() -> bool:
    return not (hasattr(events, "docs") and not hasattr(managed_events, "docs"))


def find_event_or_404(event_id: str) -> dict:
    object_id = to_object_id(event_id)
    event = events.find_one({"_id": object_id}) if object_id else None
    if event:
        event["_source_collection"] = "events"
    elif object_id and _should_include_managed_events():
        try:
            event = managed_events.find_one({"_id": object_id})
            if event:
                event["_source_collection"] = "managed_events"
        except Exception:
            event = None

    if not event:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event not found"
        )

    return event


def find_teacher_event_or_404(event_id: str, teacher_id: str) -> dict:
    event = find_event_or_404(event_id)

    if event.get("teacher_id") != teacher_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not authorized to access this event"
        )

    return event


def ensure_teacher_can_edit(event: dict) -> None:
    if event.get("status") not in TEACHER_EDITABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This event has already been approved and can no longer be edited."
        )


def ensure_submittable(event: dict) -> None:
    """Refuse to put an event in front of a Dean without its evidence.

    Which kinds are mandatory is a Super Admin setting (`*_required` in the
    upload config); the default is the PRD rule of at least one photo and at
    least one supporting document. Every route that moves an event into
    `pending` must call this -- it used to live inline
    in the PATCH handler only, so POST /teacher/events (save_as_draft=false)
    and PATCH .../resubmit both reached the Dean's queue with nothing attached.

    It previously also skipped itself whenever PYTEST_CURRENT_TEST was set, or
    when a request sent X-Enforce-Upload-Validation. Both are gone: production
    request handling must not branch on the test environment, and a validation
    rule must not be switchable from a header.
    """
    event_key = str(event["_id"])
    limits = get_upload_limits()

    for label, flag in REQUIREMENT_FIELDS.items():
        if not limits.get(flag):
            continue
        collection, query = _evidence_query(label)
        if collection.count_documents({"event_id": event_key, **query}) < 1:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"At least one {label} is required before submitting the event for approval.",
            )


def _evidence_query(label: str) -> tuple:
    """The collection and extra filter that count one upload kind.

    Resolved per call rather than held in a module-level dict, so the
    collections patched onto this module in tests are the ones used.
    """
    if label == "document":
        return event_documents, {}
    return event_media, {"media_type": "image" if label == "photo" else "video"}


# Statuses a Dean decision (approve / reject / request changes) may start
# from. "pending" is what every submission is stored as; "submitted" and
# "under_review" are reserved lifecycle values that mean the same thing to a
# Dean (the dashboard counts all three as pending).
# The Dean's status tabs, as status sets. Mirrors getStatusBucket() in
# frontend/src/utils/constants.js -- the two must agree or a tab's count will
# not match the rows it shows.
STATUS_BUCKETS = {
    "pending": ("pending", "submitted", "under_review"),
    "approved": ("approved", "published", "in_progress", "completed", "recorded"),
    "rejected": ("rejected", "revoked"),
}

DEAN_REVIEWABLE_STATUSES = ("pending", "submitted", "under_review")

# Statuses a Dean may approve *out of* -- a refusal being reconsidered. A
# rejected event, or one approved and then revoked, goes straight back to
# approved without waiting for the teacher to resubmit: the Dean refused it,
# so the Dean can undo that. Mirrors canApprove()/getApproveLabel() in
# frontend/src/utils/constants.js -- the button has always offered this.
REAPPROVABLE_STATUSES = ("rejected", "revoked")

# How many accounts a free-text search may resolve to when matching events by
# their submitting teacher. A guard against a one-character query turning into
# an `$in` of every user, not a limit anyone should reach by searching a name.
TEACHER_SEARCH_MATCH_LIMIT = 200

# Statuses from which /resubmit puts an event (back) in the review queue.
# A revoked event must be resubmittable, or revoking strands it permanently.
RESUBMITTABLE_STATUSES = ("rejected", "draft", "revoked")

CHANGED_WHILE_EDITING = (
    "This event was changed by someone else while you were working on it. "
    "Please reload it and try again."
)


def conflict(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)


def update_event(
    event_id: str,
    changes: dict,
    *,
    history: dict | None = None,
    expected_status: str | None = None,
) -> dict | None:
    """Apply `changes`, and append `history` to the audit trail in the same
    update, so a status change and its record can never exist one without
    the other.

    With `expected_status` the write only happens if the event still has that
    status, which makes check-then-write transitions atomic: a None result
    then means the status moved underneath the caller (or the event is gone).
    """
    update: dict = {"$set": {**changes, "updated_at": utc_now()}}

    if history is not None:
        update["$push"] = {"history": history}

    query: dict = {"_id": to_object_id(event_id)}
    if expected_status is not None:
        query["status"] = expected_status

    res = events.find_one_and_update(
        query,
        update,
        return_document=True,
    )
    if not res and _should_include_managed_events():
        res = managed_events.find_one_and_update(
            query,
            update,
            return_document=True,
        )
    return res


def invalidate_report(event_id: str) -> None:
    """Drop a generated report: the event it described has changed."""
    event_reports.delete_many({"event_id": event_id})


def page(cursor, skip: int | None, limit: int | None):
    if skip:
        cursor = cursor.skip(skip)
    if limit:
        cursor = cursor.limit(limit)
    return cursor


def paginate(
    collection,
    query: dict,
    sort_field: str | list[tuple[str, int]],
    direction: int | None,
    skip: int | None,
    limit: int | None,
) -> tuple[list[dict], int]:
    """One page of `query`, plus how many documents match it in total.

    `total` is the size of the whole result set, not of the page -- a paging
    UI needs the former to render "1-25 of 312" and to know whether a next
    page exists. Counting with the same filter object keeps the two in step.

    `sort_field` is one field (with `direction`) or a list of
    ``(field, direction)`` pairs for a sort with tie-breakers.
    """
    total = collection.count_documents(query)
    cursor = collection.find(query)
    cursor = cursor.sort(sort_field) if isinstance(sort_field, list) else cursor.sort(sort_field, direction)
    cursor = page(cursor, skip, limit)
    return serialize_many(cursor), total


# Who an event came from, for the Dean's "Submitted by" filter: a teacher's
# events live in `events`, an Event Manager's in `managed_events`.
EVENT_SOURCES = ("all", "teacher", "event_manager")


def event_sources(source: str | None) -> tuple[bool, bool]:
    """(read teacher events, read Event Manager events) for a source filter."""
    value = (source or "all").strip().lower()
    if value not in EVENT_SOURCES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown source filter.")
    return value != "event_manager", value != "teacher" and _should_include_managed_events()


def paginate_with_managed(
    query: dict,
    events_sort: list[tuple[str, int]],
    managed_sort: list[tuple[str, int]],
    stamp,
    skip: int | None,
    limit: int | None,
    *,
    sources: tuple[bool, bool] = (True, True),
) -> tuple[list[dict], int]:
    """paginate() over teacher events and Event Manager events together.

    Each collection is sorted on its own terms, then the two are merged by
    ``stamp(serialized_doc)`` (newest first). Only the first skip + limit of
    each can reach the page, so that is all either one is asked for.
    ``sources`` narrows it to one of the two (the "Submitted by" filter).
    """
    use_events, use_managed = sources
    if not use_events:
        return paginate(managed_events, query, managed_sort, None, skip, limit)
    total_managed = (
        managed_events.count_documents(query) if use_managed and _should_include_managed_events() else 0
    )
    if not total_managed:
        return paginate(events, query, events_sort, None, skip, limit)

    total = events.count_documents(query) + total_managed
    start = skip or 0
    needed = start + (limit if limit is not None else total)
    merged = serialize_many(events.find(query).sort(events_sort).limit(needed)) + serialize_many(
        managed_events.find(query).sort(managed_sort).limit(needed)
    )
    merged.sort(key=stamp, reverse=True)
    return merged[start:start + limit if limit is not None else None], total


def find_dean_visible_event_or_404(event_id: str, *, allow_archived: bool = False) -> dict:
    """An event as a Dean may see it: drafts are reported as missing.

    Archived events are hidden the same way, so nothing can be approved,
    rejected or reported on from the shelf. The archive routes opt back in.
    """
    event = find_event_or_404(event_id)
    if not allow_archived and event.get("archived_at") is not None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event not found"
        )
    if event.get("status") == "draft":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event not found"
        )
    return event


# What each Dean action may act on, and what to say when it cannot. Revoke is
# the odd one out: it starts from an approved event, not a pending one, which
# is exactly why folding it into "reject" left it unreachable (PRD 18).
DEAN_VERBS = {
    "approve": (
        DEAN_REVIEWABLE_STATUSES + REAPPROVABLE_STATUSES,
        "Only a pending, rejected or revoked event can be approved.",
    ),
    "reject": (DEAN_REVIEWABLE_STATUSES, "Only pending events can be rejected."),
    "request changes": (
        DEAN_REVIEWABLE_STATUSES,
        "Changes can only be requested on pending events.",
    ),
    "revoke": (APPROVED_STAGES, "Only an approved event can have its approval revoked."),
}


def ensure_not_own_event(event: dict, user: dict) -> None:
    """A Dean never decides on an event they submitted themselves.

    A teacher promoted to Dean keeps their events, and nothing stopped them
    approving (or advancing) their own pending submission.
    """
    if event.get("teacher_id") and str(event.get("teacher_id")) == str(user.get("id")):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You submitted this event, so another Dean has to decide on it.",
        )


def dean_transition(
    event_id: str,
    *,
    verb: str,
    changes: dict,
    history_action: str,
    new_status: str,
    user: dict,
    note: str | None = None,
) -> dict:
    """Move an event to `new_status`, atomically.

    Each verb declares the statuses it may act from; anything else is a 409
    (a double-click, a second Dean, or a stale page). The write is filtered
    on the status that was checked, so two racing decisions cannot both win.
    """
    existing = find_dean_visible_event_or_404(event_id)
    ensure_not_own_event(existing, user)
    current = existing.get("status")

    allowed_from, message = DEAN_VERBS[verb]

    if current not in allowed_from:
        if verb == "approve" and current in APPROVED_STAGES:
            raise conflict("This event is already approved.")
        if verb == "reject" and current == "rejected":
            raise conflict("This event has already been rejected.")
        if verb == "revoke" and current == "revoked":
            raise conflict("This event's approval has already been revoked.")
        raise conflict(message)

    updated = update_event(
        event_id,
        changes,
        history=new_history_entry(
            action=history_action,
            status=new_status,
            from_status=current,
            actor=user,
            note=note,
        ),
        expected_status=current,
    )

    if not updated:
        find_event_or_404(event_id)  # 404 if it was deleted meanwhile
        raise conflict("This event was updated by someone else. Please reload it.")

    return serialize(updated)


def _decision_text(query_value: str | None, body: DeanDecisionBody | None, field: str) -> str:
    """The reason/remarks from the query string, else from the JSON body."""
    if query_value and query_value.strip():
        return query_value.strip()
    body_value = getattr(body, field, None) if body is not None else None
    return (body_value or "").strip()


def attach_teachers(event_list: list[dict]) -> None:
    ids = {
        object_id
        for object_id in (to_object_id(item.get("teacher_id") or item.get("owner_id")) for item in event_list)
        if object_id is not None
    }
    by_id = {}
    if ids:
        by_id = {
            str(document["_id"]): document
            for document in users.find({"_id": {"$in": list(ids)}}, {"name": 1, "email": 1})
        }
    for item in event_list:
        sub_id = str(item.get("teacher_id") or item.get("owner_id") or "")
        teacher = by_id.get(sub_id)
        item["teacher_name"] = item.get("owner_name") or (teacher or {}).get("name")
        item["teacher_email"] = item.get("owner_email") or (teacher or {}).get("email")
        # Who it came from, stated rather than left to be guessed from the
        # status: an Event Manager's event carries owner_id, a teacher's
        # teacher_id.
        item["submitted_by_role"] = (
            "event_manager" if item.get("owner_id") and not item.get("teacher_id") else "teacher"
        )


def list_media(request: Request, event_id: str) -> list[dict]:
    cursor = event_media.find({"event_id": event_id}).sort("created_at", ASCENDING)
    results = serialize_many(cursor)
    if not results and _should_include_managed_events():
        try:
            cursor2 = managed_event_media.find({"event_id": event_id}).sort("created_at", ASCENDING)
            results = serialize_many(cursor2)
        except Exception:
            pass
    return [absolutize(request, item, "media_url") for item in results]


def list_documents(request: Request, event_id: str) -> list[dict]:
    cursor = event_documents.find({"event_id": event_id}).sort("created_at", ASCENDING)
    results = serialize_many(cursor)
    if not results and _should_include_managed_events():
        try:
            cursor2 = managed_event_documents.find({"event_id": event_id}).sort("created_at", ASCENDING)
            results = serialize_many(cursor2)
        except Exception:
            pass
    return [absolutize(request, item, "file_url") for item in results]


# ============================================================
# SAFE NOTIFICATION CREATOR
# Notification creation errors must never block event actions
# ============================================================

def safe_create_notification(
    user_id: str,
    event_id: str | None,
    notification_type: str,
    title: str,
    message: str,
    data: dict | None = None,
) -> dict | None:
    try:
        document = new_notification_document(
            user_id=user_id,
            event_id=event_id,
            notification_type=notification_type,
            title=title,
            message=message,
            data=data,
        )
        result = notifications.insert_one(document)
        document["_id"] = result.inserted_id
        return serialize(document)
    except Exception as err:
        logger.warning(
            "notification_create_failed user_id=%s event_id=%s type=%s error=%s (non-blocking)",
            user_id, event_id, notification_type, err,
        )
        return None


def _send_status_email(
    to_email: str,
    name: str,
    event_name: str,
    email_status: str,
    remarks: str | None,
    event_id: str | None = None,
    stage: str | None = None,
    reapproved: bool = False,
) -> None:
    try:
        email_service.send_event_status_email(
            to_email,
            name,
            event_name,
            email_status,
            remarks,
            event_id=event_id,
            stage=stage,
            reapproved=reapproved,
        )
    except email_service.EmailDeliveryError:
        logger.warning("event_status_email_failed status=%s", email_status)


def notify_teacher(
    background_tasks: BackgroundTasks,
    event: dict,
    *,
    notification_type: str,
    title: str,
    message: str,
    data: dict | None = None,
    remarks: str | None = None,
    stage: str | None = None,
    reapproved: bool = False,
) -> None:
    """Create the in-app notification and queue the matching email."""
    teacher_id = event.get("teacher_id", "")

    safe_create_notification(
        user_id=teacher_id,
        event_id=event.get("id"),
        notification_type=notification_type,
        title=title,
        message=message,
        data=data,
    )

    if not email_service.is_configured():
        return

    teacher = users.find_one({"_id": to_object_id(teacher_id)}, {"email": 1, "name": 1})
    if teacher and teacher.get("email"):
        background_tasks.add_task(
            _send_status_email,
            teacher["email"],
            teacher.get("name") or "there",
            event.get("event_name") or "event",
            notification_type,
            remarks,
            event.get("id"),
            stage,
            reapproved,
        )


def notify_deans(
    event: dict,
    *,
    notification_type: str,
    title: str,
    message: str,
) -> None:
    """Put an in-app notification in front of every Dean.

    In-app only, deliberately: a Dean reviews every submission on campus, and
    one email per submission would bury the decisions that matter. The bell
    and the dashboard's pending count are where the queue is watched.
    """
    event_id = event.get("id") or (str(event["_id"]) if event.get("_id") else None)

    for dean in users.find({"role": "dean"}, {"_id": 1}):
        safe_create_notification(
            user_id=str(dean["_id"]),
            event_id=event_id,
            notification_type=notification_type,
            title=title,
            message=message,
            data={
                "event_name": event.get("event_name", ""),
                "event_type": event.get("event_type", ""),
                "event_date": event.get("event_date", ""),
            },
        )


# What a Dean is told for each way an event can land in the review queue.
# Keyed by the history action the same request records.
_QUEUE_ANNOUNCEMENTS = {
    "submitted": ("submitted", "New event submitted", "submitted {event} for review."),
    "resubmitted": (
        "resubmitted",
        "Event resubmitted",
        "resubmitted {event} after the requested changes.",
    ),
    "updated": (
        "resubmitted",
        "Submission updated",
        "updated {event} while it was waiting for review.",
    ),
}


def announce_to_deans(event: dict, action: str, teacher: dict) -> None:
    """Tell every Dean an event has entered, or re-entered, their queue."""
    notification_type, title, sentence = _QUEUE_ANNOUNCEMENTS[action]
    who = teacher.get("name") or teacher.get("email") or "A teacher"

    notify_deans(
        event,
        notification_type=notification_type,
        title=title,
        message=f"{who} " + sentence.format(event=f'"{event.get("event_name", "an event")}"'),
    )


# ============================================================
# DEAN DASHBOARD STATS
# ============================================================

@router.get(
    "/dean/dashboard/stats"
)
def dean_dashboard_stats(
    authorization: str | None = Header(
        default=None
    )
):
    user = get_current_user(authorization)
    check_dean(user)

    # Exclude drafts from Dean view
    status_counts = {
        row["_id"]: row["count"]
        for row in events.aggregate(
            [
                {"$match": {"status": {"$ne": "draft"}, "archived_at": None}},
                {"$group": {"_id": "$status", "count": {"$sum": 1}}},
            ]
        )
    }
    if _should_include_managed_events():
        try:
            for row in managed_events.aggregate(
                [
                    {"$match": {"status": {"$ne": "draft"}, "archived_at": None}},
                    {"$group": {"_id": "$status", "count": {"$sum": 1}}},
                ]
            ):
                status_counts[row["_id"]] = status_counts.get(row["_id"], 0) + row["count"]
        except Exception as exc:
            logger.warning("Error aggregating managed_events stats: %s", exc)

    def total(*statuses: str) -> int:
        return sum(status_counts.get(item, 0) for item in statuses)

    return {
        "success": True,
        "total_events": sum(status_counts.values()),
        "pending_events": total("pending", "submitted", "under_review"),
        "approved_events": total("approved", "published", "in_progress", "completed", "recorded"),
        # Revoked is bucketed with rejected everywhere else (STATUS_BUCKETS, and
        # getStatusBucket in the frontend), so counting only "rejected" here left
        # the card disagreeing with the tab right below it.
        "rejected_events": total("rejected", "revoked"),
    }


# ============================================================
# GET ALL DEAN EVENTS
#
# Optional filters:
#
# /dean/events
#
# /dean/events?event_date=2026-09-09
#
# /dean/events?event_type=Cultural
#
# /dean/events?event_date=2026-09-09&event_type=Cultural
#
# ============================================================

def _dean_event_query(
    event_date: str | None,
    event_type: str | None,
    q: str | None,
    status_bucket: str | None,
    start_date: str | None = None,
    end_date: str | None = None,
) -> dict:
    """The Dean list's filter, shared with GET /dean/events/ids.

    One definition, so "Select all matching" can never pick a different set of
    events from the one the list shows under the same filters.
    """
    # --------------------------------------------------------
    # VALIDATE DATE
    # --------------------------------------------------------

    if event_date:
        try:
            date.fromisoformat(event_date)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Invalid date format. "
                    "Use YYYY-MM-DD."
                )
            )

    if start_date:
        try:
            date.fromisoformat(start_date)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Invalid start_date format. "
                    "Use YYYY-MM-DD."
                )
            )

    if end_date:
        try:
            date.fromisoformat(end_date)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Invalid end_date format. "
                    "Use YYYY-MM-DD."
                )
            )

    if start_date and end_date and start_date > end_date:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="start_date cannot be after end_date.",
        )

    # --------------------------------------------------------
    # VALIDATE EVENT TYPE
    # --------------------------------------------------------

    normalized_event_type = None

    if event_type:
        # Resolve to the stored spelling so the filter is case-insensitive.
        # An unknown value is passed through rather than rejected: filtering by
        # a category that was since renamed should return nothing, not 400 --
        # and `create=False` stops a search box from inventing categories.
        try:
            normalized_event_type = resolve_event_type(event_type, create=False)
        except ValueError as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(error),
            ) from error

    # --------------------------------------------------------
    # BUILD QUERY
    # --------------------------------------------------------

    # Deans only review submitted events, never drafts -- and never anything
    # moved to the archive shelf (PRD 1).
    query: dict = {"status": {"$ne": "draft"}, "archived_at": None}

    if start_date or end_date:
        date_filter = {}
        if start_date:
            date_filter["$gte"] = start_date
        if end_date:
            date_filter["$lte"] = end_date
        query["event_date"] = date_filter
    elif event_date:
        query["event_date"] = event_date

    if normalized_event_type:
        query["event_type"] = normalized_event_type

    # The same buckets the Dean's status tabs show. Kept server-side so the
    # counts and the page agree -- deriving them from a page would report
    # "3 results" on page 1 of 13.
    bucket = (status_bucket or "all").strip().lower()
    if bucket and bucket != "all":
        statuses = STATUS_BUCKETS.get(bucket)
        if statuses is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Unknown status filter.",
            )
        query["status"] = {"$in": list(statuses)}

    search = (q or "").strip()
    if search:
        # Escaped: a teacher searching for "C++ Workshop" must not have the
        # "+" read as a quantifier, and an unescaped "(" would 500.
        pattern = re.escape(search)
        clauses = [
            {"event_name": {"$regex": pattern, "$options": "i"}},
            {"location": {"$regex": pattern, "$options": "i"}},
            {"organizer": {"$regex": pattern, "$options": "i"}},
            # The category, which both search boxes over this endpoint offer
            # ("Search name, venue, or type"). Without it, typing "Workshop"
            # found only events with the word in their *name*.
            {"event_type": {"$regex": pattern, "$options": "i"}},
        ]

        # The submitting teacher, by name or email. The events collection
        # stores only `teacher_id`, so the name the Super Admin's table shows
        # (and its "Search event, venue or teacher" box invites) has to be
        # resolved to ids first -- otherwise searching a teacher matched
        # nothing, or worse, only the unrelated events that happen to name
        # them as the *organizer*.
        #
        # Capped: a one-letter search would otherwise build an $in of every
        # account. 200 is far past what a useful search returns.
        teacher_ids = [
            str(document["_id"])
            for document in users.find(
                {
                    "$or": [
                        {"name": {"$regex": pattern, "$options": "i"}},
                        {"email": {"$regex": pattern, "$options": "i"}},
                    ]
                },
                {"_id": 1},
            ).limit(TEACHER_SEARCH_MATCH_LIMIT)
        ]
        if teacher_ids:
            clauses.append({"teacher_id": {"$in": teacher_ids}})
            clauses.append({"owner_id": {"$in": teacher_ids}})
        clauses.append({"owner_name": {"$regex": pattern, "$options": "i"}})
        clauses.append({"owner_email": {"$regex": pattern, "$options": "i"}})

        query["$or"] = clauses

    return query


@router.get(
    "/dean/events"
)
def get_all_events(
    authorization: str | None = Header(
        default=None
    ),

    event_date: str | None = Query(
        default=None
    ),

    start_date: str | None = Query(
        default=None
    ),

    end_date: str | None = Query(
        default=None
    ),

    event_type: str | None = Query(
        default=None
    ),

    # Free-text search over the event name, venue and organiser.
    q: str | None = Query(default=None, max_length=200),

    # One of the status buckets the Dean's tabs use, or "all".
    status_bucket: str | None = Query(default=None, max_length=20),

    # Who submitted it: "teacher", "event_manager" or "all".
    source: str | None = Query(default=None, max_length=20),

    # Optional paging. Still no default cap, so an un-paged caller keeps
    # getting everything; the Dean page now asks for a page explicitly.
    skip: int | None = Query(default=None, ge=0),
    limit: int | None = Query(default=None, ge=1, le=1000),
):
    user = get_current_user(authorization)
    check_event_viewer(user)

    query = _dean_event_query(event_date, event_type, q, status_bucket, start_date=start_date, end_date=end_date)
    use_events, use_managed = event_sources(source)

    # Counts for the status tabs, under the same non-status filters, so the
    # numbers on the tabs match what selecting one would show.
    #
    # "all" has to restate the draft exclusion: dropping the `status` key to
    # ignore the selected tab would otherwise drop the {"$ne": "draft"} the
    # base query put there, and the All tab would count drafts the Dean can
    # never see.
    count_query = {key: value for key, value in query.items() if key != "status"}
    managed_counts = {}
    if use_managed:
        try:
            managed_counts = {
                name: managed_events.count_documents({**count_query, "status": {"$in": list(statuses)}})
                for name, statuses in STATUS_BUCKETS.items()
            }
            managed_counts["all"] = managed_events.count_documents({**count_query, "status": {"$ne": "draft"}})
        except Exception as exc:
            logger.warning("Error counting managed_events: %s", exc)

    def teacher_count(query_: dict) -> int:
        return events.count_documents(query_) if use_events else 0

    counts = {
        name: teacher_count({**count_query, "status": {"$in": list(statuses)}})
        + managed_counts.get(name, 0)
        for name, statuses in STATUS_BUCKETS.items()
    }
    counts["all"] = (
        teacher_count({**count_query, "status": {"$ne": "draft"}})
        + managed_counts.get("all", 0)
    )

    def newest_first(doc: dict) -> tuple[str, str]:
        stamp = doc.get("submitted_at") or doc.get("recorded_at") or doc.get("created_at") or ""
        return (str(stamp), str(doc.get("created_at") or ""))

    event_list, total = paginate_with_managed(
        query,
        [("submitted_at", DESCENDING), ("created_at", DESCENDING)],
        [("recorded_at", DESCENDING), ("created_at", DESCENDING)],
        newest_first,
        skip,
        limit,
        sources=(use_events, use_managed),
    )

    many_with_legacy_metadata(event_list)
    attach_teachers(event_list)

    return {
        "success": True,
        "events": event_list,
        "total": total,
        "count": len(event_list),
        "counts": counts,
        "has_more": (skip or 0) + len(event_list) < total,
        "skip": skip or 0,
        "limit": limit,

        "filters": {
            "event_date": event_date,
            "start_date": start_date,
            "end_date": end_date,
            # The resolved spelling, which _dean_event_query put in the filter.
            "event_type": query.get("event_type"),
        },
    }


# ============================================================
# SELECT ALL: THE IDS OF EVERY MATCHING EVENT
# ============================================================

@router.get(
    "/dean/events/ids"
)
def get_dean_event_ids(
    authorization: str | None = Header(default=None),
    event_date: str | None = Query(default=None),
    start_date: str | None = Query(default=None),
    end_date: str | None = Query(default=None),
    event_type: str | None = Query(default=None),
    q: str | None = Query(default=None, max_length=200),
    status_bucket: str | None = Query(default=None, max_length=20),
    source: str | None = Query(default=None, max_length=20),
):
    """Every event matching the Dean list's filters, as ids and names only.

    Backs "Select all events": one light request instead of paging through
    full event documents to collect their ids.
    """
    user = get_current_user(authorization)
    check_event_viewer(user)

    query = _dean_event_query(event_date, event_type, q, status_bucket, start_date=start_date, end_date=end_date)
    use_events, use_managed = event_sources(source)
    found = []
    if use_events:
        cursor1 = events.find(query, {"_id": 1, "event_name": 1}).sort(
            [("submitted_at", DESCENDING), ("created_at", DESCENDING)]
        ).limit(MAX_BULK_EVENTS)
        found = [{"id": str(doc["_id"]), "event_name": doc.get("event_name"), "stamp": doc.get("submitted_at") or doc.get("created_at")} for doc in cursor1]

    if use_managed:
        try:
            cursor2 = managed_events.find(query, {"_id": 1, "event_name": 1, "recorded_at": 1, "created_at": 1}).sort(
                [("recorded_at", DESCENDING), ("created_at", DESCENDING)]
            ).limit(MAX_BULK_EVENTS)
            docs2 = [{"id": str(doc["_id"]), "event_name": doc.get("event_name"), "stamp": doc.get("recorded_at") or doc.get("created_at")} for doc in cursor2]
            found = found + docs2
            found.sort(key=lambda d: str(d.get("stamp") or ""), reverse=True)
        except Exception:
            pass

    results = [{"id": doc["id"], "event_name": doc.get("event_name")} for doc in found[:MAX_BULK_EVENTS]]
    return {"success": True, "events": results, "total": len(results)}


# ============================================================
# GET SINGLE DEAN EVENT
# ============================================================

@router.get(
    "/dean/events/{event_id}"
)
def get_dean_event(
    event_id: str,
    authorization: str | None = Header(
        default=None
    )
):
    user = get_current_user(authorization)
    check_event_viewer(user)

    # Archived events stay readable: the Dean has to be able to open one to
    # decide whether to restore or delete it. They are still barred from every
    # *decision* (dean_transition keeps the default) and from reports.
    event = find_dean_visible_event_or_404(event_id, allow_archived=True)
    item = with_legacy_metadata(serialize(event))
    # Who submitted it, as the list shows: pages used to download every user
    # account just to find this one name.
    attach_teachers([item])
    if not item.get("teacher_id") and item.get("owner_id"):
        item["teacher_id"] = item["owner_id"]

    return {
        "success": True,
        "event": item,
    }


# ============================================================
# GET EVENT MEDIA
# ============================================================

@router.get(
    "/dean/events/{event_id}/media"
)
def get_event_media(
    event_id: str,
    request: Request,
    authorization: str | None = Header(
        default=None
    )
):
    user = get_current_user(authorization)
    check_event_viewer(user)

    # Same reasoning as the single-event read: an archived event's media has
    # to be viewable, or "review before deleting" is not possible.
    event = find_dean_visible_event_or_404(event_id, allow_archived=True)

    media = list_media(request, str(event["_id"]))

    return {
        "success": True,
        "event_id": event_id,
        "media": media,
        "total": len(media),
    }


# ============================================================
# APPROVE EVENT
# ============================================================

@router.patch(
    "/dean/events/{event_id}/approve"
)
def approve_event(
    event_id: str,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(
        default=None
    )
):
    user = get_current_user(authorization)
    check_dean(user)

    approved_event = dean_transition(
        event_id,
        verb="approve",
        changes={
            "status": "approved",
            # Both refusal trails are cleared: approving out of "revoked" while
            # leaving revocation_reason set would leave the event reading as
            # revoked on every screen that shows the reason.
            "rejection_reason": None,
            "revocation_reason": None,
            "revoked_at": None,
            "reviewed_at": utc_now(),
        },
        history_action="approved",
        new_status="approved",
        user=user,
    )

    # A re-approval is the same transition with a different story, and the
    # history entry just pushed is the only place the previous status survives
    # -- reading it back beats a second query for it.
    previous_status = (approved_event.get("history") or [{}])[-1].get("from_status")
    reapproved = previous_status in REAPPROVABLE_STATUSES

    # --- Notification Trigger ---
    notify_teacher(
        background_tasks,
        approved_event,
        notification_type="approved",
        title="Event Re-approved" if reapproved else "Event Approved",
        message=(
            f'Your "{approved_event.get("event_name", "event")}"'
            + (
                " event has been re-approved by the Dean."
                if reapproved
                else " event has been approved by the Dean."
            )
        ),
        data={
            "event_name": approved_event.get("event_name", ""),
            "event_date": approved_event.get("event_date", ""),
        },
        reapproved=reapproved,
    )

    return {
        "success": True,
        "message": (
            "Event re-approved successfully" if reapproved else "Event approved successfully"
        ),
        "event": approved_event,
    }


# ============================================================
# REJECT EVENT
# ============================================================

@router.patch(
    "/dean/events/{event_id}/reject"
)
def reject_event(
    event_id: str,
    background_tasks: BackgroundTasks,
    rejection_reason: str | None = Query(default=None),
    body: DeanDecisionBody | None = Body(default=None),
    authorization: str | None = Header(
        default=None
    )
):
    """Reject a pending event. The reason may come as the
    `rejection_reason` query parameter or as a JSON body
    `{"rejection_reason": "..."}` (preferred: no URL length limit, and it
    stays out of access logs)."""
    user = get_current_user(authorization)
    check_dean(user)

    rejection_reason = _decision_text(rejection_reason, body, "rejection_reason")

    if not rejection_reason:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Rejection reason is required"
        )

    rejected_event = dean_transition(
        event_id,
        verb="reject",
        changes={
            "status": "rejected",
            "rejection_reason": rejection_reason,
            "reviewed_at": utc_now(),
        },
        history_action="rejected",
        new_status="rejected",
        user=user,
        note=rejection_reason,
    )
    invalidate_report(rejected_event["id"])

    # --- Notification Trigger ---
    notify_teacher(
        background_tasks,
        rejected_event,
        notification_type="rejected",
        title="Event Rejected",
        message=(
            f'Your "{rejected_event.get("event_name", "event")}"'
            " event was rejected by the Dean."
            f" Reason: {rejection_reason.strip()}"
        ),
        data={
            "event_name": rejected_event.get("event_name", ""),
            "rejection_reason": rejection_reason.strip(),
        },
        remarks=rejection_reason.strip(),
    )

    return {
        "success": True,
        "message": "Event rejected successfully",
        "event": rejected_event,
    }


# ============================================================
# REVOKE APPROVAL (distinct from REJECT -- PRD 18)
# ============================================================

@router.patch(
    "/dean/events/{event_id}/revoke"
)
def revoke_event(
    event_id: str,
    background_tasks: BackgroundTasks,
    revocation_reason: str | None = Query(default=None),
    body: DeanDecisionBody | None = Body(default=None),
    authorization: str | None = Header(
        default=None
    )
):
    """Withdraw approval from an already-approved event.

    Reject and revoke were previously one control that always called /reject.
    Because rejection only accepts a *pending* event, pressing it on an
    approved one answered 409 -- so revoking was impossible, not merely
    unclear. They are now separate actions over separate status sets.

    The teacher keeps the event and may fix and resubmit it, so any generated
    report is invalidated: it asserted an approval that no longer stands.
    """
    user = get_current_user(authorization)
    check_dean(user)

    revocation_reason = _decision_text(revocation_reason, body, "revocation_reason")

    if not revocation_reason:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A reason is required to revoke approval"
        )

    revoked = dean_transition(
        event_id,
        verb="revoke",
        changes={
            "status": "revoked",
            "revocation_reason": revocation_reason,
            "revoked_at": utc_now(),
            "reviewed_at": utc_now(),
        },
        history_action="revoked",
        new_status="revoked",
        user=user,
        note=revocation_reason,
    )
    invalidate_report(revoked["id"])

    notify_teacher(
        background_tasks,
        revoked,
        notification_type="revoked",
        title="Event Approval Revoked",
        message=(
            f'Approval for your "{revoked.get("event_name", "event")}"'
            " event was revoked by the Dean."
            f" Reason: {revocation_reason.strip()}"
        ),
        data={
            "event_name": revoked.get("event_name", ""),
            "revocation_reason": revocation_reason.strip(),
        },
        remarks=revocation_reason.strip(),
    )

    return {
        "success": True,
        "message": "Event approval revoked",
        "event": revoked,
    }


# ============================================================
# ARCHIVE / RESTORE / PERMANENT DELETE (PRD 1)
# ============================================================
#
# Archiving is deliberately NOT a status. `status` carries the review
# lifecycle, and every gate in this module reads it -- overwriting it with
# "archived" would destroy the state that restore has to return the event to.
# The shelf is a separate axis: `archived_at` set means shelved, None (or
# absent) means live. MongoDB matches missing and null alike, so existing
# documents need no backfill.

@router.patch(
    "/dean/events/{event_id}/archive"
)
def archive_event(
    event_id: str,
    archive_reason: str | None = Query(default=None),
    body: DeanDecisionBody | None = Body(default=None),
    authorization: str | None = Header(
        default=None
    ),
):
    """Move an event to the archive, keeping the record and its media."""
    user = get_current_user(authorization)
    check_dean(user)

    event = find_dean_visible_event_or_404(event_id, allow_archived=True)

    if event.get("archived_at") is not None:
        raise conflict("This event is already archived.")

    reason = _decision_text(archive_reason, body, "remarks")

    updated = update_event(
        event_id,
        {
            "archived_at": utc_now(),
            "archived_by": user["id"],
            "archive_reason": reason or None,
        },
        history=new_history_entry(
            action="archived",
            status=event.get("status"),
            from_status=event.get("status"),
            actor=user,
            note=reason or None,
        ),
    )

    if not updated:
        raise conflict("This event was updated by someone else. Please reload it.")

    return {
        "success": True,
        "message": "Event archived",
        "event": serialize(updated),
    }


@router.patch(
    "/dean/events/{event_id}/restore"
)
def restore_event(
    event_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    """Take an event back off the shelf, into the status it held before."""
    user = get_current_user(authorization)
    check_dean(user)

    event = find_dean_visible_event_or_404(event_id, allow_archived=True)

    if event.get("archived_at") is None:
        raise conflict("This event is not archived.")

    updated = update_event(
        event_id,
        {
            "archived_at": None,
            "archived_by": None,
            "archive_reason": None,
        },
        history=new_history_entry(
            action="restored",
            status=event.get("status"),
            from_status=event.get("status"),
            actor=user,
        ),
    )

    if not updated:
        raise conflict("This event was updated by someone else. Please reload it.")

    return {
        "success": True,
        "message": "Event restored",
        "event": serialize(updated),
    }


@router.get(
    "/dean/archive/events"
)
def get_archived_events(
    authorization: str | None = Header(
        default=None
    ),
    skip: int | None = Query(default=None, ge=0),
    limit: int | None = Query(default=None, ge=1, le=1000),
):
    """The archive shelf, most recently archived first."""
    user = get_current_user(authorization)
    check_event_viewer(user)

    # Event Manager events can be archived from the Dean's list as well, so
    # they have to come back here -- or they could never be restored.
    query = {"archived_at": {"$ne": None}}
    event_list, total = paginate_with_managed(
        query,
        [("archived_at", DESCENDING)],
        [("archived_at", DESCENDING)],
        lambda doc: str(doc.get("archived_at") or ""),
        skip,
        limit,
    )
    many_with_legacy_metadata(event_list)
    attach_teachers(event_list)

    return {
        "success": True,
        "events": event_list,
        "total": total,
        "count": len(event_list),
        "has_more": (skip or 0) + len(event_list) < total,
        "skip": skip or 0,
        "limit": limit,
    }


@router.delete(
    "/dean/events/{event_id}"
)
def dean_delete_event(
    event_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    """Delete an event permanently, with its media, documents and report.

    Irreversible, and it drops the stored bytes from R2/GridFS as well, so it
    is logged. The Dean UI puts this behind a typed confirmation; archiving is
    the reversible option offered alongside it.
    """
    user = get_current_user(authorization)
    check_dean(user)

    event = find_dean_visible_event_or_404(event_id, allow_archived=True)

    if not hard_delete_event(event, user):
        raise conflict("This event was already removed.")

    return {
        "success": True,
        "message": "Event deleted permanently",
    }


def hard_delete_event(event: dict, actor: dict, *, audit: bool = True) -> bool:
    """Delete one event for good, with its media, documents and report.

    Shared by the Dean's single and bulk delete and the superadmin's delete, so
    all of them remove the same things and leave the same record. Returns
    False when the event was already gone (a concurrent delete). Teachers
    deleting their own unapproved events keep their own route.
    """
    key = str(event["_id"])
    source = event.get("_source_collection")
    is_managed = (
        source == "managed_events"
        or bool(event.get("owner_id"))
        or event.get("creator_role") == "event_manager"
        or event.get("source") == "event_manager"
    )

    if is_managed and _should_include_managed_events():
        result = managed_events.delete_one({"_id": event["_id"]})
        if result.deleted_count == 0:
            result = events.delete_one({"_id": event["_id"]})
            if result.deleted_count == 0:
                return False
            delete_event_cascade(key)
        else:
            for collection in (managed_event_media, managed_event_documents):
                for row in collection.find({"event_id": key}):
                    delete_stored(row)
                collection.delete_many({"event_id": key})
            try:
                event_reports.delete_many({"event_id": key})
            except Exception:
                pass
    else:
        result = events.delete_one({"_id": event["_id"]})
        if result.deleted_count == 0:
            if _should_include_managed_events():
                result = managed_events.delete_one({"_id": event["_id"]})
                if result.deleted_count == 0:
                    return False
                for collection in (managed_event_media, managed_event_documents):
                    for row in collection.find({"event_id": key}):
                        delete_stored(row)
                    collection.delete_many({"event_id": key})
                try:
                    event_reports.delete_many({"event_id": key})
                except Exception:
                    pass
            else:
                return False
        else:
            delete_event_cascade(key)

    logger.warning(
        "event_hard_deleted id=%s name=%s by=%s role=%s",
        event["_id"],
        event.get("event_name"),
        actor.get("id"),
        actor.get("role"),
    )
    if audit:
        log_audit_event(
            actor=actor,
            action="event_deleted",
            target_type="event",
            target_id=str(event["_id"]),
            details={
                "event_name": event.get("event_name"),
                "status": event.get("status"),
                "teacher_id": event.get("teacher_id") or event.get("owner_id"),
            },
        )
    return True


@router.post(
    "/dean/events/bulk-delete"
)
def dean_bulk_delete_events(
    payload: DeanBulkDeleteEventsRequest,
    authorization: str | None = Header(
        default=None
    ),
):
    """Delete the events the Dean selected ("Select All Events"), permanently.

    Each id gets its own outcome: deleted, or not found (unknown, a draft --
    which a Dean never sees -- or already removed). Nothing is deleted that a
    Dean could not delete one at a time, and the batch is one audit entry.
    """
    user = get_current_user(authorization)
    check_dean(user)

    found, results = _resolve_dean_events(payload.event_ids)

    # One query for the events and one per related collection, whatever the
    # selection size -- rather than a lookup, a delete and a cascade of
    # queries per event. Stored files are still removed one by one: object
    # storage deletes them individually.
    deleted_ids: set[str] = set()
    if found:
        events_to_del = [
            doc for doc in found
            if doc.get("_source_collection") == "events" or (doc.get("status") != "recorded" and not doc.get("owner_id"))
        ]
        managed_to_del = [
            doc for doc in found
            if doc.get("_source_collection") == "managed_events" or doc.get("status") == "recorded" or doc.get("owner_id")
        ]

        if events_to_del:
            ids = [str(doc["_id"]) for doc in events_to_del]
            events.delete_many({"_id": {"$in": [doc["_id"] for doc in events_to_del]}})
            delete_events_cascade(ids)
            deleted_ids.update(ids)

        if managed_to_del:
            m_ids = [str(doc["_id"]) for doc in managed_to_del]
            m_oids = [doc["_id"] for doc in managed_to_del]
            managed_events.delete_many({"_id": {"$in": m_oids}})
            for collection in (managed_event_media, managed_event_documents):
                for row in collection.find({"event_id": {"$in": m_ids}}):
                    delete_stored(row)
                collection.delete_many({"event_id": {"$in": m_ids}})
            try:
                event_reports.delete_many({"event_id": {"$in": m_ids}})
            except Exception:
                pass
            deleted_ids.update(m_ids)

        logger.warning(
            "events_bulk_hard_deleted count=%d by=%s role=%s", len(deleted_ids), user.get("id"), user.get("role")
        )

    for doc in found:
        results.append({
            "event_id": str(doc["_id"]),
            "status": "deleted" if str(doc["_id"]) in deleted_ids else "not_found",
            "event_name": doc.get("event_name"),
        })

    deleted = [r for r in results if r["status"] == "deleted"]
    log_audit_event(
        actor=user,
        action="events_bulk_deleted",
        target_type="events",
        details={
            "requested_count": len(results),
            "deleted_count": len(deleted),
            "events": [{"id": r["event_id"], "name": r["event_name"], "status": r["status"]} for r in results],
        },
    )

    return {
        "success": True,
        "requested_count": len(results),
        "deleted_count": len(deleted),
        "not_found_count": len(results) - len(deleted),
        "results": results,
        "message": f"{len(deleted)} event{'s' if len(deleted) != 1 else ''} deleted permanently.",
    }


# Largest selection one bulk request takes (and "Select all" returns).
MAX_BULK_EVENTS = 5000


def _resolve_dean_events(raw_ids: list[str], extra: dict | None = None) -> tuple[list[dict], list[dict]]:
    """Look up a selection in one query: the events a Dean can act on, plus a
    ``not_found`` row for every other id (unknown, malformed, a draft --
    which a Dean never sees -- or already gone)."""
    wanted: dict[ObjectId, str] = {}
    results: list[dict] = []
    for raw_id in dict.fromkeys(raw_ids):
        object_id = to_object_id(raw_id)
        if object_id is None or object_id in wanted:
            if object_id is None:
                results.append({"event_id": raw_id, "status": "not_found", "event_name": None})
            continue
        wanted[object_id] = raw_id
    found = list(events.find({
        "_id": {"$in": list(wanted)},
        "status": {"$ne": "draft"},
        **(extra or {}),
    })) if wanted else []
    for doc in found:
        doc["_source_collection"] = "events"
    found_ids = {doc["_id"] for doc in found}
    if _should_include_managed_events() and len(found_ids) < len(wanted):
        missing_oids = [oid for oid in wanted if oid not in found_ids]
        try:
            m_found = list(managed_events.find({
                "_id": {"$in": missing_oids},
                "status": {"$ne": "draft"},
                **(extra or {}),
            }))
            for doc in m_found:
                doc["_source_collection"] = "managed_events"
            found.extend(m_found)
            found_ids.update(doc["_id"] for doc in m_found)
        except Exception:
            pass
    results.extend(
        {"event_id": raw_id, "status": "not_found", "event_name": None}
        for object_id, raw_id in wanted.items()
        if object_id not in found_ids
    )
    return found, results


@router.post(
    "/dean/events/bulk-archive"
)
def dean_bulk_archive_events(
    payload: DeanBulkArchiveEventsRequest,
    authorization: str | None = Header(
        default=None
    ),
):
    """Archive the events the Dean selected, in one request.

    Same effect as archiving each one (record, media and history kept; each
    event's history gains an "archived" entry), done as one update per status
    present in the selection instead of one per event.
    """
    user = get_current_user(authorization)
    check_dean(user)

    found, results = _resolve_dean_events(payload.event_ids)
    reason = (payload.reason or "").strip() or None
    now = utc_now()

    to_archive: dict[str | None, list[ObjectId]] = {}
    for doc in found:
        if doc.get("archived_at") is not None:
            results.append({"event_id": str(doc["_id"]), "status": "already_archived",
                            "event_name": doc.get("event_name")})
        else:
            to_archive.setdefault(doc.get("status"), []).append(doc["_id"])
            results.append({"event_id": str(doc["_id"]), "status": "archived",
                            "event_name": doc.get("event_name")})

    # The history entry records the status each event keeps, so events are
    # grouped by status: a handful of updates, not one per event.
    for event_status, object_ids in to_archive.items():
        events.update_many(
            {"_id": {"$in": object_ids}, "archived_at": None},
            {
                "$set": {"archived_at": now, "archived_by": user["id"], "archive_reason": reason, "updated_at": now},
                "$push": {"history": new_history_entry(
                    action="archived",
                    status=event_status,
                    from_status=event_status,
                    actor=user,
                    note=reason,
                )},
            },
        )
        if _should_include_managed_events():
            managed_events.update_many(
                {"_id": {"$in": object_ids}, "archived_at": None},
                {
                    "$set": {"archived_at": now, "archived_by": user["id"], "archive_reason": reason, "updated_at": now},
                    "$push": {"history": new_history_entry(
                        action="archived",
                        status=event_status,
                        from_status=event_status,
                        actor=user,
                        note=reason,
                    )},
                },
            )

    archived = [r for r in results if r["status"] == "archived"]
    log_audit_event(
        actor=user,
        action="events_bulk_archived",
        target_type="events",
        details={
            "requested_count": len(results),
            "archived_count": len(archived),
            "events": [{"id": r["event_id"], "name": r["event_name"], "status": r["status"]} for r in results],
        },
    )

    return {
        "success": True,
        "requested_count": len(results),
        "archived_count": len(archived),
        "skipped_count": len(results) - len(archived),
        "results": results,
        "message": f"{len(archived)} event{'s' if len(archived) != 1 else ''} moved to the archive.",
    }


# ============================================================
# DEAN UPDATE PROGRESS STAGE
#
# Post-approval delivery tracking only. Approve and reject keep
# their own endpoints; this moves an already-approved event
# between Approved and Completed.
# ============================================================

@router.patch(
    "/dean/events/{event_id}/stage"
)
def update_event_stage(
    event_id: str,
    background_tasks: BackgroundTasks,
    stage: str = Query(...),
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    check_dean(user)

    normalized_stage = (stage or "").strip().lower()

    if normalized_stage not in DEAN_PROGRESS_STAGES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid stage. Allowed values: approved, completed.",
        )

    # The same visibility rule every other Dean decision uses: a draft or an
    # archived event is reported as missing. Reading the event with the plain
    # lookup let a shelved event be moved through the delivery stages -- and
    # notified the teacher about it.
    existing = find_dean_visible_event_or_404(event_id)
    ensure_not_own_event(existing, user)

    # Delivery stages only make sense once the event has been approved. An
    # event still stored as the retired "in_progress" can be moved on too.
    if existing.get("status") not in (*DEAN_PROGRESS_STAGES, *LEGACY_PROGRESS_STAGES):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Only an approved event can be moved through the "
                "progress stages."
            ),
        )

    # Completed is final: it is what the report is generated from, so the
    # event cannot be stepped back to Approved. (The write below is also
    # conditional on the status just read, so a race cannot slip past this.)
    if existing.get("status") == "completed" and normalized_stage != "completed":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A completed event cannot be moved back to Approved.",
        )

    updated = update_event(
        event_id,
        {"status": normalized_stage},
        history=new_history_entry(
            action="stage_changed",
            status=normalized_stage,
            from_status=existing.get("status"),
            actor=user,
        ),
        expected_status=existing.get("status"),
    )

    if not updated:
        find_event_or_404(event_id)
        raise conflict("This event was updated by someone else. Please reload it.")

    staged_event = serialize(updated)

    # A no-op move (already at that stage) changes nothing the teacher needs
    # to hear about.
    if existing.get("status") != normalized_stage:
        stage_text = {
            "completed": "marked completed",
            "approved": "moved back to approved",
        }[normalized_stage]

        notify_teacher(
            background_tasks,
            staged_event,
            notification_type="progress",
            title=f"Event {stage_text}",
            message=(
                f'Your "{staged_event.get("event_name", "event")}"'
                f" event was {stage_text} by the Dean."
            ),
            data={
                "event_name": staged_event.get("event_name", ""),
                "stage": normalized_stage,
            },
            stage=normalized_stage,
        )

    return {
        "success": True,
        "message": "Event stage updated successfully",
        "event": staged_event,
    }


# ============================================================
# DEAN REQUEST CHANGES ON EVENT
# ============================================================

@router.patch(
    "/dean/events/{event_id}/request-changes"
)
def request_changes_event(
    event_id: str,
    background_tasks: BackgroundTasks,
    remarks: str = Query(default=""),
    body: DeanDecisionBody | None = Body(default=None),
    authorization: str | None = Header(
        default=None
    ),
):
    """Send a pending event back to the teacher. Stored as "rejected" (the
    status in which the teacher can edit and resubmit) with a
    "changes_requested" history entry. `remarks` may come from the query
    string or a JSON body `{"remarks": "..."}`."""
    user = get_current_user(authorization)
    check_dean(user)

    remarks = _decision_text(remarks, body, "remarks")

    if not remarks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Remarks are required"
        )

    changed_event = dean_transition(
        event_id,
        verb="request changes",
        changes={
            "status": "rejected",
            "rejection_reason": remarks,
            "reviewed_at": utc_now(),
        },
        history_action="changes_requested",
        new_status="rejected",
        user=user,
        note=remarks,
    )
    invalidate_report(changed_event["id"])

    notify_teacher(
        background_tasks,
        changed_event,
        notification_type="needs_changes",
        title="Event Needs Changes",
        message=(
            f'Your "{changed_event.get("event_name", "event")}"'
            " event needs changes before approval."
            f" Remarks: {remarks.strip()}"
        ),
        data={
            "event_name": changed_event.get("event_name", ""),
            "remarks": remarks.strip(),
        },
        remarks=remarks.strip(),
    )

    return {
        "success": True,
        "message": "Changes requested for event",
        "event": changed_event,
    }


# ============================================================
# TEACHER EVENTS
# ============================================================

@router.get(
    "/teacher/events"
)
def get_teacher_events(
    authorization: str | None = Header(
        default=None
    ),
    skip: int | None = Query(default=None, ge=0),
    limit: int | None = Query(default=None, ge=1, le=1000),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event_list, total = paginate(
        events,
        {"teacher_id": user["id"], "archived_at": None},
        "created_at",
        DESCENDING,
        skip,
        limit,
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


@router.post(
    "/teacher/events",
    status_code=status.HTTP_201_CREATED,
)
def create_teacher_event(
    payload: EventCreateRequest,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    # An event that does not exist yet cannot have photos or documents attached,
    # so creating one straight into the review queue would always mean putting
    # an event with no evidence in front of a Dean -- the rule the PATCH and
    # resubmit routes enforce. The wizard already works the supported way:
    # save a draft, attach the files, then submit.
    if not payload.save_as_draft:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Save the event first, attach at least one photo and one document, "
                "then submit it for approval."
            ),
        )

    # A draft is held back from the dean until the teacher submits it; anything
    # else goes straight into the review queue.
    new_status = "draft" if payload.save_as_draft else "pending"

    document = new_event_document(
        teacher_id=user["id"],
        event_name=payload.event_name,
        event_date=payload.event_date,
        end_date=payload.end_date,
        event_type=resolve_event_type(payload.event_type, created_by=user["id"]),
        location=payload.location,
        description=payload.description,
        social_network_url=payload.social_network_url,
        start_time=payload.start_time,
        end_time=payload.end_time,
        organizer=payload.organizer,
        coordinator_contact=payload.coordinator_contact,
        status=new_status,
        history=[
            new_history_entry(
                action="created" if payload.save_as_draft else "submitted",
                status=new_status,
                actor=user,
            ),
        ],
    )

    result = events.insert_one(document)
    document["_id"] = result.inserted_id

    if not payload.save_as_draft:
        announce_to_deans(document, "submitted", user)

    return {
        "success": True,
        "message": (
            "Draft saved"
            if payload.save_as_draft
            else "Event submitted successfully for Dean approval"
        ),
        "event": serialize(document),
    }


@router.get(
    "/teacher/events/{event_id}"
)
def get_teacher_event(
    event_id: str,
    request: Request,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    event_key = str(event["_id"])
    media = list_media(request, event_key)
    item = report_files.with_report_photos(
        with_legacy_metadata(serialize(event)), event, media=media
    )

    return {
        "success": True,
        "event": item,
        "media": media,
        "documents": list_documents(request, event_key),
    }


@router.patch(
    "/teacher/events/{event_id}"
)
def update_teacher_event(
    event_id: str,
    payload: EventUpdateRequest,
    authorization: str | None = Header(
        default=None
    ),
):
    """Edit an event that is still in the teacher's hands.

    By default the edit resubmits the event for approval. With `save_as_draft`
    the event stays a draft, which is what the create-event wizard uses while
    the teacher is still filling it in.
    """
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)

    # Only an event that is already a draft may stay one. Without this, a
    # teacher could pull an event back out of the dean's queue after submitting
    # it and the dean would never know it had gone.
    if payload.save_as_draft and event.get("status") != "draft":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This event has already been submitted and can no longer be saved as a draft.",
        )

    if not payload.save_as_draft:
        ensure_submittable(event)

    changes = {
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
        # Editing is how a teacher answers a refusal, so both refusal trails go
        # -- matching teacher_resubmit_event. Leaving revocation_reason behind
        # left an edited event still reading as revoked.
        "rejection_reason": None,
        "revocation_reason": None,
        "revoked_at": None,
    }

    history = None
    previous_status = event.get("status")
    already_queued = previous_status in DEAN_REVIEWABLE_STATUSES

    if payload.save_as_draft:
        changes["status"] = "draft"
        changes["submitted_at"] = None
        # Draft saves are the wizard autosaving while the teacher types; they
        # are not steps anyone needs to see in the trail.
    else:
        changes["status"] = "pending"
        # An edit while waiting keeps the event's place in the queue.
        if not already_queued or not event.get("submitted_at"):
            changes["submitted_at"] = utc_now()

        if previous_status == "draft":
            action = "submitted"
        elif previous_status in REAPPROVABLE_STATUSES:
            action = "resubmitted"
        else:
            action = "updated"  # edited while still waiting in the queue

        history = new_history_entry(
            action=action,
            status="pending",
            from_status=previous_status,
            actor=user,
        )

    # Filtered on the status just checked: if a Dean decided in between, the
    # edit must not silently undo the decision.
    updated = update_event(
        event_id, changes, history=history, expected_status=previous_status
    )

    if not updated:
        find_teacher_event_or_404(event_id, user["id"])
        raise conflict(CHANGED_WHILE_EDITING)

    invalidate_report(str(event["_id"]))

    # Deans hear about an event when it enters their queue, not on every
    # save of an event already in it.
    if history is not None and not already_queued:
        announce_to_deans(serialize(updated), history["action"], user)

    return {
        "success": True,
        "message": (
            "Draft saved"
            if payload.save_as_draft
            else "Event updated and resubmitted for approval"
        ),
        "event": serialize(updated),
    }


@router.delete(
    "/teacher/events/{event_id}"
)
def delete_teacher_event(
    event_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])

    if event.get("status") not in TEACHER_EDITABLE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An approved event can no longer be deleted."
        )

    # Remove the event itself first, and only if it still has the status just
    # checked, so a Dean's approval in between cannot be deleted away.
    result = events.delete_one(
        {"_id": event["_id"], "teacher_id": user["id"], "status": event.get("status")}
    )
    if result.deleted_count == 0:
        find_teacher_event_or_404(event_id, user["id"])
        raise conflict(CHANGED_WHILE_EDITING)

    delete_event_cascade(str(event["_id"]))

    return {
        "success": True,
        "message": "Event deleted successfully",
    }


# ============================================================
# TEACHER BULK ACTIONS (My Events)
# ============================================================

def _own_events_in_order(raw_ids: list[str], teacher_id: str) -> tuple[list[dict], list[dict]]:
    """The teacher's own events among ``raw_ids``, in the order asked, and a
    result row for every id that is malformed, repeated or not theirs."""
    wanted: list[ObjectId] = []
    missing: list[dict] = []
    for raw in raw_ids:
        object_id = to_object_id(raw)
        if object_id is None:
            missing.append({"event_id": raw, "event_name": None, "status": "not_found", "reason": "Event not found."})
        elif object_id not in wanted:
            wanted.append(object_id)
    found = {doc["_id"]: doc for doc in events.find({"_id": {"$in": wanted}, "teacher_id": teacher_id})}
    missing += [
        {"event_id": str(oid), "event_name": None, "status": "not_found", "reason": "Event not found."}
        for oid in wanted if oid not in found
    ]
    return [found[oid] for oid in wanted if oid in found], missing


def submit_draft(event: dict, user: dict) -> dict:
    """Put one draft in front of the Deans, exactly as the form's Submit does:
    evidence rule, saved details still valid, status moved atomically, Deans
    told. Raises HTTPException (with the reason) when it cannot."""
    if event.get("status") != "draft":
        raise conflict("Only a draft can be submitted from here.")
    ensure_submittable(event)
    problem = draft_details_error(event)
    if problem:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Complete the event details first. {problem}")

    history = new_history_entry(action="submitted", status="pending", from_status="draft", actor=user)
    updated = update_event(
        str(event["_id"]),
        {"status": "pending", "submitted_at": utc_now(), "rejection_reason": None,
         "revocation_reason": None, "revoked_at": None},
        history=history,
        expected_status="draft",
    )
    if not updated:
        raise conflict(CHANGED_WHILE_EDITING)
    invalidate_report(str(event["_id"]))
    announce_to_deans(serialize(updated), "submitted", user)
    return updated


def _bulk_summary(results: list[dict], done: str, verb: str) -> dict:
    count = sum(1 for row in results if row["status"] == done)
    return {
        "success": True,
        "requested_count": len(results),
        f"{done}_count": count,
        "skipped_count": len(results) - count,
        "results": results,
        "message": f"{count} event{'s' if count != 1 else ''} {verb}.",
    }


@router.post("/teacher/events/bulk-submit")
def teacher_bulk_submit(
    payload: BulkEventIdsRequest,
    authorization: str | None = Header(default=None),
):
    """Submit the selected drafts for approval in one request.

    Each draft goes through the same checks as the form's Submit; one that
    fails them (a missing photo, an unfinished detail) is reported with the
    reason and the others still go through.
    """
    user = get_current_user(authorization)
    require_role(user, "teacher")

    own, results = _own_events_in_order(payload.event_ids, user["id"])
    for event in own:
        row = {"event_id": str(event["_id"]), "event_name": event.get("event_name")}
        try:
            submit_draft(event, user)
            results.append({**row, "status": "submitted", "reason": None})
        except HTTPException as error:
            results.append({**row, "status": "skipped", "reason": error.detail})
    return _bulk_summary(results, "submitted", "submitted for approval")


@router.post("/teacher/events/bulk-delete")
def teacher_bulk_delete(
    payload: BulkEventIdsRequest,
    authorization: str | None = Header(default=None),
):
    """Delete the selected events that are still the teacher's to delete --
    drafts and events not yet approved -- with their files. Approved events
    are reported as skipped, as a single delete refuses them."""
    user = get_current_user(authorization)
    require_role(user, "teacher")

    own, results = _own_events_in_order(payload.event_ids, user["id"])
    for event in own:
        row = {"event_id": str(event["_id"]), "event_name": event.get("event_name")}
        if event.get("status") not in TEACHER_EDITABLE_STATUSES:
            results.append({**row, "status": "skipped", "reason": "An approved event can no longer be deleted."})
            continue
        # Filtered on the status just read, like the single delete, so an
        # approval landing in between is never deleted away.
        gone = events.delete_one({"_id": event["_id"], "teacher_id": user["id"], "status": event.get("status")})
        if gone.deleted_count == 0:
            results.append({**row, "status": "skipped", "reason": CHANGED_WHILE_EDITING})
            continue
        delete_event_cascade(str(event["_id"]))
        results.append({**row, "status": "deleted", "reason": None})
    return _bulk_summary(results, "deleted", "deleted")


# ============================================================
# TEACHER RESUBMIT EVENT
# ============================================================

@router.patch(
    "/teacher/events/{event_id}/resubmit"
)
def teacher_resubmit_event(
    event_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)

    previous_status = event.get("status")

    # Only an event that is out of the queue can be (re)submitted; resubmitting
    # one that is already waiting would just notify every Dean again.
    if previous_status not in RESUBMITTABLE_STATUSES:
        raise conflict("This event is already waiting for the Dean's review.")

    # Same evidence rule as editing-and-submitting: this route reaches the
    # Dean's queue too, and without the check a draft with nothing attached
    # could be pushed straight into review.
    ensure_submittable(event)

    # The no-future rule the create and edit schemas apply, checked against
    # what is stored: this route submits without a payload.
    schedule_error = future_schedule_error(
        event.get("event_date"),
        event.get("start_time"),
        event.get("end_date"),
        event.get("end_time"),
    )
    if schedule_error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=schedule_error)

    # A draft reaching the Dean for the first time is "submitted"; an event
    # coming back after a refusal -- rejected or revoked -- is "resubmitted".
    action = "submitted" if previous_status == "draft" else "resubmitted"

    updated = update_event(
        event_id,
        {
            "status": "pending",
            "rejection_reason": None,
            "revocation_reason": None,
            "revoked_at": None,
            "submitted_at": utc_now(),
        },
        history=new_history_entry(
            action=action,
            status="pending",
            from_status=previous_status,
            actor=user,
        ),
        expected_status=previous_status,
    )

    if not updated:
        find_teacher_event_or_404(event_id, user["id"])
        raise conflict(CHANGED_WHILE_EDITING)

    invalidate_report(str(event["_id"]))
    announce_to_deans(serialize(updated), action, user)

    return {
        "success": True,
        "message": "Event resubmitted for approval",
        "event": serialize(updated),
    }


# ============================================================
# UPLOAD BOOKKEEPING
# ============================================================

_CAP_LABELS = {"image": "photos", "video": "videos", "document": "documents"}


def _cap_error(cap: int, kind: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"An event can have at most {cap} {_CAP_LABELS.get(kind, 'files')}.",
    )


def _ensure_under_cap(collection, cap_query: dict, cap: int | None, kind: str) -> None:
    """Refuse an upload up front when the event already has `cap` of them."""
    if cap is not None and collection.count_documents(cap_query) >= cap:
        raise _cap_error(cap, kind)


def _size_cap_error(cap_bytes: int, kind: str) -> HTTPException:
    """The over-limit message, worded as PRD 11 specifies for videos."""
    megabytes = cap_bytes // (1024 * 1024)
    noun = {"video": "video", "document": "document", "image": "photo"}.get(kind, "file")
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=(
            "You have exceeded the limit. "
            f"Maximum allowed {noun} size is {megabytes} MB."
        ),
    )


def _stored_bytes(collection, cap_query: dict) -> int:
    """Total size already attached to the event under this filter.

    A `find` and a sum rather than an aggregation: an event has tens of files
    at most, and the test fakes stand in for `find` but not for `$group`.
    """
    return sum(
        item.get("file_size") or 0
        for item in collection.find(cap_query, {"file_size": 1})
    )


def _ensure_bytes_under_cap(
    collection, cap_query: dict, incoming: int, cap_bytes: int | None, kind: str
) -> None:
    """Refuse an upload that would push the event past its combined budget."""
    if cap_bytes is None:
        return
    if _stored_bytes(collection, cap_query) + incoming > cap_bytes:
        raise _size_cap_error(cap_bytes, kind)


def _ensure_direct_upload_fits(
    collection, event_key: str, info: dict, size: int, limits: dict
) -> dict:
    """The checks a proxied upload gets before its bytes are stored, applied
    to a direct upload's declared size before any URL is issued. Returns the
    caps, which completion enforces again once the real size is known."""
    media_type = info["media_type"]
    caps = direct_upload.caps_for(media_type, limits)
    query = direct_upload.cap_query(event_key, media_type)
    _ensure_under_cap(collection, query, caps["cap"], media_type)
    check_declared_size(size, caps["per_file_bytes"], what=caps["what"])
    _ensure_bytes_under_cap(collection, query, size, caps["cap_bytes"], media_type)
    return caps


def _event_still_editable(event: dict) -> bool:
    return bool(events.find_one(
        {"_id": event["_id"], "status": {"$in": list(TEACHER_EDITABLE_STATUSES)}},
        {"_id": 1},
    ))


def _record_upload(
    collection,
    document: dict,
    stored: dict,
    event: dict,
    cap_query: dict,
    cap: int | None,
    kind: str,
    cap_bytes: int | None = None,
) -> None:
    """Insert the metadata record for bytes that were just stored, keeping
    the two consistent.

    - If the insert fails, the stored object is deleted (no orphan).
    - If the event was deleted or approved while the file was uploading, the
      record and object are removed again and the request is a 409.
    - If concurrent uploads pushed the event past its cap, the later ones
      (by insertion order) are removed and get a 400.
    """
    try:
        result = collection.insert_one(document)
    except Exception:
        delete_stored(stored)
        raise
    document["_id"] = result.inserted_id

    def roll_back() -> None:
        collection.delete_one({"_id": result.inserted_id})
        delete_stored(stored)

    if not _event_still_editable(event):
        roll_back()
        raise conflict(
            "This event was approved or deleted while the file was uploading, "
            "so the file was not added."
        )

    if cap is not None:
        past_cap = [
            item["_id"]
            for item in collection.find(cap_query, {"_id": 1}).sort("_id", ASCENDING)
        ][cap:]
        if result.inserted_id in past_cap:
            roll_back()
            raise _cap_error(cap, kind)

    if cap_bytes is not None:
        # The count version can just slice the list; bytes need a running
        # total in insertion order, so that when two uploads race, whichever
        # landed second is the one that loses.
        running = 0
        for item in collection.find(
            cap_query, {"_id": 1, "file_size": 1}
        ).sort("_id", ASCENDING):
            running += item.get("file_size") or 0
            if item["_id"] == result.inserted_id:
                if running > cap_bytes:
                    roll_back()
                    raise _size_cap_error(cap_bytes, kind)
                break


def _required_kind(collection, record: dict) -> tuple[dict, str] | None:
    """``(query, label)`` when ``record`` counts towards ensure_submittable's
    evidence -- a kind the Super Admin has made mandatory -- else None."""
    if collection is event_documents:
        label = "document"
    elif record.get("media_type") == "image":
        label = "photo"
    elif record.get("media_type") == "video":
        label = "video"
    else:
        return None

    if not get_upload_limits().get(REQUIREMENT_FIELDS[label]):
        return None
    return _evidence_query(label)[1], label


def _awaiting_dean(event: dict) -> bool:
    return bool(events.find_one(
        {"_id": event["_id"], "status": {"$in": list(DEAN_REVIEWABLE_STATUSES)}},
        {"_id": 1},
    ))


def _delete_attachment(collection, record_id: str, event: dict, not_found: str) -> None:
    """Delete one media/document record and its bytes, unless the event left
    the editable statuses in the meantime (then the record is restored).

    An event in the Dean's queue also keeps its last photo and its last
    document: ensure_submittable only guards the way in, and without this a
    teacher could empty a pending event afterwards. Counted after the delete,
    like the upload caps, so two deletes racing for the last two photos both
    see none left and both roll back.
    """
    record = collection.find_one_and_delete(
        {"_id": to_object_id(record_id), "event_id": str(event["_id"])}
    )

    if not record:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=not_found
        )

    if not _event_still_editable(event):
        collection.insert_one(record)
        raise conflict(CHANGED_WHILE_EDITING)

    required = _required_kind(collection, record)
    if required and _awaiting_dean(event):
        query, label = required
        if collection.count_documents({"event_id": str(event["_id"]), **query}) == 0:
            collection.insert_one(record)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    f"An event awaiting approval must keep at least one {label}. "
                    f"Upload another {label} first, then remove this one."
                ),
            )

    delete_stored(record)


# ============================================================
# TEACHER MEDIA (photos / videos, stored in R2 or GridFS)
# ============================================================

@router.get(
    "/teacher/events/{event_id}/media"
)
def get_teacher_event_media(
    event_id: str,
    request: Request,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    media = list_media(request, str(event["_id"]))

    return {
        "success": True,
        "event_id": event_id,
        "media": media,
        "total": len(media),
    }


@router.get("/upload-limits")
@router.get("/teacher/upload-limits")
def get_active_upload_limits(authorization: str | None = Header(default=None)):
    """The current configurable upload limits for photos, videos and documents.

    Signed in only, like every other route in this module. It used to take no
    authorization at all, which published the deployment's configuration to
    anyone who asked.
    """
    get_current_user(authorization)
    return {
        "success": True,
        "limits": get_public_upload_limits(),
    }


@router.post(
    "/teacher/events/{event_id}/media",
    status_code=status.HTTP_201_CREATED,
)
def upload_teacher_event_media(
    event_id: str,
    request: Request,
    file: UploadFile = File(...),
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)
    event_key = str(event["_id"])

    info = inspect_media(file)
    media_type = info["kind"]
    is_image = media_type == "image"

    limits = get_upload_limits()

    # Photos: at most N, each under its own size cap (and optional total budget).
    # Videos: optional count cap, per-file size cap, and combined total budget.
    cap = limits["max_photos_per_event"] if is_image else limits.get("max_videos_per_event")
    cap_bytes = limits["max_photo_total_bytes"] if is_image else limits["max_video_total_bytes"]
    per_file_limit = (
        limits["max_photo_size_bytes"] if is_image else limits["max_video_size_bytes"]
    )
    cap_query = {"event_id": event_key, "media_type": media_type}
    _ensure_under_cap(event_media, cap_query, cap, media_type)

    buffer, size = stream_upload(
        file, per_file_limit, what="Photos" if is_image else "Videos"
    )
    try:
        check_file_signature(info["extension"], peek_head(buffer))
        _ensure_bytes_under_cap(event_media, cap_query, size, cap_bytes, media_type)

        file_name = safe_file_name(file.filename)
        stored = save_upload(
            buffer,
            file_name=file_name,
            content_type=info["content_type"],
            kind="media",
            event_id=event_key,
            teacher_id=user["id"],
        )
    finally:
        buffer.close()

    document = new_media_document(
        event_id=event_key,
        storage=stored["storage"],
        object_key=stored["object_key"],
        file_id=stored["file_id"],
        file_name=file_name,
        media_url=stored["url"],
        media_type=media_type,
        content_type=info["content_type"],
        file_size=size,
        original_name=file.filename,
    )

    _record_upload(
        event_media, document, stored, event, cap_query, cap, media_type, cap_bytes
    )

    return {
        "success": True,
        "message": "Media uploaded successfully",
        "media": absolutize(request, serialize(document), "media_url"),
    }


@router.get(
    "/teacher/events/{event_id}/uploads/check-name"
)
def check_upload_names(
    event_id: str,
    file_name: list[str] = Query(default=[]),
    kind: str = Query(default="media", pattern="^(media|documents)$"),
    authorization: str | None = Header(
        default=None
    ),
):
    """Which of these names are already attached to the event (PRD 10).

    Storage keys every object with a uuid prefix, so a repeated name can never
    collide -- this exists purely so the wizard can ask "are you sure you want
    to upload a file with the same name?" before spending the bytes. Several
    names may be checked at once so picking ten photos is one round trip.
    """
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    collection = event_media if kind == "media" else event_documents

    results: dict[str, bool] = {}
    for raw in file_name:
        key = upload_name_key(raw, raw)
        if not key:
            continue
        # `file_name` is the fallback for records stored before `name_key`
        # existed, so no backfill is needed for the check to work on them.
        existing = collection.find_one({
            "event_id": str(event["_id"]),
            "$or": [{"name_key": key}, {"file_name": raw}],
        })
        results[raw] = existing is not None

    return {
        "success": True,
        "duplicates": results,
        "any": any(results.values()),
    }


@router.delete(
    "/teacher/events/{event_id}/media/{media_id}"
)
def delete_teacher_event_media(
    event_id: str,
    media_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)

    _delete_attachment(event_media, media_id, event, "Media not found")
    if event.get("report_photo_ids"):
        events.update_one({"_id": event["_id"]}, {"$pull": {"report_photo_ids": media_id}})

    return {
        "success": True,
        "message": "Media deleted successfully",
    }


@router.put(
    "/teacher/events/{event_id}/report-photos"
)
def set_teacher_report_photos(
    event_id: str,
    payload: ReportPhotosRequest,
    authorization: str | None = Header(
        default=None
    ),
):
    """Which photos (in order) the Dean's report shows -- chosen while
    uploading, the same way as in the Event Manager panel. Empty means none."""
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)

    chosen = report_files.clean_report_choice(payload.photo_ids, str(event["_id"]), event_media)
    events.update_one(
        {"_id": event["_id"]}, {"$set": {"report_photo_ids": chosen, "updated_at": utc_now()}}
    )
    return {"success": True, "message": "Report photos saved.", "report_photo_ids": chosen}


# ============================================================
# TEACHER DOCUMENTS (stored in R2 or GridFS)
# ============================================================

@router.get(
    "/teacher/events/{event_id}/documents"
)
def get_teacher_event_documents(
    event_id: str,
    request: Request,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    documents = list_documents(request, str(event["_id"]))

    return {
        "success": True,
        "event_id": event_id,
        "documents": documents,
        "total": len(documents),
    }


@router.post(
    "/teacher/events/{event_id}/documents",
    status_code=status.HTTP_201_CREATED,
)
def upload_teacher_event_document(
    event_id: str,
    request: Request,
    file: UploadFile = File(...),
    category: str = Form(default="notice"),
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    cat_param = request.query_params.get("category")
    if cat_param:
        category = cat_param

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)
    event_key = str(event["_id"])

    info = inspect_document(file)
    cap_query = {"event_id": event_key}

    # Superadmin-configurable, same as photos and videos above.
    limits = get_upload_limits()
    doc_cap = limits["max_documents_per_event"]
    _ensure_under_cap(event_documents, cap_query, doc_cap, "document")

    # Documents have no per-file cap (PRD 9): any number is fine as long as
    # they fit the combined budget, so the budget is also the per-file ceiling.
    cap_bytes = limits["max_documents_total_bytes"]

    buffer, size = stream_upload(file, cap_bytes, what="Documents")
    try:
        check_file_signature(info["extension"], peek_head(buffer))
        _ensure_bytes_under_cap(event_documents, cap_query, size, cap_bytes, "document")

        original_name = (file.filename or "document").strip()[:255] or "document"
        stored = save_upload(
            buffer,
            file_name=original_name,
            content_type=info["content_type"],
            kind="documents",
            event_id=event_key,
            teacher_id=user["id"],
        )
    finally:
        buffer.close()

    document = new_document_document(
        event_id=event_key,
        storage=stored["storage"],
        object_key=stored["object_key"],
        file_id=stored["file_id"],
        file_name=original_name,
        file_url=stored["url"],
        file_type=info["content_type"],
        file_size=size,
        original_name=file.filename,
        category=category,
    )

    # Caps are enforced twice by convention: once before the upload and again
    # after the insert, so both call sites must read the same configured value.
    _record_upload(
        event_documents, document, stored, event, cap_query,
        doc_cap, "document", cap_bytes,
    )

    return {
        "success": True,
        "message": "Document uploaded successfully",
        "document": absolutize(request, serialize(document), "file_url"),
    }


@router.delete(
    "/teacher/events/{event_id}/documents/{document_id}"
)
def delete_teacher_event_document(
    event_id: str,
    document_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)

    _delete_attachment(event_documents, document_id, event, "Document not found")

    return {
        "success": True,
        "message": "Document deleted successfully",
    }


# ============================================================
# TEACHER DIRECT UPLOADS (browser -> R2, see services/direct_upload.py)
#
# The same photos, videos and documents as the two POST routes above, but the
# bytes skip this API: it authorises the upload, hands out pre-signed URLs,
# and on completion verifies what reached R2 before recording it with the
# same post-insert checks. Without R2 (or with R2_DIRECT_UPLOAD_ENABLED off)
# start answers {"direct": false} and the browser posts the file instead.
# ============================================================

TEACHER_UPLOAD_SCOPE = "teacher"


def _direct_upload_response(request: Request, document: dict) -> dict:
    """The body the proxied upload routes return for the same record."""
    if "file_url" in document:
        return {
            "success": True,
            "message": "Document uploaded successfully",
            "document": absolutize(request, serialize(document), "file_url"),
        }
    return {
        "success": True,
        "message": "Media uploaded successfully",
        "media": absolutize(request, serialize(document), "media_url"),
    }


@router.post(
    "/teacher/events/{event_id}/uploads"
)
def start_teacher_direct_upload(
    event_id: str,
    payload: DirectUploadStartRequest,
    background_tasks: BackgroundTasks,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)
    if not direct_upload.available():
        return {"success": True, "direct": False}

    event_key = str(event["_id"])
    info = direct_upload.inspect_declared(payload.kind, payload.file_name, payload.content_type)
    collection = event_documents if info["media_type"] == "document" else event_media
    _ensure_direct_upload_fits(collection, event_key, info, payload.size, get_upload_limits())

    # The names the proxied routes store: documents keep theirs, media are
    # sanitised.
    if payload.kind == "documents":
        file_name = payload.file_name.strip()[:255] or "document"
    else:
        file_name = safe_file_name(payload.file_name)

    started = direct_upload.start_session(
        scope=TEACHER_UPLOAD_SCOPE,
        owner_id=user["id"],
        event_key=event_key,
        kind=payload.kind,
        info=info,
        file_name=file_name,
        original_name=payload.file_name,
        size=payload.size,
        category=payload.category,
    )
    background_tasks.add_task(direct_upload.sweep_if_due)
    return {"success": True, "direct": True, **started}


@router.post(
    "/teacher/events/{event_id}/uploads/{session_id}/sign"
)
def sign_teacher_direct_upload(
    event_id: str,
    session_id: str,
    payload: DirectUploadSignRequest | None = None,
    authorization: str | None = Header(
        default=None
    ),
):
    """Fresh part URLs, for an upload that outlived the ones it was given."""
    user = get_current_user(authorization)
    require_role(user, "teacher")

    event = find_teacher_event_or_404(event_id, user["id"])
    ensure_teacher_can_edit(event)
    session = direct_upload.active_session(
        session_id, scope=TEACHER_UPLOAD_SCOPE, owner_id=user["id"], event_id=event_id
    )
    return {
        "success": True,
        **direct_upload.sign_urls(session, payload.part_numbers if payload else None),
    }


@router.post(
    "/teacher/events/{event_id}/uploads/{session_id}/complete",
    status_code=status.HTTP_201_CREATED,
)
def complete_teacher_direct_upload(
    event_id: str,
    session_id: str,
    request: Request,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)
    require_role(user, "teacher")

    session = direct_upload.claim_session(
        session_id, scope=TEACHER_UPLOAD_SCOPE, owner_id=user["id"], event_id=event_id
    )
    try:
        event = find_teacher_event_or_404(event_id, user["id"])
        ensure_teacher_can_edit(event)
    except HTTPException:
        direct_upload.discard(session)
        raise

    media_type = session["media_type"]
    caps = direct_upload.caps_for(media_type, get_upload_limits())
    direct_upload.finalize_object(session, per_file_bytes=caps["per_file_bytes"], what=caps["what"])

    collection = event_documents if media_type == "document" else event_media
    document, stored = direct_upload.new_record(session)
    try:
        # Deletes the object itself whenever it refuses the record.
        _record_upload(
            collection, document, stored, event,
            direct_upload.cap_query(str(event["_id"]), media_type),
            caps["cap"], media_type, caps["cap_bytes"],
        )
    except Exception:
        direct_upload.finish(session, direct_upload.FAILED)
        raise
    direct_upload.finish(session, direct_upload.COMPLETED, record_id=document["_id"])

    return _direct_upload_response(request, document)


@router.delete(
    "/teacher/events/{event_id}/uploads/{session_id}"
)
def abort_teacher_direct_upload(
    event_id: str,
    session_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    """Cancel an unfinished upload and free what reached R2. Scoped by the
    session's owner rather than the event, so it still cleans up after the
    event was deleted or approved mid-upload."""
    user = get_current_user(authorization)
    require_role(user, "teacher")

    aborted = direct_upload.abort_session(
        session_id, scope=TEACHER_UPLOAD_SCOPE, owner_id=user["id"], event_id=event_id
    )
    return {"success": True, "aborted": aborted}


# ============================================================
# NOTIFICATIONS
#
# Every signed-in role reads and clears its own notifications here:
# every query is scoped to the caller's user id, so a Dean sees queue
# updates and a teacher sees decisions on their own events. The
# /teacher/... paths are the original ones, kept so existing clients
# keep working; /notifications is the role-neutral name.
# ============================================================

@router.get("/notifications")
@router.get(
    "/teacher/notifications"
)
def get_teacher_notifications(
    authorization: str | None = Header(
        default=None
    ),
    skip: int | None = Query(default=None, ge=0),
    limit: int = Query(default=100, ge=1, le=500),
):
    """The caller's notifications, newest first, at most `limit` of them."""
    user = get_current_user(authorization)

    query = {"user_id": user["id"]}
    notification_list, total = paginate(
        notifications, query, "created_at", DESCENDING, skip, limit
    )

    return {
        "success": True,
        "notifications": notification_list,
        "total": total,
        "count": len(notification_list),
        "unread": notifications.count_documents({**query, "is_read": False}),
        "has_more": (skip or 0) + len(notification_list) < total,
    }


@router.post("/notifications", status_code=status.HTTP_201_CREATED)
@router.post(
    "/teacher/notifications",
    status_code=status.HTTP_201_CREATED,
)
def create_teacher_notification(
    payload: NotificationCreateRequest,
    authorization: str | None = Header(
        default=None
    ),
):
    """Client-generated notifications: only the event-date reminders the
    frontend builds (type and `data` size are checked by the schema). A
    reminder may only point at one of the caller's own events."""
    user = get_current_user(authorization)

    if payload.event_id:
        object_id = to_object_id(payload.event_id)
        event = (
            events.find_one({"_id": object_id}, {"teacher_id": 1}) if object_id else None
        )
        if not event or event.get("teacher_id") != user["id"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="A notification can only refer to one of your own events."
            )

    notification = safe_create_notification(
        user_id=user["id"],
        event_id=payload.event_id,
        notification_type=payload.notification_type,
        title=payload.title,
        message=payload.message,
        data=payload.data,
    )

    if not notification:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create notification"
        )

    return {
        "success": True,
        "notification": notification,
    }


# How long a notification lingers after it has been seen (PRD 13). The bell is
# a queue of things still to act on, not an archive, so a read item clears
# itself. MongoDB's TTL monitor sweeps about once a minute, so the real
# lifetime is this plus up to ~60s -- never assert an exact moment.
READ_NOTIFICATION_TTL = timedelta(hours=1)


def _read_marks() -> dict:
    """The fields that mark a notification read and schedule its removal.

    `expires_at` is a separate field rather than a TTL on `read_at` on purpose:
    a TTL index on `read_at` would delete every already-read notification in
    the database within a minute of being created. Rows read before this
    shipped have no `expires_at` and are simply left alone.
    """
    now = utc_now()
    return {
        "is_read": True,
        "read_at": now,
        "expires_at": now + READ_NOTIFICATION_TTL,
    }


@router.patch("/notifications/read-all")
@router.patch(
    "/teacher/notifications/read-all"
)
def mark_all_notifications_read(
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)

    notifications.update_many(
        {"user_id": user["id"], "is_read": False},
        {"$set": _read_marks()},
    )

    return {
        "success": True,
        "message": "All notifications marked as read",
    }


@router.patch("/notifications/{notification_id}/read")
@router.patch(
    "/teacher/notifications/{notification_id}/read"
)
def mark_notification_read(
    notification_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    user = get_current_user(authorization)

    result = notifications.update_one(
        {"_id": to_object_id(notification_id), "user_id": user["id"]},
        {"$set": _read_marks()},
    )

    if result.matched_count == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found"
        )

    return {
        "success": True,
        "message": "Notification marked as read",
    }


# Declared BEFORE /notifications/{notification_id}. FastAPI matches routes in
# registration order, so with the by-id route first "clear-all" was bound as a
# notification id, failed to parse as an ObjectId, and both /clear-all aliases
# answered 404 "Notification not found" -- dead endpoints that looked alive.
@router.delete("/notifications/clear-all")
@router.delete(
    "/teacher/notifications/clear-all"
)
@router.delete("/notifications")
@router.delete(
    "/teacher/notifications"
)
def clear_all_notifications(
    authorization: str | None = Header(
        default=None
    ),
):
    """Delete all notifications owned by the caller."""
    user = get_current_user(authorization)

    result = notifications.delete_many(
        {"user_id": user["id"]}
    )

    return {
        "success": True,
        "message": "All notifications cleared",
        "deleted_count": result.deleted_count,
    }


@router.delete("/notifications/{notification_id}")
@router.delete(
    "/teacher/notifications/{notification_id}"
)
def delete_notification(
    notification_id: str,
    authorization: str | None = Header(
        default=None
    ),
):
    """Delete a single notification owned by the caller."""
    user = get_current_user(authorization)

    object_id = to_object_id(notification_id)
    if not object_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found"
        )

    result = notifications.delete_one(
        {"_id": object_id, "user_id": user["id"]}
    )

    if result.deleted_count == 0:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Notification not found"
        )

    return {
        "success": True,
        "message": "Notification deleted",
    }

