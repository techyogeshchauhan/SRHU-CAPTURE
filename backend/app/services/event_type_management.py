"""Owner-authorized, atomic migrations of the shared event-type catalog."""

import re

from bson import ObjectId
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError, PyMongoError

from app.database import events, managed_events
from app.models.documents import new_event_type_document, utc_now
from app.services import event_types as catalog


def _id(value: str) -> ObjectId:
    if not ObjectId.is_valid(value):
        raise HTTPException(404, "Event type not found.")
    return ObjectId(value)


def _owned(type_id, user, *, session=None):
    options = {"session": session} if session is not None else {}
    row = catalog.event_types.find_one({"_id": _id(type_id)}, **options)
    if not row:
        raise HTTPException(404, "Event type not found.")
    if (row.get("is_default") or row.get("key") == "uncategorized"
            or str(row.get("created_by")) != user["id"]):
        raise HTTPException(403, "You can manage only custom event types you created.")
    return row


def list_manageable_types(user):
    try:
        rows = list(catalog.event_types.find({}, {"name": 1, "key": 1, "is_default": 1, "created_by": 1}))
    except PyMongoError as error:
        raise HTTPException(503, "Could not load event types. Please try again.") from error
    rows.sort(key=lambda row: str(row.get("name", "")).casefold())
    return [{"id": str(row["_id"]), "name": row["name"],
             "is_default": bool(row.get("is_default") or row.get("key") == "uncategorized"),
             "can_manage": not row.get("is_default") and row.get("key") != "uncategorized"
             and str(row.get("created_by")) == user["id"]} for row in rows]


def _names(row):
    return list(dict.fromkeys([row["name"], *row.get("aliases", [])]))


def _references(row):
    # Escaping is essential: custom type names are labels, never regex syntax.
    pattern = "^(?:" + "|".join(re.escape(name) for name in _names(row)) + ")$"
    return {"event_type": {"$regex": pattern, "$options": "i"}}


def event_type_usage(type_id, user):
    try:
        row = _owned(type_id, user)
        query = _references(row)
        teacher_count = events.count_documents(query)
        manager_count = managed_events.count_documents(query)
    except PyMongoError as error:
        raise HTTPException(503, "Could not check associated events. Please try again.") from error
    return {"teacher_events": teacher_count, "managed_events": manager_count,
            "total": teacher_count + manager_count}


def migrate_event_type(type_id, user, *, name=None, destination_id=None, delete=False):
    def migrate(session):
        source = _owned(type_id, user, session=session)
        source_id = source["_id"]
        if delete:
            if destination_id is None:
                destination = catalog.find_event_type("Uncategorized", session=session)
                if not destination:
                    destination = new_event_type_document(name="Uncategorized", is_default=True)
                    destination["_id"] = catalog.event_types.insert_one(destination, session=session).inserted_id
            else:
                destination = catalog.event_types.find_one({"_id": _id(destination_id)}, session=session)
                if not destination:
                    raise HTTPException(404, "Destination event type not found.")
            if destination["_id"] == source_id:
                raise HTTPException(409, "Choose a different destination event type.")
            target_name = destination["name"]
            aliases = set(destination.get("aliases", [])) | {n.casefold() for n in _names(source)}
            aliases.discard(destination["key"])
            catalog.event_types.update_one({"_id": destination["_id"]}, {
                "$set": {"aliases": sorted(aliases)}, "$inc": {"usage_revision": 1},
            }, session=session)
        else:
            target_name = catalog.clean_event_type_name(name)
            if target_name.casefold() == "uncategorized":
                raise HTTPException(409, "Uncategorized is reserved. Choose another event type name.")
            existing = catalog.find_event_type(target_name, session=session)
            if existing and existing["_id"] != source_id:
                raise HTTPException(409, "An event type with that name already exists.")
            aliases = {n.casefold() for n in _names(source)}
            aliases.discard(target_name.casefold())
            catalog.event_types.update_one({"_id": source_id}, {
                "$set": {"name": target_name, "key": target_name.casefold(),
                         "aliases": sorted(aliases), "updated_at": utc_now()},
                "$inc": {"usage_revision": 1},
            }, session=session)

        # Touch source as well as destination: concurrent event saves lock this row.
        if delete:
            catalog.event_types.update_one({"_id": source_id}, {"$inc": {"usage_revision": 1}}, session=session)
        query = _references(source)
        moved = 0
        for collection in (events, managed_events):
            result = collection.update_many(query, {"$set": {"event_type": target_name}}, session=session)
            moved += result.matched_count
            remaining = {"$and": [query, {"event_type": {"$ne": target_name}}]}
            if collection.count_documents(remaining, session=session):
                raise HTTPException(409, "Not all events could be moved. No changes were saved.")
        if delete:
            result = catalog.event_types.delete_one({"_id": source_id}, session=session)
            if result.deleted_count != 1:
                raise HTTPException(409, "Event type changed. No changes were saved.")
        return {"success": True, "event_type": target_name, "previous_names": _names(source),
                "events_moved": moved}

    try:
        # Validate access before starting a transaction, including on standalone MongoDB.
        _owned(type_id, user)
        with catalog.event_types.database.client.start_session() as session:
            result = session.with_transaction(migrate)
    except DuplicateKeyError as error:
        raise HTTPException(409, "Event types changed or that name already exists. Please reload.") from error
    except PyMongoError as error:
        if catalog.transactions_unavailable(error):
            detail = ("No changes were saved. Event type management requires a MongoDB replica set "
                      "or sharded deployment with transaction support.")
        else:
            detail = "Could not complete the event type change. Please reload to check its current state and try again."
        raise HTTPException(503, detail) from error
    result["event_types"] = catalog.list_event_type_names()
    return result
