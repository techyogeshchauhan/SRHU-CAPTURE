"""Make previews for photos uploaded before photos had them.

New photos get a small WebP preview when they are uploaded
(app/services/media_previews.py), which the grids and covers show instead of
the multi-megabyte original. This gives photos already in storage the same,
for teacher events and Event Manager events alike. Originals are never
changed; a photo whose preview cannot be made keeps showing its original.

Run from the backend directory. A dry run by default; --apply writes:
    python scripts/create_media_previews.py
    python scripts/create_media_previews.py --apply
    python scripts/create_media_previews.py --apply --limit 200

Idempotent: a photo that has a preview is skipped, so it can be re-run (or
stopped and resumed) safely. Safe beside a running server: a preview is only
recorded on a photo that still has none, and one made for a photo deleted
meanwhile is removed again. It prints the database and storage it will write
to before doing anything -- check them on the dry run.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings  # noqa: E402
from app.database import _MONGODB_DB_NAME, event_media, managed_event_media  # noqa: E402
from app.services.media_previews import attach_preview  # noqa: E402

WITHOUT_PREVIEW = {"media_type": "image", "preview": None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="Make and store the previews (default: dry run)")
    parser.add_argument("--limit", type=int, default=0, help="Stop after this many photos (default: all)")
    args = parser.parse_args()

    print(f"Database: {_MONGODB_DB_NAME}")
    print(f"Storage:  {'R2 bucket ' + str(settings.r2_bucket_name) if settings.r2_configured else 'GridFS (MongoDB)'}")
    if not settings.media_previews_enabled:
        print("MEDIA_PREVIEWS_ENABLED is false here, so no preview can be made. Nothing was done.")
        return 1
    made = failed = seen = 0
    for name, collection in (("teacher events", event_media), ("Event Manager events", managed_event_media)):
        waiting = collection.count_documents(WITHOUT_PREVIEW)
        print(f"{name}: {waiting} photo(s) without a preview")
        if not args.apply:
            continue
        # The ids first, then one photo at a time: no cursor is held open
        # across a long run (a server would time it out).
        ids = [row["_id"] for row in collection.find(WITHOUT_PREVIEW, {"_id": 1}).sort("_id", 1)]
        for record_id in ids:
            if args.limit and seen >= args.limit:
                break
            record = collection.find_one({"_id": record_id, **WITHOUT_PREVIEW})
            if record is None:
                continue  # deleted, or given a preview, since the ids were read
            seen += 1
            preview = attach_preview(
                collection, record, event_id=str(record.get("event_id") or ""), owner_id="preview-backfill"
            )
            if preview:
                made += 1
                print(f"  made     {record['_id']}  {record.get('file_name')}  ({preview['file_size'] // 1024} KB)")
            else:
                failed += 1
                print(f"  skipped  {record['_id']}  {record.get('file_name')}  (no preview made, see the log; it keeps its original)")

    if args.apply:
        print(f"\nMade {made} preview(s); {failed} photo(s) keep their original.")
    else:
        print("\nDry run only. Re-run with --apply to make the previews.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
