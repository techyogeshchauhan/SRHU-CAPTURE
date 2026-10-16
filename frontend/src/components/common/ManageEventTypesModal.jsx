import { useEffect, useId, useState } from "react";

import Modal from "../teacher/Modal";
import {
  deleteEventType, getEventTypeUsage, listManageableEventTypes, renameEventType,
} from "../../services/directory";

export default function ManageEventTypesModal({ onClose, onChanged }) {
  const inputId = useId();
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("list");
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [usage, setUsage] = useState(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try { setTypes(await listManageableEventTypes()); }
    catch (err) { setError(err.message || "Could not load event types."); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let active = true;
    listManageableEventTypes()
      .then((rows) => { if (active) setTypes(rows); })
      .catch((err) => { if (active) setError(err.message || "Could not load event types."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const choose = async (type, action) => {
    setSelected(type);
    setMode(action);
    setName(type.name);
    setDestination("");
    setError("");
    setNotice("");
    setUsage(null);
    if (action === "delete") {
      setBusy(true);
      try { setUsage(await getEventTypeUsage(type.id)); }
      catch (err) { setError(err.message || "Could not check associated events."); }
      finally { setBusy(false); }
    }
  };

  const confirm = async () => {
    if (busy) return;
    if (mode === "edit" && !name.trim()) {
      setError("Enter an event type name."); return;
    }
    if (mode === "delete" && (!destination || !usage)) {
      setError("Choose where the associated events should move."); return;
    }
    setBusy(true);
    setError("");
    try {
      const result = mode === "edit"
        ? await renameEventType(selected.id, name.trim())
        : await deleteEventType(selected.id, destination === "uncategorized" ? null : destination);
      onChanged(result);
      setNotice(mode === "edit" ? "Event type updated." :
        `Event type deleted. ${result.events_moved} event(s) moved to ${result.event_type}.`);
      setMode("list");
      setSelected(null);
      await load();
    } catch (err) { setError(err.message || "Could not save the change. Please try again."); }
    finally { setBusy(false); }
  };

  const ownTypes = types.filter((type) => type.can_manage);
  return (
    <Modal open onClose={busy ? undefined : onClose} eyebrow="Event types"
      title={mode === "edit" ? "Edit event type" : mode === "delete" ? "Delete event type" : "Manage event types"}
      subtitle="Manage custom types you created. Changes apply to all events using the type."
      footer={mode === "list" ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={busy}>Done</button>
      ) : <>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy}
          onClick={() => { setMode("list"); setError(""); }}>Back</button>
        <button type="button" className={`btn ${mode === "delete" ? "btn-danger" : "btn-brand"} btn-sm`}
          disabled={busy || (mode === "delete" && (!destination || !usage))} onClick={confirm}>
          {busy ? "Please wait…" : mode === "edit" ? "Save changes" : "Move events and delete type"}
        </button>
      </>}
    >
      {error && <p role="alert" className="field-error mb-3">{error}</p>}
      {notice && <p role="status" className="prose-muted mb-3">{notice}</p>}
      {mode === "list" ? <>
        {loading ? <p role="status" className="prose-muted">Loading event types…</p> : error ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button>
        ) : ownTypes.length ? (
          <ul className="divide-y divide-line/10">
            {ownTypes.map((type) => <li key={type.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <span className="min-w-0 flex-1 break-words font-medium text-ink">{type.name}</span>
              <div className="flex shrink-0 gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => choose(type, "edit")}
                  aria-label={`Edit ${type.name}`}>Edit</button>
                <button type="button" className="btn btn-danger btn-sm" onClick={() => choose(type, "delete")}
                  aria-label={`Delete ${type.name}`}>Delete</button>
              </div>
            </li>)}
          </ul>
        ) : <p className="prose-muted">You have no custom event types yet. Add one using “+ Add event type”.</p>}
        <p className="prose-muted mt-4 text-xs">Built-in types and types created by other users cannot be edited or deleted here.</p>
      </> : mode === "edit" ? <div className="field">
        <label htmlFor={inputId}>Event type name</label>
        <input id={inputId} className="input" value={name} maxLength={60} autoFocus disabled={busy}
          onChange={(event) => setName(event.target.value)} />
        <p className="prose-muted text-xs">Associated events will use the updated name.</p>
      </div> : <div className="space-y-4">
        <p className="text-sm text-ink">Delete <strong className="break-words">{selected.name}</strong> after moving its associated events.</p>
        {busy && !usage ? <p role="status" className="prose-muted">Checking associated events…</p> : usage && (
          <p className="prose-muted">{usage.total} associated event(s). All current associations will be moved, including drafts and archived events.</p>
        )}
        {!busy && !usage && <button type="button" className="btn btn-ghost btn-sm"
          onClick={() => choose(selected, "delete")}>Retry event check</button>}
        <div className="field">
          <label htmlFor={inputId}>Move associated events to<span className="req">*</span></label>
          <select id={inputId} className="input" value={destination} disabled={busy || !usage}
            onChange={(event) => setDestination(event.target.value)}>
            <option value="">Select destination</option>
            <option value="uncategorized">Uncategorized</option>
            {types.filter((type) => type.id !== selected.id && type.name.toLowerCase() !== "uncategorized")
              .map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>
        </div>
        <p className="prose-muted text-xs">No events or uploaded files will be deleted. The type is removed only after all associated events have moved successfully.</p>
      </div>}
    </Modal>
  );
}
