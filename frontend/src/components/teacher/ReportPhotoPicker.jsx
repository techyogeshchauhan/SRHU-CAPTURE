import { useState } from "react";

import { saveReportPhotos } from "../../services/eventManager";
import { IconCamera, IconSave } from "./icons";

/**
 * Which photos -- as many as are ticked -- go into the event's report: the
 * Event Manager's own report, or the Dean's report for a teacher's event.
 * Shown on the event page to change the choice made while uploading; the
 * server defaults to the first photos uploaded until a choice is saved.
 */
export default function ReportPhotoPicker({ eventId, api, photos, initial, onSaved, onError }) {
  const [chosen, setChosen] = useState(initial || []);
  const [saved, setSaved] = useState(initial || []);
  const [saving, setSaving] = useState(false);

  const changed = chosen.length !== saved.length || chosen.some((id, i) => id !== saved[i]);

  const toggle = (id) =>
    setChosen((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      return [...current, id];
    });

  const save = async () => {
    try {
      setSaving(true);
      const result = await saveReportPhotos(eventId, chosen, api);
      const ids = result?.report_photo_ids || chosen;
      setSaved(ids);
      setChosen(ids);
      onSaved?.(ids);
    } catch (err) {
      onError?.(err?.message || "Could not save the report photos.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass mt-6 overflow-hidden" aria-labelledby="report-photos-heading">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b hairline px-6 py-4">
        <div>
          <p className="eyebrow">Report</p>
          <h2 id="report-photos-heading" className="h3 mt-1 text-ink">Photos in the report</h2>
          <p className="prose-muted mt-0.5 text-xs">
            Tick as many photos as you like: {chosen.length} of {photos.length} chosen.
            The report keeps each photo's shape and arranges them to fit together.
          </p>
        </div>
        {changed && (
          <button type="button" onClick={save} disabled={saving} className="btn btn-brand btn-sm">
            {saving ? <span className="spin h-3.5 w-3.5" /> : <IconSave />}
            Save report photos
          </button>
        )}
      </div>

      {photos.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-8 text-center">
          <span className="icon-tile mb-3 h-11 w-11 rounded-xl">
            <IconCamera className="h-5 w-5" />
          </span>
          <p className="prose-muted text-sm">No photos uploaded for this event.</p>
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 lg:grid-cols-5">
          {photos.map((photo) => {
            const position = chosen.indexOf(photo.id) + 1;
            const inReport = position > 0;
            return (
              <li
                key={photo.id}
                className={`overflow-hidden rounded-xl border bg-raised/30 ${
                  inReport ? "border-accent ring-2 ring-accent/30" : "hairline"
                }`}
              >
                <img
                  src={photo.media_url}
                  alt={photo.file_name}
                  className="h-28 w-full object-cover"
                  loading="lazy"
                />
                <label className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={inReport}
                    disabled={saving}
                    onChange={() => toggle(photo.id)}
                    aria-label={`Show ${photo.file_name} in the report`}
                    className="h-3.5 w-3.5 rounded border-line text-accent focus:ring-accent"
                  />
                  {inReport ? `In report (${position})` : "In report"}
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
