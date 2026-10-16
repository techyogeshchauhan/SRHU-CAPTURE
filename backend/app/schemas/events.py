import json
from datetime import date, datetime
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field, field_validator, model_validator

from app.models.documents import NOTIFICATION_TYPES
from app.schemas.common import normalize_hhmm, normalize_phone

# Event dates and times are local campus wall-clock values, never UTC. The
# server runs in UTC, where between 18:30 and midnight IST "today" is already
# yesterday locally -- so comparing a teacher's date against a UTC today would
# reject an event they are creating for this evening.
CAMPUS_TZ = ZoneInfo("Asia/Kolkata")


def campus_now() -> datetime:
    """Now, in the campus's own timezone. Read per call, never cached."""
    return datetime.now(CAMPUS_TZ)


def future_schedule_error(
    event_date: str | None,
    start_time: str | None,
    end_date: str | None,
    end_time: str | None,
    now: datetime | None = None,
) -> str | None:
    """Why this schedule lies in the future, or None when it has already begun
    and ended.

    Events are recorded after they take place (backdated), so no part of the
    schedule may be later than now: not the start date or time, and not the
    end date or time. Every value is a canonical zero-padded string
    ("YYYY-MM-DD", "HH:MM"), so plain string comparison is correct and no
    Date/timezone maths is needed.
    """
    now = now or campus_now()
    today = now.strftime("%Y-%m-%d")
    current = now.strftime("%H:%M")

    if event_date and event_date > today:
        return "Event date cannot be in the future"
    if event_date == today and start_time and start_time > current:
        return "Start time cannot be in the future"

    last_day = end_date or event_date
    if last_day and last_day > today:
        return "End date cannot be in the future"
    if last_day == today and end_time and end_time > current:
        return "End time cannot be in the future"
    return None


def _validate_event_date(value: str) -> str:
    try:
        date.fromisoformat(value)
    except ValueError as error:
        raise ValueError("event_date must use the YYYY-MM-DD format") from error
    return value


def _validate_event_type(value: str) -> str:
    """Shape only -- the category list is data now, not an enum (PRD 4 / 14).

    Membership is resolved against the `event_types` collection in the router,
    which is also what adds a teacher's new category. Doing it here would mean
    a schema reaching into MongoDB, which the test fakes cannot stand in for.
    """
    normalized = " ".join((value or "").split())
    if not normalized:
        raise ValueError("Event type must not be empty")
    if len(normalized) > 60:
        raise ValueError("Event type must be at most 60 characters")
    if any(ord(char) < 32 for char in normalized):
        raise ValueError("Event type contains invalid characters")
    return normalized


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def normalize_social_url(url: str) -> str:
    """The one rule for social-post links, used for teacher and Dean input.

    ``www.example.com`` becomes ``https://www.example.com``; the result must be
    an http(s) URL with a host. Anything else -- ``javascript:``, ``data:``,
    a bare word with spaces -- is rejected with ValueError. The link is shown
    as an ``href`` on the Dean page and in the report PDF.
    """
    url = (url or "").strip()
    if not url:
        raise ValueError("Social Network Link is required")

    if not url.lower().startswith(("http://", "https://")):
        url = "https://" + url

    parsed = urlparse(url)
    try:
        parsed.port  # raises ValueError for a non-numeric port ("javascript:alert(1)")
    except ValueError as error:
        raise ValueError("Please enter a valid Social Network Link") from error

    host = parsed.hostname or ""
    if (
        parsed.scheme.lower() not in ("http", "https")
        or not host
        or any(char.isspace() or char in "<>\"`" for char in url)
    ):
        raise ValueError("Please enter a valid Social Network Link")
    return url


class EventCreateRequest(BaseModel):
    event_name: str = Field(min_length=1, max_length=200)
    event_date: str
    # The last day, for an event that runs over more than one. None (or the
    # same value as event_date) means it begins and ends on the same day.
    end_date: str | None = Field(default=None, max_length=10)
    event_type: str
    location: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)
    social_network_url: str | None = Field(default=None, max_length=2048)

    # Promoted out of the description's <!--CC_METADATA:--> blob. Times are
    # canonical zero-padded "HH:MM"; the contact is a bare 10-digit mobile and
    # is optional (PRD 5) -- an event may have no published contact number.
    start_time: str | None = Field(default=None, max_length=8)
    end_time: str | None = Field(default=None, max_length=8)
    organizer: str | None = Field(default=None, max_length=120)
    coordinator_contact: str | None = Field(default=None, max_length=24)

    # A draft is parked on the server so its photos, videos and documents can be
    # uploaded before the teacher is ready to submit. Drafts are excluded from
    # every dean view, so this never puts an unfinished event in front of them.
    save_as_draft: bool = False

    @field_validator("event_name", "location")
    @classmethod
    def strip_required(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Field must not be empty")
        return cleaned

    @field_validator("event_date")
    @classmethod
    def check_date(cls, value: str) -> str:
        return _validate_event_date(value)

    @field_validator("end_date")
    @classmethod
    def check_end_date(cls, value: str | None) -> str | None:
        cleaned = _clean_optional(value)
        return None if cleaned is None else _validate_event_date(cleaned)

    @field_validator("event_type")
    @classmethod
    def check_type(cls, value: str) -> str:
        return _validate_event_type(value)

    @field_validator("description")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("social_network_url")
    @classmethod
    def check_social_url(cls, value: str | None) -> str | None:
        cleaned = _clean_optional(value)
        return None if cleaned is None else normalize_social_url(cleaned)

    @field_validator("start_time")
    @classmethod
    def check_start_time(cls, value: str | None) -> str | None:
        return normalize_hhmm(value, field="Start time")

    @field_validator("end_time")
    @classmethod
    def check_end_time(cls, value: str | None) -> str | None:
        return normalize_hhmm(value, field="End time")

    @field_validator("organizer")
    @classmethod
    def clean_organizer(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("coordinator_contact")
    @classmethod
    def check_coordinator_contact(cls, value: str | None) -> str | None:
        return normalize_phone(value)

    @model_validator(mode="after")
    def check_schedule(self):
        """No future date or time (events are backdated), and the end must
        follow the start.

        Every value is a canonical zero-padded string ("YYYY-MM-DD", "HH:MM"),
        so plain comparison is correct and no Date/timezone maths is needed.
        """
        # Same day and "ends on event_date" are the same thing; storing None
        # for both keeps one representation in the database.
        if self.end_date and self.end_date == self.event_date:
            self.end_date = None

        if self.end_date and self.end_date < self.event_date:
            raise ValueError("End date cannot be before the start date")

        # The time order only constrains a single-day event. An event running
        # 18:00 on Friday to 02:00 on Saturday is perfectly ordinary, and
        # rejecting it is what made overnight events impossible to express.
        if (
            self.end_date is None
            and self.start_time
            and self.end_time
            and self.end_time <= self.start_time
        ):
            raise ValueError(
                "End time must be after start time for an event on a single day"
            )

        # Applies to drafts and edits too: an event is only ever created for
        # something that has already happened.
        error = future_schedule_error(
            self.event_date, self.start_time, self.end_date, self.end_time
        )
        if error:
            raise ValueError(error)

        return self


class EventUpdateRequest(EventCreateRequest):
    """Same fields as creation; a teacher edit always resubmits the event.

    The no-future rule applies exactly as on creation. A past date never
    needs an exemption: an event whose date has lapsed is the normal case.
    """


# The stored fields a draft must still satisfy EventCreateRequest with before
# a bulk action submits it without the form: the form re-checked them on every
# single submit, and a bulk submit must not skip that.
DRAFT_DETAIL_FIELDS = (
    "event_name", "event_date", "end_date", "event_type", "location", "description",
    "social_network_url", "start_time", "end_time", "organizer", "coordinator_contact",
)

# Events one bulk submit or delete from My Events may cover.
MAX_BULK_OWN_EVENTS = 500


class BulkEventIdsRequest(BaseModel):
    event_ids: list[str] = Field(min_length=1, max_length=MAX_BULK_OWN_EVENTS)


def draft_details_error(event: dict, request_type: type[EventCreateRequest] = EventCreateRequest) -> str | None:
    """Why a stored draft cannot be submitted as it stands, or None."""
    from pydantic import ValidationError

    try:
        fields = {key: event.get(key) for key in DRAFT_DETAIL_FIELDS}
        if "organizers" in request_type.model_fields:
            fields["organizers"] = event.get("organizers")
        request_type(**fields)
    except ValidationError as error:
        first = error.errors()[0]
        field = str(first["loc"][0]).replace("_", " ") if first.get("loc") else "details"
        message = str(first.get("msg", "")).removeprefix("Value error, ")
        return f"{field.capitalize()}: {message}" if first.get("loc") else message
    return None


# The only notifications a client may create for itself: the event-day
# reminders built by frontend/src/utils/notificationService.js. Every other
# type is raised by the server as the result of a real action.
CLIENT_NOTIFICATION_TYPES = ("reminder",)

# Serialized size cap for a client notification's `data`.
MAX_NOTIFICATION_DATA_BYTES = 4 * 1024


class NotificationCreateRequest(BaseModel):
    event_id: str | None = Field(default=None, max_length=64)
    notification_type: str = "reminder"
    title: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=2000)
    data: dict = Field(default_factory=dict)

    @field_validator("notification_type")
    @classmethod
    def check_type(cls, value: str) -> str:
        if value not in CLIENT_NOTIFICATION_TYPES or value not in NOTIFICATION_TYPES:
            raise ValueError(
                "Invalid notification type. Allowed values: " + ", ".join(CLIENT_NOTIFICATION_TYPES)
            )
        return value

    @field_validator("data")
    @classmethod
    def check_data_size(cls, value: dict) -> dict:
        try:
            size = len(json.dumps(value, default=str).encode("utf-8"))
        except (TypeError, ValueError, RecursionError) as error:
            raise ValueError("Notification data must be plain JSON") from error
        if size > MAX_NOTIFICATION_DATA_BYTES:
            raise ValueError(
                f"Notification data must be at most {MAX_NOTIFICATION_DATA_BYTES} bytes"
            )
        return value


class DeanBulkDeleteEventsRequest(BaseModel):
    """Events the Dean selected ("Select All Events") to delete together."""

    event_ids: list[str] = Field(min_length=1, max_length=5000)


class DeanBulkArchiveEventsRequest(BaseModel):
    """Events the Dean selected to archive together."""

    event_ids: list[str] = Field(min_length=1, max_length=5000)
    reason: str | None = Field(default=None, max_length=1000)


class DeanDecisionBody(BaseModel):
    """Optional JSON body for reject / revoke / request-changes; the query string
    parameters are still accepted."""

    rejection_reason: str | None = Field(default=None, max_length=5000)
    revocation_reason: str | None = Field(default=None, max_length=5000)
    remarks: str | None = Field(default=None, max_length=5000)
