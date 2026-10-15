"""Schemas for event reports and report customization."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator


class ReportCustomizationOptions(BaseModel):
    """Customization options for generating event reports."""

    include_basic_details: bool = Field(
        default=True,
        description="Include basic event details such as title, category/type, host department, coordinator, and organizer.",
    )
    include_schedule_venue: bool = Field(
        default=True,
        description="Include event dates, timings, and location/venue.",
    )
    include_description: bool = Field(
        default=True,
        description="Include event description and objectives.",
    )
    include_other_info: bool = Field(
        default=True,
        description="Include other event information such as No. of Participants and social media link.",
    )
    include_photos: bool = Field(
        default=True,
        description="Include event photographs and images.",
    )
    include_documents: bool = Field(
        default=True,
        description="Include uploaded notices, reports, and document attachments.",
    )
    include_notices: bool = Field(
        default=True,
        description="Include uploaded notice documents.",
    )
    include_reports: bool = Field(
        default=True,
        description="Include uploaded report documents.",
    )
    selected_photo_ids: list[str] | None = Field(
        default=None,
        description="Optional list of specific photo IDs to include.",
    )

    @model_validator(mode="before")
    @classmethod
    def sync_documents(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if data.get("include_documents") is False:
                if "include_notices" not in data:
                    data["include_notices"] = False
                if "include_reports" not in data:
                    data["include_reports"] = False
            elif data.get("include_notices") is False and data.get("include_reports") is False:
                data["include_documents"] = False
            elif data.get("include_notices") is True or data.get("include_reports") is True:
                data["include_documents"] = True
        return data


# The choices that each put something on the page. `include_documents` is the
# umbrella over notices and reports, so it is not a section of its own.
SECTION_KEYS = (
    "include_basic_details",
    "include_schedule_venue",
    "include_description",
    "include_other_info",
    "include_photos",
    "include_notices",
    "include_reports",
)


def normalize_customization(raw: ReportCustomizationOptions | dict | None) -> dict | None:
    """Every choice spelled out, with the documents umbrella reconciled.

    A partial dict (query flags, or a customization stored with an older
    report) goes through the model, so all three entry points -- JSON body,
    query string, stored report -- mean the same thing. None stays None: no
    customization is the full report.
    """
    if raw is None:
        return None
    if isinstance(raw, ReportCustomizationOptions):
        return raw.model_dump()
    return ReportCustomizationOptions.model_validate(dict(raw)).model_dump()


def has_any_section(options: dict) -> bool:
    return any(options.get(key, True) for key in SECTION_KEYS)
