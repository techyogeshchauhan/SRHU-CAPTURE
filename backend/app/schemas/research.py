"""Request bodies for the research portfolio.

Shape only. Which fields a category has, and which of them are required, is
checked by the router against app/services/research_categories.py; who the
record belongs to is resolved against the users collection there too -- a
validator must never touch MongoDB.
"""

from __future__ import annotations

import re
from datetime import date

from pydantic import BaseModel, Field, field_validator

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# A paper's SRHU authors besides the one the record belongs to.
MAX_CO_AUTHORS = 20
_URL = re.compile(r"^https?://\S+$", re.I)


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text or None


def _clean_date(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if not _ISO_DATE.match(text):
        raise ValueError("Use a date in the form YYYY-MM-DD.")
    try:
        date.fromisoformat(text)
    except ValueError:
        raise ValueError("That date does not exist.") from None
    return text


def _clean_link(value: str | None) -> str | None:
    text = (value or "").strip()
    if not text:
        return None
    if not _URL.match(text):
        raise ValueError("The link must start with http:// or https://.")
    return text


class _RecordFields(BaseModel):
    title: str | None = Field(default=None, max_length=400)
    record_date: str | None = None
    outcome_status: str | None = Field(default=None, max_length=40)
    details: dict | None = None
    link: str | None = Field(default=None, max_length=600)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: str | None) -> str | None:
        return _clean_text(value)

    @field_validator("record_date")
    @classmethod
    def check_date(cls, value: str | None) -> str | None:
        return _clean_date(value)

    @field_validator("link")
    @classmethod
    def check_link(cls, value: str | None) -> str | None:
        return _clean_link(value)


class ResearchCreateRequest(_RecordFields):
    category: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=400)
    # Whose research it is. An Event Manager names a teacher; a teacher may
    # leave it out (it is always themselves).
    faculty_id: str | None = Field(default=None, max_length=40)
    # Other SRHU teachers who are authors (inventors, investigators) of the
    # same work. Only the Event Manager names them.
    co_faculty_ids: list[str] | None = Field(default=None, max_length=MAX_CO_AUTHORS)

    @field_validator("title")
    @classmethod
    def check_required_title(cls, value: str) -> str:
        text = _clean_text(value)
        if not text:
            raise ValueError("Give the record a title.")
        return text


class ResearchUpdateRequest(_RecordFields):
    co_faculty_ids: list[str] | None = Field(default=None, max_length=MAX_CO_AUTHORS)
    # The record's updated_at as the editor last saw it. When given, a save
    # over someone else's newer change is refused rather than overwriting it:
    # the Event Manager and the teacher can both edit the same record.
    expected_updated_at: str | None = Field(default=None, max_length=64)


class DeanRemarksRequest(BaseModel):
    remarks: str | None = Field(default=None, max_length=2000)

    @field_validator("remarks")
    @classmethod
    def check_remarks(cls, value: str | None) -> str | None:
        text = (value or "").strip()
        return text or None


class RequiredRemarksRequest(BaseModel):
    remarks: str = Field(min_length=1, max_length=2000)

    @field_validator("remarks")
    @classmethod
    def check_remarks(cls, value: str) -> str:
        text = (value or "").strip()
        if len(text) < 3:
            raise ValueError("Say what needs to change (at least a few words).")
        return text


class ResearchBulkVerifyRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)


class ResearchBulkDeleteRequest(BaseModel):
    """The ids of records selected for one bulk delete action."""

    ids: list[str] = Field(min_length=1, max_length=500)


class ResearchBulkRecordRequest(BaseModel):
    """The Event Manager's bulk record action: selected record ids."""

    ids: list[str] = Field(min_length=1, max_length=500)


class CorrectionFlagRequest(BaseModel):
    note: str = Field(min_length=1, max_length=1000)

    @field_validator("note")
    @classmethod
    def check_note(cls, value: str) -> str:
        text = (value or "").strip()
        if len(text) < 3:
            raise ValueError("Say what is wrong with the record.")
        return text


class DuplicateCheckRequest(BaseModel):
    category: str = Field(min_length=1, max_length=40)
    title: str | None = Field(default=None, max_length=400)
    details: dict | None = None
    # The record being edited, so it is not reported as its own duplicate.
    exclude_id: str | None = Field(default=None, max_length=40)
    faculty_id: str | None = Field(default=None, max_length=40)


class ResearchImportRequest(BaseModel):
    """The rows a preview accepted, sent back to be created. Each is checked
    again on the server; nothing from the preview is trusted."""

    rows: list[dict] = Field(min_length=1, max_length=500)


class ShowcaseCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=5000)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: str) -> str:
        text = _clean_text(value)
        if not text:
            raise ValueError("Give the showcase a title.")
        return text

    @field_validator("description")
    @classmethod
    def check_description(cls, value: str | None) -> str | None:
        text = (value or "").strip()
        return text or None


class ShowcaseUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    record_ids: list[str] | None = Field(default=None, max_length=200)
    highlight_ids: list[str] | None = Field(default=None, max_length=200)

    @field_validator("title")
    @classmethod
    def check_title(cls, value: str | None) -> str | None:
        return _clean_text(value)

    @field_validator("description")
    @classmethod
    def check_description(cls, value: str | None) -> str | None:
        text = (value or "").strip()
        return text or None
