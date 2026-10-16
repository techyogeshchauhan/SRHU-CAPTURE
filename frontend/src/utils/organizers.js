export const MAX_ORGANIZERS = 20;
export const MAX_ORGANIZER_NAME_LENGTH = 120;

export function normalizeOrganizers(names = []) {
  const seen = new Set();
  return names.filter((name) => {
    const key = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((name) => name.trim());
}

export const organizerLabel = (names) => normalizeOrganizers(names).join("; ");

export function organizersOf(event = {}, legacyName = event.organizer || "") {
  // Commas and semicolons can belong to a legacy name; never split it.
  return normalizeOrganizers(Array.isArray(event.organizers) && event.organizers.length ? event.organizers : legacyName ? [legacyName] : []);
}
