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
    by_faculty: dict[str, Counter] = defaultdict(Counter)
    other_kinds: Counter = Counter()

    for record in records:
        category = record.get("category") or "other"
        details = record.get("details") or {}
        outcome = record.get("outcome_status")
        faculty_id = str(record.get("faculty_id") or "")

        by_category[category] += 1
        by_year[record.get("academic_year") or "Undated"][category] += 1
        by_faculty[faculty_id][category] += 1

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

    contributors = sorted(
        by_faculty.items(),
        key=lambda item: (-sum(item[1].values()), (people.get(item[0]) or {}).get("name") or ""),
    )[:TOP_CONTRIBUTORS]

    return {
        "total": len(records),
        "faculty_count": len([fid for fid in by_faculty if fid]),
        "by_category": counts(by_category),
        "by_year": [{"academic_year": year, **counts(by_year[year])} for year in years],
        "patents": {key: patents.get(key, 0) for key, _ in CATEGORIES["patent"].outcomes},
        "indexing": dict(indexing.most_common()),
        "quartiles": {q: quartiles.get(q, 0) for q in ("Q1", "Q2", "Q3", "Q4")},
        "other_kinds": dict(other_kinds.most_common()),
        "top_contributors": [
            {
                "faculty_id": faculty_id,
                "name": (people.get(faculty_id) or {}).get("name") or "Unknown",
                "total": sum(counter.values()),
                **counts(counter),
            }
            for faculty_id, counter in contributors
        ],
    }
