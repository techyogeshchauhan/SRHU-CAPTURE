import { eventReportRestriction } from "../../utils/eventReportEligibility";
import { IconDownload } from "../teacher/icons";

/** One label and disabled behavior for every Event Manager report action. */
export default function EventReportButton({ event, onClick, generating = false, className = "btn btn-ghost btn-xs" }) {
  const reason = eventReportRestriction(event);
  return (
    <button
      type="button"
      onClick={reason ? undefined : onClick}
      disabled={generating || Boolean(reason)}
      className={className}
    >
      {generating ? <span className="spin h-3.5 w-3.5" /> : <IconDownload className="h-4 w-4" />}
      Download Report
    </button>
  );
}
