"""Event photos are stored as WebP (app/services/photo_webp.py)."""

from __future__ import annotations

import os
import unittest
from io import BytesIO

from fastapi import HTTPException
from PIL import Image

os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from app.services import photo_webp  # noqa: E402


def encode(image: Image.Image, fmt: str, **options) -> BytesIO:
    buffer = BytesIO()
    image.save(buffer, fmt, **options)
    buffer.seek(0)
    return buffer


def photo_like(size=(640, 480)) -> Image.Image:
    """Smooth gradients, as a photograph has -- where WebP saves most."""
    image = Image.new("RGB", size)
    image.putdata([((x * 255) // size[0], (y * 255) // size[1], (x + y) % 256) for y in range(size[1]) for x in range(size[0])])
    return image


def decoded(buffer) -> Image.Image:
    buffer.seek(0)
    image = Image.open(buffer)
    image.load()
    return image


class ConvertTests(unittest.TestCase):
    def test_a_jpeg_becomes_a_smaller_webp(self) -> None:
        source = encode(photo_like(), "JPEG", quality=95)
        original = len(source.getvalue())
        output, size = photo_webp.convert_to_webp(source)
        image = decoded(output)
        self.assertEqual((image.format, image.size), ("WEBP", (640, 480)))
        self.assertLess(size, original)

    def test_a_png_keeps_its_transparency(self) -> None:
        source = encode(Image.new("RGBA", (40, 30), (10, 120, 200, 90)), "PNG")
        output, _ = photo_webp.convert_to_webp(source)
        image = decoded(output)
        self.assertEqual(image.format, "WEBP")
        self.assertEqual(image.mode, "RGBA")
        self.assertEqual(image.getpixel((5, 5))[3], 90)

    def test_an_animated_gif_stays_animated(self) -> None:
        frames = [Image.new("RGB", (20, 20), color) for color in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
        source = BytesIO()
        frames[0].save(source, "GIF", save_all=True, append_images=frames[1:], duration=120, loop=0)
        source.seek(0)
        output, _ = photo_webp.convert_to_webp(source)
        image = decoded(output)
        self.assertEqual(image.format, "WEBP")
        self.assertEqual(getattr(image, "n_frames", 1), 3)

    def test_the_camera_orientation_is_applied_and_metadata_dropped(self) -> None:
        exif = Image.Exif()
        exif[0x0112] = 6        # rotate 90 degrees clockwise to display
        exif[0x8825] = {1: "N"}  # a GPS block that must not be kept
        source = encode(Image.new("RGB", (60, 20), (90, 90, 90)), "JPEG", exif=exif.tobytes())
        output, _ = photo_webp.convert_to_webp(source)
        image = decoded(output)
        self.assertEqual(image.size, (20, 60))   # upright now
        self.assertFalse(image.getexif())        # no EXIF (and so no GPS) carried over

    def test_an_unreadable_file_is_refused(self) -> None:
        with self.assertRaises(HTTPException) as refused:
            photo_webp.convert_to_webp(BytesIO(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64))
        self.assertEqual(refused.exception.status_code, 400)

    def test_an_absurd_pixel_count_is_refused(self) -> None:
        source = encode(Image.new("L", (100, 100)), "PNG")
        original = photo_webp.MAX_PIXELS
        photo_webp.MAX_PIXELS = 5_000
        try:
            with self.assertRaises(HTTPException):
                photo_webp.convert_to_webp(source)
        finally:
            photo_webp.MAX_PIXELS = original


class UploadHelperTests(unittest.TestCase):
    def test_names_and_passthrough(self) -> None:
        self.assertEqual(photo_webp.webp_name("Stage photo.JPG"), "Stage photo.webp")
        self.assertEqual(photo_webp.webp_name("poster"), "poster.webp")
        self.assertFalse(photo_webp.needs_conversion(".webp"))
        self.assertTrue(photo_webp.needs_conversion(".png"))

        webp = encode(Image.new("RGB", (8, 8)), "WEBP")
        same = photo_webp.photo_as_webp(webp, 10, extension=".webp", file_name="a.webp", content_type="image/webp")
        self.assertIs(same[0], webp)  # stored as it came

        jpeg = encode(photo_like((64, 48)), "JPEG")
        buffer, size, name, content_type = photo_webp.photo_as_webp(
            jpeg, len(jpeg.getvalue()), extension=".jpg", file_name="Stage.jpg", content_type="image/jpeg")
        self.assertEqual((name, content_type), ("Stage.webp", "image/webp"))
        self.assertEqual(size, len(buffer.read()))
        buffer.close()


if __name__ == "__main__":
    unittest.main()
