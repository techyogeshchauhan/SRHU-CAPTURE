import { apiJson } from "./api";
import { eventReportRestriction } from "../utils/eventReportEligibility";

/** Reuse role-authorized detail/upload routes; never infer availability from
 * list rows, which intentionally omit optional fields and upload contents. */
export async function loadReportSections(ids, apiBase, signal) {
  const entries = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const index = next++;
      const base = `${apiBase}/events/${encodeURIComponent(ids[index])}`;
      const data = await apiJson(base, { signal });
      if (!data?.event) throw new Error("Event information could not be loaded.");
      if (apiBase === "/event-manager") {
        const reason = eventReportRestriction(data.event);
        if (reason) throw new Error(reason);
      }
      if (apiBase === "/dean") {
        const [media, documents] = await Promise.all([
          apiJson(`${base}/media`, { signal }),
          apiJson(`${base}/documents`, { signal }),
        ]);
        entries[index] = { event: data.event, media: media.media || [], documents: documents.documents || [] };
      } else {
        entries[index] = { event: data.event, media: data.media || [], documents: data.documents || [] };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ids.length, 5) }, worker));
  return entries;
}
