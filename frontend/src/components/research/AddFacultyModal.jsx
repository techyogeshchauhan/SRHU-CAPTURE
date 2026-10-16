import { useEffect, useState } from "react";

import Combobox from "../common/Combobox";
import Modal from "../teacher/Modal";
import { IconUserPlus } from "../teacher/icons";
import { addFaculty } from "../../services/research";
import { DESIGNATION_OPTIONS, MAX_DESIGNATION_LENGTH } from "../../utils/designations";

// No department: the platform serves one school (SST) and the server files
// every faculty member added here under it.
const EMPTY = { name: "", email: "", designation: "", phone: "", send_invite: false };

/**
 * The Event Manager adds a faculty member who has no account yet, without
 * leaving the research form. It creates the same Teacher account the Dean's
 * "Add teacher" does; an email that already belongs to a teacher simply
 * selects that teacher.
 *
 * `onAdded(faculty, message)` receives the person to select.
 */
export default function AddFacultyModal({ open, onClose, onAdded, initialName = "" }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Start from whatever was typed into the search box.
  useEffect(() => {
    if (open) {
      setForm({ ...EMPTY, name: initialName.includes("@") ? "" : initialName, email: initialName.includes("@") ? initialName : "" });
      setError("");
    }
  }, [open, initialName]);

  const set = (name, value) => setForm((prev) => ({ ...prev, [name]: value }));

  const save = async () => {
    setError("");
    if (!form.name.trim()) return setError("Enter the faculty member's name.");
    if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) return setError("Enter a valid email address.");
    setSaving(true);
    try {
      const body = await addFaculty({
        name: form.name.trim(),
        email: form.email.trim(),
        designation: form.designation.trim() || null,
        phone: form.phone.trim() || null,
        send_invite: form.send_invite,
      });
      onAdded(body.faculty, body.message);
    } catch (err) {
      setError(err?.message || "The faculty member could not be added.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !saving && onClose()}
      eyebrow="Add faculty member"
      title="Someone not in the list yet?"
      subtitle="Adds them as a teacher, so their research can be recorded. The Dean sees them on the Teachers page."
      zIndex={70}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="btn btn-ghost">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving} className="btn btn-primary">
            {saving ? <span className="spin h-4 w-4" /> : <IconUserPlus />}
            Add and select
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-4">
        <div className="field col-span-2">
          <label htmlFor="af-name">
            Full name<span className="req">*</span>
          </label>
          <input id="af-name" type="text" value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Dr. Kavita Negi" className="input" />
        </div>
        <div className="field col-span-2">
          <label htmlFor="af-email">
            Institutional email<span className="req">*</span>
          </label>
          <input id="af-email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="name@srhu.edu.in" className="input" />
          <p className="field-hint">Their sign-in email, if they are invited. Must not belong to another account.</p>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <Combobox
            id="af-designation"
            label={
              <>
                Designation<span className="ml-2 font-normal text-muted">(Optional)</span>
              </>
            }
            value={form.designation}
            onChange={(value) => set("designation", value.slice(0, MAX_DESIGNATION_LENGTH))}
            onSelect={(option) => set("designation", option.name)}
            options={DESIGNATION_OPTIONS}
            placeholder="e.g. Assistant Professor"
          />
        </div>
        <div className="field col-span-2 sm:col-span-1">
          <label htmlFor="af-phone">
            Mobile<span className="ml-2 font-normal text-muted">(Optional)</span>
          </label>
          <input id="af-phone" type="tel" inputMode="numeric" value={form.phone} maxLength={14} onChange={(e) => set("phone", e.target.value)} placeholder="10-digit mobile" className="input" />
        </div>
        <label className="col-span-2 flex cursor-pointer items-start gap-2.5 rounded-xl border hairline p-3 text-sm text-ink">
          <input type="checkbox" checked={form.send_invite} onChange={(e) => set("send_invite", e.target.checked)} className="mt-0.5 h-4 w-4 accent-accent" />
          <span>
            Email them an invitation to set a password
            <span className="block text-xs text-muted">
              So they can sign in, see their research and flag mistakes. Leave it off to only record their research for
              now — the Dean can invite them later.
            </span>
          </span>
        </label>
        {error && (
          <p className="field-error col-span-2" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
