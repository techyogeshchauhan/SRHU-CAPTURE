"""Event photos are stored as WebP, whatever format they were uploaded in.

WebP is markedly smaller than JPEG or PNG at the same visual quality, so
every gallery, album and event page loads faster. A photo arrives as JPG,
PNG, GIF or WebP (the formats the upload accepts, see
``storage_service.MEDIA_TYPES``) and is re-encoded here before it is stored:

* JPEG / PNG -> WebP at ``QUALITY``; transparency is kept.
* An animated GIF stays animated (animated WebP); a still GIF becomes a
  still WebP.
* A photo that is already WebP is stored as it came -- re-encoding it would
  only lose quality.
* The camera's orientation tag is applied to the pixels first, because the
  tag itself is not carried over; other metadata (EXIF, including any GPS
  position) is dropped. The colour profile is kept.

Both upload paths use it: the proxied one before the bytes are stored, and
the direct-to-R2 one after the browser's upload is verified.
"""

from __future__ import annotations

import logging
import warnings
from tempfile import SpooledTemporaryFile

from fastapi import HTTPException, status
from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

WEBP_EXTENSION = ".webp"
WEBP_CONTENT_TYPE = "image/webp"
# Visually indistinguishable from the original for photos, at a fraction of
# the size; `method` trades a little encoding time for a smaller file.
QUALITY = 82
METHOD = 4
# The converted file is buffered like an upload: in memory while small,
# rolling to disk past this size.
_SPOOL_THRESHOLD = 2 * 1024 * 1024
# Refuse pixel counts far beyond any camera (a decompression bomb): about
# 150 megapixels.
MAX_PIXELS = 150_000_000

UNREADABLE = (
    "This photo could not be read. Please upload a valid JPG, PNG, WebP or GIF image."
)


def needs_conversion(extension: str | None) -> bool:
    """Whether a photo of this extension is re-encoded (WebP is kept as is)."""
    return (extension or "").lower() != WEBP_EXTENSION


def webp_name(file_name: str) -> str:
    """"Stage photo.JPG" -> "Stage photo.webp"."""
    stem, dot, _ = (file_name or "photo").rpartition(".")
    return f"{stem if dot else file_name or 'photo'}{WEBP_EXTENSION}"


def _unreadable() -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=UNREADABLE)


def _prepared(frame: Image.Image) -> Image.Image:
    """A frame in a mode WebP can hold, transparency kept where there is any."""
    if frame.mode in ("RGBA", "LA") or (frame.mode == "P" and "transparency" in frame.info):
        return frame.convert("RGBA")
    if frame.mode != "RGB":
        return frame.convert("RGB")
    return frame


def convert_to_webp(source) -> tuple[SpooledTemporaryFile, int]:
    """Re-encode the image in ``source`` (a rewound file object) as WebP.

    Returns a rewound buffer holding the WebP and its size; the caller closes
    it. Raises 400 when the file cannot be decoded as an image.
    """
    output = SpooledTemporaryFile(max_size=_SPOOL_THRESHOLD)
    try:
        with warnings.catch_warnings():
            # Pillow only warns between its limit and twice it; treat it as
            # the error it is.
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if image.width * image.height > MAX_PIXELS:
                    raise _unreadable()
                icc_profile = image.info.get("icc_profile")
                frames = getattr(image, "n_frames", 1)
                if frames > 1:
                    # Animated GIF -> animated WebP, frame timings and looping kept.
                    image.save(
                        output,
                        format="WEBP",
                        save_all=True,
                        quality=QUALITY,
                        method=METHOD,
                        loop=image.info.get("loop", 0),
                        duration=image.info.get("duration", 100),
                    )
                else:
                    still = _prepared(ImageOps.exif_transpose(image))
                    options = {"format": "WEBP", "quality": QUALITY, "method": METHOD}
                    if icc_profile:
                        options["icc_profile"] = icc_profile
                    still.save(output, **options)
    except HTTPException:
        output.close()
        raise
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        output.close()
        logger.warning("photo_webp_conversion_failed error=%s", error)
        raise _unreadable() from None

    size = output.tell()
    output.seek(0)
    return output, size


def photo_as_webp(buffer, size: int, *, extension: str, file_name: str, content_type: str):
    """The proxied upload path: (buffer, size, file_name, content_type) for
    storing the photo as WebP. A WebP photo is returned untouched; otherwise
    ``buffer`` is closed and a new one with the WebP returned."""
    if not needs_conversion(extension):
        return buffer, size, file_name, content_type
    buffer.seek(0)
    try:
        converted, converted_size = convert_to_webp(buffer)
    finally:
        buffer.close()
    logger.info("photo_converted_to_webp from=%s bytes=%d->%d", extension, size, converted_size)
    return converted, converted_size, webp_name(file_name), WEBP_CONTENT_TYPE
