"""Bounded dashboard reads; full-list and grouped-list contracts stay intact."""
from app.services.event_fields import many_with_legacy_metadata
from app.utils.serializers import serialize_many

RECENT_EVENTS = 6


def dashboard_events(collection, scope: dict) -> dict:
    # A single aggregation reads counts and the recent window from the same
    # scope. Legacy ISO timestamps and BSON dates share the browser's ordering.
    result = next(iter(collection.aggregate([
        {"$match": scope},
        {"$facet": {
            "counts": [{"$group": {"_id": "$status", "count": {"$sum": 1}}}],
            "recent": [
                {"$addFields": {"_recent_at": {"$ifNull": [
                    {"$convert": {"input": "$updated_at", "to": "date", "onError": None, "onNull": None}},
                    {"$convert": {"input": "$created_at", "to": "date", "onError": None, "onNull": None}},
                ]}}},
                {"$sort": {"_recent_at": -1, "created_at": -1, "_id": -1}},
                {"$limit": RECENT_EVENTS},
                {"$project": {"_recent_at": 0}},
            ],
        }},
    ])), {})
    counts = {row["_id"]: row["count"] for row in result.get("counts", [])}
    total = sum(counts.values())
    recent = many_with_legacy_metadata(serialize_many(result.get("recent", [])))
    return {
        "success": True, "events": recent, "total": total, "count": len(recent),
        "has_more": len(recent) < total, "skip": 0, "limit": RECENT_EVENTS,
        "dashboard": {
            "all": total, "draft": counts.get("draft", 0),
            "pending": sum(counts.get(key, 0) for key in ("pending", "submitted", "under_review")),
            "approved": sum(counts.get(key, 0) for key in ("approved", "in_progress", "completed", "published")),
            "rejected": sum(counts.get(key, 0) for key in ("rejected", "revoked")),
            "recorded": counts.get("recorded", 0),
        },
    }
