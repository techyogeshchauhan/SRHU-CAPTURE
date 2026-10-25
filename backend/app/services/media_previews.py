"""Small previews of uploaded photos, for the grids and covers.

A phone photo is 3-10 MB; a grid tile shows it a few hundred pixels wide.
Every photo therefore gets a preview -- at most PREVIEW_EDGE pixels on its
long side, WebP -- stored beside the original (R2 or GridFS, as the original)
and recorded on the media document as ``preview``. Lists hand it out as
``preview_url``; the original stays the ``media_url`` for full view and
download.

A preview is a convenience, never a requirement: if one cannot be made
(an unreadable or legacy HEIC file, storage down) the photo simply has none
and the frontend shows the original. Nothing here raises into an upload.
"""

from __future__ import annotations

import logging
import shutil
from io import BytesIO
from tempfile import SpooledTemporaryFile

from fastapi import Request
from PIL import Image, ImageOps, UnidentifiedImageError

from app.config import settings
from app.services import r2_service
from app.services.storage_service import absolutize, delete_stored, fs, save_upload

logger = logging.getLogger(__name__)

PREVIEW_EDGE = 640
PREVIEW_QUALITY = 72
PREVIEW_TYPE = "image/webp"
# A photo is at most 20 MB; anything this many pixels is not one.
MAX_SOURCE_PIXELS = 80_000_000


def build_preview(source) -> bytes | None:
    """WebP bytes of a downscaled copy, or None if the image cannot be read.

    ``source``: the original's bytes or a file object (it is rewound first).
    """
    try:
        if hasattr(source, "seek"):
            source.seek(0)
        stream = source if hasattr(source, "read") else BytesIO(source)
        with Image.open(stream) as image:
            if image.width * image.height > MAX_SOURCE_PIXELS:
                return None
            # A JPEG can be decoded at a fraction of its size: far quicker.
            image.draft("RGB", (PREVIEW_EDGE * 2, PREVIEW_EDGE * 2))
            image = ImageOps.exif_transpose(image)
            image.thumbnail((PREVIEW_EDGE, PREVIEW_EDGE))
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "transparency" in image.info or image.mode in ("LA", "P") else "RGB")
            out = BytesIO()
            image.save(out, format="WEBP", quality=PREVIEW_QUALITY, method=4)
            return out.getvalue()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return None
    except Exception:
        logger.exception("preview_build_failed")
        return None


def _read_original(record: dict):
    """The original's bytes as a spooled file, from R2 or GridFS, or None."""
    try:
        buffer = SpooledTemporaryFile(max_size=2 * 1024 * 1024)
        if record.get("object_key"):
            if not r2_service.download_to(record["object_key"], buffer):
                buffer.close()
                return None
        elif record.get("file_id"):
            from bson import ObjectId

            shutil.copyfileobj(fs.get(ObjectId(str(record["file_id"]))), buffer)
        else:
            buffer.close()
            return None
        buffer.seek(0)
        return buffer
    except Exception:
        logger.exception("preview_source_unreadable record=%s", record.get("_id"))
        return None


def attach_preview(collection, record: dict, *, event_id: str, owner_id: str, data: bytes | None = None) -> dict | None:
    """Store and record a preview for one photo record.

    ``data`` is the preview when the caller built it from the original it
    still held (a posted upload, see build_preview); without it the original
    is read back from storage (a direct upload, or the backfill). Returns the
    stored preview, or None. Never raises.
    """
    if not settings.media_previews_enabled:
        return None
    if record.get("media_type") != "image" or record.get("preview"):
        return None
    if data is None:
        source = _read_original(record)
        if source is None:
            return None
        try:
            data = build_preview(source)
        finally:
            source.close()
    if not data:
        return None

    stem = (record.get("file_name") or "photo").rsplit(".", 1)[0]
    try:
        stored = save_upload(
            data,
            file_name=f"{stem}-preview.webp",
            content_type=PREVIEW_TYPE,
            kind="preview",
            event_id=event_id,
            teacher_id=owner_id,
        )
    except Exception:
        logger.exception("preview_store_failed record=%s", record.get("_id"))
        return None

    preview = {**stored, "file_name": f"{stem}-preview.webp", "content_type": PREVIEW_TYPE, "file_size": len(data)}
    try:
        result = collection.update_one({"_id": record["_id"], "preview": None}, {"$set": {"preview": preview}})
    except Exception:
        logger.exception("preview_record_failed record=%s", record.get("_id"))
        delete_stored(preview)
        return None
    if not result.matched_count:
        # The photo was deleted meanwhile, or another preview won the race.
        delete_stored(preview)
        return None
    record["preview"] = preview
    return preview


def present_media(request: Request, item: dict | None) -> dict | None:
    """A media record for a client: signed ``media_url``, and ``preview_url``
    when it has a preview (the stored preview fields themselves are dropped)."""
    if item is None:
        return None
    preview = item.pop("preview", None)
    absolutize(request, item, "media_url")
    if isinstance(preview, dict) and (preview.get("object_key") or preview.get("file_id")):
        signed = absolutize(request, {**preview, "preview_url": preview.get("url")}, "preview_url") or {}
        item["preview_url"] = signed.get("preview_url")
    return item
