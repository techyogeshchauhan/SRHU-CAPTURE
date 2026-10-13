"""Research Showcases: how research is *presented* to the Dean.

A showcase is a titled, curated collection of verified records with a short
narrative -- "Annual Research Highlights 2025-26", "Patents granted this
year", "Dr Joshi's research" -- that its author sends to the Dean, who
opens it as a presentation and can download it as a PDF.

* The Event Manager builds showcases from any teacher's verified records and
  can edit any showcase (they work as a team).
* A teacher builds showcases from their own verified records only.
* The Dean sees showcases once they are sent, and is notified when one is.

Records are referenced, not copied: a showcase always shows the record as it
is now. One whose verification is later withdrawn drops out of the Dean's
view (and the PDF) and the author's editor flags it.
"""

from __future__ import annotations

from fastapi import APIRouter, Header, HTTPException, Request, Response, status

from app.database import research_showcases
from app.models.documents import new_notification_document
from app.routers import research as core
from app.routers.research_tools import _download, _people, _slug
from app.schemas.research import ShowcaseCreateRequest, ShowcaseUpdateRequest
from app.services.research_analytics import compute_analytics
from app.services.research_pdf import build_showcase_pdf
from app.utils.serializers import serialize, to_object_id, utc_now

router = APIRouter(tags=["Research showcases"])

MAX_SHOWCASE_RECORDS = 200


def _not_found() -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Showcase not found")


def _scope(user: dict) -> dict:
    return {} if user.get("role") == "event_manager" else {"owner_id": user["id"]}


def _find_for_author(showcase_id: str, user: dict) -> dict:
    object_id = to_object_id(showcase_id)
    found = research_showcases.find_one({"_id": object_id, **_scope(user)}) if object_id else None
    if not found:
        raise _not_found()
    return found


def _find_for_dean(showcase_id: str) -> dict:
    object_id = to_object_id(showcase_id)
    found = research_showcases.find_one({"_id": object_id, "status": "sent"}) if object_id else None
    if not found:
        raise _not_found()
    return found


def _records(showcase: dict) -> list[dict]:
    """The showcase's records, in its order. Missing ones are skipped."""
    ids = [oid for oid in (to_object_id(value) for value in showcase.get("record_ids") or []) if oid is not None]
    if not ids:
        return []
    found = {str(row["_id"]): row for row in core.research_records.find({"_id": {"$in": ids}})}
    return [found[str(oid)] for oid in ids if str(oid) in found]


def _summary(showcase: dict, user: dict) -> dict:
    item = serialize(showcase)
    item["record_count"] = len(showcase.get("record_ids") or [])
    item["viewed"] = any(v.get("dean_id") == user.get("id") for v in showcase.get("viewed_by") or [])
    item["can_edit"] = user.get("role") != "dean"
    return item


def _full(request: Request, showcase: dict, user: dict, *, verified_only: bool) -> dict:
    records = _records(showcase)
    withdrawn = sum(1 for r in records if r.get("verification_status") != "verified")
    if verified_only:
        records = [r for r in records if r.get("verification_status") == "verified"]
    item = _summary(showcase, user)
    item["records"] = core._present(request, records, user) if records else []
    item["withdrawn_count"] = withdrawn
    item["stats"] = compute_analytics(
        [r for r in records if r.get("verification_status") == "verified"],
        _people({r.get("faculty_id") for r in records}),
    )
    return item


def _check_records(record_ids: list[str], user: dict) -> list[str]:
    """Every record the showcase may hold: existing, verified, in scope."""
    unique = list(dict.fromkeys(record_ids))
    if len(unique) > MAX_SHOWCASE_RECORDS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"A showcase can hold at most {MAX_SHOWCASE_RECORDS} records.",
        )
    object_ids = [to_object_id(value) for value in unique]
    if any(oid is None for oid in object_ids):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown research record.")
    query = {"_id": {"$in": object_ids}, **core._scope(user)}
    found = {
        str(row["_id"]): row
        for row in core.research_records.find(query, {"verification_status": 1, "category": 1})
    }
    for value in unique:
        row = found.get(value)
        if row is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown research record.")
        if row.get("verification_status") != "verified":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Only verified records can be presented to the Dean.",
            )
        if core.get_category(row.get("category")) is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="This research category is no longer available for new showcases.",
            )
    return unique


# ============================================================
# AUTHORS
# ============================================================

@router.get("/research/showcases")
def list_showcases(authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    rows = research_showcases.find(_scope(user)).sort([("updated_at", -1)])
    return {"success": True, "showcases": [_summary(row, user) for row in rows]}


@router.post("/research/showcases", status_code=status.HTTP_201_CREATED)
def create_showcase(payload: ShowcaseCreateRequest, request: Request, authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    now = utc_now()
    document = {
        "title": payload.title,
        "description": payload.description,
        "owner_id": user["id"],
        "owner_name": user.get("name") or user.get("email"),
        "owner_role": user.get("role"),
        "record_ids": [],
        "highlight_ids": [],
        "status": "draft",
        "sent_at": None,
        "sent_count": 0,
        "viewed_by": [],
        "created_at": now,
        "updated_at": now,
    }
    result = research_showcases.insert_one(document)
    document["_id"] = result.inserted_id
    return {"success": True, "showcase": _full(request, document, user, verified_only=False)}


@router.get("/research/showcases/{showcase_id}")
def get_showcase(showcase_id: str, request: Request, authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    return {"success": True, "showcase": _full(request, _find_for_author(showcase_id, user), user, verified_only=False)}


@router.patch("/research/showcases/{showcase_id}")
def update_showcase(
    showcase_id: str,
    payload: ShowcaseUpdateRequest,
    request: Request,
    authorization: str | None = Header(default=None),
):
    user = core._author(authorization)
    showcase = _find_for_author(showcase_id, user)
    fields = payload.model_dump(exclude_unset=True)
    changes: dict = {}
    if "title" in fields:
        if not fields["title"]:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Give the showcase a title.")
        changes["title"] = fields["title"]
    if "description" in fields:
        changes["description"] = fields["description"]
    record_ids = showcase.get("record_ids") or []
    if "record_ids" in fields:
        # Records already in it stay allowed even if since unverified, so
        # reordering never fails; only newly added ones are checked.
        added = [rid for rid in fields["record_ids"] or [] if rid not in record_ids]
        _check_records(added, user)
        record_ids = list(dict.fromkeys(fields["record_ids"] or []))
        if len(record_ids) > MAX_SHOWCASE_RECORDS:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"A showcase can hold at most {MAX_SHOWCASE_RECORDS} records.",
            )
        changes["record_ids"] = record_ids
    highlights = fields.get("highlight_ids", showcase.get("highlight_ids") or [])
    # A highlight is always one of the showcase's own records.
    changes["highlight_ids"] = [rid for rid in dict.fromkeys(highlights or []) if rid in record_ids]
    changes["updated_at"] = utc_now()
    research_showcases.update_one({"_id": showcase["_id"]}, {"$set": changes})
    fresh = research_showcases.find_one({"_id": showcase["_id"]})
    return {"success": True, "showcase": _full(request, fresh, user, verified_only=False)}


@router.delete("/research/showcases/{showcase_id}")
def delete_showcase(showcase_id: str, authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    showcase = _find_for_author(showcase_id, user)
    research_showcases.delete_one({"_id": showcase["_id"]})
    return {"success": True, "message": "Showcase deleted"}


@router.post("/research/showcases/{showcase_id}/send")
def send_showcase(showcase_id: str, request: Request, authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    showcase = _find_for_author(showcase_id, user)
    verified = [r for r in _records(showcase) if r.get("verification_status") == "verified"]
    if not verified:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Add at least one verified record before sending the showcase to the Dean.",
        )
    again = showcase.get("status") == "sent"
    now = utc_now()
    research_showcases.update_one(
        {"_id": showcase["_id"]},
        {"$set": {
            "status": "sent",
            "sent_at": now,
            "sent_count": int(showcase.get("sent_count") or 0) + 1,
            "updated_at": now,
            # A re-sent showcase is new to every Dean again.
            "viewed_by": [],
        }},
    )
    for dean in core.users.find({"role": "dean"}, {"_id": 1}):
        try:
            core.notifications.insert_one(new_notification_document(
                user_id=str(dean["_id"]),
                event_id=None,
                notification_type="research_showcase",
                title="Research showcase updated" if again else "New research showcase",
                message=(
                    f"{core._who(user)} {'updated' if again else 'sent you'} the research showcase "
                    f"\"{showcase.get('title')}\" ({len(verified)} verified records)."
                ),
                data={"showcase_id": str(showcase["_id"]), "showcase_title": showcase.get("title")},
            ))
        except Exception:  # noqa: BLE001 -- a notification never blocks the send
            continue
    fresh = research_showcases.find_one({"_id": showcase["_id"]})
    return {
        "success": True,
        "message": "Sent to the Dean again" if again else "Sent to the Dean",
        "showcase": _full(request, fresh, user, verified_only=False),
    }


def _pdf(showcase: dict) -> Response:
    records = [r for r in _records(showcase) if r.get("verification_status") == "verified"]
    content = build_showcase_pdf(
        {**showcase, "highlight_ids": [str(x) for x in showcase.get("highlight_ids") or []]},
        records,
        _people({r.get("faculty_id") for r in records}),
    )
    return _download(content, f"research-showcase-{_slug(showcase.get('title'))}.pdf", "application/pdf")


@router.get("/research/showcases/{showcase_id}/pdf")
def author_showcase_pdf(showcase_id: str, authorization: str | None = Header(default=None)):
    user = core._author(authorization)
    return _pdf(_find_for_author(showcase_id, user))


# ============================================================
# DEAN
# ============================================================

@router.get("/dean/research/showcases")
def dean_list_showcases(authorization: str | None = Header(default=None)):
    user = core._dean(authorization)
    rows = research_showcases.find({"status": "sent"}).sort([("sent_at", -1)])
    items = [_summary(row, user) for row in rows]
    return {"success": True, "showcases": items, "unviewed": sum(1 for item in items if not item["viewed"])}


@router.get("/dean/research/showcases/{showcase_id}")
def dean_get_showcase(showcase_id: str, request: Request, authorization: str | None = Header(default=None)):
    user = core._dean(authorization)
    showcase = _find_for_dean(showcase_id)
    if not any(v.get("dean_id") == user["id"] for v in showcase.get("viewed_by") or []):
        research_showcases.update_one(
            {"_id": showcase["_id"]},
            {"$push": {"viewed_by": {"dean_id": user["id"], "name": user.get("name"), "at": utc_now()}}},
        )
        showcase = research_showcases.find_one({"_id": showcase["_id"]})
    return {"success": True, "showcase": _full(request, showcase, user, verified_only=True)}


@router.get("/dean/research/showcases/{showcase_id}/pdf")
def dean_showcase_pdf(showcase_id: str, authorization: str | None = Header(default=None)):
    core._dean(authorization)
    return _pdf(_find_for_dean(showcase_id))
