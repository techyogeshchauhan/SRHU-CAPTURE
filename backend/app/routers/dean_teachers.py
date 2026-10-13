"""The Dean's Teacher-account management.

Every route here acts on **Teacher accounts only**. The target is always looked
up with ``role: "teacher"`` in the filter -- and every write repeats that
condition -- so a Dean can never reach a superadmin, another Dean or their own
account, and a teacher promoted or deleted between the read and the write is
not modified by a stale request.

What deliberately differs from the superadmin equivalents in superadmin.py:

* No password is ever sent or returned. A teacher is *invited*: emailed a
  one-time link (POST /auth/accept-invite) to choose their own password. The
  superadmin's routes still hand out temporary passwords; a Dean never does.
* "Reset password" issues the same one-time link as /auth/forgot-password
  and leaves the current password working until the teacher chooses a new one.
* Emails are sent synchronously, so the Dean sees each teacher's real outcome.
  An invitation link is stored only after its email was accepted, so a failed
  send never replaces a link the teacher already has.
* A Dean *removes* a teacher (hidden, signed out, every record kept) and can
  restore them. Permanent deletion is only for a teacher with no events --
  the typical case being a wrong import -- because it erases their events,
  media and reports.

Audit entries reuse the superadmin's action names where the action is the
same (so the superadmin's existing audit filters include Dean actions) and all
carry ``details.via = "dean_panel"`` so the Dean panel can list its own.
"""

import logging
import re
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import EmailStr, TypeAdapter, ValidationError
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.config import settings
from app.database import audit_logs, events, users
from app.models.documents import USER_PRIVATE_FIELDS, new_user_document
from app.routers.auth import find_user_by_email
from app.schemas.dean import (
    DeanCreateTeacherRequest,
    DeanImportTeachersRequest,
    DeanInviteRequest,
    DeanTeacherIdsRequest,
    DeanUpdateTeacherRequest,
)
from app.services import email_service, teacher_import
from app.services.audit_service import log_audit_event
from app.services.storage_service import delete_user_cascade, delete_users_cascade
from app.utils.auth import dean_dep, public_user
from app.utils.security import (
    generate_one_time_token,
    hash_one_time_token,
    hash_password,
)
from app.utils.serializers import serialize_many, to_object_id, utc_now


router = APIRouter(
    prefix="/dean/teachers",
    tags=["Dean Teacher Management"],
    dependencies=[Depends(dean_dep)],
)
logger = logging.getLogger(__name__)

VIA = "dean_panel"

# Two invitations to the same teacher inside this window are almost always a
# double click or two Deans acting at once; the second would silently replace
# the link the first one just delivered.
INVITE_RESEND_COOLDOWN_MINUTES = 10

# Largest selection one bulk request takes (and "Select all" returns).
MAX_BULK_TEACHERS = 5000

# Invitation emails sent at once by a bulk invite. Parallel sending is what
# makes one request for the whole selection practical; kept small so a mail
# server that limits concurrent connections is not flooded.
INVITE_SEND_WORKERS = 4

STATUS_FILTERS = ("all", "active", "inactive", "pending", "removed")
ONBOARDING_FILTERS = ("all", "not_invited", "invited", "expired", "joined")
VERIFIED_FILTERS = ("all", "verified", "unverified")
SOURCE_FILTERS = ("all", "imported", "added", "registered")

# Mark an account a Dean created: from an Excel import, or one at a time with
# the "Add teacher" form. Anything else registered itself or was onboarded by
# the superadmin.
IMPORT_SOURCE = "dean_import"
ADDED_SOURCE = "dean_added"
SORTS = {
    "newest": [("created_at", DESCENDING), ("_id", DESCENDING)],
    "oldest": [("created_at", ASCENDING), ("_id", ASCENDING)],
    "name": [("name", ASCENDING), ("_id", ASCENDING)],
    "last_login": [("last_sign_in_at", DESCENDING), ("_id", DESCENDING)],
}

EMAIL_NOT_CONFIGURED = "Email delivery is not configured on the server, so no email can be sent."

_email_adapter = TypeAdapter(EmailStr)


# ============================================================
# HELPERS
# ============================================================

def _canonical_id(user_id: str) -> str:
    object_id = to_object_id(user_id)
    return str(object_id) if object_id is not None else user_id


def find_teacher_or_404(user_id: str, actor: dict, *, include_removed: bool = False) -> dict:
    """The Teacher account with this id, or 404 for anything else.

    A superadmin or Dean id answers exactly like an unknown one, so these
    routes cannot be used to probe or touch accounts outside a Dean's remit.
    A removed teacher is out of reach too, except for the routes that bring
    them back or delete them (``include_removed``).
    """
    if _canonical_id(user_id) == actor.get("id"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot manage your own account from here.",
        )

    object_id = to_object_id(user_id)
    query: dict[str, Any] = {"_id": object_id, "role": "teacher"}
    if not include_removed:
        query["removed_at"] = None
    teacher = users.find_one(query) if object_id else None
    if not teacher:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Teacher not found",
        )
    return teacher


def _label(doc: dict) -> str:
    return doc.get("name") or doc.get("email") or "this teacher"


def _domain(email: str) -> str:
    return (email or "").rsplit("@", 1)[-1]


def _audit(actor: dict, action: str, target: dict | None, details: dict[str, Any]) -> None:
    log_audit_event(
        actor=actor,
        action=action,
        target_type="user" if target is not None else "teachers_batch",
        target_id=str(target["_id"]) if target is not None else None,
        details={
            "via": VIA,
            **(
                {
                    "target_name": target.get("name"),
                    "target_email": target.get("email"),
                    "target_role": "teacher",
                }
                if target is not None
                else {}
            ),
            **details,
        },
    )


def _valid_email(value: str | None) -> bool:
    if not value:
        return False
    try:
        _email_adapter.validate_python(value)
    except ValidationError:
        return False
    return True


def _is_active(doc: dict) -> bool:
    return doc.get("is_active") is not False


def _existing_account_reason(existing: dict) -> str:
    """Why an email cannot be used for a new teacher, in words for the Dean."""
    if existing.get("role") != "teacher":
        return "This email belongs to an account that is not a Teacher."
    if existing.get("removed_at"):
        return "Belongs to a removed teacher. Restore them from the Removed tab."
    return "Already in the teacher list."


def _unusable_password_hash() -> str:
    """A real bcrypt hash of a secret that is discarded at once.

    A Dean-created teacher has no password until they accept an invitation
    (or use Forgot password). A real hash rather than none keeps a sign-in
    attempt on such an account as slow as any other, so timing does not
    reveal that it exists.
    """
    return hash_password(secrets.token_urlsafe(32))


def _new_teacher_document(item: Any, *, name: str, password_hash: str, extra: dict[str, Any]) -> dict:
    """The user document for a teacher a Dean creates (Excel import or Add teacher)."""
    document = new_user_document(
        name=name,
        email=item.email,
        password_hash=password_hash,
        role="teacher",
        # Nothing has proved this mailbox yet. Accepting the invitation, or
        # completing a password reset, marks it verified.
        email_verified=False,
        must_change_password=True,
        phone=item.phone,
        department=item.department,
        designation=item.designation,
    )
    document.update(extra)
    return document


def _aware(value: datetime | None) -> datetime | None:
    """PyMongo can return naive UTC datetimes; compare them as UTC."""
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=utc_now().tzinfo)
    return value


def onboarding_status(doc: dict, now: datetime | None = None) -> str:
    """not_invited, invited, expired or joined -- the Dean panel's onboarding column."""
    if doc.get("last_sign_in_at") or doc.get("invite_accepted_at"):
        return "joined"
    expires = _aware(doc.get("invite_expires_at"))
    if expires is None:
        return "not_invited"
    return "invited" if expires > (now or utc_now()) else "expired"


def _onboarding_query(key: str, now: datetime) -> dict:
    """The MongoDB filter for one onboarding status (matches onboarding_status)."""
    not_joined = {"last_sign_in_at": None, "invite_accepted_at": None}
    if key == "joined":
        return {"$or": [{"last_sign_in_at": {"$ne": None}}, {"invite_accepted_at": {"$ne": None}}]}
    if key == "invited":
        return {**not_joined, "invite_expires_at": {"$gt": now}}
    if key == "expired":
        return {**not_joined, "invite_expires_at": {"$lte": now}}
    if key == "not_invited":
        return {**not_joined, "invite_expires_at": None}
    return {}


def _combine(*clauses: dict) -> dict:
    """AND together filters that may each carry their own $or."""
    parts = [c for c in clauses if c]
    if not parts:
        return {}
    return parts[0] if len(parts) == 1 else {"$and": parts}


def _event_counts(teacher_ids: list[str], *, include_drafts: bool = False) -> dict[str, int]:
    """How many events each teacher owns (events store the id as a string).

    Drafts are the teacher's own until submitted, so the Dean's numbers leave
    them out. Only the permanent-delete guard counts them: deleting the
    account would erase them too.

    find() and a Python count rather than an aggregation, so it stays testable
    with the collection fakes (see the api skill).
    """
    counts = {teacher_id: 0 for teacher_id in teacher_ids}
    query: dict[str, Any] = {"teacher_id": {"$in": teacher_ids}}
    if not include_drafts:
        query["status"] = {"$ne": "draft"}
    if teacher_ids:
        for event in events.find(query, {"teacher_id": 1}):
            key = str(event.get("teacher_id"))
            if key in counts:
                counts[key] += 1
    return counts


def _has_events_text(visible: int) -> str:
    """Why an account with events cannot be deleted, without counting drafts
    the Dean cannot see."""
    if visible:
        return f"Has {visible} event{'s' if visible != 1 else ''}."
    return "Has work saved in their account."


# ============================================================
# LIST
# ============================================================

def _teacher_filters(
    q: str | None, verified: str, source: str, onboarding: str, now: datetime
) -> tuple[dict, dict, dict, dict]:
    """The teacher list's filters: ``(base, search, onboarding, per-status)``.

    Shared by the list and GET /dean/teachers/ids, so "Select all matching"
    can never pick a different set of teachers from the one the list shows.
    """
    base: dict[str, Any] = {"role": "teacher"}

    verified_key = verified.strip().lower()
    if verified_key == "verified":
        base["email_verified"] = True
    elif verified_key == "unverified":
        base["email_verified"] = {"$ne": True}

    source_key = source.strip().lower()
    if source_key == "imported":
        base["onboarded_via"] = IMPORT_SOURCE
    elif source_key == "added":
        base["onboarded_via"] = ADDED_SOURCE
    elif source_key == "registered":
        base["onboarded_via"] = {"$nin": [IMPORT_SOURCE, ADDED_SOURCE]}

    search_clause: dict = {}
    search = (q or "").strip()
    if search:
        pattern = re.escape(search)
        search_clause = {"$or": [
            {"name": {"$regex": pattern, "$options": "i"}},
            {"email": {"$regex": pattern, "$options": "i"}},
            {"phone": {"$regex": pattern, "$options": "i"}},
            {"department": {"$regex": pattern, "$options": "i"}},
        ]}

    onboarding_key = onboarding.strip().lower()
    if onboarding_key not in ONBOARDING_FILTERS:
        onboarding_key = "all"
    onboarding_clause = _onboarding_query(onboarding_key, now)

    # Tab counts under every other filter, so each number is what clicking
    # that tab would show. Removed teachers are only ever in their own tab.
    listed = {"removed_at": None}
    status_queries = {
        "all": listed,
        # Active means able to take part: an active account whose email is
        # verified. Unverified accounts (e.g. never-joined imports) are left
        # out; they are still in All and Never signed in.
        "active": {**listed, "is_active": {"$ne": False}, "email_verified": True},
        "inactive": {**listed, "is_active": False},
        # Never signed in: the people invitations are for.
        "pending": {**listed, "last_sign_in_at": None},
        "removed": {"removed_at": {"$ne": None}},
    }
    return base, search_clause, onboarding_clause, status_queries


def _status_key(account_status: str) -> str:
    key = (account_status or "all").strip().lower()
    return key if key in STATUS_FILTERS else "all"


@router.get("")
def list_teachers(
    q: str | None = Query(default=None, max_length=200),
    # Named account_status, not status: `status` would shadow fastapi.status.
    account_status: str = Query(default="all", alias="status", max_length=20),
    verified: str = Query(default="all", max_length=20),
    source: str = Query(default="all", max_length=20),
    onboarding: str = Query(default="all", max_length=20),
    sort: str = Query(default="newest", max_length=20),
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
):
    now = utc_now()
    base, search_clause, onboarding_clause, status_queries = _teacher_filters(
        q, verified, source, onboarding, now
    )
    counts = {
        key: users.count_documents(_combine({**base, **extra}, search_clause, onboarding_clause))
        for key, extra in status_queries.items()
    }

    status_key = _status_key(account_status)
    status_base = {**base, **status_queries[status_key]}
    onboarding_counts = {
        key: users.count_documents(_combine(status_base, search_clause, _onboarding_query(key, now)))
        for key in ONBOARDING_FILTERS
    }
    query = _combine(status_base, search_clause, onboarding_clause)

    total = counts[status_key]
    cursor = (
        users.find(query, {field: 0 for field in USER_PRIVATE_FIELDS})
        .sort(SORTS.get(sort, SORTS["newest"]))
        .skip(skip)
        .limit(limit)
    )
    # Excluded twice on purpose: by the projection, and again on the way out,
    # so no credential field can reach a Dean even if the projection changes.
    teachers = serialize_many(cursor, exclude=USER_PRIVATE_FIELDS)
    event_counts = _event_counts([t["id"] for t in teachers])
    for teacher in teachers:
        teacher["onboarding_status"] = onboarding_status(
            {
                "last_sign_in_at": teacher.get("last_sign_in_at"),
                "invite_accepted_at": teacher.get("invite_accepted_at"),
                "invite_expires_at": _parse_iso(teacher.get("invite_expires_at")),
            },
            now,
        )
        teacher["event_count"] = event_counts.get(teacher["id"], 0)

    return {
        "success": True,
        "teachers": teachers,
        "total": total,
        "count": len(teachers),
        "has_more": skip + len(teachers) < total,
        "skip": skip,
        "limit": limit,
        "counts": counts,
        "onboarding_counts": onboarding_counts,
        "email_configured": email_service.is_configured(),
        "email_delivery_enabled": email_service.delivery_enabled(),
        "invite_expire_days": settings.teacher_invite_expire_days,
        "invite_cooldown_minutes": INVITE_RESEND_COOLDOWN_MINUTES,
    }


def _parse_iso(value: Any) -> datetime | None:
    """serialize() turned datetimes into ISO strings; read one back."""
    if value is None or isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


@router.get("/ids")
def list_teacher_ids(
    q: str | None = Query(default=None, max_length=200),
    account_status: str = Query(default="all", alias="status", max_length=20),
    verified: str = Query(default="all", max_length=20),
    source: str = Query(default="all", max_length=20),
    onboarding: str = Query(default="all", max_length=20),
):
    """Every teacher matching the list's filters, as id, name and email only.

    Backs "Select all matching": one light request instead of paging through
    full teacher records to collect their ids.
    """
    base, search_clause, onboarding_clause, status_queries = _teacher_filters(
        q, verified, source, onboarding, utc_now()
    )
    query = _combine({**base, **status_queries[_status_key(account_status)]}, search_clause, onboarding_clause)
    cursor = users.find(query, {"_id": 1, "name": 1, "email": 1}).limit(MAX_BULK_TEACHERS)
    found = [{"id": str(d["_id"]), "name": d.get("name"), "email": d.get("email")} for d in cursor]
    return {"success": True, "teachers": found, "total": len(found)}


@router.get("/activity")
def teacher_management_activity(limit: int = Query(default=20, ge=1, le=100)):
    """Recent teacher-management actions taken from the Dean panel, by any Dean."""
    cursor = (
        audit_logs.find({"details.via": VIA})
        .sort([("created_at", DESCENDING)])
        .limit(limit)
    )
    return {"success": True, "logs": serialize_many(cursor)}


# ============================================================
# IMPORT FROM EXCEL / CSV
# ============================================================

@router.post("/import/preview")
async def preview_teacher_import(file: UploadFile = File(...)):
    """Read a roster file and say what importing each row would do.

    Nothing is written. Every row comes back with a status: ``new`` (an
    account will be created), ``exists`` (an account with that email is
    already there -- of any role, so a Dean or superadmin address is never
    turned into a Teacher), ``duplicate`` (repeated in the file) or
    ``invalid`` (with why).
    """
    # One byte over the limit is enough to know it is too large, without
    # reading an arbitrarily large upload into memory.
    content = await file.read(teacher_import.MAX_FILE_BYTES + 1)
    try:
        rows = teacher_import.read_rows(file.filename, content)
        entries, truncated = teacher_import.parse_roster(rows)
    except teacher_import.ImportFileError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error))

    if not entries:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No teachers were found in this file. It needs at least an Email column.",
        )

    for entry in entries:
        if entry["status"] != "ok":
            continue
        existing = find_user_by_email(entry["email"])
        if existing:
            entry["status"] = "exists"
            entry["reason"] = _existing_account_reason(existing)
        else:
            entry["status"] = "new"

    counts = {key: 0 for key in ("new", "exists", "duplicate", "invalid")}
    for entry in entries:
        counts[entry["status"]] += 1

    return {
        "success": True,
        "filename": file.filename,
        "rows": entries,
        "total": len(entries),
        "counts": counts,
        "truncated": truncated,
        "max_rows": teacher_import.MAX_ROWS,
        "email_configured": email_service.is_configured(),
        "email_delivery_enabled": email_service.delivery_enabled(),
    }


@router.post("/import")
def import_teachers(payload: DeanImportTeachersRequest, dean: dict = Depends(dean_dep)):
    """Create Teacher accounts for the rows the Dean confirmed.

    Every row is checked again here -- the preview is advisory, and time has
    passed since it. An address with any existing account is skipped, never
    overwritten.

    The accounts have no usable password (see _unusable_password_hash), so
    nobody can sign in until the teacher accepts an invitation or uses Forgot
    password. With ``send_invites`` the new accounts are invited in this same
    request (the panel's "send invitations" option), rather than by a second
    call to POST /dean/teachers/invite. One hash is shared by the
    whole batch: hashing 500 would take minutes, and the secret behind it is
    unknowable either way.
    """
    unusable_hash = _unusable_password_hash()
    now = utc_now()

    results: list[dict] = []
    seen: set[str] = set()
    for item in payload.teachers:
        email = item.email
        if email in seen:
            results.append({"email": email, "name": item.name, "status": "skipped",
                            "reason": "Repeated in this import.", "user_id": None})
            continue
        seen.add(email)

        if find_user_by_email(email):
            results.append({"email": email, "name": item.name, "status": "skipped",
                            "reason": "An account with this email already exists.", "user_id": None})
            continue

        name = item.name or teacher_import.name_from_email(email)
        document = _new_teacher_document(item, name=name, password_hash=unusable_hash, extra={
            "onboarded_via": IMPORT_SOURCE,
            "imported_by": dean.get("id"),
            "imported_at": now,
        })

        try:
            inserted = users.insert_one(document)
        except DuplicateKeyError:
            results.append({"email": email, "name": name, "status": "skipped",
                            "reason": "An account with this email already exists.", "user_id": None})
            continue

        results.append({"email": email, "name": name, "status": "created",
                        "reason": None, "user_id": str(inserted.inserted_id)})

    created = [r for r in results if r["status"] == "created"]
    skipped = [r for r in results if r["status"] == "skipped"]

    _audit(dean, "teachers_imported", None, {
        "result": "success" if created else "failed",
        "requested_count": len(results),
        "created_count": len(created),
        "skipped_count": len(skipped),
        "results": [
            {"user_id": r["user_id"], "email": r["email"], "status": r["status"], "reason": r["reason"]}
            for r in results
        ],
    })

    response = {
        "success": True,
        "requested_count": len(results),
        "created_count": len(created),
        "skipped_count": len(skipped),
        "results": results,
    }

    if payload.send_invites and created:
        if not email_service.is_configured():
            response["invite_error"] = EMAIL_NOT_CONFIGURED
        else:
            ids = [ObjectId(r["user_id"]) for r in created]
            teachers = list(users.find({"_id": {"$in": ids}, "role": "teacher"}))
            response["invites"] = _send_invitations(teachers, dean)

    return response


# ============================================================
# ADD ONE TEACHER
# ============================================================

@router.post("", status_code=status.HTTP_201_CREATED)
def create_teacher(payload: DeanCreateTeacherRequest, dean: dict = Depends(dean_dep)):
    """Add a single Teacher from the Dean panel's form.

    The same account an Excel import creates -- no usable password, joined by
    invitation -- and, with ``send_invite``, the invitation goes straight out.
    An address that already has any account is refused with the reason,
    never overwritten.
    """
    existing = find_user_by_email(payload.email)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=_existing_account_reason(existing))

    now = utc_now()
    document = _new_teacher_document(payload, name=payload.name, password_hash=_unusable_password_hash(), extra={
        "onboarded_via": ADDED_SOURCE,
        "added_by": dean.get("id"),
        "added_at": now,
    })
    try:
        inserted = users.insert_one(document)
    except DuplicateKeyError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Already in the teacher list.")
    document["_id"] = inserted.inserted_id

    invite: dict[str, Any] = {"status": "not_sent", "reason": None}
    if payload.send_invite:
        if not email_service.is_configured():
            invite["reason"] = "Email is not configured on the server. Invite them from the list later."
        else:
            outcome, reason = _deliver_invite(document, dean)
            invite = {"status": outcome, "reason": reason}

    _audit(dean, "teacher_created", document, {
        "result": "success",
        "source": ADDED_SOURCE,
        "invite": invite["status"],
        "email_delivery": "enabled" if email_service.delivery_enabled() else "disabled",
    })

    created = users.find_one({"_id": inserted.inserted_id}) or document
    teacher = public_user(created)
    teacher["onboarding_status"] = onboarding_status(created)
    teacher["event_count"] = 0

    label = _label(created)
    if invite["status"] == "sent":
        message = (
            f"{label} was added and invited."
            if email_service.delivery_enabled()
            else f"{label} was added. The invitation was saved to the server outbox (email delivery is switched off)."
        )
    elif invite["status"] == "failed":
        message = f"{label} was added, but the invitation could not be sent: {invite['reason']} Try again from the list."
    elif invite["reason"]:
        message = f"{label} was added. {invite['reason']}"
    else:
        message = f"{label} was added. Send an invitation from the list when you are ready."

    return {"success": True, "message": message, "teacher": teacher, "invite": invite}


# ============================================================
# EDIT
# ============================================================

EDITABLE_FIELDS = ("name", "email", "phone", "department", "designation")


@router.patch("/{user_id}")
def update_teacher(
    user_id: str,
    payload: DeanUpdateTeacherRequest,
    dean: dict = Depends(dean_dep),
):
    teacher = find_teacher_or_404(user_id, dean)

    sent = payload.model_fields_set
    changes: dict[str, Any] = {}
    for field in EDITABLE_FIELDS:
        if field in sent:
            value = getattr(payload, field)
            if value != teacher.get(field):
                changes[field] = value

    if not changes:
        return {
            "success": True,
            "message": "Nothing to update.",
            "teacher": public_user(teacher),
        }

    update: dict[str, Any] = {**changes, "updated_at": utc_now()}

    if "email" in changes:
        # Same lookup as registration and login, so a Gmail dot variant of
        # another account is caught too.
        existing = find_user_by_email(changes["email"])
        if existing and existing["_id"] != teacher["_id"]:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Another account already uses this email address.",
            )
        # Any reset or verification link still outstanding went to the old
        # address; it must not keep working once that address is no longer
        # the account's.
        update.update({
            "reset_token_hash": None,
            "reset_expires_at": None,
            "verification_token_hash": None,
            "verification_expires_at": None,
        })

    updated = users.find_one_and_update(
        {"_id": teacher["_id"], "role": "teacher"},
        {"$set": update},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    _audit(dean, "user_profile_updated", teacher, {
        "result": "success",
        "changed": {field: {"from": teacher.get(field), "to": value} for field, value in changes.items()},
    })

    return {
        "success": True,
        "message": f"{_label(updated)}'s profile was updated.",
        "teacher": public_user(updated),
    }


# ============================================================
# ACTIVATE / DEACTIVATE
# ============================================================

def _set_active(user_id: str, dean: dict, active: bool) -> dict:
    teacher = find_teacher_or_404(user_id, dean)
    word = "active" if active else "inactive"

    if _is_active(teacher) == active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{_label(teacher)}'s account is already {word}.",
        )

    update: dict[str, Any] = {"$set": {"is_active": active, "updated_at": utc_now()}}
    if not active:
        # Ends every session now rather than at the next token check.
        # authenticate() refuses an inactive account as well.
        update["$inc"] = {"token_version": 1}

    updated = users.find_one_and_update(
        {"_id": teacher["_id"], "role": "teacher"},
        update,
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    action = "user_activated" if active else "user_deactivated"
    _audit(dean, action, teacher, {"result": "success", "is_active": active})

    return {
        "success": True,
        "message": (
            f"{_label(teacher)} can sign in again."
            if active
            else f"{_label(teacher)} was deactivated and signed out everywhere."
        ),
        "teacher": public_user(updated),
    }


@router.post("/{user_id}/activate")
def activate_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    return _set_active(user_id, dean, True)


@router.post("/{user_id}/deactivate")
def deactivate_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    return _set_active(user_id, dean, False)


# ============================================================
# DELETE
# ============================================================

@router.post("/{user_id}/remove")
def remove_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    """Take a teacher off the list without destroying anything.

    The account is deactivated and signed out everywhere, and hidden from the
    teacher list; their events, media, documents and reports are untouched.
    Whether they were active is remembered, so restoring puts things back.
    """
    teacher = find_teacher_or_404(user_id, dean)
    now = utc_now()

    updated = users.find_one_and_update(
        {"_id": teacher["_id"], "role": "teacher", "removed_at": None},
        {
            "$set": {
                "removed_at": now,
                "removed_by": dean.get("id"),
                "removed_was_active": _is_active(teacher),
                "is_active": False,
                "updated_at": now,
            },
            "$inc": {"token_version": 1},
        },
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    _audit(dean, "user_removed", teacher, {
        "result": "success",
        "event_count": _event_counts([str(teacher["_id"])])[str(teacher["_id"])],
    })

    return {
        "success": True,
        "message": f"{_label(teacher)} was removed. Their events are kept; restore them any time from the Removed tab.",
        "teacher": public_user(updated),
    }


@router.post("/{user_id}/restore")
def restore_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    teacher = find_teacher_or_404(user_id, dean, include_removed=True)
    if not teacher.get("removed_at"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"{_label(teacher)} is not removed.",
        )

    was_active = teacher.get("removed_was_active", True) is not False
    updated = users.find_one_and_update(
        {"_id": teacher["_id"], "role": "teacher", "removed_at": {"$ne": None}},
        {"$set": {
            "removed_at": None,
            "removed_by": None,
            "removed_was_active": None,
            "is_active": was_active,
            "updated_at": utc_now(),
        }},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Teacher not found")

    _audit(dean, "user_restored", teacher, {"result": "success", "is_active": was_active})

    return {
        "success": True,
        "message": (
            f"{_label(teacher)} is back in the teacher list"
            + ("." if was_active else " (still deactivated, as before).")
        ),
        "teacher": public_user(updated),
    }


def _resolve_teachers(user_ids: list[str], dean: dict) -> tuple[list[dict], list[dict]]:
    """Look up selected ids: the Teacher documents, and a skip row for the rest.

    Anything that is not a Teacher -- or is the Dean -- is reported like an
    unknown id, as everywhere else in this router.
    """
    wanted: dict[str, Any] = {}
    skipped: list[dict] = []
    for raw_id in user_ids:
        user_id = _canonical_id(raw_id)
        if user_id in wanted or any(r["user_id"] == user_id for r in skipped):
            continue
        object_id = to_object_id(user_id)
        if object_id is None or user_id == dean.get("id"):
            skipped.append(_result_row(None, user_id, "skipped", "Not a Teacher account."))
        else:
            wanted[user_id] = object_id

    # One query for the whole selection.
    found = list(users.find({"_id": {"$in": list(wanted.values())}, "role": "teacher"})) if wanted else []
    found_ids = {str(doc["_id"]) for doc in found}
    skipped.extend(
        _result_row(None, user_id, "skipped", "Not a Teacher account.")
        for user_id in wanted
        if user_id not in found_ids
    )
    return found, skipped


@router.post("/bulk-delete")
def bulk_delete_teachers(payload: DeanTeacherIdsRequest, dean: dict = Depends(dean_dep)):
    """Delete the selected teachers permanently -- the ones with no events.

    The same rule as deleting one: permanent deletion erases a teacher's
    events, media and reports, so a teacher who has any is skipped with the
    reason, and can be removed instead (which keeps everything).
    """
    teachers, results = _resolve_teachers(payload.user_ids, dean)
    ids = [str(t["_id"]) for t in teachers]
    counts = _event_counts(ids)
    everything = _event_counts(ids, include_drafts=True)

    deletable: list[dict] = []
    for teacher in teachers:
        key = str(teacher["_id"])
        if everything.get(key, 0):
            results.append(_result_row(
                teacher, key, "skipped",
                f"{_has_events_text(counts.get(key, 0))} Remove the teacher instead.",
            ))
        else:
            deletable.append(teacher)

    # One cascade for all of them: a query per collection, not per teacher.
    if deletable:
        delete_users_cascade([str(t["_id"]) for t in deletable])
    results.extend(_result_row(t, str(t["_id"]), "deleted", None) for t in deletable)

    return _bulk_response(dean, "teachers_bulk_deleted", results, "deleted")


@router.post("/bulk-remove")
def bulk_remove_teachers(payload: DeanTeacherIdsRequest, dean: dict = Depends(dean_dep)):
    """Remove the selected teachers: hidden and signed out, every record kept."""
    teachers, results = _resolve_teachers(payload.user_ids, dean)
    now = utc_now()

    # Grouped by whether each was active (remembered for Restore): at most two
    # updates for the whole selection instead of one per teacher.
    groups: dict[bool, list[dict]] = {True: [], False: []}
    for teacher in teachers:
        if teacher.get("removed_at"):
            results.append(_result_row(teacher, str(teacher["_id"]), "skipped", "Already removed."))
        else:
            groups[_is_active(teacher)].append(teacher)

    for was_active, group in groups.items():
        if not group:
            continue
        users.update_many(
            {"_id": {"$in": [t["_id"] for t in group]}, "role": "teacher", "removed_at": None},
            {
                "$set": {
                    "removed_at": now,
                    "removed_by": dean.get("id"),
                    "removed_was_active": was_active,
                    "is_active": False,
                    "updated_at": now,
                },
                "$inc": {"token_version": 1},
            },
        )
        results.extend(_result_row(t, str(t["_id"]), "removed", None) for t in group)

    return _bulk_response(dean, "teachers_bulk_removed", results, "removed")


def _bulk_response(dean: dict, action: str, results: list[dict], done_status: str) -> dict:
    done = [r for r in results if r["status"] == done_status]
    skipped = [r for r in results if r["status"] != done_status]
    _audit(dean, action, None, {
        "result": "success" if done else "failed",
        "requested_count": len(results),
        f"{done_status}_count": len(done),
        "skipped_count": len(skipped),
        "results": [
            {"user_id": r["user_id"], "email": r["email"], "status": r["status"], "reason": r["reason"]}
            for r in results
        ],
    })
    return {
        "success": True,
        "requested_count": len(results),
        "done_count": len(done),
        "skipped_count": len(skipped),
        "results": results,
    }


@router.delete("/{user_id}")
def delete_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    """Permanently delete a teacher who has no events.

    Deleting uses the application's standard cascade, which also erases a
    teacher's events, media, documents and reports -- so a Dean may only do it
    when there are none (a wrong import, a duplicate account). Anyone with
    events is removed instead, which keeps every record.
    """
    teacher = find_teacher_or_404(user_id, dean, include_removed=True)

    key = str(teacher["_id"])
    if _event_counts([key], include_drafts=True)[key]:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"{_label(teacher)}: {_has_events_text(_event_counts([key])[key])} "
                "The account cannot be deleted permanently. Remove the teacher instead: "
                "their records are kept."
            ),
        )

    delete_user_cascade(str(teacher["_id"]))

    _audit(dean, "user_deleted", teacher, {"result": "success", "role": "teacher", "event_count": 0})

    return {
        "success": True,
        "message": f"{_label(teacher)}'s account was deleted permanently.",
        "teacher": public_user(teacher),
    }


# ============================================================
# PROMOTE TO DEAN
# ============================================================

@router.post("/{user_id}/promote")
def promote_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    teacher = find_teacher_or_404(user_id, dean)

    if not _is_active(teacher):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Activate this account before promoting it to Dean.",
        )

    # token_version is bumped so the promoted user's open sessions end and
    # their next sign-in lands in the Dean panel, instead of a browser still
    # holding the Teacher screens against an account that is now a Dean.
    updated = users.find_one_and_update(
        {"_id": teacher["_id"], "role": "teacher"},
        {"$set": {"role": "dean", "updated_at": utc_now()}, "$inc": {"token_version": 1}},
        return_document=ReturnDocument.AFTER,
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account is no longer a Teacher.",
        )

    _audit(dean, "role_change", teacher, {
        "result": "success",
        "old_role": "teacher",
        "new_role": "dean",
        "user_name": teacher.get("name"),
    })

    return {
        "success": True,
        "message": f"{_label(teacher)} is now a Dean. They will be asked to sign in again.",
        "teacher": public_user(updated),
    }


# ============================================================
# PASSWORD RESET (one-time link)
# ============================================================

@router.post("/{user_id}/reset-password")
def send_password_reset(user_id: str, dean: dict = Depends(dean_dep)):
    """Email the teacher a one-time link to choose a new password.

    The mechanism of /auth/forgot-password: only the token's hash is stored,
    it expires, and completing it signs the teacher out everywhere. The
    current password keeps working until then, so a Dean can never lock a
    teacher out by starting a reset.
    """
    teacher = find_teacher_or_404(user_id, dean)

    if not _is_active(teacher):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This account is deactivated. Activate it before resetting the password.",
        )
    if not _valid_email(teacher.get("email")):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="This teacher's email address is not valid. Correct it first.",
        )
    if not email_service.is_configured():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=EMAIL_NOT_CONFIGURED)

    token = generate_one_time_token()
    token_hash = hash_one_time_token(token)
    now = utc_now()
    users.update_one(
        {"_id": teacher["_id"], "role": "teacher"},
        {"$set": {
            "reset_token_hash": token_hash,
            "reset_expires_at": now + timedelta(minutes=settings.password_reset_expire_minutes),
            "updated_at": now,
        }},
    )

    try:
        email_service.send_password_reset_email(teacher["email"], teacher.get("name") or "there", token)
    except email_service.EmailDeliveryError:
        # A link nobody received is withdrawn, conditional on it still being
        # the current one.
        users.update_one(
            {"_id": teacher["_id"], "reset_token_hash": token_hash},
            {"$set": {"reset_token_hash": None, "reset_expires_at": None}},
        )
        logger.warning("dean_password_reset_email_failed recipient_domain=%s", _domain(teacher["email"]))
        _audit(dean, "password_reset_link_sent", teacher, {"result": "failed", "reason": "email_delivery_failed"})
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The password reset email could not be delivered. Please try again later.",
        )

    _audit(dean, "password_reset_link_sent", teacher, {
        "result": "success",
        "expires_in_minutes": settings.password_reset_expire_minutes,
    })

    return {
        "success": True,
        "message": f"A password reset link was emailed to {teacher['email']}.",
    }


# ============================================================
# INVITATIONS (single and bulk)
# ============================================================

def _invite_skip_reason(doc: dict) -> str | None:
    """Why this teacher should not be sent an invitation, or None."""
    if doc.get("removed_at"):
        return "Teacher has been removed. Restore them first."
    if not _is_active(doc):
        return "Account is deactivated. Activate it first."
    if not _valid_email(doc.get("email")):
        return "Email address on the account is not valid."
    if onboarding_status(doc) == "joined":
        return "Already joined. Use Reset Password if they cannot sign in."
    invited_at = _aware(doc.get("invited_at"))
    if invited_at is not None and utc_now() - invited_at < timedelta(minutes=INVITE_RESEND_COOLDOWN_MINUTES):
        return f"An invitation was sent less than {INVITE_RESEND_COOLDOWN_MINUTES} minutes ago."
    return None


def _deliver_invite(doc: dict, dean: dict) -> tuple[str, str | None]:
    """Email one teacher a new invitation link. Returns ``(outcome, reason)``.

    The email goes first and the link is stored only once it was accepted, so
    a failed send never replaces a link the teacher already has. The write is
    conditional on the account still being an active, listed Teacher.
    """
    token = generate_one_time_token()
    try:
        email_service.send_teacher_invitation_email(doc["email"], doc.get("name") or "there", token)
    except email_service.EmailDeliveryError:
        logger.warning("dean_invite_email_failed recipient_domain=%s", _domain(doc["email"]))
        return "failed", "The email could not be delivered."

    now = utc_now()
    result = users.update_one(
        {"_id": doc["_id"], "role": "teacher", "is_active": {"$ne": False}, "removed_at": None},
        {"$set": {
            "invite_token_hash": hash_one_time_token(token),
            "invite_expires_at": now + timedelta(days=settings.teacher_invite_expire_days),
            "invited_at": now,
            "invited_by": dean.get("id"),
            "updated_at": now,
        }},
    )
    if getattr(result, "matched_count", 1) == 0:
        return "failed", "The account changed while sending. The emailed link will not work."
    return "sent", None


def _result_row(doc: dict | None, user_id: str, outcome: str, reason: str | None) -> dict:
    return {
        "user_id": str(doc["_id"]) if doc else user_id,
        "name": doc.get("name") if doc else None,
        "email": doc.get("email") if doc else None,
        "status": outcome,
        "reason": reason,
    }


def _send_invitations(teachers: list[dict], dean: dict, results: list[dict] | None = None) -> dict:
    """Invite these teachers in parallel and report every one (sent, skipped
    with why, or failed with why). Shared by POST /invite and by the Excel
    import, which invites the accounts it created in the same request."""
    results = list(results or [])

    to_send: list[dict] = []
    for doc in teachers:
        reason = _invite_skip_reason(doc)
        if reason:
            results.append(_result_row(doc, str(doc["_id"]), "skipped", reason))
        else:
            to_send.append(doc)

    # Sent in parallel: one request covers the whole selection, and each
    # teacher still gets their real outcome (sent, or failed with why).
    def deliver(doc: dict) -> dict:
        outcome, reason = _deliver_invite(doc, dean)
        return _result_row(doc, str(doc["_id"]), outcome, reason)

    if to_send:
        with ThreadPoolExecutor(max_workers=min(INVITE_SEND_WORKERS, len(to_send))) as pool:
            results.extend(pool.map(deliver, to_send))

    sent = [r for r in results if r["status"] == "sent"]
    failed = [r for r in results if r["status"] == "failed"]
    skipped = [r for r in results if r["status"] == "skipped"]

    _audit(dean, "teachers_invited", None, {
        "result": "success" if not failed else ("failed" if not sent else "partial"),
        "requested_count": len(results),
        "sent_count": len(sent),
        "failed_count": len(failed),
        "skipped_count": len(skipped),
        "email_delivery": "enabled" if email_service.delivery_enabled() else "disabled",
        # Who and what happened -- never the links.
        "results": [
            {"user_id": r["user_id"], "email": r["email"], "status": r["status"], "reason": r["reason"]}
            for r in results
        ],
    })

    return {
        "requested_count": len(results),
        "sent_count": len(sent),
        "failed_count": len(failed),
        "skipped_count": len(skipped),
        "results": results,
        "email_delivery_enabled": email_service.delivery_enabled(),
    }


@router.post("/invite")
def invite_teachers(payload: DeanInviteRequest, dean: dict = Depends(dean_dep)):
    """Send invitations to the whole selection in one request; report each outcome.

    Every id is resolved (in one query) and checked before anything is sent,
    so the response always accounts for every requested teacher: sent,
    skipped (with why) or failed (with why).
    """
    if not email_service.is_configured():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=EMAIL_NOT_CONFIGURED)

    teachers, results = _resolve_teachers(payload.user_ids, dean)
    return {"success": True, **_send_invitations(teachers, dean, results)}


@router.post("/{user_id}/invite")
def invite_teacher(user_id: str, dean: dict = Depends(dean_dep)):
    teacher = find_teacher_or_404(user_id, dean)

    if not email_service.is_configured():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=EMAIL_NOT_CONFIGURED)

    reason = _invite_skip_reason(teacher)
    if reason:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=reason)

    outcome, reason = _deliver_invite(teacher, dean)
    _audit(dean, "teacher_invited", teacher, {
        "result": "success" if outcome == "sent" else "failed",
        "email_delivery": "enabled" if email_service.delivery_enabled() else "disabled",
        **({"reason": reason} if reason else {}),
    })

    if outcome != "sent":
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=reason)

    days = settings.teacher_invite_expire_days
    return {
        "success": True,
        "message": (
            f"An invitation was emailed to {teacher['email']}. The link is valid for {days} days."
            if email_service.delivery_enabled()
            else f"Invitation for {teacher['email']} saved to the server outbox (email delivery is switched off)."
        ),
    }
