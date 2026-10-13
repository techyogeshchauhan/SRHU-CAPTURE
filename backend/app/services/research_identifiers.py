"""The keys two research records can be recognised as the same work by.

Each record stores ``identifiers``: normalised strings such as
``"doi:10.1016/j.x.2026.01.001"`` or ``"patent-app:202611012345"``, with a
multikey index, so finding other records that claim the same work is one
``{"identifiers": {"$in": [...]}}`` query.

A match is a *warning*, never a refusal: a co-authored paper is legitimately
recorded once for each SRHU author, and the Dean is shown "also claimed by"
rather than an error.

Some identifiers are deliberately not keys. A conference's proceedings ISBN
and a book chapter's ISBN are shared by every paper or chapter in the volume,
so a chapter is keyed by its ISBN *and* its own title.
"""

from __future__ import annotations

import re
from urllib.parse import unquote

# A DOI wherever it sits in what was typed or pasted: "10.1038/nature14539",
# "doi:10.1038/…", "DOI: https://doi.org/10.1038/…", a publisher's page such
# as "https://dl.acm.org/doi/10.1145/…", or a sentence around it.
_DOI_IN_TEXT = re.compile(r"10\.\d{4,9}/[^\s\"'<>]+")
_DOI = re.compile(r"^10\.\d{4,9}/\S+$")
_NATURE_ARTICLE = re.compile(r"\bnature\.com/articles/([A-Za-z0-9][A-Za-z0-9.\-]*[A-Za-z0-9])", re.I)
# Closing brackets are part of a DOI only when it opened them
# (10.1016/S0140-6736(20)30183-5); otherwise they close the sentence.
_PAIRS = {")": "(", "]": "[", "}": "{"}

# Fewer words than this make a title too generic to call two records the same
# ("Editorial", "Annual report").
_MIN_TITLE_WORDS = 4

# identifier prefix -> how a person reads it
MATCH_LABELS = {
    "doi": "DOI",
    "isbn": "ISBN",
    "chapter": "ISBN and chapter title",
    "patent-app": "Patent application number",
    "patent": "Patent number",
    "sanction": "Sanction order number",
    "title": "Title",
}


def normalize_doi(value) -> str | None:
    """The DOI in `value`, lower-cased (DOIs are case-insensitive), or None.

    Found anywhere in the text, so a full doi.org link, a "DOI:" label or a
    publisher's URL all give the bare DOI. From a link, the query string and
    fragment are not part of it; nor is punctuation that ends a sentence.
    """
    text = unquote(str(value or "").strip())
    match = _DOI_IN_TEXT.search(text)
    if not match:
        # Nature's article pages carry the DOI's suffix, not the DOI itself:
        # nature.com/articles/nature14236 is 10.1038/nature14236.
        nature = _NATURE_ARTICLE.search(text)
        return f"10.1038/{nature.group(1).lower()}" if nature else None
    doi = match.group(0)
    if "://" in text or text.lower().startswith("www."):
        doi = re.split(r"[?#]", doi, maxsplit=1)[0]
    while doi and (
        doi[-1] in ".,;:!?'\""
        or (doi[-1] in _PAIRS and doi.count(doi[-1]) > doi.count(_PAIRS[doi[-1]]))
    ):
        doi = doi[:-1]
    doi = doi.lower()
    return doi if _DOI.match(doi) else None


def normalize_isbn(value) -> str | None:
    text = re.sub(r"[^0-9Xx]", "", str(value or "")).upper()
    return text if len(text) in (10, 13) else None


def normalize_number(value) -> str | None:
    text = re.sub(r"[^0-9A-Za-z]", "", str(value or "")).upper()
    return text if len(text) >= 4 else None


def title_key(value) -> str | None:
    words = re.findall(r"[a-z0-9]+", str(value or "").lower())
    return " ".join(words) if len(words) >= _MIN_TITLE_WORDS else None


def identifiers_of(category: str | None, title: str | None, details: dict | None) -> list[str]:
    """Every key the record can be matched on, most specific first."""
    details = details or {}
    keys: list[str] = []

    def add(prefix: str, value: str | None) -> None:
        if value and f"{prefix}:{value}" not in keys:
            keys.append(f"{prefix}:{value}")

    add("doi", normalize_doi(details.get("doi")))

    if category == "patent":
        add("patent-app", normalize_number(details.get("application_number")))
        add("patent", normalize_number(details.get("patent_number")))
    elif category == "book":
        isbn = normalize_isbn(details.get("isbn"))
        if details.get("book_type") == "Book chapter":
            chapter = title_key(title)
            if isbn and chapter:
                add("chapter", f"{isbn}:{chapter}")
        else:
            add("isbn", isbn)

    if category != "other":
        key = title_key(title)
        if key:
            add("title", f"{category}:{key}")
    return keys


def match_label(identifier: str) -> str:
    return MATCH_LABELS.get(identifier.split(":", 1)[0], "Identifier")
