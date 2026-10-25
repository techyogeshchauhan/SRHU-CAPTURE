"""Prepare the R2 bucket for direct browser uploads.

Two bucket settings, merged into whatever the bucket already has:

* a **CORS rule** letting the frontend origins PUT upload parts straight to
  R2 (FRONTEND_URL and CORS_ORIGINS, plus any --origin given here). Signed
  GET links (photos, video playback, downloads) need no CORS and are not
  touched.
* a **lifecycle rule** aborting multipart uploads under ``events/`` that were
  never completed -- the backstop behind the API's own session sweep.

Prints the current and proposed configuration and changes nothing unless
--apply is given. Run from the backend directory:

    python scripts/configure_r2.py                  # show what would change
    python scripts/configure_r2.py --apply
    python scripts/configure_r2.py --apply --origin https://preview.example.app

CORS_ORIGIN_REGEX cannot be expressed in a bucket rule; pass such origins
with --origin (R2 accepts one ``*`` wildcard, e.g. https://*.campus.example.edu).
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from botocore.exceptions import ClientError  # noqa: E402

from app.config import settings  # noqa: E402
from app.services.r2_service import _client  # noqa: E402


LIFECYCLE_RULE_ID = "campus-capture-abort-incomplete-uploads"


def upload_cors_rule(origins: list[str]) -> dict:
    return {
        "AllowedOrigins": origins,
        # Parts are PUT with no custom headers; Content-Type is allowed in
        # case a browser labels the body anyway.
        "AllowedMethods": ["PUT"],
        "AllowedHeaders": ["content-type"],
        "ExposeHeaders": ["ETag"],
        "MaxAgeSeconds": 3600,
    }


def abort_lifecycle_rule() -> dict:
    # Never shorter than an upload session may legitimately last.
    days = max(1, math.ceil(settings.r2_upload_session_ttl_minutes / (24 * 60)) + 1)
    return {
        "ID": LIFECYCLE_RULE_ID,
        "Status": "Enabled",
        "Filter": {"Prefix": "events/"},
        "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": days},
    }


def current_cors(client, bucket: str) -> list[dict]:
    try:
        return client.get_bucket_cors(Bucket=bucket).get("CORSRules", [])
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in ("NoSuchCORSConfiguration", "404"):
            return []
        raise


def current_lifecycle(client, bucket: str) -> list[dict]:
    try:
        return client.get_bucket_lifecycle_configuration(Bucket=bucket).get("Rules", [])
    except ClientError as error:
        if error.response.get("Error", {}).get("Code") in ("NoSuchLifecycleConfiguration", "404"):
            return []
        raise


def merged_cors(existing: list[dict], ours: dict) -> list[dict]:
    """Existing rules plus ours. A PUT-only rule is taken to be an earlier
    version of ours and replaced, so re-running with new origins updates it."""
    kept = [rule for rule in existing if sorted(rule.get("AllowedMethods", [])) != ["PUT"]]
    return [*kept, ours]


def merged_lifecycle(existing: list[dict], ours: dict) -> list[dict]:
    return [*(rule for rule in existing if rule.get("ID") != LIFECYCLE_RULE_ID), ours]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="write the configuration (default: dry run)")
    parser.add_argument("--origin", action="append", default=[], help="an extra allowed origin (repeatable)")
    args = parser.parse_args()

    if not settings.r2_configured:
        print("R2 is not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).")
        return 1

    origins = list(dict.fromkeys([*settings.allowed_cors_origins, *(o.rstrip("/") for o in args.origin)]))
    bucket = settings.r2_bucket_name
    client = _client()

    cors_before = current_cors(client, bucket)
    cors_after = merged_cors(cors_before, upload_cors_rule(origins))
    lifecycle_before = current_lifecycle(client, bucket)
    lifecycle_after = merged_lifecycle(lifecycle_before, abort_lifecycle_rule())

    print(f"Bucket: {bucket}")
    print("CORS now:      ", json.dumps(cors_before, indent=2))
    print("CORS proposed: ", json.dumps(cors_after, indent=2))
    print("Lifecycle now:      ", json.dumps(lifecycle_before, indent=2, default=str))
    print("Lifecycle proposed: ", json.dumps(lifecycle_after, indent=2, default=str))
    if settings.cors_origin_regex:
        print(f"Note: CORS_ORIGIN_REGEX ({settings.cors_origin_regex}) is not copied; use --origin.")

    if not args.apply:
        print("Dry run: nothing changed. Re-run with --apply to write it.")
        return 0

    client.put_bucket_cors(Bucket=bucket, CORSConfiguration={"CORSRules": cors_after})
    client.put_bucket_lifecycle_configuration(
        Bucket=bucket, LifecycleConfiguration={"Rules": lifecycle_after}
    )
    print("Applied.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
