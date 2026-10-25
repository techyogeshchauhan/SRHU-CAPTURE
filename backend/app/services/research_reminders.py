"""Which research records need an update, and why.

Pure rules over a record and today's date, so the list on the portfolio page
and the notifications that point at it say the same thing. Dates are
``"YYYY-MM-DD"`` strings compared as strings (see the domain rules); the
only arithmetic is on whole months, done on the year and month numbers.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.services.research_categories import get_category


@dataclass(frozen=True)
class Reminder:
    key: str          # stable per rule, for de-duplicating notifications
    message: str
    action: str       # "update" (edit the record) or "submit"


def _months_since(iso: str | None, today: date) -> int | None:
    if not iso or len(iso) < 10:
        return None
    try:
        year, month, day = int(iso[:4]), int(iso[5:7]), int(iso[8:10])
    except ValueError:
        return None
    months = (today.year - year) * 12 + (today.month - month)
    if today.day < day:
        months -= 1
    return months


def _days_since(stamp, today: date) -> int | None:
    if stamp is None:
        return None
    value = stamp.date() if hasattr(stamp, "date") else None
    if value is None:
        try:
            value = date.fromisoformat(str(stamp)[:10])
        except ValueError:
            return None
    return (today - value).days


def reminders_for(record: dict, today: date) -> list[Reminder]:
    """What this record is waiting on. Rejected records are left alone."""
    state = record.get("verification_status")
    if state == "rejected":
        return []

    found: list[Reminder] = []
    category = record.get("category")
    if get_category(category) is None:
        # Retired categories remain readable but no longer have actionable
        # reminders or edit flows.
        return []
    outcome = record.get("outcome_status")
    details = record.get("details") or {}
    started = record.get("record_date")
    today_iso = today.isoformat()

    if state == "changes_requested":
        waited = _days_since(record.get("updated_at"), today)
        if waited is not None and waited >= 7:
            found.append(Reminder(
                "changes-pending",
                f"The Dean asked for changes {waited} days ago and the record has not been resubmitted.",
                "update",
            ))
    elif state == "draft":
        idle = _days_since(record.get("updated_at"), today)
        if idle is not None and idle >= 30:
            found.append(Reminder(
                "draft-idle",
                f"This draft has not been touched for {idle} days. Finish it and send it to the Dean.",
                "submit",
            ))

    if category == "patent":
        if outcome == "filed":
            months = _months_since(started, today)
            if months is not None and months >= 18:
                found.append(Reminder(
                    "patent-publication",
                    f"Filed {months} months ago. Patents are usually published 18 months after filing "
                    "— has this one been published?",
                    "update",
                ))
        elif outcome == "published":
            months = _months_since(details.get("publication_date") or started, today)
            if months is not None and months >= 24:
                found.append(Reminder(
                    "patent-grant",
                    f"Published {months} months ago. Check whether the patent has been granted or refused.",
                    "update",
                ))
    # Journal and conference records now start at their final outcome; these
    # two reminders only ever fire for older records.
    elif category == "journal" and outcome in ("accepted", "in_press"):
        months = _months_since(started, today)
        if months is not None and months >= 6:
            found.append(Reminder(
                "journal-published",
                "Accepted over six months ago. If the paper is out, update it to Published with its volume and pages.",
                "update",
            ))
    elif category == "conference" and outcome == "accepted":
        last_day = details.get("end_date") or started
        if last_day and last_day < today_iso:
            found.append(Reminder(
                "conference-presented",
                "The conference date has passed. Mark the paper as presented.",
                "update",
            ))
    elif category == "book" and outcome == "accepted":
        months = _months_since(started, today)
        if months is not None and months >= 12:
            found.append(Reminder(
                "book-published",
                "Accepted over a year ago. If it has been published, add the ISBN and update its status.",
                "update",
            ))
    return found
