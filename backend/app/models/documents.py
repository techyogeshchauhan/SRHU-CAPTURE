"""Document shapes for each MongoDB collection.

MongoDB has no schema, so the builders here are the single place that decides
which fields a freshly inserted document carries.
"""

from __future__ import annotations

from typing import Any

from app.utils.serializers import utc_now


# event_manager records events and generates their reports directly, with no
# Dean review; its events live in their own collection (managed_events).
ROLES = ("teacher", "dean", "superadmin", "event_manager")

# Full event lifecycle. Drafts live in the teacher's browser, but the value is
# reserved so that dean views can always exclude it.
EVENT_STATUSES = (
    "draft",
    "submitted",
    "pending",
    "under_review",
    "approved",
    "in_progress",
    "completed",
    "rejected",
    "published",
    # Approval withdrawn after the fact. Distinct from "rejected", which means
    # never approved: they start from different states, read differently in
    # the history and notifications, and were previously one ambiguous button
    # that in practice could not be pressed at all (PRD 18).
    "revoked",
)

# Statuses in which the owning teacher may still edit or withdraw an event.
# "revoked" is included so a withdrawn event can be fixed and resubmitted --
# otherwise revoking would be a dead end for the teacher.
TEACHER_EDITABLE_STATUSES = (
    "draft", "submitted", "pending", "under_review", "rejected", "revoked",
)

# Post-approval delivery stages the Dean moves an event through. "in_progress"
# was removed from event tracking: an approved event now goes straight to
# completed. Events already stored as in_progress are moved to approved by
# scripts/migrate_in_progress_to_approved.py, and until then can still be
# moved on (see LEGACY_PROGRESS_STAGES).
DEAN_PROGRESS_STAGES = ("approved", "completed")

# Stages an event may still be *in* when the Dean moves it, though no longer a
# stage it can be moved *to*.
LEGACY_PROGRESS_STAGES = ("in_progress",)

# Statuses at or beyond approval.
APPROVED_STAGES = ("approved", "published", "in_progress", "completed")

ALLOWED_EVENT_TYPES = (
    "Academic",
    "Cultural",
    "Sports",
    "Workshop",
    "Seminar",
    "Conference",
    "Celebration",
    "Other",
)

# Kept as the seed set for the `event_types` collection, and as the fallback
# the API falls back to if that collection is somehow empty. It is no longer a
# closed whitelist: teachers may add their own categories (PRD 4 / 14).
DEFAULT_EVENT_TYPES = ALLOWED_EVENT_TYPES

NOTIFICATION_TYPES = (
    # To the teacher, about their own event
    "approved",
    "rejected",
    "revoked",
    "needs_changes",
    "progress",      # the Dean moved it to In Progress / Completed / back
    "published",
    "reminder",
    # To every Dean, about the review queue
    "submitted",
    "resubmitted",
)

# The teacher-visible audit trail, embedded on the event as `history`.
#
# Every status transition appends one entry, because none of what a teacher
# needs to see in "Event progress" is recoverable from the current status: a
# rejection that was later approved leaves no trace of the rejection, and a
# Dean's remarks are overwritten by the next decision. Embedded rather than a
# collection of its own — an event's history is a handful of entries, only ever
# read with the event, and appending it in the same update as the status change
# means one can never exist without the other.
HISTORY_ACTIONS = (
    "created",
    "submitted",
    "updated",
    "resubmitted",
    "approved",
    "rejected",
    "revoked",
    "changes_requested",
    "stage_changed",
    "archived",
    "restored",
)

# Fields that must never leave the server.
USER_PRIVATE_FIELDS = (
    "password_hash",
    "verification_token_hash",
    "verification_expires_at",
    "reset_token_hash",
    "reset_expires_at",
    # A Dean's invitation link. Its expiry and send time are not secret and
    # are served, so the Dean panel can say "Invited" / "Link expired".
    "invite_token_hash",
    # Session counter embedded in access tokens as `ver`; bumping it signs the
    # user out everywhere. Not secret, but of no use to the client.
    "token_version",
)
# `must_change_password` is deliberately NOT private: the frontend reads it from
# the login / me response to send a Dean with a temporary password straight to
# the change-password screen.


def new_user_document(
    *,
    name: str,
    email: str,
    password_hash: str,
    role: str = "teacher",
    email_verified: bool = False,
    must_change_password: bool = False,
    phone: str | None = None,
    designation: str | None = None,
    department: str | None = None,
    is_active: bool = True,
) -> dict[str, Any]:
    now = utc_now()
    return {
        "name": name,
        "email": email,
        "password_hash": password_hash,
        "role": role,
        # A 10-digit mobile, or None. Opting in is what puts a member of staff
        # into the faculty-coordinator directory teachers pick from (PRD 5).
        "phone": phone,
        # Academic rank, collected at registration. None on accounts created
        # before it was added, and on Deans and superadmins, who are
        # provisioned rather than self-registered.
        "designation": designation,
        "department": department,
        "is_active": is_active,
        "email_verified": email_verified,
        "email_verified_at": now if email_verified else None,
        "must_change_password": must_change_password,
        "token_version": 0,
        "verification_token_hash": None,
        "verification_expires_at": None,
        "reset_token_hash": None,
        "reset_expires_at": None,
        "last_sign_in_at": None,
        "created_at": now,
        "updated_at": now,
    }


def new_audit_log_document(
    *,
    actor_id: str,
    actor_name: str,
    actor_email: str,
    action: str,
    target_type: str,
    target_id: str | None = None,
    details: dict | None = None,
) -> dict[str, Any]:
    return {
        "actor_id": str(actor_id),
        "actor_name": actor_name,
        "actor_email": actor_email,
        "action": action,
        "target_type": target_type,
        "target_id": str(target_id) if target_id else None,
        "details": details or {},
        "created_at": utc_now(),
    }


def new_history_entry(
    *,
    action: str,
    status: str,
    actor: dict,
    from_status: str | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    """One step of an event's audit trail.

    The actor's name and role are copied in rather than looked up on read, so
    the trail still says who decided even if that account is later renamed,
    demoted or deleted.
    """
    return {
        "action": action,
        "status": status,
        "from_status": from_status,
        "actor_id": actor.get("id"),
        "actor_name": actor.get("name") or actor.get("email"),
        "actor_role": actor.get("role"),
        "note": (note or "").strip() or None,
        "created_at": utc_now(),
    }


def new_event_document(
    *,
    teacher_id: str,
    event_name: str,
    event_date: str,
    end_date: str | None = None,
    event_type: str,
    location: str,
    description: str | None,
    social_network_url: str | None,
    status: str = "pending",
    history: list[dict] | None = None,
    start_time: str | None = None,
    end_time: str | None = None,
    organizer: str | None = None,
    coordinator_contact: str | None = None,
) -> dict[str, Any]:
    now = utc_now()
    return {
        "teacher_id": teacher_id,
        "event_name": event_name,
        "event_date": event_date,
        # The last day of a multi-day event. None means it starts and ends on
        # event_date, which is what every event created before this holds.
        "end_date": end_date,
        "event_type": event_type,
        "location": location,
        "description": description,
        "social_network_url": social_network_url,
        # Promoted out of the <!--CC_METADATA:--> blob the frontend used to
        # hide these in. Real fields so they can be validated, queried and
        # rendered without parsing a comment out of the description. Events
        # created before the promotion carry None here and are filled on read
        # by app/services/event_fields.with_legacy_metadata().
        "start_time": start_time,
        "end_time": end_time,
        "organizer": organizer,
        "coordinator_contact": coordinator_contact,
        "status": status,
        "rejection_reason": None,
        # Revocation is tracked separately from rejection: merging the two
        # reasons is how the actions became indistinguishable in the first place.
        "revocation_reason": None,
        "revoked_at": None,
        # The archive shelf, orthogonal to the review lifecycle in `status`.
        # None (or absent) means live; MongoDB matches both with {"field": None}.
        "archived_at": None,
        "archived_by": None,
        "archive_reason": None,
        "submitted_at": now if status != "draft" else None,
        "reviewed_at": None,
        "history": history or [],
        "created_at": now,
        "updated_at": now,
    }


def upload_name_key(original_name: str | None, fallback: str) -> str:
    """The key duplicate-name checks compare on (PRD 10).

    Case-folded, because "Poster.JPG" and "poster.jpg" are the same file to a
    teacher even though storage keys them apart with a uuid prefix.
    """
    return " ".join((original_name or fallback or "").split()).casefold()


def new_media_document(
    *,
    event_id: str,
    file_id: str | None,
    file_name: str,
    media_url: str | None,
    media_type: str,
    content_type: str | None,
    file_size: int,
    storage: str = "gridfs",
    object_key: str | None = None,
    original_name: str | None = None,
) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "storage": storage,
        "object_key": object_key,
        "file_id": file_id,
        "file_name": file_name,
        # The name as the teacher's device reported it, before sanitising, so
        # a duplicate-name prompt can quote what they actually picked.
        "original_name": (original_name or file_name),
        "name_key": upload_name_key(original_name, file_name),
        "media_url": media_url,
        "media_type": media_type,
        "content_type": content_type,
        "file_size": file_size,
        "created_at": utc_now(),
    }


def new_document_document(
    *,
    event_id: str,
    file_id: str | None,
    file_name: str,
    file_url: str | None,
    file_type: str | None,
    file_size: int,
    storage: str = "gridfs",
    object_key: str | None = None,
    original_name: str | None = None,
    category: str = "notice",
) -> dict[str, Any]:
    cat = (category or "notice").strip().lower()
    if cat not in ("notice", "report"):
        cat = "notice"
    return {
        "event_id": event_id,
        "storage": storage,
        "object_key": object_key,
        "file_id": file_id,
        "file_name": file_name,
        "original_name": (original_name or file_name),
        "name_key": upload_name_key(original_name, file_name),
        "file_url": file_url,
        "file_type": file_type,
        "file_size": file_size,
        "category": cat,
        "created_at": utc_now(),
    }


def new_notification_document(
    *,
    user_id: str,
    event_id: str | None,
    notification_type: str,
    title: str,
    message: str,
    data: dict | None = None,
) -> dict[str, Any]:
    return {
        "user_id": user_id,
        "event_id": event_id,
        "notification_type": notification_type,
        "title": title,
        "message": message,
        "data": data or {},
        "is_read": False,
        "created_at": utc_now(),
        "read_at": None,
    }


def new_report_document(
    *,
    event_id: str,
    report_title: str,
    report_content: str,
) -> dict[str, Any]:
    return {
        "event_id": event_id,
        "report_title": report_title,
        "report_content": report_content,
        "generated_at": utc_now(),
    }


def new_event_type_document(
    *,
    name: str,
    is_default: bool = False,
    created_by: str | None = None,
) -> dict[str, Any]:
    """A selectable event category.

    `key` is the case-folded name and carries a unique index, so "Hackathon"
    and "hackathon" cannot both exist -- whoever types it second reuses the
    first one's canonical spelling rather than creating a near-duplicate.
    """
    return {
        "name": name,
        "key": name.casefold(),
        "is_default": is_default,
        "created_by": created_by,
        "created_at": utc_now(),
    }


def new_faculty_coordinator_document(
    *,
    name: str,
    phone: str,
    created_by: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """A coordinator contact card.

    Deliberately not a user account: an account needs a unique email and a
    password hash, would appear in the superadmin user list, and would skew the
    role counts on its dashboard. A coordinator is a name and a number that a
    teacher can attach to an event, nothing more.
    """
    display_name = " ".join(name.split())
    return {
        "name": display_name,
        "name_key": display_name.casefold(),
        "phone": phone,
        "user_id": user_id,
        "created_by": created_by,
        "created_at": utc_now(),
        "updated_at": utc_now(),
    }
