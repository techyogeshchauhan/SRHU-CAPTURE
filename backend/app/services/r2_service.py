"""Cloudflare R2 object storage (S3-compatible) for event uploads.

Objects are private. Clients get a pre-signed GET URL, which R2 serves with
full HTTP Range support, so browsers can stream and seek videos directly
from R2 without the bytes passing through this API.
"""

from __future__ import annotations

import logging
import uuid
from functools import lru_cache
from urllib.parse import quote

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

from app.config import settings


logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _client():
    return boto3.client(
        "s3",
        endpoint_url=settings.r2_endpoint_url,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key,
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def build_object_key(*, event_id: str, kind: str, file_name: str) -> str:
    """``events/<event>/<media|documents>/<random>-<name>``; the prefix keeps
    one event's files together and the random part avoids collisions."""
    return f"events/{event_id}/{kind}/{uuid.uuid4().hex}-{file_name}"


def upload_bytes(
    data: bytes,
    *,
    object_key: str,
    content_type: str | None,
    metadata: dict[str, str] | None = None,
    content_disposition: str | None = None,
) -> None:
    params = {
        "Bucket": settings.r2_bucket_name,
        "Key": object_key,
        "Body": data,
        "ContentType": content_type or "application/octet-stream",
        "Metadata": {k: str(v) for k, v in (metadata or {}).items()},
    }
    # Stored on the object too, so even a public-bucket URL (which cannot
    # carry response overrides) downloads rather than renders risky types.
    if content_disposition:
        params["ContentDisposition"] = content_disposition
    _client().put_object(**params)


def upload_stream(
    stream,
    *,
    object_key: str,
    content_type: str | None,
    metadata: dict[str, str] | None = None,
    content_disposition: str | None = None,
) -> None:
    """Upload from a file-like object without reading it into memory.

    `upload_fileobj` streams in parts, so a 200 MB video costs a part-sized
    buffer rather than 200 MB of process memory -- which on a small container
    is the difference between working and being OOM-killed.
    """
    extra: dict[str, object] = {
        "ContentType": content_type or "application/octet-stream",
        "Metadata": {k: str(v) for k, v in (metadata or {}).items()},
    }
    if content_disposition:
        extra["ContentDisposition"] = content_disposition

    _client().upload_fileobj(
        stream,
        settings.r2_bucket_name,
        object_key,
        ExtraArgs=extra,
    )


# ======================================================================
# Direct browser uploads (see app.services.direct_upload)
#
# Every direct upload is a multipart upload whose parts the browser PUTs to
# pre-signed URLs. Content-Length is passed when presigning, which makes it a
# signed header: R2 refuses a part whose size differs from what the API
# authorised, and the browser sets the header itself from the body.
# ======================================================================

def create_multipart_upload(
    object_key: str,
    *,
    content_type: str,
    content_disposition: str | None = None,
    metadata: dict[str, str] | None = None,
) -> str:
    """Start a multipart upload; returns its UploadId. The object's type,
    disposition and metadata are fixed here, server side."""
    params: dict[str, object] = {
        "Bucket": settings.r2_bucket_name,
        "Key": object_key,
        "ContentType": content_type,
        "Metadata": {k: str(v) for k, v in (metadata or {}).items()},
    }
    if content_disposition:
        params["ContentDisposition"] = content_disposition
    return _client().create_multipart_upload(**params)["UploadId"]


def presign_upload_part(
    object_key: str,
    *,
    upload_id: str,
    part_number: int,
    content_length: int,
    expires_in: int,
) -> str:
    return _client().generate_presigned_url(
        "upload_part",
        Params={
            "Bucket": settings.r2_bucket_name,
            "Key": object_key,
            "UploadId": upload_id,
            "PartNumber": part_number,
            "ContentLength": content_length,
        },
        ExpiresIn=expires_in,
    )


def list_parts(object_key: str, *, upload_id: str) -> list[dict]:
    """Every part R2 holds for the upload: ``PartNumber``, ``ETag``, ``Size``."""
    parts: list[dict] = []
    marker = 0
    while True:
        response = _client().list_parts(
            Bucket=settings.r2_bucket_name,
            Key=object_key,
            UploadId=upload_id,
            PartNumberMarker=marker,
        )
        parts.extend(response.get("Parts", []))
        if not response.get("IsTruncated"):
            return parts
        marker = response.get("NextPartNumberMarker") or parts[-1]["PartNumber"]


def complete_multipart_upload(object_key: str, *, upload_id: str, parts: list[dict]) -> None:
    _client().complete_multipart_upload(
        Bucket=settings.r2_bucket_name,
        Key=object_key,
        UploadId=upload_id,
        MultipartUpload={
            "Parts": [
                {"PartNumber": part["PartNumber"], "ETag": part["ETag"]}
                for part in sorted(parts, key=lambda p: p["PartNumber"])
            ]
        },
    )


def abort_multipart_upload(object_key: str, *, upload_id: str) -> bool:
    """Abort and free the parts; True when R2 no longer holds the upload."""
    try:
        _client().abort_multipart_upload(
            Bucket=settings.r2_bucket_name, Key=object_key, UploadId=upload_id
        )
        return True
    except ClientError as error:
        if _error_code(error) in ("NoSuchUpload", "404"):
            return True
        logger.exception("Could not abort R2 multipart upload %s", object_key)
        return False
    except BotoCoreError:
        logger.exception("Could not abort R2 multipart upload %s", object_key)
        return False


def head_object(object_key: str) -> dict | None:
    """The object's metadata, or None when it does not exist."""
    try:
        return _client().head_object(Bucket=settings.r2_bucket_name, Key=object_key)
    except ClientError as error:
        if _error_code(error) in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def read_range(object_key: str, *, length: int) -> bytes:
    """The first ``length`` bytes of an object, for the magic-byte check."""
    response = _client().get_object(
        Bucket=settings.r2_bucket_name,
        Key=object_key,
        Range=f"bytes=0-{max(0, length - 1)}",
    )
    with response["Body"] as body:
        return body.read(length)


def _error_code(error: ClientError) -> str:
    return str(error.response.get("Error", {}).get("Code", ""))


def delete_object(object_key: str) -> bool:
    """Delete an object; returns False (and logs) when R2 refused."""
    try:
        _client().delete_object(Bucket=settings.r2_bucket_name, Key=object_key)
        return True
    except (BotoCoreError, ClientError):
        # A leftover object only costs storage; never fail the request for it.
        logger.exception("Could not delete R2 object %s", object_key)
        return False


def object_url(
    object_key: str,
    *,
    file_name: str | None = None,
    content_type: str | None = None,
) -> str:
    """A browser-usable URL for the object: public if a public base URL is
    configured, otherwise pre-signed for ``R2_SIGNED_URL_EXPIRY`` seconds.

    The pre-signed URL pins the response type and disposition: only the
    accepted image, video and PDF types open inline, everything else (and any
    legacy object stored with an unlisted type such as SVG or HTML) is served
    as an ``application/octet-stream`` attachment. R2 cannot add
    ``X-Content-Type-Options`` through a pre-signed URL, which is why the type
    itself is forced instead.
    """
    if settings.r2_public_url:
        return f"{settings.r2_public_url.rstrip('/')}/{quote(object_key)}"

    # Imported here: storage_service imports this module.
    from app.services.storage_service import content_disposition, serving_policy

    served_type, disposition = serving_policy(content_type)
    name = file_name or object_key.rsplit("/", 1)[-1]
    params = {
        "Bucket": settings.r2_bucket_name,
        "Key": object_key,
        "ResponseContentType": served_type,
        "ResponseContentDisposition": content_disposition(disposition, name),
    }

    return _client().generate_presigned_url(
        "get_object",
        Params=params,
        ExpiresIn=settings.r2_signed_url_expiry,
    )
