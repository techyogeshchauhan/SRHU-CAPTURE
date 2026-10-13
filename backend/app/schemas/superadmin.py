from typing import Any

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.config import settings
from app.utils.security import password_byte_error


class CreateDeanRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Name must not be empty")
        return normalized


class CreateEventManagerRequest(CreateDeanRequest):
    """Name and sign-in email; the Event Manager chooses their own password."""


# The single definition of every configurable upload bound. The Pydantic fields
# below derive their ge/le from this, and GET /superadmin/upload-limits serves it
# to the browser, so the ranges cannot drift between the form and the API.
LIMIT_BOUNDS: dict[str, dict[str, object]] = {
    "max_photos_per_event": {"min": 1, "max": 100, "unit": "count"},
    "max_photo_size_mb": {"min": 1, "max": 100, "unit": "mb"},
    "max_photo_total_mb": {"min": 1, "max": 1000, "unit": "mb", "nullable": True},
    "max_videos_per_event": {"min": 1, "max": 50, "unit": "count", "nullable": True},
    "max_video_size_mb": {"min": 1, "max": 1000, "unit": "mb"},
    "max_video_total_mb": {"min": 1, "max": 2000, "unit": "mb"},
    "max_documents_per_event": {"min": 1, "max": 200, "unit": "count"},
    "max_documents_total_mb": {"min": 1, "max": 500, "unit": "mb"},
}

# Per-file ceilings the deployment must be able to physically accept. Documents
# have no per-file cap by design (PRD 9), so their combined budget is also the
# largest single document, which is why it appears here.
PER_FILE_LIMIT_FIELDS = (
    "max_photo_size_mb",
    "max_video_size_mb",
    "max_documents_total_mb",
)


def _bounded(name: str, description: str, *, nullable: bool = False) -> Any:
    """Build a Field from LIMIT_BOUNDS so the range lives in exactly one place."""
    bound = LIMIT_BOUNDS[name]
    kwargs: dict[str, Any] = {
        "ge": bound["min"],
        "le": bound["max"],
        "description": description,
    }
    if nullable:
        kwargs["default"] = None
    return Field(**kwargs)


class UploadLimitsUpdateRequest(BaseModel):
    max_photos_per_event: int = _bounded(
        "max_photos_per_event", "Max number of photos allowed per event"
    )
    max_photo_size_mb: int = _bounded(
        "max_photo_size_mb", "Max size per photo in MB"
    )
    max_photo_total_mb: int | None = _bounded(
        "max_photo_total_mb",
        "Max total combined size for photos in MB (null = no combined budget)",
        nullable=True,
    )
    max_videos_per_event: int | None = _bounded(
        "max_videos_per_event",
        "Max number of videos allowed per event (null = no count cap)",
        nullable=True,
    )
    max_video_size_mb: int = _bounded(
        "max_video_size_mb", "Max size per video in MB"
    )
    max_video_total_mb: int = _bounded(
        "max_video_total_mb", "Max total combined size for videos in MB"
    )
    max_documents_per_event: int = _bounded(
        "max_documents_per_event", "Max number of documents allowed per event"
    )
    max_documents_total_mb: int = _bounded(
        "max_documents_total_mb",
        "Max total combined size for documents in MB; also the largest single document",
    )
    photos_required: bool = Field(
        default=True, description="At least one photo is needed to submit an event"
    )
    videos_required: bool = Field(
        default=False, description="At least one video is needed to submit an event"
    )
    documents_required: bool = Field(
        default=True, description="At least one document is needed to submit an event"
    )

    @model_validator(mode="after")
    def validate_relationships(self) -> "UploadLimitsUpdateRequest":
        if (
            self.max_photo_total_mb is not None
            and self.max_photo_total_mb < self.max_photo_size_mb
        ):
            raise ValueError(
                "Max total photo size cannot be less than single photo size limit"
            )
        if self.max_video_size_mb > self.max_video_total_mb:
            raise ValueError(
                "Max single video size cannot be greater than total video size limit"
            )

        # The per-file caps configured here replace the global backstop on the
        # upload path (stream_upload receives them as max_bytes), so a value above
        # MAX_UPLOAD_SIZE_MB would promise teachers an upload the deployment
        # cannot physically accept.
        ceiling = settings.max_upload_size_mb
        for field in PER_FILE_LIMIT_FIELDS:
            value = getattr(self, field)
            if value is not None and value > ceiling:
                raise ValueError(
                    f"{field} cannot exceed the deployment upload ceiling of {ceiling} MB"
                )
        return self


class UpdateUserProfileRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=24)
    department: str | None = Field(default=None, max_length=120)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Name must not be empty")
        return normalized

    @field_validator("phone")
    @classmethod
    def normalize_phone_field(cls, value: str | None) -> str | None:
        from app.schemas.common import normalize_phone
        return normalize_phone(value)


class ResetUserPasswordRequest(BaseModel):
    new_password: str | None = Field(default=None, min_length=8, max_length=128)

    @field_validator("new_password")
    @classmethod
    def check_password(cls, value: str | None) -> str | None:
        """Reject a password bcrypt cannot fully use (over 72 UTF-8 bytes).

        max_length counts characters, so 30 Hindi letters or emoji pass it and
        then raise ValueError inside hash_password -- which this route does not
        catch, turning a bad input into a 500. Every other schema that accepts
        a chosen password runs this same check.
        """
        if value is None:
            return None
        error = password_byte_error(value)
        if error:
            raise ValueError(error)
        return value


class BulkOnboardTeacherItem(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    department: str | None = Field(default=None, max_length=120)

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        normalized = " ".join(value.split())
        if not normalized:
            raise ValueError("Name must not be empty")
        return normalized


# Teachers one bulk onboard (JSON or CSV file) may create.
MAX_BULK_TEACHERS = 500


class BulkOnboardTeachersRequest(BaseModel):
    teachers: list[BulkOnboardTeacherItem] = Field(min_length=1, max_length=MAX_BULK_TEACHERS)
    send_email: bool = Field(default=True)


class SendCredentialsRequest(BaseModel):
    user_ids: list[str] = Field(min_length=1, max_length=500)


