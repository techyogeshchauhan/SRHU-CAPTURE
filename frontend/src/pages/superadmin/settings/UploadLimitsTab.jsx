import NumberLimitField from "../../../components/superadmin/settings/NumberLimitField";
import OptionalLimit from "../../../components/superadmin/settings/OptionalLimit";
import RequirementToggle from "../../../components/superadmin/settings/RequirementToggle";
import SettingsCard from "../../../components/superadmin/settings/SettingsCard";
import { IconCamera, IconFilm } from "../../../components/teacher/icons";

export default function UploadLimitsTab({ values, bounds, errors, disabled, onChange }) {
  const field = (name, props) => (
    <NumberLimitField
      id={name.replace(/_/g, "-")}
      name={name}
      bound={bounds[name]}
      value={values[name]}
      error={errors[name]}
      disabled={disabled}
      onChange={onChange}
      {...props}
    />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SettingsCard
        index={1}
        icon={<IconCamera />}
        eyebrow="Images & photographs"
        title="Photo upload limits"
        chip="JPEG, PNG, WebP, GIF"
        description="How many photos a teacher may attach to an event, and how large each one may be."
      >
        <RequirementToggle
          id="photos-required"
          noun="photo"
          value={values.photos_required}
          disabled={disabled}
          onChange={(on) => onChange("photos_required", on)}
        />

        {field("max_photos_per_event", {
          label: "Max photos per event",
          hint: "The number of images permitted for a single event.",
        })}

        {field("max_photo_size_mb", {
          label: "Max size per photo",
          unit: "MB",
          hint: "A photo larger than this is rejected at upload.",
        })}

        <OptionalLimit
          id="photo-total"
          label="Enforce a combined photo budget"
          offHint="Off: photos are limited by count and per-file size only."
          enabled={values.max_photo_total_mb !== null}
          disabled={disabled}
          onToggle={(on) =>
            onChange(
              "max_photo_total_mb",
              on ? String(values.max_photo_size_mb ?? bounds.max_photo_total_mb.min) : null,
            )
          }
        >
          {field("max_photo_total_mb", {
            label: "Combined size of all photos",
            unit: "MB",
            hint: "Must be at least the per-photo limit.",
          })}
        </OptionalLimit>
      </SettingsCard>

      <SettingsCard
        index={2}
        icon={<IconFilm />}
        eyebrow="Recordings & teasers"
        title="Video upload limits"
        chip="MP4, WebM, MOV"
        description="Videos are budgeted by combined size, so a teacher can choose between a few large files or many small ones."
      >
        <RequirementToggle
          id="videos-required"
          noun="video"
          value={values.videos_required}
          disabled={disabled}
          onChange={(on) => onChange("videos_required", on)}
        />

        <OptionalLimit
          id="video-count"
          label="Enforce a maximum video count"
          offHint="Off: any number of videos, as long as they fit the combined budget."
          enabled={values.max_videos_per_event !== null}
          disabled={disabled}
          onToggle={(on) =>
            onChange("max_videos_per_event", on ? String(bounds.max_videos_per_event.min) : null)
          }
        >
          {field("max_videos_per_event", {
            label: "Max videos per event",
            hint: "The number of individual video files permitted.",
          })}
        </OptionalLimit>

        {field("max_video_size_mb", {
          label: "Max size per video",
          unit: "MB",
          hint: "A video larger than this is rejected at upload.",
        })}

        {field("max_video_total_mb", {
          label: "Combined size of all videos",
          unit: "MB",
          hint: "The total budget across every video on one event.",
        })}
      </SettingsCard>
    </div>
  );
}
