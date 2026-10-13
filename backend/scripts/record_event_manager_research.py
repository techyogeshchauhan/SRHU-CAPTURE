"""Record research the Event Manager submitted before submissions were recorded directly.

What the Event Manager submits is accepted at once, without the Dean's
verification (routers/research.py). Submissions made before that change were
queued for the Dean; the backend now records them by itself at startup
(main.lifespan -> record_waiting_manager_submissions). This script does the
same on demand, e.g. to preview what a startup would change. A teacher's own
submissions are never touched.

Run from the backend directory. A dry run by default; --apply writes:
    python scripts/record_event_manager_research.py
    python scripts/record_event_manager_research.py --apply

Idempotent: a second run finds nothing left to record.
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.routers.research import latest_submission, record_waiting_manager_submissions  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--apply", action="store_true", help="Write the changes (default: dry run)")
    args = parser.parse_args()

    found = record_waiting_manager_submissions(apply=args.apply)
    for record in found:
        who = (latest_submission(record) or {}).get("actor_name")
        print(f"{'RECORDED' if args.apply else 'WOULD RECORD'}  {record['_id']}  {record.get('title')!r}  (submitted by {who})")

    verb = "Recorded" if args.apply else "Would record"
    print(f"\n{verb} {len(found)} Event Manager submission(s).")
    if found and not args.apply:
        print("Dry run only. Re-run with --apply to write these changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
