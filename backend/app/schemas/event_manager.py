"""Request bodies for the Event Manager role (routers/event_manager.py).

Event fields extend the shared teacher schema with multiple organizers.
"""

from typing import Annotated

from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.schemas.events import EventCreateRequest
from app.schemas.reports import ReportCustomizationOptions


OrganizerName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120, strict=True)]


class ManagedEventRequest(EventCreateRequest):
    """Create/edit fields, with legacy single-organizer request compatibility."""

    organizer: str | None = Field(default=None, max_length=2500)
    organizers: list[OrganizerName] | None = Field(default=None, min_length=1, max_length=20)

    @model_validator(mode="after")
    def normalize_organizers(self):
        names = self.organizers
        if names is None:
            if not self.organizer:
                raise ValueError("Select at least one organizer or faculty coordinator.")
            if len(self.organizer) > 120:
                raise ValueError("Each organizer name must be 120 characters or fewer.")
            names = [self.organizer]
        unique = {}
        for name in names:
            unique.setdefault(name.casefold(), name)
        self.organizers = list(unique.values())
        # All existing role/detail/report readers retain their string contract.
        # The array is authoritative when both representations are submitted.
        self.organizer = "; ".join(self.organizers)
        return self

# Photos in an event's report. The teacher or Event Manager ticks as many as
# they like while uploading; until they choose, the report shows the first
# DEFAULT_REPORT_PHOTOS uploaded. A choice can never name more photos than an
# event may hold, and the Super Admin's ceiling for that is 100.
DEFAULT_REPORT_PHOTOS = 4
MAX_REPORT_PHOTO_CHOICE = 100

# Events per consolidated report: bounds the work of one request and the size
# of the PDF.
MAX_EVENTS_PER_REPORT = 50


class ReportPhotosRequest(BaseModel):
    """Which photos go into the event's report, in order. Empty means none."""

    photo_ids: list[str] = Field(default_factory=list, max_length=MAX_REPORT_PHOTO_CHOICE)


class ManagedReportRequest(BaseModel):
    event_ids: list[str] = Field(min_length=1, max_length=MAX_EVENTS_PER_REPORT)
    customization: ReportCustomizationOptions | None = None


# Events one bulk delete may cover (the same ceiling as the Dean's).
MAX_BULK_DELETE_EVENTS = 5000


class ManagedBulkDeleteRequest(BaseModel):
    event_ids: list[str] = Field(min_length=1, max_length=MAX_BULK_DELETE_EVENTS)
