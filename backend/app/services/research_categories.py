"""What each kind of research record holds, and the rules for filling it in.

One definition per category -- its fields, its outcome stages and the kinds
of evidence that back it -- served to both panels by GET /research/categories
so the forms are drawn from it, and used here to validate what comes back.
The frontend never keeps its own copy, so the two cannot drift apart.

Validation is shape only and never touches the database (see the API
conventions): which faculty member a record belongs to is the router's job.

Drafts are allowed to be incomplete. ``clean_details`` rejects malformed
values at any time, and reports what is still missing; the router refuses a
*submission* while anything is.
"""

from __future__ import annotations

import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from app.services.research_identifiers import normalize_doi


@dataclass(frozen=True)
class Field:
    key: str
    label: str
    # text, textarea, select, multiselect, number, date, url, doi
    type: str = "text"
    required: bool = False
    options: tuple[str, ...] = ()
    help: str | None = None
    placeholder: str | None = None
    # Required only once the outcome has reached this stage: a patent number
    # cannot exist before the patent is granted.
    required_from: str | None = None
    # Shown -- and kept, and (if `required`) needed -- only while another
    # field holds a value: ("indexing", "Other") asks for the other platform's
    # name only once "Other" is ticked. Otherwise the field is dropped.
    shown_if: tuple[str, str] | None = None


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    short: str
    description: str
    # What `record_date` means for this kind of record.
    date_label: str
    outcomes: tuple[tuple[str, str], ...]
    fields: tuple[Field, ...]
    evidence_tags: tuple[str, ...]
    title_label: str = "Title"
    # Outcomes that end the line without success (a refused patent).
    closed_outcomes: tuple[str, ...] = field(default=())


INDEXING = ("Scopus", "Web of Science", "UGC-CARE", "PubMed", "Google Scholar", "Other")
LEVELS = ("International", "National", "State", "University")

CATEGORIES: dict[str, Category] = {
    "journal": Category(
        key="journal",
        label="Journal publication",
        short="Journal",
        description="Research papers and articles published in journals.",
        date_label="Publication date",
        title_label="Paper title",
        outcomes=(("accepted", "Accepted"), ("in_press", "In press"), ("published", "Published")),
        fields=(
            # Kept short on purpose: no author list, publisher, volume, issue,
            # pages, ISSN or impact factor. The DOI stays, optional; the form
            # draws it with its "Fill from DOI" button rather than as a field
            # of its own.
            Field("author_position", "Faculty member's authorship", "select", required=True,
                  options=("First author", "Corresponding author", "Co-author")),
            Field("journal", "Journal", required=True),
            Field("doi", "DOI", "doi", placeholder="e.g. 10.1016/j.example.2026.01.001"),
            Field("indexing", "Indexed in", "multiselect", required=True, options=INDEXING,
                  help="Choose every database that indexes the journal."),
            Field("indexing_other", "Other indexing platform", required=True, shown_if=("indexing", "Other"),
                  placeholder="e.g. DOAJ, EBSCO, Index Copernicus"),
            Field("quartile", "Quartile", "select", options=("Q1", "Q2", "Q3", "Q4")),
        ),
        evidence_tags=("Full paper", "First page", "Acceptance letter", "Indexing proof", "Other"),
    ),
    "conference": Category(
        key="conference",
        label="Conference paper / presentation",
        short="Conference",
        description="Papers, posters, keynotes and invited talks at conferences.",
        date_label="Presentation date",
        title_label="Paper / talk title",
        outcomes=(
            ("accepted", "Accepted"),
            ("presented", "Presented"),
            ("published", "Published in proceedings"),
        ),
        fields=(
            Field("presentation_type", "Type", "select", required=True,
                  options=("Oral presentation", "Poster", "Keynote", "Invited talk", "Session chair")),
            Field("conference", "Conference", required=True),
            Field("organiser", "Organised by", required=True),
            Field("level", "Level", "select", required=True, options=LEVELS),
            Field("end_date", "Last day", "date"),
            Field("doi", "DOI", "doi"),
        ),
        evidence_tags=("Certificate", "Paper / abstract", "Acceptance letter", "Programme", "Other"),
    ),
    "patent": Category(
        key="patent",
        label="Patent",
        short="Patent",
        description="Patents filed, published or granted, in India or abroad.",
        date_label="Filing date",
        title_label="Title of the invention",
        outcomes=(
            ("filed", "Filed"),
            ("published", "Published"),
            ("granted", "Granted"),
            ("refused", "Refused"),
            ("abandoned", "Abandoned"),
        ),
        closed_outcomes=("refused", "abandoned"),
        fields=(
            Field("inventors", "Inventors", "textarea", required=True),
            Field("application_number", "Application number", required=True),
            Field("publication_date", "Publication date", "date", required_from="published"),
            Field("grant_date", "Grant date", "date", required_from="granted"),
            Field("patent_number", "Patent number", required_from="granted"),
        ),
        evidence_tags=(
            "Filing receipt",
            "Publication extract",
            "Grant certificate",
            "Examination report",
            "Other",
        ),
    ),
    "book": Category(
        key="book",
        label="Book / book chapter",
        short="Book",
        description="Authored and edited books, and chapters in books.",
        date_label="Publication date",
        outcomes=(("accepted", "Accepted"), ("published", "Published")),
        fields=(
            Field("book_type", "Type", "select", required=True,
                  options=("Authored book", "Edited book", "Book chapter")),
            Field("book_title", "Book title",
                  help="For a chapter: the book it appears in. Leave blank for a whole book."),
            Field("authors", "Authors / editors", "textarea", required=True),
            Field("publisher", "Publisher", required=True),
        ),
        evidence_tags=("Cover page", "ISBN page", "Chapter first page", "Acceptance letter", "Other"),
    ),
    "other": Category(
        key="other",
        label="Other achievement",
        short="Other",
        description="Awards, fellowships, PhD supervision, editorial roles, consultancy and more.",
        date_label="Date",
        outcomes=(("recorded", "Recorded"),),
        fields=(
            Field("kind", "Kind", "select", required=True,
                  options=(
                      "Award / honour",
                      "Fellowship",
                      "PhD supervision",
                      "Editorial board / reviewer",
                      "Consultancy",
                      "Copyright / design registration",
                      "Invited talk",
                      "MoU / collaboration",
                      "Other",
                  )),
            Field("awarded_by", "Awarded by / organisation", required=True),
            Field("level", "Level", "select", options=LEVELS),
            Field("description", "Details", "textarea"),
        ),
        evidence_tags=("Certificate", "Letter", "Photograph", "Other"),
    ),
}

# Kept only to present old project/grant records. Retired categories are never
# returned by the category API and are not accepted by create, edit, or submit.
LEGACY_CATEGORIES: dict[str, Category] = {
    "project": Category(
        key="project",
        label="Research project / grant",
        short="Project",
        description="Legacy research projects and grants.",
        date_label="Start date",
        title_label="Project title",
        outcomes=(
            ("applied", "Applied"),
            ("sanctioned", "Sanctioned"),
            ("ongoing", "Ongoing"),
            ("completed", "Completed"),
            ("not_sanctioned", "Not sanctioned"),
        ),
        closed_outcomes=("not_sanctioned",),
        fields=(
            Field("role", "Faculty member's role", "select", required=True,
                  options=("Principal Investigator", "Co-Principal Investigator", "Co-Investigator")),
            Field("end_date", "End date", "date"),
        ),
        evidence_tags=("Sanction letter", "Proposal", "Utilisation certificate", "Completion report", "Other"),
    ),
}


TEXT_MAX = 300
TEXTAREA_MAX = 4000
_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_URL = re.compile(r"^https?://\S+$", re.I)


class DetailsError(ValueError):
    """A value that can never be right, whatever stage the record is at."""


def get_category(key: str | None) -> Category | None:
    return CATEGORIES.get((key or "").strip().lower())


def get_display_category(key: str | None) -> Category | None:
    """Return active category metadata, or read-only metadata for old records."""
    normalized = (key or "").strip().lower()
    return CATEGORIES.get(normalized) or LEGACY_CATEGORIES.get(normalized)


def outcome_keys(category: Category) -> tuple[str, ...]:
    return tuple(key for key, _ in category.outcomes)


def outcome_label(category: Category, outcome: str | None) -> str:
    return dict(category.outcomes).get(outcome or "", outcome or "")


def _reached(category: Category, outcome: str, stage: str) -> bool:
    """Whether `outcome` is at or past `stage` along the category's line.

    A closed outcome (refused, abandoned) is off the line: it reaches nothing,
    so a refused patent is never asked for its grant number.
    """
    if outcome in category.closed_outcomes:
        return False
    keys = outcome_keys(category)
    if stage not in keys or outcome not in keys:
        return False
    return keys.index(outcome) >= keys.index(stage)


def is_shown(item: Field, details: dict) -> bool:
    """Whether a conditional field applies, given the (cleaned) details."""
    if not item.shown_if:
        return True
    other, wanted = item.shown_if
    value = details.get(other)
    return wanted in value if isinstance(value, list) else value == wanted


def indexing_text(details: dict) -> str:
    """'Scopus, Other (DOAJ)': the indexes with the other platform named."""
    other = (details or {}).get("indexing_other")
    return ", ".join(
        f"Other ({other})" if name == "Other" and other else name for name in (details or {}).get("indexing") or []
    )


def is_required(category: Category, item: Field, outcome: str) -> bool:
    if item.required:
        return True
    return bool(item.required_from) and _reached(category, outcome, item.required_from)


def _clean_value(item: Field, raw: Any) -> Any:
    """The tidied value, None for empty, or DetailsError."""
    if raw is None:
        return None

    if item.type == "multiselect":
        values = raw if isinstance(raw, (list, tuple)) else [raw]
        picked = []
        for value in values:
            text = str(value or "").strip()
            if not text:
                continue
            if text not in item.options:
                raise DetailsError(f"{item.label}: “{text}” is not one of the choices.")
            if text not in picked:
                picked.append(text)
        return picked or None

    if isinstance(raw, (list, dict)):
        raise DetailsError(f"{item.label} must be a single value.")

    if item.type == "number":
        if isinstance(raw, bool):
            raise DetailsError(f"{item.label} must be a number.")
        text = str(raw).strip().replace(",", "")
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            raise DetailsError(f"{item.label} must be a number.") from None
        if not math.isfinite(number) or number < 0:
            raise DetailsError(f"{item.label} must be zero or more.")
        return int(number) if number.is_integer() else round(number, 4)

    text = " ".join(str(raw).split()) if item.type != "textarea" else str(raw).strip()
    if not text:
        return None

    if item.type == "select":
        if text not in item.options:
            raise DetailsError(f"{item.label}: “{text}” is not one of the choices.")
        return text
    if item.type == "date":
        if not _ISO_DATE.match(text):
            raise DetailsError(f"{item.label} must be a date (YYYY-MM-DD).")
        return text
    if item.type == "doi":
        doi = normalize_doi(text)
        if not doi:
            raise DetailsError(f"{item.label}: “{text}” does not look like a DOI. A DOI starts with 10., e.g. 10.1016/j.cell.2026.01.001.")
        return doi
    if item.type == "url":
        if not _URL.match(text):
            raise DetailsError(f"{item.label} must be a web address starting with http:// or https://.")
        return text[:TEXT_MAX * 2]

    limit = TEXTAREA_MAX if item.type == "textarea" else TEXT_MAX
    if len(text) > limit:
        raise DetailsError(f"{item.label} is too long (at most {limit} characters).")
    return text


def clean_details(category: Category, details: dict | None, outcome: str) -> tuple[dict, list[str]]:
    """(cleaned details, labels of required fields still empty).

    Keys the category does not define are dropped, so a form can never store
    fields nobody will see. Raises DetailsError for a value that is malformed.
    """
    if details is not None and not isinstance(details, dict):
        raise DetailsError("Details must be an object.")
    source = details or {}
    cleaned: dict[str, Any] = {}
    missing: list[str] = []
    for item in category.fields:
        # A conditional field follows the one it depends on, which is
        # therefore already cleaned; when it does not apply it is dropped.
        if not is_shown(item, cleaned):
            continue
        value = _clean_value(item, source.get(item.key))
        if value is not None:
            cleaned[item.key] = value
        elif is_required(category, item, outcome):
            missing.append(item.label)
    return cleaned, missing


def clean_details_leniently(category: Category, details: dict | None, outcome: str) -> dict:
    """Like clean_details, but a malformed value is dropped instead of
    failing the lot. For suggestions (a DOI look-up), never for saving."""
    cleaned: dict[str, Any] = {}
    for item in category.fields:
        if not is_shown(item, cleaned):
            continue
        try:
            value = _clean_value(item, (details or {}).get(item.key))
        except DetailsError:
            continue
        if value is not None:
            cleaned[item.key] = value
    return cleaned


def evidence_tags(category: Category) -> tuple[str, ...]:
    return category.evidence_tags


def serialize_category(category: Category) -> dict:
    data = asdict(category)
    data["outcomes"] = [{"key": key, "label": label} for key, label in category.outcomes]
    data["fields"] = [
        {
            **asdict(item),
            "options": list(item.options),
            "shown_if": {"field": item.shown_if[0], "value": item.shown_if[1]} if item.shown_if else None,
        }
        for item in category.fields
    ]
    data["evidence_tags"] = list(category.evidence_tags)
    data["closed_outcomes"] = list(category.closed_outcomes)
    return data


def serialize_categories() -> list[dict]:
    """Active definitions for the research forms."""
    return [serialize_category(category) for category in CATEGORIES.values()]
