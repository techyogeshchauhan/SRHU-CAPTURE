"""Research PDFs: a faculty member's research CV, and a Research Showcase.

Both are built from verified records and set in the event report's design --
the same letterhead, styles and page-numbered footer (report_pdf) -- so
everything Campus Capture prints reads as one institution's documents.

Each record is printed as a citation in its category's usual form, e.g. a
journal paper as "Authors (2026). Title. Journal, 12(3), 45–60. doi:…".
"""

from __future__ import annotations

from datetime import datetime
from io import BytesIO
from xml.sax.saxutils import escape

from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from app.services.report_pdf import (
    CONTENT_WIDTH,
    LABEL_FILL,
    MARGIN,
    MUTED,
    NAVY,
    REPORT_SCHOOL,
    RULE,
    _letterhead,
    _NumberedCanvas,
    _styles,
    format_date,
    rich,
)
from app.services.research_categories import CATEGORIES, LEGACY_CATEGORIES, Category, indexing_text, outcome_label

class _ResearchCanvas(_NumberedCanvas):
    """The report footer, saying what kind of document this is."""

    footer_text = "Research record"

    def _draw_footer(self, total: int) -> None:
        y = 11 * mm
        self.setStrokeColor(RULE)
        self.setLineWidth(0.5)
        self.line(MARGIN, y + 4 * mm, self._pagesize[0] - MARGIN, y + 4 * mm)
        self.setFont("Helvetica", 7.5)
        self.setFillColor(MUTED)
        self.drawString(MARGIN, y, f"Campus Capture  ·  {REPORT_SCHOOL}  ·  {self.footer_text}")
        self.drawRightString(self._pagesize[0] - MARGIN, y, f"Page {self._pageNumber} of {total}")


def _canvas(text: str):
    return type("Canvas", (_ResearchCanvas,), {"footer_text": text})


def _research_styles() -> dict[str, ParagraphStyle]:
    styles = _styles()
    styles["name"] = ParagraphStyle("Name", parent=styles["title"], fontSize=18, leading=22)
    styles["sub"] = ParagraphStyle("Sub", parent=styles["reference"], fontSize=9.5, leading=13)
    styles["entry"] = ParagraphStyle(
        "Entry", parent=styles["body"], fontSize=9.5, leading=13.5, leftIndent=14, firstLineIndent=-14,
        spaceAfter=5,
    )
    styles["note"] = ParagraphStyle("Note", parent=styles["reference"], alignment=0)
    styles["narrative"] = ParagraphStyle("Narrative", parent=styles["body"], spaceAfter=6)
    return styles


def _year(iso: str | None) -> str:
    return (iso or "")[:4]


def citation(record: dict, category: Category | None) -> str:
    """One record as Paragraph markup, in its category's citation form."""
    d = record.get("details") or {}
    title = rich(record.get("title"))
    year = _year(record.get("record_date"))
    when = format_date(record.get("record_date")) if record.get("record_date") else ""
    key = category.key if category else record.get("category")
    status = outcome_label(category, record.get("outcome_status")) if category else ""
    parts: list[str] = []

    if key == "journal":
        volume = rich(d.get("volume")) + (f"({rich(d.get('issue'))})" if d.get("issue") else "")
        source = ", ".join(p for p in (f"<i>{rich(d.get('journal'))}</i>" if d.get("journal") else "", volume, rich(d.get("pages"))) if p)
        # Journal records no longer carry an author list; older ones may.
        lead = rich(d.get("authors"))
        parts = [f"{lead} ({year}). <b>{title}</b>." if lead else f"<b>{title}</b> ({year}).",
                 f"{source}." if source else ""]
        if d.get("doi"):
            parts.append(f"doi:{escape(str(d['doi']))}")
        extras = [x for x in (indexing_text(d), d.get("quartile"),
                              f"IF {d['impact_factor']}" if d.get("impact_factor") else None) if x]
        if extras:
            parts.append(f"[{escape(' · '.join(str(x) for x in extras))}]")
        if record.get("outcome_status") != "published":
            parts.append(f"({escape(status)})")
    elif key == "conference":
        parts = [
            f"{rich(d.get('authors'))}. <b>{title}</b>.",
            f"{escape(d.get('presentation_type') or 'Presented')} at <i>{rich(d.get('conference'))}</i>",
            f"{rich(d.get('organiser'))}{', ' + rich(d.get('venue')) if d.get('venue') else ''}, {escape(when)}"
            f" ({escape(d.get('level') or '')}).",
        ]
        if d.get("proceedings"):
            parts.append(f"In <i>{rich(d['proceedings'])}</i>{', ISBN/ISSN ' + escape(str(d['isbn'])) if d.get('isbn') else ''}.")
    elif key == "patent":
        parts = [
            f"<b>{title}</b>. Inventors: {rich(d.get('inventors'))}.",
            f"{escape(d.get('office') or '')}, application no. {escape(str(d.get('application_number') or '—'))},"
            f" filed {escape(when)}.",
            f"Status: <b>{escape(status)}</b>",
        ]
        if d.get("publication_date"):
            parts.append(f"· published {escape(format_date(d['publication_date']))}")
        if d.get("grant_date") or d.get("patent_number"):
            parts.append(
                f"· granted {escape(format_date(d['grant_date'])) if d.get('grant_date') else ''}"
                f"{', patent no. ' + escape(str(d['patent_number'])) if d.get('patent_number') else ''}"
            )
    elif key == "project":
        span = escape(when) + (f" to {escape(format_date(d['end_date']))}" if d.get("end_date") else "")
        parts = [
            f"<b>{title}</b>.",
            f"Role: {escape(d.get('role') or 'Not specified')}. {span}. Status: {escape(status)}.",
        ]
    elif key == "book":
        if d.get("book_type") == "Book chapter":
            parts = [f"{rich(d.get('authors'))} ({year}). <b>{title}</b>. In <i>{rich(d.get('book_title'))}</i>."]
        else:
            parts = [f"{rich(d.get('authors'))} ({year}). <b><i>{title}</i></b> ({escape(d.get('book_type') or 'Book')})."]
        parts.append(f"{rich(d.get('publisher'))}{'. ISBN ' + escape(str(d['isbn'])) if d.get('isbn') else ''}.")
    else:
        parts = [
            f"<b>{title}</b> — {escape(d.get('kind') or 'Achievement')}.",
            f"{rich(d.get('awarded_by'))}{', ' + escape(d['level']) + ' level' if d.get('level') else ''}, {escape(when)}.",
        ]
        if d.get("description"):
            parts.append(rich(d["description"]))
    return " ".join(p for p in parts if p)


def _sorted(records: list[dict]) -> list[dict]:
    return sorted(records, key=lambda r: r.get("record_date") or "", reverse=True)


def _summary_table(records: list[dict], styles) -> Table:
    counts = [(category.label, sum(1 for r in records if r.get("category") == category.key)) for category in CATEGORIES.values()]
    counts.extend(
        (f"Legacy: {category.label}", sum(1 for r in records if r.get("category") == category.key))
        for category in LEGACY_CATEGORIES.values()
    )
    counts = [(label, n) for label, n in counts if n]
    cells = [[Paragraph(f"<b>{n}</b>", styles["value"]), Paragraph(escape(label), styles["label"])] for label, n in counts]
    # Two pairs per row.
    rows = [sum(cells[i:i + 2], []) + ([""] * 2 if i + 1 >= len(cells) else []) for i in range(0, len(cells), 2)]
    if not rows:
        rows = [[Paragraph("No verified records yet.", styles["value"]), "", "", ""]]
    width = CONTENT_WIDTH / 2
    table = Table(rows, colWidths=[14 * mm, width - 14 * mm, 14 * mm, width - 14 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), LABEL_FILL),
        ("BOX", (0, 0), (-1, -1), 0.6, RULE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return table


def _sections(
    records: list[dict], styles, highlights: set[str] | None = None, people: dict[str, dict] | None = None
) -> list:
    """Every record under its category. With ``people`` (a showcase spanning
    several teachers) each entry also says whose it is."""
    story: list = []
    for category in (*CATEGORIES.values(), *LEGACY_CATEGORIES.values()):
        rows = [r for r in records if r.get("category") == category.key]
        if not rows:
            continue
        label = f"Legacy: {category.label}" if category.key in LEGACY_CATEGORIES else category.label
        story.append(Paragraph(f"{escape(label)} ({len(rows)})", styles["section"]))
        for number, record in enumerate(rows, start=1):
            star = "» " if highlights and str(record.get("_id") or record.get("id")) in highlights else ""
            whose = ""
            if people is not None:
                name = (people.get(str(record.get("faculty_id"))) or {}).get("name")
                whose = f" <font color='#5B6475'>— {rich(name)}</font>" if name else ""
            story.append(Paragraph(f"{number}. {star}{citation(record, category)}{whose}", styles["entry"]))
    return story


def _document(story: list, footer: str, title: str) -> bytes:
    buffer = BytesIO()
    SimpleDocTemplate(
        buffer,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=14 * mm,
        bottomMargin=22 * mm,
        title=title,
        author="Campus Capture",
    ).build(story, canvasmaker=_canvas(footer))
    return buffer.getvalue()


def build_research_cv(person: dict, records: list[dict]) -> bytes:
    """A faculty member's verified research, by category, newest first."""
    styles = _research_styles()
    records = _sorted(records)
    # The letterhead names the school, so the line under the name does not.
    facts = " · ".join(escape(str(x)) for x in (person.get("designation"), person.get("email")) if x)
    story = [
        *_letterhead(styles),
        Spacer(1, 7 * mm),
        Paragraph(rich(person.get("name") or "Faculty member", bold=True), styles["name"]),
        Spacer(1, 1.5 * mm),
        Paragraph(facts or "&nbsp;", styles["sub"]),
        Spacer(1, 1.5 * mm),
        Paragraph(
            f"Research portfolio · verified records as of {datetime.now().strftime('%d %b %Y')}",
            styles["reference"],
        ),
        Spacer(1, 6 * mm),
        _summary_table(records, styles),
        Spacer(1, 2 * mm),
        *_sections(records, styles),
    ]
    if not records:
        story.append(Spacer(1, 8 * mm))
        story.append(Paragraph("No research has been verified for this faculty member yet.", styles["body"]))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(
        "Every entry above was verified by the Dean against its evidence in Campus Capture.", styles["note"]
    ))
    return _document(story, "Research CV", f"Research CV — {person.get('name') or ''}")


def build_showcase_pdf(showcase: dict, records: list[dict], people: dict[str, dict]) -> bytes:
    """A showcase: its narrative, headline numbers, highlights, then every record."""
    styles = _research_styles()
    highlights = {str(x) for x in showcase.get("highlight_ids") or []}
    faculty = sorted({(people.get(str(r.get("faculty_id"))) or {}).get("name") or "" for r in records} - {""})
    by_owner = showcase.get("owner_name") or "Campus Capture"
    story = [
        *_letterhead(styles),
        Spacer(1, 7 * mm),
        Paragraph("Research Showcase", styles["reference"]),
        Spacer(1, 1 * mm),
        Paragraph(rich(showcase.get("title"), bold=True), styles["name"]),
        Spacer(1, 1.5 * mm),
        Paragraph(
            f"Presented by {rich(by_owner)} · {len(records)} verified records · {len(faculty)} faculty members",
            styles["sub"],
        ),
        Spacer(1, 6 * mm),
    ]
    narrative = (showcase.get("description") or "").strip()
    if narrative:
        for line in narrative.replace("\r\n", "\n").split("\n\n"):
            story.append(Paragraph(rich(line).replace("\n", "<br/>"), styles["narrative"]))
        story.append(Spacer(1, 3 * mm))
    story.append(_summary_table(records, styles))

    chosen = [r for r in records if str(r.get("_id") or r.get("id")) in highlights]
    if chosen:
        story.append(Paragraph("Highlights", styles["section"]))
        for record in chosen:
            category = CATEGORIES.get(record.get("category")) or LEGACY_CATEGORIES.get(record.get("category"))
            name = (people.get(str(record.get("faculty_id"))) or {}).get("name") or ""
            story.append(KeepTogether([Paragraph(
                f"» {citation(record, category)} <font color='#5B6475'>— {rich(name)}</font>", styles["entry"]
            )]))

    story.extend(_sections(records, styles, highlights, people))
    if faculty:
        story.append(Paragraph("Faculty members", styles["section"]))
        story.append(Paragraph(rich(", ".join(faculty)), styles["body"]))
    return _document(story, "Research Showcase", f"Research Showcase — {showcase.get('title') or ''}")
