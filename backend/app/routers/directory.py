"""Lookup data the create-event form needs: categories and coordinators.

Both are lists a teacher picks from and may add to, and neither belongs to an
existing router -- events.py is about the events themselves, users.py about the
caller's own account.
"""

import re

from fastapi import APIRouter, Header, HTTPException, Query, status

from app.database import faculty_coordinators, users
from app.models.documents import new_faculty_coordinator_document
from app.schemas.common import normalize_phone
from app.services.event_types import (
    clean_event_type_name,
    find_event_type,
    list_event_type_names,
    resolve_event_type,
)
from app.services.event_type_management import (
    event_type_usage, list_manageable_types, migrate_event_type,
)
from app.utils.auth import get_current_user, require_role
from app.utils.serializers import serialize_many

from pydantic import BaseModel, Field, field_validator

router = APIRouter(tags=["Directory"])


# ============================================================
# EVENT TYPES
# ============================================================

class EventTypeCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=60)

    @field_validator("name")
    @classmethod
    def check_name(cls, value: str) -> str:
        return clean_event_type_name(value)


@router.get("/event-types")
def get_event_types(authorization: str | None = Header(default=None)):
    """Every selectable category. Any signed-in role may read it."""
    get_current_user(authorization)
    return {"success": True, "event_types": list_event_type_names()}


@router.post("/event-types", status_code=status.HTTP_201_CREATED)
def add_event_type(
    payload: EventTypeCreateRequest,
    authorization: str | None = Header(default=None),
):
    """Add a category (PRD 4 / 14).

    Adding one that already exists is not an error -- it returns the canonical
    spelling, so two teachers racing on "Hackathon" both end up on one row.
    """
    user = get_current_user(authorization)
    require_role(user, "teacher", "event_manager")

    if payload.name.casefold() == "uncategorized" and not find_event_type(payload.name):
        raise HTTPException(409, "Uncategorized is reserved for events moved from deleted types.")
    name = resolve_event_type(payload.name, created_by=user["id"])
    if not find_event_type(name):
        raise HTTPException(503, "Could not save the event type. Please try again.")
    return {
        "success": True,
        "event_type": name,
        "event_types": list_event_type_names(),
    }


@router.get("/event-types/manage")
def manage_event_types(authorization: str | None = Header(default=None)):
    user = get_current_user(authorization)
    require_role(user, "event_manager")
    return {"success": True, "event_types": list_manageable_types(user)}


@router.get("/event-types/{type_id}/usage")
def get_event_type_usage(type_id: str, authorization: str | None = Header(default=None)):
    user = get_current_user(authorization)
    require_role(user, "event_manager")
    return {"success": True, **event_type_usage(type_id, user)}


@router.patch("/event-types/{type_id}")
def edit_event_type(type_id: str, payload: EventTypeCreateRequest,
                    authorization: str | None = Header(default=None)):
    user = get_current_user(authorization)
    require_role(user, "event_manager")
    return migrate_event_type(type_id, user, name=payload.name)


class EventTypeDeleteRequest(BaseModel):
    # Explicit null means Uncategorized; an omitted field must never delete.
    destination_id: str | None = Field(...)


@router.delete("/event-types/{type_id}")
def delete_event_type(type_id: str, payload: EventTypeDeleteRequest,
                      authorization: str | None = Header(default=None)):
    user = get_current_user(authorization)
    require_role(user, "event_manager")
    return migrate_event_type(type_id, user, destination_id=payload.destination_id, delete=True)


# ============================================================
# FACULTY COORDINATORS
# ============================================================

class FacultyCoordinatorCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str = Field(min_length=1, max_length=24)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        name = " ".join(value.split())
        if not name:
            raise ValueError("Name must not be empty")
        return name

    @field_validator("phone")
    @classmethod
    def check_phone(cls, value: str) -> str:
        # Required here: a directory entry with no number has no purpose.
        return normalize_phone(value, required=True)


def _coordinator_entries(search: str) -> list[dict]:
    """Staff who published a mobile, plus the standalone contact cards.

    Only `name` and `phone` ever leave this function. Teachers must not be able
    to enumerate colleagues' email addresses or roles through a form's
    autocomplete, so the projection -- not a filter applied later -- is what
    guarantees it.
    """
    entries: list[dict] = []

    # The search runs in the query, not over the whole collection in Python.
    # This endpoint backs an autocomplete, so it is called on keystrokes; it
    # used to read every account with a phone number and every contact card on
    # each one, then filter the result in memory.
    name_filter: dict = {}
    if search:
        name_filter = {"name": {"$regex": re.escape(search), "$options": "i"}}

    staff = users.find(
        {"phone": {"$nin": [None, ""]}, **name_filter},
        {"name": 1, "phone": 1},
    )
    for row in serialize_many(staff):
        if row.get("name") and row.get("phone"):
            entries.append({
                "id": row["id"],
                "name": row["name"],
                "phone": row["phone"],
                "source": "user",
            })

    cards = faculty_coordinators.find(name_filter, {"name": 1, "phone": 1})
    for row in serialize_many(cards):
        if row.get("name") and row.get("phone"):
            entries.append({
                "id": row["id"],
                "name": row["name"],
                "phone": row["phone"],
                "source": "custom",
            })

    # A staff account and a contact card for the same person collapse to one
    # row; the account wins because its number is self-maintained.
    seen: set[str] = set()
    deduped: list[dict] = []
    for entry in sorted(entries, key=lambda e: e["source"] != "user"):
        key = " ".join(entry["name"].split()).casefold()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)

    deduped.sort(key=lambda e: e["name"].casefold())
    return deduped


@router.get("/faculty/coordinators")
def list_faculty_coordinators(
    authorization: str | None = Header(default=None),
    q: str | None = Query(default=None, max_length=80),
    limit: int = Query(default=50, ge=1, le=200),
):
    get_current_user(authorization)

    entries = _coordinator_entries((q or "").strip())
    return {
        "success": True,
        "coordinators": entries[:limit],
        "total": len(entries),
    }


@router.post("/faculty/coordinators", status_code=status.HTTP_201_CREATED)
def add_faculty_coordinator(
    payload: FacultyCoordinatorCreateRequest,
    authorization: str | None = Header(default=None),
):
    """Record a coordinator who has no account (PRD 5).

    Idempotent on the name: adding someone already listed updates their number
    rather than failing, which is what a teacher correcting a typo expects.
    """
    user = get_current_user(authorization)
    require_role(user, "teacher", "event_manager")

    document = new_faculty_coordinator_document(
        name=payload.name,
        phone=payload.phone,
        created_by=user["id"],
    )

    existing = faculty_coordinators.find_one({"name_key": document["name_key"]})
    if existing:
        faculty_coordinators.update_one(
            {"_id": existing["_id"]},
            {"$set": {"phone": payload.phone, "updated_at": document["updated_at"]}},
        )
        return {
            "success": True,
            "message": "Coordinator updated",
            "coordinator": {
                "id": str(existing["_id"]),
                "name": existing.get("name") or document["name"],
                "phone": payload.phone,
                "source": "custom",
            },
        }

    result = faculty_coordinators.insert_one(document)
    return {
        "success": True,
        "message": "Coordinator added",
        "coordinator": {
            "id": str(result.inserted_id),
            "name": document["name"],
            "phone": document["phone"],
            "source": "custom",
        },
    }
