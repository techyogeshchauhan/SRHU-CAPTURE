import { formatDateRange, formatTime12h } from "../../utils/dates";
import { formatFileSize } from "../../utils/files";

/**
 * Everything the teacher filled in, laid out for a last read before submitting
 * (PRD 12).
 *
 * Takes the normalised shape `readEventFields()` produces rather than the
 * wizard's raw form state, so the same component can later show a saved event
 * read-only without a second set of prop names.
 *
 * Not built on EventMediaSections: that is a gallery with a lightbox viewer,
 * far heavier than a confirmation dialog needs.
 */

function Row({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 py-1.5">
      <dt className="prose-muted min-w-40 text-xs uppercase tracking-wide">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-ink">{value}</dd>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="border-t hairline pt-4 first:border-t-0 first:pt-0">
      <h4 className="rail-label mb-2">{title}</h4>
      {children}
    </section>
  );
}

function FileList({ files, emptyLabel }) {
  if (!files || files.length === 0) {
    return <p className="prose-muted text-xs">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1">
      {files.map((file) => (
        <li
          key={file.id || file.file_name}
          className="flex items-baseline justify-between gap-3 text-sm"
        >
          <span className="min-w-0 truncate text-ink">{file.file_name}</span>
          <span className="prose-muted shrink-0 text-xs">
            {formatFileSize(file.file_size)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EventSummary({
  event,
  fields,
  photos = [],
  videos = [],
  documents = [],
}) {
  const multiDay = Boolean(event.endDate && event.endDate !== event.eventDate);
  const timeRange =
    fields.startTime && fields.endTime
      ? `${formatTime12h(fields.startTime)} – ${formatTime12h(fields.endTime)}`
      : formatTime12h(fields.startTime) || "";

  return (
    <div className="space-y-5">
      <Section title="Event details">
        <dl>
          <Row label="Event name" value={event.eventName} />
          <Row label="Event type" value={event.eventType} />
          <Row label="Date" value={formatDateRange(event.eventDate, event.endDate)} />
          <Row
            label="Time"
            value={
              timeRange && multiDay
                ? `${timeRange} (the end time is on the final day)`
                : timeRange
            }
          />
          <Row label="Venue" value={event.location} />
          <Row label="Department" value={fields.department} />
          <Row label="No. of Participants" value={fields.expectedParticipants} />
          <Row label="Organizer" value={fields.organizer} />
          <Row label="Contact number" value={fields.contactInfo} />
          <Row label="Social network link" value={event.socialNetworkUrl} />
        </dl>
      </Section>

      <Section title="Description">
        {/* Shown in full and unwrapped: this is the last chance to catch a
            truncated or mangled description before the Dean reads it. */}
        <p className="whitespace-pre-wrap text-sm text-ink">
          {fields.description || event.description || "—"}
        </p>
      </Section>

      <Section title={`Photos (${photos.length})`}>
        {photos.length > 0 ? (
          <ul className="grid grid-cols-4 gap-2">
            {photos.map((photo) => (
              <li key={photo.id} className="overflow-hidden rounded-lg">
                <img
                  src={photo.preview_url || photo.media_url}
                  alt={photo.file_name}
                  loading="lazy"
                  className="h-16 w-full object-cover"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="prose-muted text-xs">No photos attached.</p>
        )}
      </Section>

      <Section title={`Videos (${videos.length})`}>
        <FileList files={videos} emptyLabel="No videos attached." />
      </Section>

      <Section title={`Documents (${documents.length})`}>
        <FileList files={documents} emptyLabel="No documents attached." />
      </Section>
    </div>
  );
}

export default EventSummary;
