import { Link } from "react-router-dom";

import { IconUsers, IconX } from "../teacher/icons";

/**
 * Above a research list narrowed to one faculty member (?faculty=, from the
 * faculty-wise view): whose records these are, and the way out.
 */
export default function FacultyFilterNotice({ name, facultyWise, onClear }) {
  return (
    <div className="glass mt-4 flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm text-ink sm:px-5" role="status">
      <IconUsers className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        Showing the research of <span className="font-semibold">{name || "one faculty member"}</span>
      </span>
      <Link to={facultyWise} className="btn btn-ghost btn-xs">
        Faculty-wise
      </Link>
      <button type="button" onClick={onClear} className="btn btn-ghost btn-xs">
        <IconX />
        Show everyone
      </button>
    </div>
  );
}
