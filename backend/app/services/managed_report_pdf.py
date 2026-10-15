"""The event report PDF: one event, or several in one document.

Both reports use it -- the Event Manager's and the Dean's -- so they share one
design: the letterhead, styles, footer and sign-off (app/services/report_pdf.py),
and the same sections in the same order. The only differences are what each
workflow has: the Dean's report says who submitted the event and closes with
its approval (ReportEntry.approval), the Event Manager's says who recorded it
and has no approval anywhere. The material itself is the same --

- every detail entered when the event was recorded,
- the chosen photos, as many as were chosen, each at its original aspect
  ratio (never cropped), in compact blocks of up to four whatever mix of
  portrait and landscape they are (see layout_photos and photo_groups),
- every uploaded file listed with a download link.

The builder only lays out what it is given: the router loads the photo bytes
and signs the download links, so this module never touches storage.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field
from datetime import datetime
from io import BytesIO
from xml.sax.saxutils import escape

from PIL import Image as PILImage
from PIL import ImageOps
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    CondPageBreak,
    Flowable,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.platypus.tableofcontents import TableOfContents

from app.config import settings
from app.services.report_pdf import (
    CONTENT_WIDTH,
    LABEL_FILL,
    MARGIN,
    MUTED,
    NAVY,
    PAGE_WIDTH,
    REPORT_SCHOOL,
    REPORT_UNIVERSITY,
    RULE,
    _boxed_text,
    _key_value_table,
    _letterhead,
    _NumberedCanvas,
    _signature_block,
    _styles,
    format_date,
    format_date_range,
    format_time_range,
    rich,
)

# Photos are re-encoded for the PDF: large enough to print sharply at the
# sizes below, small enough that a report with many events stays light.
PHOTO_MAX_PIXELS = 1600
PHOTO_JPEG_QUALITY = 85
PHOTO_GAP = 5 * mm

# The photo block (see layout_photos). A row is never taller than
# ROW_MAX_HEIGHT and the block never taller than BLOCK_MAX_HEIGHT -- about
# half the page -- so a lone portrait does not fill the page and four photos
# stay a compact section. More photos than PHOTOS_PER_BLOCK make several
# blocks, one under the other (see photo_groups). A photo whose geometric mean side (the square root
# of its area) falls below MIN_PHOTO_SIDE counts as too small to read.
ROW_MAX_HEIGHT = 100 * mm
BLOCK_MAX_HEIGHT = 135 * mm
MIN_PHOTO_SIDE = 40 * mm
PHOTOS_PER_BLOCK = 4

# Layout scoring weights, per point (1/72 inch) unless stated. Tuned over
# every portrait/landscape mix of one to four photos at 3:4, 4:3, 9:16, 16:9
# and 1:1 -- see PhotoLayoutTests.
_W_TOO_SMALL = 10.0     # per point a photo falls below MIN_PHOTO_SIDE
_W_NARROW = 1.0         # per point the block is narrower than the page
_W_UNEVEN = 0.5         # per point between the tallest and shortest row
_W_HEIGHT = 0.1         # per point of block height: prefer compact
_W_LONE_ROW = 25 * mm   # a photo alone on its row, among three or more
_W_MOVED = 3 * mm       # a photo placed away from its chosen position

# How far a row of photos may shrink to use the space left on a page instead
# of moving to the next one and leaving a blank gap behind it.
MIN_PHOTO_SCALE = 0.55

# Space a heading needs below it before it may start on a page, and the space
# a new event needs (divider, title and the start of its details) in a
# consolidated report.
SECTION_ROOM = 28 * mm
EVENT_ROOM = 70 * mm

KIND_LABELS = {"photo": "Photo", "video": "Video", "document": "Document"}


@dataclass
class Attachment:
    name: str
    kind: str            # "photo" | "video" | "document"
    size: int | None
    url: str | None      # absolute, long-lived download link
    category: str = "notice"  # documents: "notice" | "report"; media: "media"


def attachment_for(kind: str, row: dict, name: str, url: str | None) -> Attachment:
    """One upload row as a report attachment; ``kind`` is "media" or "documents"."""
    if kind == "media":
        return Attachment(
            name=name,
            kind="photo" if row.get("media_type") == "image" else "video",
            size=row.get("file_size"),
            url=url,
            category="media",
        )
    return Attachment(
        name=name,
        kind="document",
        size=row.get("file_size"),
        url=url,
        category="report" if row.get("category") == "report" else "notice",
    )


@dataclass
class ReportEntry:
    event: dict
    # The chosen photos, in order, already run through prepare_photo():
    # re-encoded as they are read, so a report over many events never holds
    # the original full-size files in memory.
    photos: list[tuple[BytesIO, int, int]] = field(default_factory=list)
    photo_failures: int = 0     # chosen photos that could not be read
    attachments: list[Attachment] = field(default_factory=list)
    recorded_by: dict = field(default_factory=dict)
    # "Recorded" (Event Manager) or "Submitted" (a teacher's event, in the
    # Dean's report): labels the person row, and the date row when shown.
    recorded_label: str = "Recorded"
    show_recorded_on: bool = True
    # (approved by, approved on) for an approved teacher event; the Dean's
    # report ends its sections with them. None: no approval section at all.
    approval: tuple[str, str] | None = None
    # The reference printed under the title; None uses the Event Manager's.
    reference: str | None = None
    customization: dict | None = None
    # Dean reports omit optional event fields the manager left blank. Other
    # report entry points retain their established placeholder behavior.
    omit_empty_fields: bool = False


# ============================================================
# PHOTOS
# ============================================================

def prepare_photo(data: bytes) -> tuple[BytesIO, int, int] | None:
    """Upright, flattened, re-encoded JPEG bytes and their pixel size.

    ``exif_transpose`` applies the camera's orientation tag, so a phone photo
    taken upright is treated as portrait even though its pixels are stored
    sideways -- that is the photo's *original* orientation as people saw it.
    Returns None for bytes that are not a readable image.
    """
    try:
        with PILImage.open(BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode in ("RGBA", "LA", "P"):
                rgba = image.convert("RGBA")
                flat = PILImage.new("RGB", rgba.size, "white")
                flat.paste(rgba, mask=rgba.getchannel("A"))
                image = flat
            else:
                image = image.convert("RGB")
            image.thumbnail((PHOTO_MAX_PIXELS, PHOTO_MAX_PIXELS))
            out = BytesIO()
            image.save(out, format="JPEG", quality=PHOTO_JPEG_QUALITY, optimize=True)
            out.seek(0)
            return out, image.width, image.height
    except Exception:  # noqa: BLE001 - any unreadable image is simply left out
        return None


def orientation_of(width: int, height: int) -> str:
    return "portrait" if height > width else "landscape"


def fit_within(width: int, height: int, box: tuple[float, float]) -> tuple[float, float]:
    """The largest size inside ``box`` with the photo's own aspect ratio."""
    scale = min(box[0] / width, box[1] / height)
    return width * scale, height * scale


def _partitions(order: tuple[int, ...]):
    """Every way to cut ``order`` into consecutive rows."""
    count = len(order)
    for cuts in itertools.product((False, True), repeat=count - 1):
        rows, current = [], [order[0]]
        for position, cut in enumerate(cuts, start=1):
            if cut:
                rows.append(current)
                current = []
            current.append(order[position])
        rows.append(current)
        yield rows


def _justify(aspects: list[float], rows: list[list[int]]) -> tuple[float, list[float]]:
    """The block width and each row's height when every row fills that width.

    A row of photos with aspect ratios a1..ak, all at one height h, is
    h * sum(a) + gaps wide -- so at a given block width each row's height
    follows directly. The width starts at the page width and narrows only as
    far as needed to keep every row under ROW_MAX_HEIGHT and the block under
    BLOCK_MAX_HEIGHT; every row stays exactly the block's width.
    """
    sums = [sum(aspects[i] for i in row) for row in rows]
    gaps = [PHOTO_GAP * (len(row) - 1) for row in rows]
    width = CONTENT_WIDTH
    for total, gap in zip(sums, gaps):
        width = min(width, ROW_MAX_HEIGHT * total + gap)
    # Block height is linear in the width: sum((width - gap) / total) + row gaps.
    per_width = sum(1 / total for total in sums)
    offset = sum(gap / total for total, gap in zip(sums, gaps)) - PHOTO_GAP * (len(rows) - 1)
    if width * per_width - offset > BLOCK_MAX_HEIGHT:
        width = (BLOCK_MAX_HEIGHT + offset) / per_width
    return width, [(width - gap) / total for total, gap in zip(sums, gaps)]


def _layout_cost(aspects: list[float], rows: list[list[int]], moved: int) -> float:
    width, heights = _justify(aspects, rows)
    smallest = min(
        math.sqrt(aspects[i]) * height for row, height in zip(rows, heights) for i in row
    )
    lone = sum(1 for row in rows if len(row) == 1) if len(aspects) > 2 else 0
    block_height = sum(heights) + PHOTO_GAP * (len(rows) - 1)
    return (
        _W_TOO_SMALL * max(0.0, MIN_PHOTO_SIDE - smallest)
        + _W_NARROW * (CONTENT_WIDTH - width)
        + _W_UNEVEN * (max(heights) - min(heights))
        + _W_HEIGHT * block_height
        + _W_LONE_ROW * lone
        + _W_MOVED * moved
    )


def layout_photos(sizes: list[tuple[int, int]]) -> list[list[tuple[int, float, float]]]:
    """Rows of ``(index, draw_width, draw_height)`` forming one clean block.

    Justified rows: the photos on a row share one height and together span
    the block's width exactly, so there is no blank space between or around
    them and every row lines up at both edges. No photo is cropped or
    distorted -- each keeps its own aspect ratio, portrait or landscape.

    Which photos share a row decides how it looks (two portraits and two
    landscapes read far better as two portrait+landscape rows than as a tall
    portrait row over a thin landscape one), so every split into rows -- and,
    for mixed sets, every order -- is scored and the best kept: photos large
    enough to read, the block as wide as the page, rows of similar height,
    compact overall, no photo alone on its row. Moving a photo from the
    position it was chosen in costs a little, so the chosen order holds unless
    another clearly lays out better. At most 4! x 2^3 = 192 candidates.
    """
    if not sizes:
        return []
    aspects = [width / height for width, height in sizes]
    best: tuple[float, list[list[int]]] | None = None
    for order in itertools.permutations(range(len(aspects))):
        moved = sum(1 for position, index in enumerate(order) if position != index)
        for rows in _partitions(order):
            cost = _layout_cost(aspects, rows, moved)
            if best is None or cost < best[0] - 1e-9:
                best = (cost, rows)
    rows = best[1]
    _, heights = _justify(aspects, rows)
    return [
        [(index, aspects[index] * height, height) for index in row]
        for row, height in zip(rows, heights)
    ]


class _PhotoGrid(Flowable):
    """Every photo of one event, row under row, centred, each framed by a
    hairline and drawn at its own aspect ratio.

    ReportLab measures a KeepTogether group against unlimited height, so an
    image inside one can never shrink: a photo block that did not quite fit
    jumped to the next page and left the rest of the page blank. The grid is
    a single flowable instead -- it is told the space actually left, and
    scales itself down (to MIN_PHOTO_SCALE at most) to fit there. All rows
    scale together, so the photos keep the same size relative to each other;
    one row per flowable let the last row shrink alone. When even that does
    not fit, the grid moves to the next page at full size. The section
    heading, when given, is drawn as part of it so it can never be stranded
    above an empty page foot.
    """

    def __init__(self, rows: list[list[tuple[BytesIO, float, float]]], heading: Paragraph | None = None):
        super().__init__()
        self.rows = rows
        self.heading = heading
        self._scale = 1.0
        self._head_h = 0.0

    def _row_heights(self) -> list[float]:
        return [max(h for _, _, h in row) for row in self.rows]

    def _natural_height(self) -> float:
        heights = self._row_heights()
        return sum(heights) + PHOTO_GAP * (len(heights) - 1)

    def _heading_height(self, width: float) -> float:
        if not self.heading:
            return 0.0
        _, height = self.heading.wrap(width, 10_000)
        style = self.heading.style
        return height + style.spaceBefore + style.spaceAfter

    def wrap(self, avail_width, avail_height):
        self._head_h = self._heading_height(avail_width)
        natural = self._natural_height() + PHOTO_GAP
        room = avail_height - self._head_h
        self._scale = 1.0
        if natural > room and room > 0 and room / natural >= MIN_PHOTO_SCALE:
            self._scale = room / natural
        self.width = avail_width
        self.height = self._head_h + natural * self._scale
        return self.width, self.height

    def split(self, avail_width, avail_height):
        return []  # never cut a photo; the frame moves the grid to a new page

    def draw(self):
        canvas = self.canv
        top = self.height
        if self.heading:
            _, heading_h = self.heading.wrap(self.width, 10_000)
            self.heading.drawOn(canvas, 0, top - self.heading.style.spaceBefore - heading_h)
        scale = self._scale
        row_top = top - self._head_h
        for row, natural_h in zip(self.rows, self._row_heights()):
            row_h = natural_h * scale
            total_w = sum(w * scale for _, w, _ in row) + PHOTO_GAP * (len(row) - 1)
            x = (self.width - total_w) / 2
            base = row_top - row_h
            for buffer, w, h in row:
                w, h = w * scale, h * scale
                y = base + (row_h - h) / 2
                buffer.seek(0)
                canvas.drawImage(ImageReader(buffer), x, y, w, h)
                canvas.setStrokeColor(RULE)
                canvas.setLineWidth(0.6)
                canvas.rect(x, y, w, h)
                x += w + PHOTO_GAP
            row_top = base - PHOTO_GAP


def photo_groups(count: int) -> list[range]:
    """Split ``count`` photos, in order, into blocks of at most
    PHOTOS_PER_BLOCK and as even as possible: 5 is 3 + 2, not 4 + 1, so the
    last block never holds one photo stretched across the page alone.

    layout_photos tries every arrangement of a block, which is only cheap
    while a block stays this small (4! x 2^3 = 192 candidates).
    """
    if count <= 0:
        return []
    blocks = -(-count // PHOTOS_PER_BLOCK)
    size, extra = divmod(count, blocks)
    groups, start = [], 0
    for index in range(blocks):
        end = start + size + (1 if index < extra else 0)
        groups.append(range(start, end))
        start = end
    return groups


def _photo_flowables(entry: "ReportEntry", heading: Paragraph, styles) -> list:
    """The photo section: its heading travels with the first block of photos;
    later blocks follow on, each moving to a new page whole if it must."""
    prepared = entry.photos
    flowables: list = []
    for group in photo_groups(len(prepared)):
        block = [prepared[i] for i in group]
        rows = [
            [(block[i][0], w, h) for i, w, h in row]
            for row in layout_photos([(w, h) for _, w, h in block])
        ]
        if flowables:
            flowables.append(Spacer(1, PHOTO_GAP))
        flowables.append(_PhotoGrid(rows, None if flowables else heading))
    if entry.photo_failures:
        text = (
            f"<i>{entry.photo_failures} selected photo{'s' if entry.photo_failures != 1 else ''}"
            " could not be read.</i>"
        )
        if not flowables:
            flowables.append(heading)
        flowables.append(Paragraph(text, styles["value"]))
    return flowables


# ============================================================
# TEXT BLOCKS
# ============================================================

def _link(url: str, text: str) -> str:
    return (
        f"<link href='{escape(url, {chr(39): '&#39;'})}' color='#1D3F7A'>"
        f"<u>{escape(text)}</u></link>"
    )


def _human_size(size: int | None) -> str:
    if not size:
        return ""
    value = float(size)
    for unit in ("bytes", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "bytes" else f"{value:.1f} {unit}"
        value /= 1024
    return ""


def _details_rows(entry: "ReportEntry", customization: dict | None = None) -> list[tuple[str, str]]:
    event, recorded_by = entry.event, entry.recorded_by
    opts = entry.customization if entry.customization is not None else (customization or {})
    inc_basic = opts.get("include_basic_details", True)
    inc_sched = opts.get("include_schedule_venue", True)
    inc_other = opts.get("include_other_info", True)
    omit_empty = entry.omit_empty_fields

    rows: list[tuple[str, str]] = []

    if inc_basic or inc_sched or inc_other:
        rows.append(("Event Name", rich(event.get("event_name"))))

    if inc_basic:
        event_type = str(event.get("event_type") or "").strip()
        if event_type or not omit_empty:
            rows.append(("Event Type", rich(event_type)))

    if inc_sched:
        event_date = event.get("event_date") or event.get("end_date")
        if event_date or not omit_empty:
            rows.append(("Event Date", escape(format_date_range(event.get("event_date"), event.get("end_date")))))
        time_range = format_time_range(event.get("start_time") or "", event.get("end_time") or "")
        if time_range:
            rows.append(("Time", escape(time_range)))
        venue = str(event.get("location") or "").strip()
        if venue or not omit_empty:
            rows.append(("Venue", rich(venue)))

    if inc_basic:
        department = str(event.get("department") or "").strip()
        if department or not omit_empty:
            rows.append(("Department", rich(department or settings.default_host_department)))
        for key, label in (
            ("organizer", "Organiser"),
            ("coordinator_contact", "Contact"),
        ):
            value = str(event.get(key) or "").strip()
            if value:
                rows.append((label, rich(value)))

    if inc_other:
        val = str(event.get("expected_participants") or "").strip()
        if val:
            rows.append(("No. of Participants", rich(val)))
        social_url = str(event.get("social_network_url") or "").strip()
        if social_url:
            rows.append((
                "Social Media Post",
                _link(social_url, social_url)
                if social_url.lower().startswith(("http://", "https://"))
                else escape(social_url),
            ))

    if inc_basic:
        name = str(recorded_by.get("name") or "").strip()
        email = str(recorded_by.get("email") or "").strip()
        if name.lower() == "not available":
            name = ""
        if name or email or not omit_empty:
            who = rich(name or ("Not available" if not omit_empty else ""))
            if email:
                who += f"<br/><font color='#5B6475'>{escape(email)}</font>"
            rows.append((f"{entry.recorded_label} by", who))
        created = event.get("created_at")
        if created and entry.show_recorded_on:
            rows.append((f"{entry.recorded_label} on", escape(format_date(str(created)[:10]))))

    return rows


def _attachments_table(attachments: list[Attachment], styles) -> list:
    if not attachments:
        return [Paragraph("<i>No files were uploaded for this event.</i>", styles["value"])]

    head = [Paragraph(text, styles["label"]) for text in ("S. No.", "File (click to download)", "Type", "Size")]
    data = [head]
    for number, item in enumerate(attachments, start=1):
        name = item.name or "file"
        data.append([
            Paragraph(str(number), styles["value"]),
            Paragraph(_link(item.url, name) if item.url else escape(name), styles["value"]),
            Paragraph(escape(KIND_LABELS.get(item.kind, item.kind.title())), styles["value"]),
            Paragraph(escape(_human_size(item.size)), styles["value"]),
        ])
    table = Table(
        data,
        colWidths=[15 * mm, CONTENT_WIDTH - 15 * mm - 26 * mm - 24 * mm, 26 * mm, 24 * mm],
        repeatRows=1,
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), LABEL_FILL),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 0.4, RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return [table]


def _event_sections(
    entry: ReportEntry,
    styles,
    *,
    attachments_first: bool = False,
    customization: dict | None = None,
) -> list:
    """Details and description conditionally included based on customization;
    photos and attachments only when selected and present.

    ``attachments_first`` (the consolidated report) lists the files before the
    photos: the photo block then ends the event's page and can shrink into
    the space left, instead of pushing a short file list onto a page of its
    own."""
    event = entry.event
    opts = entry.customization if entry.customization is not None else (customization or {})
    inc_desc = opts.get("include_description", True)
    inc_photos = opts.get("include_photos", True)
    inc_notices = opts.get("include_notices", True)
    inc_reports = opts.get("include_reports", True)

    story = []
    number = 1

    details = _details_rows(entry, opts)
    if details:
        story += [
            CondPageBreak(SECTION_ROOM),
            Paragraph(f"{number}. Event Details", styles["section"]),
            _key_value_table(details, styles),
        ]
        number += 1

    # Printed even when empty ("No description provided."), as before the
    # sections became optional: an unticked box is the only way to drop it.
    if inc_desc and (str(event.get("description") or "").strip() or not entry.omit_empty_fields):
        story += [
            CondPageBreak(SECTION_ROOM),
            Paragraph(f"{number}. Event Description & Objectives", styles["section"]),
            *_boxed_text(str(event.get("description") or "").strip(), styles["body"]),
        ]
        number += 1

    def photos_section(num: int) -> list:
        heading = Paragraph(f"{num}. Event Photos", styles["section"])
        return _photo_flowables(entry, heading, styles)

    # Notices hold notice documents only, one or many. Everything else --
    # report documents and the photo and video links -- is listed under
    # Attachments.
    notice_files = [
        a for a in entry.attachments
        if inc_notices and a.kind == "document" and a.category != "report"
    ]
    report_files = [
        a for a in entry.attachments
        if inc_reports and not (a.kind == "document" and a.category != "report")
    ]

    def notices_section(num: int) -> list:
        return [
            CondPageBreak(SECTION_ROOM),
            Paragraph(f"{num}. Uploaded Notices", styles["section"]),
            *_attachments_table(notice_files, styles),
        ]

    def reports_section(num: int) -> list:
        return [
            CondPageBreak(SECTION_ROOM),
            Paragraph(f"{num}. Uploaded Attachments", styles["section"]),
            *_attachments_table(report_files, styles),
        ]

    files = [
        section for present, section in (
            (bool(notice_files), notices_section),
            (bool(report_files), reports_section),
        ) if present
    ]
    photos = [photos_section] if inc_photos and (entry.photos or entry.photo_failures) else []
    parts = files + photos if attachments_first else photos + files

    for section_fn in parts:
        story += section_fn(number)
        number += 1

    if entry.approval:
        approved_by, approved_on = entry.approval
        story += [
            CondPageBreak(SECTION_ROOM),
            Paragraph(f"{number}. Approval", styles["section"]),
            _key_value_table([
                ("Status", "<b>Approved</b>"),
                ("Approved by", rich(f"{approved_by} (Dean)" if approved_by != "Dean" else "Dean")),
                ("Approved on", escape(approved_on or "Not recorded")),
            ], styles),
        ]
        number += 1

    return story


def _event_divider() -> Table:
    rule = Table([[""]], colWidths=[CONTENT_WIDTH], rowHeights=[1])
    rule.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, 0), 1.2, NAVY)]))
    return rule


def _links_note(entries: list[ReportEntry], links_valid_until: datetime | None, styles) -> list:
    if not (links_valid_until and any(e.attachments for e in entries)):
        return []
    return [
        Spacer(1, 2 * mm),
        Paragraph(
            f"<font color='#5B6475'>Download links in this report work until "
            f"{escape(format_date(links_valid_until.date().isoformat()))}.</font>",
            styles["reference"],
        ),
    ]


# ============================================================
# CONSOLIDATED REPORT (several events)
# ============================================================

class _ConsolidatedDoc(SimpleDocTemplate):
    """Collects the contents entries and PDF bookmarks as the events are laid
    out, and remembers the page count of each pass so the footer can print
    "Page X of Y" on the final one.

    The single-event report counts pages by holding every page until the end
    (_NumberedCanvas); that would point every bookmark and contents link at
    page 1 here, so this report numbers its pages from the previous pass of
    the multi-pass build instead (the pass count settles the table of
    contents anyway).
    """

    total_pages = 0

    def afterFlowable(self, flowable):
        marker = getattr(flowable, "_report_mark", None)
        if not marker:
            return
        toc_text, outline_text, key = marker
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(outline_text, key, level=0, closed=False)
        if toc_text:
            self.notify("TOCEntry", (0, toc_text, self.page, key))

    def build(self, flowables, **kwargs):
        super().build(flowables, **kwargs)
        self.total_pages = self.page


def _consolidated_footer(canvas, doc) -> None:
    """The same footer as every other report page."""
    y = 11 * mm
    canvas.saveState()
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, y + 4 * mm, PAGE_WIDTH - MARGIN, y + 4 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN, y, f"Campus Capture  ·  {REPORT_SCHOOL}  ·  Official event record")
    total = doc.total_pages or doc.page
    canvas.drawRightString(PAGE_WIDTH - MARGIN, y, f"Page {doc.page} of {total}")
    canvas.restoreState()


def _marked(flowable, toc_text: str | None, outline_text: str, key: str):
    flowable._report_mark = (toc_text, outline_text, key)
    return flowable


def _cover_page(entries: list[ReportEntry], styles, issued: str, prepared_by: dict | None) -> list:
    count = len(entries)
    days = sorted(
        day
        for entry in entries
        for day in (entry.event.get("event_date"), entry.event.get("end_date"))
        if day
    )
    period = format_date_range(days[0], days[-1]) if days else "Not recorded"
    if days and days[0] == days[-1]:
        period = format_date(days[0])
    # Whoever generated the report; the first event's owner if not given.
    preparer = prepared_by or entries[0].recorded_by or {}
    prepared = rich(preparer.get("name") or "Not available")
    if preparer.get("email"):
        prepared += f"<br/><font color='#5B6475'>{escape(preparer['email'])}</font>"
    departments = sorted({str(e.event.get("department") or "").strip() for e in entries} - {""})

    rows = [
        ("Events covered", f"{count} event{'s' if count != 1 else ''}"),
        ("Period", escape(period)),
        ("Department", rich(", ".join(departments) or "SST")),
        ("Prepared by", prepared),
        ("Issued on", issued),
    ]
    return [
        *_letterhead(styles),
        Spacer(1, 38 * mm),
        _marked(Paragraph("CONSOLIDATED EVENT REPORT", styles["cover_title"]), None, "Cover", "cover"),
        Spacer(1, 3 * mm),
        Paragraph(f"{escape(REPORT_SCHOOL)} &nbsp;·&nbsp; {escape(REPORT_UNIVERSITY)}", styles["cover_sub"]),
        Spacer(1, 4 * mm),
        _event_divider(),
        Spacer(1, 12 * mm),
        _key_value_table(rows, styles),
        Spacer(1, 10 * mm),
        Paragraph(
            "This report brings together the records of the events listed on the "
            "next page. Each event has its own section: its details, description, "
            "photographs, and every uploaded file with a download link.",
            styles["cover_note"],
        ),
    ]


def _contents_page(styles) -> list:
    toc = TableOfContents(dotsMinLevel=0)
    toc.levelStyles = [styles["toc_entry"]]
    return [
        _marked(Paragraph("Contents", styles["toc_title"]), None, "Contents", "contents"),
        Spacer(1, 4 * mm),
        toc,
    ]


def _build_consolidated(
    entries: list[ReportEntry],
    styles,
    issued: str,
    links_valid_until: datetime | None,
    subject: str,
    prepared_by: dict | None = None,
    customization: dict | None = None,
) -> BytesIO:
    styles["cover_title"] = ParagraphStyle(
        "CoverTitle", parent=styles["title"], fontSize=24, leading=30,
    )
    styles["cover_sub"] = ParagraphStyle(
        "CoverSub", parent=styles["reference"], fontSize=11, leading=15, textColor=NAVY,
    )
    styles["cover_note"] = ParagraphStyle(
        "CoverNote", parent=styles["body"], textColor=MUTED, fontSize=9.5, leading=14,
    )
    styles["toc_title"] = ParagraphStyle(
        "TocTitle", parent=styles["title"], alignment=0, fontSize=16, leading=20, spaceAfter=2,
    )
    styles["toc_entry"] = ParagraphStyle(
        "TocEntry", parent=styles["body"], fontSize=10.5, leading=19,
    )

    count = len(entries)
    story = _cover_page(entries, styles, issued, prepared_by)
    story += [PageBreak(), *_contents_page(styles)]

    for number, entry in enumerate(entries, start=1):
        ev = entry.event
        name = str(ev.get("event_name") or "Untitled event")
        when = format_date_range(ev.get("event_date"), ev.get("end_date"))
        toc_text = (
            f"{number}. {rich(name)}"
            + (f" &nbsp;<font color='#5B6475' size='9'>({escape(when)})</font>" if when else "")
        )
        story += [
            # Each event opens on its own page, as a section of the report.
            PageBreak(),
            Paragraph(
                f"EVENT {number} OF {count}",
                styles["event_kicker"],
            ),
            _marked(
                Paragraph(rich(name), styles["event_title"]),
                toc_text,
                f"{number}. {name}",
                f"event-{number}",
            ),
            Spacer(1, 1.5 * mm),
            _event_divider(),
            Spacer(1, 1 * mm),
        ]
        story += _event_sections(entry, styles, attachments_first=True, customization=customization)

    story += _links_note(entries, links_valid_until, styles)
    story.append(_signature_block(styles))

    buffer = BytesIO()
    doc = _ConsolidatedDoc(
        buffer,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=16 * mm,
        bottomMargin=22 * mm,
        title=f"Consolidated Event Report - {count} events",
        author="Campus Capture, Swami Rama Himalayan University",
        subject=subject,
    )
    doc.multiBuild(story, onFirstPage=_consolidated_footer, onLaterPages=_consolidated_footer)
    buffer.seek(0)
    return buffer


# ============================================================
# ENTRY POINT
# ============================================================

def build_managed_report_pdf(
    entries: list[ReportEntry],
    *,
    links_valid_until: datetime | None = None,
    subject: str = "Event report",
    prepared_by: dict | None = None,
    customization: dict | None = None,
) -> BytesIO:
    """One report for one event, or a consolidated report for several."""
    if not entries:
        raise ValueError("A report needs at least one event")

    styles = _styles()
    # Headings flow; CondPageBreak (see _event_sections) keeps them off the
    # page foot instead of welding them to the whole section that follows.
    styles["section"] = ParagraphStyle("SectionFlow", parent=styles["section"], keepWithNext=0)
    styles["event_title"] = ParagraphStyle(
        "EventTitle", parent=styles["title"], fontSize=13.5, leading=17,
        alignment=0, spaceBefore=2, spaceAfter=2,
    )
    styles["event_kicker"] = ParagraphStyle(
        "EventKicker", parent=styles["label"], textColor=MUTED, fontSize=8.5, leading=11,
    )
    issued = escape(format_date(datetime.now().isoformat()))
    single = len(entries) == 1
    if not single:
        return _build_consolidated(
            entries, styles, issued, links_valid_until, subject, prepared_by, customization=customization
        )

    story = _letterhead(styles)
    if single:
        story += [
            Spacer(1, 5 * mm),
            Paragraph("EVENT REPORT", styles["title"]),
            Spacer(1, 1.5 * mm),
            Paragraph(f"Issued {issued}", styles["reference"]),
        ]
        story += _event_sections(entries[0], styles, customization=customization)

    if links_valid_until and any(e.attachments for e in entries):
        story += [
            Spacer(1, 2 * mm),
            Paragraph(
                f"<font color='#5B6475'>Download links in this report work until "
                f"{escape(format_date(links_valid_until.date().isoformat()))}.</font>",
                styles["reference"],
            ),
        ]

    story.append(_signature_block(styles))

    title = (
        f"Event Report - {entries[0].event.get('event_name') or ''}"
        if single
        else f"Consolidated Event Report - {len(entries)} events"
    )
    buffer = BytesIO()
    SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=16 * mm,
        bottomMargin=22 * mm,
        title=title,
        author="Campus Capture, Swami Rama Himalayan University",
        subject=subject,
    ).build(story, canvasmaker=_NumberedCanvas)
    buffer.seek(0)
    return buffer


__all__ = [
    "Attachment",
    "PHOTOS_PER_BLOCK",
    "ReportEntry",
    "build_managed_report_pdf",
    "fit_within",
    "layout_photos",
    "orientation_of",
    "photo_groups",
    "prepare_photo",
]
