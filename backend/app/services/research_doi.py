"""Fill a research record in from its DOI, using Crossref's public API.

Only the DOI leaves the server -- no personal data -- and the answer is only
ever a suggestion for the form: the author reviews it before saving.

``lookup_doi`` returns the record's fields shaped the way the research form
and ``clean_details`` expect, already restricted to each category's fields.
"""

from __future__ import annotations

import html
import logging
import re
import time
from datetime import date
from urllib.parse import quote

import httpx

from app.config import settings
from app.services.research_categories import TEXTAREA_MAX
from app.services.research_identifiers import normalize_doi

logger = logging.getLogger(__name__)

CROSSREF_URL = "https://api.crossref.org/works/{doi}"
TIMEOUT_SECONDS = 8.0

# Crossref "type" -> (research category, book_type for books)
_TYPES = {
    "journal-article": ("journal", None),
    "proceedings-article": ("conference", None),
    "book-chapter": ("book", "Book chapter"),
    "book": ("book", "Authored book"),
    "monograph": ("book", "Authored book"),
    "edited-book": ("book", "Edited book"),
    "reference-book": ("book", "Authored book"),
    "posted-content": ("journal", None),
}

# A small cache, so a form that looks the same DOI up twice costs one call.
_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_SECONDS = 60 * 60
_CACHE_MAX = 256


class DoiError(Exception):
    """Something the author should be told, with the HTTP status to use."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _user_agent() -> str:
    # Crossref asks clients to identify themselves; a contact address puts
    # the request in its "polite" pool.
    contact = settings.smtp_from_email
    base = "CampusCapture/2.0 (SRHU research portfolio)"
    return f"{base}; mailto:{contact}" if contact and "@" in str(contact) else base


def _first(values) -> str | None:
    if isinstance(values, list) and values:
        return str(values[0]).strip() or None
    if isinstance(values, str):
        return values.strip() or None
    return None


def _text(value) -> str | None:
    """Plain text: inline markup (<i>, <jats:italic>…) stripped, entities
    decoded, and whitespace -- including the thin spaces Crossref puts in
    "B. P." -- collapsed to single spaces."""
    if not value:
        return None
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", str(value))).split()) or None


# ----------------------------------------------------------------- dates

def _parts(message: dict, key: str) -> tuple[int, ...] | None:
    """(year,), (year, month) or (year, month, day) -- as precise as given."""
    parts = ((message.get(key) or {}).get("date-parts") or [[None]])[0] or [None]
    clean = []
    for part in parts[:3]:
        if not part:
            break
        clean.append(int(part))
    return tuple(clean) or None


def _iso(parts: tuple[int, ...]) -> str:
    year, month, day = (list(parts) + [1, 1])[:3]
    return f"{year:04d}-{month:02d}-{day:02d}"


def _publication_date(message: dict) -> tuple[int, ...] | None:
    """When the work was published: the most precise date Crossref has and,
    of equally precise ones, the earliest. A paper online on 16 September and
    in print on the 17th was published on the 16th, as the paper itself says.

    "created" -- when the DOI was registered -- is not a publication date and
    is never used.
    """
    found = [parts for key in ("published-online", "published-print", "issued", "published", "posted")
             if (parts := _parts(message, key))]
    if not found:
        return None
    best = max(len(parts) for parts in found)
    return min(parts for parts in found if len(parts) == best)


def _rough_date_note(parts: tuple[int, ...]) -> str | None:
    if len(parts) == 3:
        return None
    if len(parts) == 2:
        shown = date(parts[0], parts[1], 1).strftime("%B %Y")
        return (f"Crossref gives only the month of publication ({shown}), so the day was set to the 1st. "
                "Correct it if you know the day.")
    return (f"Crossref gives only the year of publication ({parts[0]}), so the date was set to 1 January. "
            "Correct it if you know the date.")


# ---------------------------------------------------------------- people

def _person(person: dict) -> str | None:
    name = " ".join(part for part in (_text(person.get("given")), _text(person.get("family"))) if part)
    return name or _text(person.get("name"))


def _names(message: dict, role: str = "author") -> list[str]:
    return [name for name in (_person(person) for person in message.get(role) or []) if name]


def _join_names(names: list[str], limit: int) -> tuple[str | None, str | None]:
    """'A, B, C' -- shortened to fit the form, with a note, when a paper has
    hundreds of authors (a physics collaboration can list a thousand)."""
    joined = ", ".join(names)
    if len(joined) <= limit:
        return joined or None, None
    tail = f", et al. ({len(names)} authors in all)"
    kept: list[str] = []
    for name in names:
        if len(", ".join([*kept, name])) + len(tail) > limit:
            break
        kept.append(name)
    note = (f"The paper lists {len(names)} authors, more than the form holds, so only the first {len(kept)} "
            "are filled in, followed by “et al.”. Add the faculty member if they come further down.")
    return ", ".join(kept) + tail, note


# ------------------------------------------------------------ containers

# Book series Crossref lists beside the book a chapter is actually in
# ("Lecture Notes in Computer Science" beside "MICCAI 2015").
_SERIES = re.compile(r"\b(lecture notes|series|studies in|communications in|advances in intelligent|smart innovation)\b", re.I)
_PROCEEDINGS = re.compile(r"\b(proceedings|conference|symposium|workshop|congress|lecture notes)\b|\b[A-Z]{3,}\s+(?:19|20)\d\d\b")


def _containers(message: dict) -> list[str]:
    return [text for text in (_text(value) for value in message.get("container-title") or []) if text]


def _book_of(containers: list[str]) -> str | None:
    """The book a chapter or paper sits in, rather than the series it is part of."""
    books = [title for title in containers if not _SERIES.search(title)]
    return (books or containers or [None])[-1]


def _typed(message: dict, key: str) -> str | None:
    """The print ISSN/ISBN when Crossref says which is which, else the first."""
    for item in message.get(f"{key.lower()}-type") or []:
        if item.get("type") == "print" and item.get("value"):
            return str(item["value"]).strip()
    return _first(message.get(key))


def _ordinal(value) -> str | None:
    try:
        number = int(str(value).strip())
    except (TypeError, ValueError):
        return _text(value)
    if number <= 0:
        return None
    suffix = "th" if 10 <= number % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(number % 10, "th")
    return f"{number}{suffix}"


# -------------------------------------------------------------- abstract

ABSTRACT_MAX = 4000
_NS = r"(?:[\w-]+:)?"  # an XML namespace prefix, as in <jats:p> or <mml:mn>
# One child element: <mrow>…</mrow>, <mn>10</mn>.
_CHILD = rf"(<{_NS}(\w+)\b[^>]*>(?:(?!<{_NS}\2\b).)*?</{_NS}\2>)"


def _flat(fragment: str) -> str:
    return re.sub(r"<[^>]+>", "", fragment)


def _math(match: re.Match) -> str:
    """Inline MathML as text: <msup><mn>10</mn><mn>−21</mn></msup> -> 10^−21."""
    text = re.sub(r">\s+<", "><", match.group(0))
    second = _CHILD.replace(r"\2", r"\4")
    third = _CHILD.replace(r"\2", r"\6")
    # 410 with −180 below and +160 above (an uncertainty) -> 410^+160_−180
    for name in ("msubsup", "munderover"):
        pattern = rf"<{_NS}{name}\b[^>]*>{_CHILD}{second}{third}</{_NS}{name}>"
        text = re.sub(pattern, lambda m: f"{_flat(m.group(1))}^{_flat(m.group(5))}_{_flat(m.group(3))}", text, flags=re.S)
    for name, joiner in (("msup", "^"), ("msub", ""), ("mfrac", "/")):
        pattern = rf"<{_NS}{name}\b[^>]*>{_CHILD}{second}</{_NS}{name}>"
        count = 1
        while count:
            text, count = re.subn(pattern, lambda m: _flat(m.group(1)) + joiner + _flat(m.group(3)), text, flags=re.S)
    return _flat(text)


def _abstract(raw: str | None) -> str | None:
    """Crossref abstracts are JATS XML (<jats:title>Abstract</jats:title>
    <jats:p>…</jats:p>). Kept as paragraphs of plain text, with citation
    markers dropped, and cut at a word to fit the form's 4,000 characters."""
    if not raw:
        return None
    text = re.sub(rf"<({_NS})math\b.*?</\1math>", _math, str(raw), flags=re.S)
    # An "Abstract" heading says nothing; a section heading (Background,
    # Methods…) leads its paragraph.
    text = re.sub(r"<(?:jats:)?title>\s*(?:abstract|summary)\s*</(?:jats:)?title>", "", text, flags=re.I)
    text = re.sub(r"<(?:jats:)?title>(.*?)</(?:jats:)?title>", r"\n\n\1:", text, flags=re.I | re.S)
    # A superscript number after a word ("waves<sup>1</sup>") cites a
    # reference; after a number ("10<sup>6</sup>") it is a power.
    text = re.sub(r"(?<=[^\W\d_]|[)\].,;:])\s*<(?:jats:)?sup>[\d,\s–-]+</(?:jats:)?sup>", "", text)
    text = re.sub(r"<(?:jats:)?sup>(.*?)</(?:jats:)?sup>", r"^\1", text, flags=re.S)
    text = re.sub(r"</?(?:jats:)?(?:p|sec|list-item)\b[^>]*>", "\n\n", text)
    paragraphs = [_text(part) for part in re.split(r"\n\s*\n", text)]
    joined = "\n\n".join(re.sub(r"\s+([.,;:])", r"\1", part) for part in paragraphs if part)
    # A heading alone in its paragraph joins the one it introduces.
    joined = re.sub(r"(?m)^([^\n]{1,60}):\n\n", r"\1: ", joined)
    if len(joined) > ABSTRACT_MAX:
        joined = joined[: ABSTRACT_MAX - 1].rsplit(" ", 1)[0].rstrip(",;:") + "…"
    return joined or None


# ----------------------------------------------------------------- parse

def parse_crossref(message: dict, doi: str) -> dict:
    """Crossref's ``message`` object -> suggested record fields.

    ``notes`` says what the author should check by hand: a date Crossref
    knows only to the month, a shortened author list, a chapter that looks
    like conference proceedings. ``doi_fields`` names every detail the DOI
    speaks for in this category -- filled or knowingly left empty -- so the
    form replaces those and keeps what the author typed everywhere else.
    """
    kind = message.get("type") or ""
    category, book_type = _TYPES.get(kind, ("journal", None))
    notes: list[str] = []

    title = _text(_first(message.get("title")))
    subtitle = _text(_first(message.get("subtitle")))
    if title and subtitle and subtitle.lower() not in title.lower():
        title = f"{title}: {subtitle}"

    names = _names(message) or (_names(message, "editor") if category == "book" else [])
    authors, too_many = _join_names(names, TEXTAREA_MAX)

    containers = _containers(message)
    published = _publication_date(message)
    record_date = _iso(published) if published else None
    date_note = _rough_date_note(published) if published else None
    outcome: str | None = "published"
    pages = _text(message.get("page"))
    if not pages and message.get("article-number"):
        # Online-only journals number articles instead of paging them.
        pages = f"Article {_text(message.get('article-number'))}"

    details: dict = {"doi": doi}
    if category == "journal":
        journal = _first(containers)
        if kind == "posted-content":
            host = _text(_first([item.get("name") for item in message.get("institution") or []]))
            journal = journal or host or _text(message.get("group-title"))
            outcome = None
            later = [item.get("id") for item in (message.get("relation") or {}).get("is-preprint-of") or []]
            notes.append(
                f"This DOI is a preprint{f' on {journal}' if journal else ''}, not a journal publication. "
                + (f"Its published version has the DOI {later[0]}: fill the form from that instead." if later and later[0]
                   else "If it has since appeared in a journal, fill the form from the journal's DOI instead.")
            )
        details.update(
            authors=authors,
            journal=journal,
            publisher=_text(message.get("publisher")),
            volume=_text(message.get("volume")),
            issue=_text(message.get("issue")),
            pages=pages,
            issn=_typed(message, "ISSN"),
        )
    elif category == "conference":
        event = message.get("event") or {}
        start, end = _parts(event, "start"), _parts(event, "end")
        if start and len(start) == 3:
            # The presentation date is the conference's, not the proceedings'.
            record_date, date_note = _iso(start), None
        elif record_date:
            date_note = ("Crossref does not give the conference dates, so the presentation date is the date the "
                         "proceedings were published. Correct it to the day the paper was presented.")
        sponsors = [text for text in (_text(value) for value in event.get("sponsor") or []) if text]
        details.update(
            authors=authors,
            conference=_text(event.get("name")) or _book_of(containers),
            proceedings=_book_of(containers),
            venue=_text(event.get("location")),
            end_date=_iso(end) if end and len(end) == 3 and (not start or end >= start) else None,
            isbn=_typed(message, "ISBN") or _typed(message, "ISSN"),
            organiser="; ".join(sponsors) or None,
        )
    else:
        chapter = book_type == "Book chapter"
        book = _book_of(containers) if chapter else None
        details.update(
            book_type=book_type,
            book_title=book,
            authors=authors,
            publisher=_text(message.get("publisher")),
            isbn=_typed(message, "ISBN"),
            edition=None if chapter else _ordinal(message.get("edition-number")),
            pages=pages if chapter else None,
        )
        if chapter and any(_PROCEEDINGS.search(container) for container in containers):
            notes.append(
                f"Crossref files this as a chapter of “{book}”, which looks like conference proceedings. "
                "If the paper was presented at the conference, choose Conference paper instead."
            )

    if date_note:
        notes.insert(0, date_note)
    if too_many:
        notes.append(too_many)

    return {
        "doi": doi,
        "crossref_type": kind,
        "category": category,
        "title": title,
        "record_date": record_date,
        "outcome_status": outcome,
        "link": _text(message.get("URL")) or f"https://doi.org/{doi}",
        "abstract": _abstract(message.get("abstract")),
        "author_names": names,
        "notes": notes,
        "doi_fields": sorted(details),
        "details": {key: value for key, value in details.items() if value not in (None, "")},
    }


def lookup_doi(raw: str, *, client: httpx.Client | None = None) -> dict:
    doi = normalize_doi(raw)
    if not doi:
        raise DoiError("That does not look like a DOI. A DOI starts with 10., for example 10.1016/j.cell.2026.01.001.")

    cached = _CACHE.get(doi)
    if cached and time.monotonic() - cached[0] < _CACHE_SECONDS:
        return dict(cached[1])

    url = CROSSREF_URL.format(doi=quote(doi, safe="/"))
    try:
        owner = client or httpx.Client(timeout=TIMEOUT_SECONDS, follow_redirects=True)
        try:
            response = owner.get(url, headers={"User-Agent": _user_agent(), "Accept": "application/json"})
        finally:
            if client is None:
                owner.close()
    except httpx.HTTPError as error:
        logger.warning("crossref_unreachable doi=%s error=%s", doi, error)
        raise DoiError("Crossref could not be reached. Fill the details in by hand, or try again later.", 502) from None

    if response.status_code == 404:
        raise DoiError("Crossref has no record of that DOI. Check it, or fill the details in by hand.", 404)
    if response.status_code != 200:
        logger.warning("crossref_error doi=%s status=%s", doi, response.status_code)
        raise DoiError("Crossref could not answer just now. Fill the details in by hand, or try again later.", 502)

    try:
        message = response.json().get("message") or {}
    except ValueError:
        raise DoiError("Crossref sent an answer that could not be read.", 502) from None

    result = parse_crossref(message, doi)
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[doi] = (time.monotonic(), result)
    return dict(result)
