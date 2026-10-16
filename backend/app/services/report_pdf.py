"""The building blocks of the event report PDF: the SRHU letterhead (the same
crest the Landing page shows), styles, key-value tables, the verbatim
description box, the Dean's signature block and the page-count footer.

The report itself -- for the Dean and for the Event Manager alike -- is laid
out by app/services/managed_report_pdf.py from these pieces, so both share
one design.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas as pdf_canvas
from reportlab.platypus import (
    FrameBG,
    Image,
    KeepTogether,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from app.config import settings


logger = logging.getLogger(__name__)

ASSETS = Path(__file__).resolve().parent.parent / "assets"
LOGO_PATH = ASSETS / "srhu-logo.png"


# ============================================================
# DEVANAGARI
#
# The report is set in Helvetica, a Latin-1 Type 1 font. Hindi text in an
# event name, venue or description was not dropped loudly -- ReportLab
# rendered every Devanagari letter as a black box, so an official record of a
# Hindi-named event went out with its name unreadable and nothing failed.
#
# Noto Sans Devanagari carries the Devanagari block but NOT the Latin letters,
# so it cannot simply replace Helvetica. Instead it is registered alongside,
# and `rich()` below wraps only the Devanagari runs in it -- which also keeps
# mixed text such as "Science दिवस 2026" correct in both scripts.
# ============================================================

DEVANAGARI_FONT = "NotoSansDevanagari"
DEVANAGARI_FONT_BOLD = "NotoSansDevanagari-Bold"

# Devanagari, Devanagari Extended and the Vedic Extensions.
_DEVANAGARI = re.compile("[\\u0900-\\u097F\\u1CD0-\\u1CFF\\uA8E0-\\uA8FF]+")


def _register_devanagari() -> bool:
    """Register the bundled Devanagari faces. False when they are not present.

    A missing font file must not break report generation: the report is still
    correct for the Latin-script events that are the overwhelming majority, so
    this degrades to the old behaviour and says so in the log.
    """
    faces = (
        (DEVANAGARI_FONT, ASSETS / "NotoSansDevanagari-Regular.ttf"),
        (DEVANAGARI_FONT_BOLD, ASSETS / "NotoSansDevanagari-Bold.ttf"),
    )
    for name, path in faces:
        if not path.exists():
            logger.warning(
                "devanagari_font_missing path=%s -- Hindi text in reports will "
                "render as boxes",
                path,
            )
            return False
    try:
        for name, path in faces:
            pdfmetrics.registerFont(TTFont(name, str(path)))
        pdfmetrics.registerFontFamily(
            DEVANAGARI_FONT, normal=DEVANAGARI_FONT, bold=DEVANAGARI_FONT_BOLD
        )
    except Exception:  # pragma: no cover - depends on the font file
        logger.exception("devanagari_font_registration_failed")
        return False
    return True


_DEVANAGARI_READY = _register_devanagari()


def rich(value, *, bold: bool = False) -> str:
    """XML-escape text for a Paragraph, in a font that can render it.

    Latin stays in the paragraph's own font; each Devanagari run is wrapped in
    the Noto face. Use this anywhere the value comes from a teacher -- an event
    name, venue, organiser, person's name or description.
    """
    text = "" if value is None else str(value)
    if not _DEVANAGARI_READY or not _DEVANAGARI.search(text):
        return escape(text)

    face = DEVANAGARI_FONT_BOLD if bold else DEVANAGARI_FONT
    out: list[str] = []
    position = 0
    for match in _DEVANAGARI.finditer(text):
        out.append(escape(text[position:match.start()]))
        out.append(f'<font name="{face}">{escape(match.group())}</font>')
        position = match.end()
    out.append(escape(text[position:]))
    return "".join(out)


# The crest's own blue, so the letterhead and the logo read as one mark.
NAVY = colors.HexColor("#1D3F7A")
INK = colors.HexColor("#0F172A")
MUTED = colors.HexColor("#5B6475")
RULE = colors.HexColor("#CBD2DE")
LABEL_FILL = colors.HexColor("#F1F4F9")
GOLD = colors.HexColor("#C8962E")

PAGE_WIDTH, PAGE_HEIGHT = A4
MARGIN = 18 * mm
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN

# The event form tucks extra fields into the description behind this marker
# (see frontend/src/utils/draftStorage.js). It is not part of what the teacher
# wrote, so it is split off before the description is printed.
METADATA_PATTERN = re.compile(r"\s*<!--CC_METADATA:([\s\S]*?)-->")

REPORT_HOST_DEPARTMENT = "Computer Science and Engineering, School of Science and Technology"


def report_department(value: str | None = None) -> str:
    """Expand the legacy host abbreviation only when displaying a report."""
    department = str(value or "").strip() or settings.default_host_department.strip()
    return REPORT_HOST_DEPARTMENT if not department or department.casefold() == "sst" else department


def metadata_value(meta: dict, key: str) -> str:
    """A report metadata field, using the host's full name for its department."""
    value = str(meta.get(key) or "").strip()
    if key == "department":
        return report_department(value)
    return value


# ============================================================
# TEXT HELPERS
# ============================================================

def split_description(raw: str | None) -> tuple[str, dict]:
    """Return the teacher's own text and the form's hidden metadata."""
    raw = raw or ""
    meta: dict = {}
    match = METADATA_PATTERN.search(raw)
    if match:
        try:
            parsed = json.loads(match.group(1))
            if isinstance(parsed, dict):
                meta = _clean_metadata(parsed)
        except (ValueError, RecursionError):
            pass
    return METADATA_PATTERN.sub("", raw).strip(), meta


def _clean_metadata(parsed: dict) -> dict[str, str]:
    """Keep only scalar metadata values, as strings.

    The metadata is teacher-controlled JSON, so a value may be a number
    (``{"startTime": 930}``), a list or null. Numbers become strings;
    anything that is not a plain scalar is ignored.
    """
    cleaned: dict[str, str] = {}
    for key, value in parsed.items():
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, (str, int, float)):
            cleaned[str(key)] = str(value)
    return cleaned


def verbatim_markup(text: str) -> str:
    """Paragraph markup that keeps the text exactly as typed.

    A plain Paragraph collapses runs of spaces and drops line breaks; this
    escapes the text and pins both down, so only the line wrapping differs
    from what the teacher entered.
    """
    lines = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        # rich() rather than escape(): a description written in Hindi has to
        # come out in Hindi, not as a column of black boxes.
        line = rich(line.replace("\t", "    "))
        # Keep every space after the first in a run, and any leading indent.
        line = re.sub(r"(?<= ) ", "&nbsp;", line)
        line = re.sub(r"^ ", "&nbsp;", line)
        lines.append(line)
    return "<br/>".join(lines)


def format_date(value) -> str:
    """'2026-10-15' or an ISO timestamp -> '15 October 2026'."""
    if not value:
        return ""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return str(value)
    return f"{parsed.day} {parsed:%B %Y}"


def format_date_range(start, end) -> str:
    """One day as '15 October 2026', several as '15 - 17 October 2026'.

    The month and year are printed once when both ends share them, which is
    the common case for a two- or three-day event.
    """
    first = format_date(start)
    if not end or str(end).strip() == str(start).strip():
        return first

    last = format_date(end)
    if not first:
        return last
    if not last:
        return first

    # "15 October 2026" -> ("15", "October 2026")
    first_day, _, first_rest = first.partition(" ")
    last_day, _, last_rest = last.partition(" ")
    if first_rest and first_rest == last_rest:
        return f"{first_day} - {last_day} {last_rest}"

    return f"{first} - {last}"


def format_time_range(start, end) -> str:
    def to_12h(value: str) -> str:
        try:
            return datetime.strptime(value, "%H:%M").strftime("%I:%M %p").lstrip("0")
        except ValueError:
            return value

    def text(value) -> str:
        return "" if value is None else str(value).strip()

    start, end = text(start), text(end)
    if start and end:
        return f"{to_12h(start)} to {to_12h(end)}"
    return to_12h(start or end)


def approval_record(event: dict) -> tuple[str, str]:
    """(approved by, approved on) from the event's audit trail."""
    approvals = [
        entry for entry in (event.get("history") or [])
        if entry.get("action") == "approved"
    ]
    if approvals:
        latest = approvals[-1]
        return latest.get("actor_name") or "Dean", format_date(latest.get("created_at"))
    return "Dean", format_date(event.get("reviewed_at"))


def report_reference(event: dict) -> str:
    return f"CC/ER/{(event.get('id') or '')[-6:].upper() or 'NA'}"


# ============================================================
# STYLES
# ============================================================

def _styles() -> dict[str, ParagraphStyle]:
    base = dict(fontName="Helvetica", textColor=INK)
    return {
        "university": ParagraphStyle(
            "University", fontName="Helvetica-Bold", fontSize=15, leading=18, textColor=NAVY
        ),
        "school": ParagraphStyle(
            "School", fontName="Helvetica-Bold", fontSize=10.5, leading=13, textColor=NAVY
        ),
        "product": ParagraphStyle(
            "Product", fontName="Helvetica", fontSize=10, leading=13, textColor=MUTED
        ),
        "title": ParagraphStyle(
            "Title", fontName="Helvetica-Bold", fontSize=16, leading=20,
            alignment=TA_CENTER, textColor=NAVY,
        ),
        "reference": ParagraphStyle(
            "Reference", fontSize=8.5, leading=11, alignment=TA_CENTER, textColor=MUTED,
            fontName="Helvetica",
        ),
        "section": ParagraphStyle(
            "Section", fontName="Helvetica-Bold", fontSize=10.5, leading=13,
            textColor=NAVY, spaceBefore=12, spaceAfter=5,
            keepWithNext=1,  # never strand a heading at the foot of a page
        ),
        "label": ParagraphStyle(
            "Label", fontName="Helvetica-Bold", fontSize=9, leading=12, textColor=MUTED
        ),
        "value": ParagraphStyle("Value", fontSize=9.5, leading=13, **base),
        "body": ParagraphStyle("Body", fontSize=10, leading=15, **base),
        "sign_label": ParagraphStyle(
            "SignLabel", fontName="Helvetica-Bold", fontSize=10, leading=14, textColor=INK
        ),
        "sign_value": ParagraphStyle("SignValue", fontSize=10, leading=14, **base),
    }


# ============================================================
# BLOCKS
# ============================================================

def _logo(height: float) -> Image:
    """The Landing page crest, flattened onto white.

    The PNG is palette-based with a transparent background, which some PDF
    viewers render black; flattening avoids that without altering the mark.
    """
    source = PILImage.open(LOGO_PATH).convert("RGBA")
    flat = PILImage.new("RGB", source.size, "white")
    flat.paste(source, mask=source.getchannel("A"))
    buffer = BytesIO()
    flat.save(buffer, format="PNG")
    buffer.seek(0)
    width = height * source.width / source.height
    return Image(buffer, width=width, height=height)


# The school issuing the report, printed under the university name on the
# letterhead. Overridable per deployment so another school can use the same
# build without a code change.
REPORT_SCHOOL = settings.report_school
REPORT_UNIVERSITY = "Swami Rama Himalayan University"


def _letterhead(styles) -> list:
    text = [
        Paragraph(REPORT_UNIVERSITY, styles["university"]),
        Spacer(1, 1),
        Paragraph(REPORT_SCHOOL, styles["school"]),
    ]
    logo = _logo(20 * mm)
    table = Table(
        [[logo, text]],
        colWidths=[logo.drawWidth + 6 * mm, CONTENT_WIDTH - logo.drawWidth - 6 * mm],
    )
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))

    rules = Table([[""]], colWidths=[CONTENT_WIDTH], rowHeights=[2.2])
    rules.setStyle(TableStyle([
        ("LINEABOVE", (0, 0), (-1, 0), 1.6, NAVY),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, GOLD),
    ]))
    return [table, Spacer(1, 4 * mm), rules]


def _key_value_table(rows, styles) -> Table:
    data = [
        [Paragraph(rich(label), styles["label"]), Paragraph(value, styles["value"])]
        for label, value in rows
    ]
    table = Table(data, colWidths=[48 * mm, CONTENT_WIDTH - 48 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), LABEL_FILL),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _boxed_text(text: str, style: ParagraphStyle) -> list:
    """The description in a ruled box that can run over as many pages as it
    needs.

    The text is plain Paragraph flowables (one per line of the teacher's
    text), which ReportLab splits across pages natively; the box is drawn by
    a FrameBG pair, which follows the flow onto every page. A table cell
    cannot do this: a one-cell table holding a long description raised
    LayoutError, and splitInRow tables can loop on long rows.
    """
    boxed_style = ParagraphStyle(
        f"{style.name}Boxed", parent=style, leftIndent=10, rightIndent=10
    )
    if text:
        lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        paragraphs = [Paragraph(verbatim_markup(line) or "&nbsp;", boxed_style) for line in lines]
    else:
        paragraphs = [Paragraph("<i>No description provided.</i>", boxed_style)]

    return [
        FrameBG(color=colors.white, strokeColor=RULE, strokeWidth=0.6, start=True),
        Spacer(1, 8),
        *paragraphs,
        Spacer(1, 9),
        FrameBG(start=False),
    ]


def _signature_block(styles) -> KeepTogether:
    line = "_" * 34
    # The signatory's full designation, one line each.
    signatory = "<br/>".join(
        escape(part) for part in ("Dean", REPORT_SCHOOL, REPORT_UNIVERSITY)
    )
    rows = [
        ("Signature:", line),
        ("Date:", line),
        ("Signed by:", signatory),
    ]
    data = [
        [Paragraph(label, styles["sign_label"]), Paragraph(value, styles["sign_value"])]
        for label, value in rows
    ]
    table = Table(data, colWidths=[26 * mm, 80 * mm], hAlign="RIGHT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
        # "Signed by:" lines up with the first line of the designation.
        ("VALIGN", (0, -1), (-1, -1), "TOP"),
    ]))
    # No heading of its own: a right-aligned block at the foot of the record
    # already reads as the sign-off, and the space keeps typical reports on
    # a single page.
    return KeepTogether([Spacer(1, 8 * mm), table])


# ============================================================
# PAGE FURNITURE
# ============================================================

class _NumberedCanvas(pdf_canvas.Canvas):
    """Draws the footer once the total page count is known."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._pages = []

    def showPage(self):
        self._pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        total = len(self._pages)
        for state in self._pages:
            self.__dict__.update(state)
            self._draw_footer(total)
            super().showPage()
        super().save()

    def _draw_footer(self, total: int) -> None:
        y = 11 * mm
        self.setStrokeColor(RULE)
        self.setLineWidth(0.5)
        self.line(MARGIN, y + 4 * mm, PAGE_WIDTH - MARGIN, y + 4 * mm)
        self.setFont("Helvetica", 7.5)
        self.setFillColor(MUTED)
        self.drawString(
            MARGIN,
            y,
            f"Campus Capture  ·  {REPORT_SCHOOL}  ·  Official event record",
        )
        self.drawRightString(PAGE_WIDTH - MARGIN, y, f"Page {self._pageNumber} of {total}")
