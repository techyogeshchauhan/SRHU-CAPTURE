"""Research portfolio tools: exports, CVs, DOI and reminders.

The records themselves live in routers/research.py; this module reads them
through that module (``core.research_records``, ``core.users`` ...) so there
is one place a test patches a collection, and one set of access rules.

Who may use what
----------------
* The NAAC export: the Event Manager (read-only) and the Dean.
* The register export: the Dean, the Event Manager (everything) and a teacher
  (their own records).
* A research CV: the Dean for anyone, a teacher for themselves. Not the
  Event Manager.
* DOI look-up, outcomes due and reminders: both authoring roles.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

from fastapi import APIRouter, Header, HTTPException, Query, Response, status
from pymongo import DESCENDING

from app.models.documents import new_notification_document
from app.routers import research as core
from app.services.research_categories import (
    CATEGORIES,
    clean_details_leniently,
)
from app.services.research_doi import DoiError, lookup_doi
from app.services.research_identifiers import identifiers_of
from app.services.research_pdf import build_research_cv
from app.services.research_reminders import reminders_for
from app.services.research_spreadsheets import (
    export_naac,
    export_records,
)
from app.services.storage_service import content_disposition
from app.utils.auth import require_role
from app.utils.serializers import to_object_id, utc_now

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Research tools"])

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

# How often the same reminder may be repeated.
TEACHER_REMINDER_DAYS = 30
MANAGER_DIGEST_DAYS = 7


# ============================================================
# HELPERS
# ============================================================

def _download(content: bytes, file_name: str, media_type: str) -> Response:
    return Response(
        content=content,
        media_type=media_type,
        headers={
            "Content-Disposition": content_disposition("attachment", file_name),
            "Cache-Control": "no-store",
        },
    )


def _manager_or_dean(authorization: str | None) -> dict:
    return require_role(core.get_current_user(authorization), "event_manager", "dean")


def _event_manager(authorization: str | None) -> dict:
    return require_role(core.get_current_user(authorization), "event_manager")


def _people(faculty_ids) -> dict[str, dict]:
    object_ids = [oid for oid in {to_object_id(value) for value in faculty_ids if value} if oid is not None]
    people: dict[str, dict] = {}
    if object_ids:
        for person in core.users.find(
            {"_id": {"$in": object_ids}},
            {"name": 1, "email": 1, "designation": 1},
        ):
            people[str(person["_id"])] = {
                "name": person.get("name") or person.get("email"),
                "email": person.get("email"),
                "designation": person.get("designation"),
            }
    return people


def _slug(text: str | None) -> str:
    return "-".join("".join(c if c.isalnum() else " " for c in (text or "")).split())[:60] or "research"


def _period(academic_year: str | None) -> str:
    return f"Academic year {academic_year}" if academic_year else "All years"


# ============================================================
# EXPORTS
# ============================================================

def _export_query(user: dict, status_filter: str | None, category, academic_year, q) -> dict:
    query = core._scope(user)
    core._apply_filters(query, category=category, academic_year=academic_year, faculty_id=None)
    search = core._search_clause(q, include_people=user.get("role") != "teacher")
    if search:
        query.update(search)
    wanted = (status_filter or "all").strip().lower()
    if wanted != "all":
        if wanted not in core.RESEARCH_VERIFICATION_STATUSES:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown status filter.")
        query["verification_status"] = wanted
    return query


def _register_export(user: dict, status_filter, category, academic_year, q) -> Response:
    query = _export_query(user, status_filter, category, academic_year, q)
    records = list(core.research_records.find(query).sort([("record_date", DESCENDING)]))
    heading = "Research register" if user.get("role") != "teacher" else f"Research portfolio — {user.get('name') or ''}"
    content = export_records(records, _people({r.get("faculty_id") for r in records}), heading=heading)
    stamp = date.today().isoformat()
    return _download(content, f"research-register-{stamp}.xlsx", XLSX)


@router.get("/research/export.xlsx")
def author_export(
    authorization: str | None = Header(default=None),
    status_filter: str | None = Query(default=None, alias="status", max_length=30),
    category: str | None = Query(default=None, max_length=30),
    academic_year: str | None = Query(default=None, max_length=10),
    q: str | None = Query(default=None, max_length=200),
):
    user = core._author(authorization)
    return _register_export(user, status_filter, category, academic_year, q)


def _naac(academic_year: str | None) -> Response:
    query: dict = {"verification_status": "verified"}
    core._apply_filters(query, category=None, academic_year=academic_year, faculty_id=None)
    records = list(core.research_records.find(query))
    content = export_naac(records, _people({r.get("faculty_id") for r in records}), period=_period(academic_year))
    suffix = academic_year or "all-years"
    return _download(content, f"naac-criterion-3-research-{suffix}.xlsx", XLSX)


@router.get("/research/export/naac.xlsx")
def manager_naac(
    authorization: str | None = Header(default=None),
    academic_year: str | None = Query(default=None, max_length=10),
):
    _event_manager(authorization)
    return _naac(academic_year)


@router.get("/dean/research/export/naac.xlsx")
def dean_naac(
    authorization: str | None = Header(default=None),
    academic_year: str | None = Query(default=None, max_length=10),
):
    core._dean(authorization)
    return _naac(academic_year)


# ============================================================
# RESEARCH CV
# ============================================================

def _cv(faculty_id: str) -> Response:
    object_id = to_object_id(faculty_id)
    person = core.users.find_one({"_id": object_id, "role": "teacher"}) if object_id else None
    if not person:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Faculty member not found")
    records = list(core.research_records.find({"faculty_id": str(person["_id"]), "verification_status": "verified"}))
    content = build_research_cv(
        {
            "name": person.get("name") or person.get("email"),
            "email": person.get("email"),
            "designation": person.get("designation"),
        },
        records,
    )
    return _download(content, f"research-cv-{_slug(person.get('name'))}.pdf", "application/pdf")


@router.get("/research/faculty/{faculty_id}/cv.pdf")
def author_cv(faculty_id: str, authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    if user.get("role") != "teacher":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Research CVs are for the Dean and the teacher.")
    if faculty_id != user["id"]:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can download your own research CV only.")
    return _cv(faculty_id)


@router.get("/dean/research/faculty/{faculty_id}/cv.pdf")
def dean_cv(faculty_id: str, authorization: str | None = Header(default=None)):
    core._dean(authorization)
    return _cv(faculty_id)


# ============================================================
# SPREADSHEET IMPORT (EVENT MANAGER)
# ============================================================

# ============================================================
# DOI
# ============================================================

@router.get("/research/doi")
def doi_lookup(doi: str = Query(min_length=3, max_length=300), authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    try:
        found = lookup_doi(doi)
    except DoiError as error:
        raise HTTPException(status_code=error.status, detail=str(error)) from None
    category = CATEGORIES.get(found["category"])
    # Whatever does not fit the form (a value Crossref spells differently)
    # is dropped field by field rather than refusing the whole suggestion.
    details = clean_details_leniently(category, found["details"], found["outcome_status"]) if category else {}
    found["details"] = details
    identifiers = identifiers_of(found["category"], found.get("title"), details)
    matches = core.find_duplicates(identifiers, user)
    found["duplicates"] = core.duplicates_for({"_id": "", "identifiers": identifiers, "faculty_id": None}, matches)
    return {"success": True, "suggestion": found}


# ============================================================
# OUTCOMES DUE AND REMINDERS
# ============================================================

def _due(user: dict) -> list[tuple[dict, list]]:
    query = {**core._scope(user), "verification_status": {"$ne": "rejected"}}
    today = date.today()
    found = []
    for record in core.research_records.find(query):
        reminders = reminders_for(record, today)
        if reminders:
            found.append((record, reminders))
    return found


@router.get("/research/outcomes-due")
def outcomes_due(authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    due = _due(user)
    people = _people({record.get("faculty_id") for record, _ in due})
    items = [
        {
            "id": str(record["_id"]),
            "title": record.get("title"),
            "category": record.get("category"),
            "outcome_status": record.get("outcome_status"),
            "verification_status": record.get("verification_status"),
            "faculty": {"id": record.get("faculty_id"), **(people.get(str(record.get("faculty_id"))) or {})},
            "reminders": [{"key": r.key, "message": r.message, "action": r.action} for r in reminders],
        }
        for record, reminders in due
    ]
    items.sort(key=lambda item: (item["faculty"].get("name") or "", item["title"] or ""))
    return {"success": True, "items": items, "total": len(items)}


def _recently(user_id: str, query: dict, days: int) -> bool:
    since = utc_now() - timedelta(days=days)
    return core.notifications.find_one({
        "user_id": user_id,
        "notification_type": "research_reminder",
        "created_at": {"$gte": since},
        **query,
    }) is not None


@router.post("/research/reminders/check")
def check_reminders(authorization: str | None = Header(default=None)):
    """Turn due outcomes into notifications, without repeating them.

    A teacher gets one per record and reason, at most monthly. An Event
    Manager -- who keeps every teacher's records -- gets one digest a week
    instead of one per record.
    """
    user = core._author(authorization)
    due = _due(user)
    created = 0

    if user.get("role") == "teacher":
        for record, reminders in due:
            for reminder in reminders:
                key = {"data.research_id": str(record["_id"]), "data.reason": reminder.key}
                if _recently(user["id"], key, TEACHER_REMINDER_DAYS):
                    continue
                core.notifications.insert_one(new_notification_document(
                    user_id=user["id"],
                    event_id=None,
                    notification_type="research_reminder",
                    title=f"Update needed: {record.get('title')}",
                    message=reminder.message,
                    data={"research_id": str(record["_id"]), "reason": reminder.key, "research_title": record.get("title")},
                ))
                created += 1
    elif due and not _recently(user["id"], {"data.digest": True}, MANAGER_DIGEST_DAYS):
        count = len(due)
        core.notifications.insert_one(new_notification_document(
            user_id=user["id"],
            event_id=None,
            notification_type="research_reminder",
            title="Research records need an update",
            message=(
                f"{count} research {'record needs' if count == 1 else 'records need'} an update — patents due for "
                "publication, papers since published. See Outcomes due on the Research page."
            ),
            data={"digest": True, "research_list": True},
        ))
        created = 1

    return {"success": True, "created": created, "due": len(due)}

