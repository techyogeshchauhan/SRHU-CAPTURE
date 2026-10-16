/**
 * Draft Storage & Event Metadata Utilities for Campus Capture
 * Enables teacher draft management and lossless metadata encoding/decoding.
 */

const STORAGE_PREFIX = "cc_teacher_drafts_";

/**
 * Retrieve all drafts for the given teacher
 * @param {string} userId
 * @returns {Array}
 */
export function getTeacherDrafts(userId) {
  if (!userId || typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("Failed to read teacher drafts from storage:", err);
    return [];
  }
}

/**
 * Retrieve a specific draft by ID
 * @param {string} userId
 * @param {string} draftId
 * @returns {Object|null}
 */
export function getTeacherDraftById(userId, draftId) {
  if (!userId || !draftId) return null;
  const drafts = getTeacherDrafts(userId);
  return drafts.find((d) => d.id === draftId) || null;
}

/**
 * Save or update a draft for the given teacher
 * @param {string} userId
 * @param {Object} draftData
 * @returns {Object|null} Saved draft object, or null when it could not be
 *   written (storage full, private mode, blocked) -- callers must tell the
 *   user instead of claiming the draft was saved.
 */
export function saveTeacherDraft(userId, draftData) {
  if (!userId) throw new Error("User ID is required to save drafts");
  const drafts = getTeacherDrafts(userId);

  const now = new Date().toISOString();
  const draftId = draftData.id || `draft_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const cleanDraft = {
    id: draftId,
    teacher_id: userId,
    event_name: draftData.eventName?.trim() || draftData.event_name?.trim() || "Untitled Draft",
    event_date: draftData.eventDate || draftData.event_date || "",
    end_date: draftData.endDate || draftData.end_date || "",
    event_type: draftData.eventType || draftData.event_type || "",
    // What was typed under "Other" -- without it a reopened draft shows
    // "Other" with an empty box and cannot move past step 1.
    event_type_other: draftData.eventTypeOther?.trim() || draftData.event_type_other || "",
    location: draftData.location?.trim() || "",
    start_time: draftData.startTime || draftData.start_time || "",
    end_time: draftData.endTime || draftData.end_time || "",
    department: draftData.department?.trim() || "",
    organizer: draftData.organizer?.trim() || "",
    ...(Array.isArray(draftData.organizers) ? { organizers: [...draftData.organizers] } : {}),
    expected_participants: draftData.expectedParticipants || draftData.expected_participants || "",
    contact_info: draftData.contactInfo?.trim() || draftData.contact_info?.trim() || "",
    description: draftData.description || "",
    social_network_url: draftData.socialNetworkUrl?.trim() || draftData.social_network_url?.trim() || "",
    mediaFilesCount: draftData.mediaFiles?.length || draftData.mediaFilesCount || 0,
    documentFilesCount: draftData.documentFiles?.length || draftData.documentFilesCount || 0,
    status: "draft",
    created_at: draftData.created_at || now,
    updated_at: now,
  };

  const existingIndex = drafts.findIndex((d) => d.id === draftId);
  if (existingIndex >= 0) {
    drafts[existingIndex] = { ...drafts[existingIndex], ...cleanDraft };
  } else {
    drafts.unshift(cleanDraft);
  }

  try {
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(drafts));
  } catch (err) {
    console.error("Failed to persist draft to localStorage:", err);
    return null;
  }

  return cleanDraft;
}

/**
 * Delete a draft for the given teacher
 * @param {string} userId
 * @param {string} draftId
 * @returns {boolean}
 */
export function deleteTeacherDraft(userId, draftId) {
  if (!userId || !draftId) return false;
  const drafts = getTeacherDrafts(userId);
  const filtered = drafts.filter((d) => d.id !== draftId);
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${userId}`, JSON.stringify(filtered));
    return true;
  } catch (err) {
    console.error("Failed to delete draft from storage:", err);
    return false;
  }
}

/**
 * Encode extended event metadata cleanly into the description string
 * Uses a safe HTML comment tag <!--CC_METADATA:{...}--> so standard renderers ignore it
 * @param {string} baseDescription
 * @param {Object} metadata
 * @returns {string}
 */
export function encodeEventMetadata(baseDescription = "", metadata = {}) {
  const cleanBase = decodeEventMetadata(baseDescription || "").description;

  const payload = {
    startTime: metadata.startTime || metadata.start_time || "",
    endTime: metadata.endTime || metadata.end_time || "",
    department: metadata.department || "",
    organizer: metadata.organizer || "",
    expectedParticipants: metadata.expectedParticipants || metadata.expected_participants || "",
    contactInfo: metadata.contactInfo || metadata.contact_info || "",
  };

  // "\u002d" is a JSON escape for "-", so JSON.parse restores it, but the
  // stored text can never contain "-->" (or "--") inside the comment.
  const jsonStr = JSON.stringify(payload).replace(/--/g, "\\u002d\\u002d");
  return cleanBase ? `${cleanBase}\n\n<!--CC_METADATA:${jsonStr}-->` : `<!--CC_METADATA:${jsonStr}-->`;
}

const METADATA_OPEN = "<!--CC_METADATA:";
const METADATA_CLOSE = "-->";

/**
 * Locate the metadata comment and parse its JSON.
 *
 * New descriptions never contain "--" inside the JSON (see
 * encodeEventMetadata), but older ones may hold a raw "-->" inside a value.
 * So instead of stopping at the first "-->", try each "-->" in turn and take
 * the first candidate that parses as a JSON object.
 *
 * Returns { start, end, meta } (end is exclusive, and swallows the leading
 * whitespace before the block) or null.
 */
function findMetadataBlock(text) {
  const openAt = text.lastIndexOf(METADATA_OPEN);
  if (openAt < 0) return null;
  const jsonStart = openAt + METADATA_OPEN.length;

  let closeAt = text.indexOf(METADATA_CLOSE, jsonStart);
  while (closeAt >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart, closeAt));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        let start = openAt;
        while (start > 0 && /\s/.test(text[start - 1])) start -= 1;
        return { start, end: closeAt + METADATA_CLOSE.length, meta: parsed };
      }
    } catch {
      /* not the real end of the block yet */
    }
    closeAt = text.indexOf(METADATA_CLOSE, closeAt + 1);
  }
  return null;
}

/**
 * Decode extended event metadata from the description string
 * @param {string} rawDescription
 * @returns {{ description: string, meta: Object }}
 */
export function decodeEventMetadata(rawDescription = "") {
  if (!rawDescription || typeof rawDescription !== "string") {
    return {
      description: "",
      meta: {
        startTime: "",
        endTime: "",
        department: "",
        organizer: "",
        expectedParticipants: "",
        contactInfo: "",
      },
    };
  }

  const match = findMetadataBlock(rawDescription);
  let meta = {
    startTime: "",
    endTime: "",
    department: "",
    organizer: "",
    expectedParticipants: "",
    contactInfo: "",
  };

  if (match) {
    meta = { ...meta, ...match.meta };
  }

  const cleanDescription = (
    match
      ? rawDescription.slice(0, match.start) + rawDescription.slice(match.end)
      : rawDescription
  )
    .replace(/\s*<!--CC_METADATA:[\s\S]*?-->/g, "")
    .trim();

  return {
    description: cleanDescription,
    meta,
  };
}

/**
 * Duplicate an event (DB event or Draft) into a new Draft for the teacher
 * @param {string} userId
 * @param {Object} sourceEvent
 * @returns {Object} Newly created draft
 */
export function duplicateEventAsDraft(userId, sourceEvent) {
  if (!userId || !sourceEvent) {
    throw new Error("User ID and source event are required to duplicate an event");
  }

  const { description: cleanDesc, meta } = decodeEventMetadata(sourceEvent.description || "");

  const baseTitle = sourceEvent.event_name || sourceEvent.eventName || "Untitled Event";
  const newTitle = baseTitle.startsWith("Copy of ") ? `${baseTitle} (Copy)` : `Copy of ${baseTitle}`;

  const draftData = {
    eventName: newTitle,
    eventDate: sourceEvent.event_date || sourceEvent.eventDate || "",
    eventType: sourceEvent.event_type || sourceEvent.eventType || "",
    location: sourceEvent.location || "",
    startTime: meta.startTime || sourceEvent.start_time || sourceEvent.startTime || "",
    endTime: meta.endTime || sourceEvent.end_time || sourceEvent.endTime || "",
    department: meta.department || sourceEvent.department || "",
    organizer: meta.organizer || sourceEvent.organizer || "",
      ...(Array.isArray(sourceEvent.organizers) ? { organizers: [...sourceEvent.organizers] } : {}),
    expectedParticipants: meta.expectedParticipants || sourceEvent.expected_participants || sourceEvent.expectedParticipants || "",
    contactInfo: meta.contactInfo || sourceEvent.contact_info || sourceEvent.contactInfo || "",
    description: cleanDesc,
    socialNetworkUrl: sourceEvent.social_network_url || sourceEvent.socialNetworkUrl || "",
    status: "draft",
  };

  const saved = saveTeacherDraft(userId, draftData);
  if (!saved) {
    throw new Error("This browser could not store the draft (storage full or blocked).");
  }
  return saved;
}
