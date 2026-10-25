"""The research numbers behind the Dean's (and the Event Manager's) charts.

A pure function over records the router has already read: no aggregation
pipeline, so the route stays testable against the collection fakes (see the
API conventions), and the research collection is small -- a few records per
faculty member per year.
"""

from __future__ import annotations

from collections import Counter, defaultdict

from app.services.research_categories import CATEGORIES

TOP_CONTRIBUTORS = 10


def faculty_rows(records: list[dict], people: dict[str, dict]) -> list[dict]:
    """Every faculty member with at least one record -- their own or one they
    co-authored -- most records first: their total and their count per
    category. ``people`` as below."""
    by_faculty: dict[str, Counter] = defaultdict(Counter)
    for record in records:
        # A co-authored paper counts for each of its SRHU authors.
        first = record.get("faculty_id")
        authors = dict.fromkeys(str(fid) for fid in [first, *(record.get("co_faculty_ids") or [])] if fid)
        for faculty_id in authors:
            by_faculty[faculty_id][record.get("category") or "other"] += 1

    rows = []
    for faculty_id, counter in by_faculty.items():
        person = people.get(faculty_id) or {}
        rows.append({
            "faculty_id": faculty_id,
            "name": person.get("name") or "Unknown",
            "email": person.get("email"),
            "designation": person.get("designation"),
            "total": sum(counter.values()),
            **{key: counter.get(key, 0) for key in CATEGORIES},
        })
    rows.sort(key=lambda row: (-row["total"], row["name"].casefold()))
    return rows


def compute_analytics(records: list[dict], people: dict[str, dict]) -> dict:
    """``people`` maps faculty id -> {"name"}.

    No department breakdown: the platform serves one school (SST), so it
    would always be a single row. Contributors are the per-person view.
    """
    by_category: Counter = Counter()
    by_year: dict[str, Counter] = defaultdict(Counter)
    patents: Counter = Counter()
    indexing: Counter = Counter()
    quartiles: Counter = Counter()
    other_kinds: Counter = Counter()

    for record in records:
        category = record.get("category") or "other"
        details = record.get("details") or {}
        outcome = record.get("outcome_status")

        by_category[category] += 1
        by_year[record.get("academic_year") or "Undated"][category] += 1

        if category == "patent":
            patents[outcome or "filed"] += 1
        elif category == "journal":
            for index in details.get("indexing") or []:
                indexing[index] += 1
            if details.get("quartile"):
                quartiles[details["quartile"]] += 1
        elif category == "other":
            other_kinds[details.get("kind") or "Other"] += 1

    def counts(counter: Counter) -> dict:
        return {key: counter.get(key, 0) for key in CATEGORIES}

    years = sorted((year for year in by_year if year != "Undated"))
    if "Undated" in by_year:
        years.append("Undated")

    faculty = faculty_rows(records, people)

    return {
        "total": len(records),
        "faculty_count": len(faculty),
        "by_category": counts(by_category),
        "by_year": [{"academic_year": year, **counts(by_year[year])} for year in years],
        "patents": {key: patents.get(key, 0) for key, _ in CATEGORIES["patent"].outcomes},
        "indexing": dict(indexing.most_common()),
        "quartiles": {q: quartiles.get(q, 0) for q in ("Q1", "Q2", "Q3", "Q4")},
        "other_kinds": dict(other_kinds.most_common()),
        "top_contributors": [
            {key: value for key, value in row.items() if key not in ("email", "designation")}
            for row in faculty[:TOP_CONTRIBUTORS]
        ],
    }
