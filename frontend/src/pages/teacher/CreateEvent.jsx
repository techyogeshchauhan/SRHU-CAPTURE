import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { apiJson, isAbortError } from "../../services/api";
import { uploadEventFile } from "../../services/directUpload";
import { fetchCurrentUser, signOut } from "../../services/auth";
import { canTeacherEditEvent, getRefusalReason } from "../../utils/constants";
import {
  compareHHmm,
  localDateKey,
  nowHHmm,
} from "../../utils/dates";
import {
  getTeacherDraftById,
  saveTeacherDraft,
  deleteTeacherDraft,
  encodeEventMetadata,
} from "../../utils/draftStorage";
import { DEFAULT_HOST_DEPARTMENT, readEventFields } from "../../utils/eventFields";
import {
  DOC_ACCEPT,
  IMAGE_ACCEPT,
  VIDEO_ACCEPT,
  formatMb,
  limitFor,
  usedBytes,
  validatePick,
} from "../../utils/uploadRules";
import useUploadLimits from "../../hooks/useUploadLimits";
import { checkUploadNames } from "../../services/directory";
import { DEFAULT_REPORT_PHOTOS, saveReportPhotos } from "../../services/eventManager";
import Combobox from "../../components/common/Combobox";
import EventSummary from "../../components/common/EventSummary";
import EventTypeSelect from "../../components/common/EventTypeSelect";
import DateInputDMY from "../../components/common/DateInputDMY";
import TimePicker12h from "../../components/common/TimePicker12h";
import { normalizePhoneInput } from "../../utils/phone";
import useEventTypes from "../../hooks/useEventTypes";
import {
  createFacultyCoordinator,
  listFacultyCoordinators,
} from "../../services/directory";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import Modal from "../../components/teacher/Modal";
import RequirementNotice from "../../components/teacher/RequirementNotice";
import UploadPanel from "../../components/teacher/UploadPanel";
import useMediaRefresh from "../../components/common/useMediaRefresh";
import StatusChip from "../../components/teacher/StatusChip";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBookmark,
  IconCheck,
  IconCheckCircle,
  IconFilm,
  IconImagePlus,
  IconInfo,
  IconLayers,
} from "../../components/teacher/icons";

// Whether an upload step is mandatory is a Super Admin setting, so it is read
// from the upload limits at render time rather than fixed here.
const STEPS = [
  { key: "details", label: "Details", Icon: IconLayers },
  { key: "images_and_documents", label: "Images & Documents", Icon: IconImagePlus },
  { key: "videos", label: "Videos", Icon: IconFilm },
];

const REQUIRED_DETAILS = [
  ["eventName", "Please enter the event name."],
  ["eventDate", "Please select the event start date."],
  ["endDate", "Please select the event end date."],
  ["eventType", "Please select the event type."],
  ["startTime", "Please specify the event start time."],
  ["endTime", "Please specify the event end time."],
  ["location", "Please enter the venue / location."],
  ["organizer", "Please enter the organizer or faculty coordinator name."],
  ["description", "Please provide a description for the event."],
];

let uploadKeySeed = 0;

const EMPTY_FORM = {
  eventName: "",
  eventDate: "",
  // Default matches eventDate for same-day events.
  endDate: "",
  eventType: "",
  // Only used when eventType is "Other" (PRD 4).
  eventTypeOther: "",
  startTime: "",
  endTime: "",
  location: "",
  // Not asked on the form any more (SST only); kept so an edited event keeps
  // the department it was saved with.
  department: DEFAULT_HOST_DEPARTMENT,
  organizer: "",
  expectedParticipants: "",
  contactInfo: "",
  description: "",
  socialNetworkUrl: "",
};

// How long typing must pause before step-1 edits are saved to the server draft.
const AUTOSAVE_DELAY_MS = 1500;

/** The day after `iso`, or tomorrow when no start date is set yet. */
function nextDayOf(iso) {
  const base = iso ? new Date(`${iso}T00:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) return "";
  base.setDate(base.getDate() + 1);
  return localDateKey(base);
}

/** Field -> message for everything wrong with the step-1 details. */
function detailsErrorsOf(data) {
  const errors = {};

  for (const [field, message] of REQUIRED_DETAILS) {
    if (!String(data[field] ?? "").trim()) errors[field] = message;
  }

  // Schedule rules. Events are backdated: no part of the schedule -- start or
  // end, date or time -- may be later than now. "Now" is read on every call
  // rather than captured at module load, so a wizard left open does not keep
  // refusing a time that has since passed. All comparisons are on zero-padded
  // local strings -- "YYYY-MM-DD" and "HH:MM" both sort lexicographically --
  // which keeps the UTC drift documented in utils/dates.js out of it entirely.
  const today = localDateKey();
  const now = nowHHmm();
  const eventDate = String(data.eventDate ?? "").trim();
  const endDate = String(data.endDate ?? "").trim();
  const startTime = String(data.startTime ?? "").trim();
  const endTime = String(data.endTime ?? "").trim();

  if (eventDate && eventDate > today) {
    errors.eventDate = "The event date cannot be in the future.";
  }

  if (!errors.eventDate && eventDate === today && startTime && startTime > now) {
    errors.startTime = "The start time cannot be later than now.";
  }

  const lastDay = endDate || eventDate;
  if (endDate && endDate > today) {
    errors.endDate = "The end date cannot be in the future.";
  }

  if (!errors.eventDate && !errors.endDate && lastDay === today && endTime && endTime > now) {
    errors.endTime = "The end time cannot be later than now.";
  }

  // End date must be on or after start date.
  if (!errors.endDate && endDate && eventDate && endDate < eventDate) {
    errors.endDate = "The end date must be on or after the start date.";
  }

  // The time order only constrains a single-day event: an event running from
  // 18:00 to 02:00 the next morning is ordinary, not a mistake.
  const singleDay = !endDate || endDate === eventDate;
  if (!errors.endTime && singleDay && startTime && endTime && compareHHmm(endTime, startTime) <= 0) {
    errors.endTime = "The end time must be after the start time on a single day.";
  }

  // PRD 4: "Other" needs the free-text description alongside it.
  if (data.eventType === "Other" && !String(data.eventTypeOther ?? "").trim()) {
    errors.eventTypeOther = "Describe the event type, or pick one from the list.";
  }

  // PRD 6: optional, but when given it must be exactly ten digits.
  const contact = String(data.contactInfo ?? "").trim();
  if (contact && !/^\d{10}$/.test(contact)) {
    errors.contactInfo = "Enter a 10-digit mobile number, digits only.";
  }

  if (data.socialNetworkUrl.trim()) {
    try {
      const url = new URL(data.socialNetworkUrl.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.socialNetworkUrl = "The link must start with http:// or https://";
      }
    } catch {
      errors.socialNetworkUrl = "Please enter a valid social network URL.";
    }
  }

  return errors;
}

const snapshotOf = (data) => JSON.stringify(data);

function CreateEvent() {
  const navigate = useNavigate();
  const panel = usePanel();
  // Event Manager: no Dean. Submitting records the event straight away.
  const direct = !panel.approval;
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const draftIdParam = searchParams.get("draftId");
  const editEventIdParam = searchParams.get("editEventId");

  /**
   * Where leaving the wizard goes.
   *
   * Every page that opens the wizard passes `state.from` (see
   * hooks/useOriginState), so Back returns to the exact view the teacher came
   * from -- filter and all. The fallbacks cover a direct URL visit, where
   * there is no origin to return to: editing an existing event or draft came
   * from a list, a blank form from the dashboard.
   */
  const originPath =
    location.state?.from ||
    (draftIdParam || editEventIdParam ? `${panel.base}/my-events` : `${panel.base}/dashboard`);

  const [step, setStep] = useState(1);
  const [maxStepReached, setMaxStepReached] = useState(1);

  const [formData, setFormData] = useState(EMPTY_FORM);

  // The form as last stored somewhere (server draft, browser draft, or the
  // blank form it started as). Anything different is an unsaved change.
  const [savedSnapshot, setSavedSnapshot] = useState(() => snapshotOf(EMPTY_FORM));
  const [autoSave, setAutoSave] = useState("idle"); // idle | saving | error

  const [fieldErrors, setFieldErrors] = useState({});
  const [uploadErrors, setUploadErrors] = useState({
    photos: false,
    videos: false,
    documents: false,
  });

  // Files live on the server from the moment they are picked, so these hold
  // saved records rather than browser File objects.
  const [mediaItems, setMediaItems] = useState([]);
  const [documentItems, setDocumentItems] = useState([]);
  const [uploads, setUploads] = useState([]);

  // The report's photos are picked while uploading them -- for the Event
  // Manager's own report and for the Dean's report on a teacher's event
  // alike. null while the report still uses its default -- the first photos
  // uploaded -- so new uploads keep filling the ticks until the user makes a
  // choice of their own.
  const [reportChoice, setReportChoice] = useState(null);
  const [savingReportPhotos, setSavingReportPhotos] = useState(false);

  // Event categories and the coordinator directory (PRD 4 / 5 / 14).
  const {
    types: eventTypes,
    loading: typesLoading,
    addType: addEventType,
  } = useEventTypes();

  const [coordinators, setCoordinators] = useState([]);
  const [coordinatorsLoading, setCoordinatorsLoading] = useState(true);
  const [savingCoordinator, setSavingCoordinator] = useState(false);

  // Upload dialogs. Separate from the page error banner: both are questions
  // or hard stops the teacher has to see, and the banner sits far above the
  // upload panel they are looking at.
  const [limitNotice, setLimitNotice] = useState(null);
  const [dupPrompt, setDupPrompt] = useState(null);

  // The number last auto-filled from a directory pick. Used to decide whether
  // a later pick may overwrite the field: if the teacher has typed their own
  // number, choosing a different coordinator must not silently discard it.
  const autoFilledContactRef = useRef("");
  const contactTouchedRef = useRef(false);

  const [currentUser, setCurrentUser] = useState(null);
  const [editingDraftId, setEditingDraftId] = useState(draftIdParam || null);
  const [serverEvent, setServerEvent] = useState(null);
  const [serverEventId, setServerEventId] = useState(null);

  const [initialising, setInitialising] = useState(Boolean(editEventIdParam));
  const [loading, setLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  /**
   * Set once a draft has been stored, and rendered as a dialog rather than a
   * banner. The Save Draft button lives at the foot of a long form, and the
   * banner rendered above it: on a laptop the confirmation appeared roughly
   * 480px above the top of the viewport, so the teacher clicked Save Draft and
   * saw nothing happen at all. `where` distinguishes the two resting places a
   * draft can have, because only one of them survives a change of browser.
   */
  const [draftSaved, setDraftSaved] = useState(null);

  // Submitting is two dialogs: "are you sure?" before anything is sent, then
  // "submitted" once the server has it. The confirm dialog carries its own
  // error line, because the page's banner sits far above the sticky Submit
  // button and a failure there would go unseen.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [submitted, setSubmitted] = useState(null); // the saved event
  // Shared hook rather than a local fetch: it also revalidates when this tab is
  // focused, so a limit an admin changes elsewhere reaches an open wizard.
  const { limits: uploadLimits, reload: reloadUploadLimits } = useUploadLimits();
  // The combined document budget, from the same settings as the checks below.
  const documentLimitBytes = limitFor("document", uploadLimits);
  // Which upload steps must have at least one file before submitting. The
  // Super Admin sets these; the server applies the same rule on submit.
  const required = {
    details: true,
    photos: Boolean(uploadLimits.photos_required),
    videos: Boolean(uploadLimits.videos_required),
    documents: Boolean(uploadLimits.documents_required),
  };

  // The event id is also held in a ref: several files picked at once each need
  // it, and React state would still be null for all of them.
  const eventIdRef = useRef(null);
  const creatingEventRef = useRef(null);
  const formDataRef = useRef(formData);
  const userRef = useRef(null);
  const editingDraftRef = useRef(draftIdParam || null);

  // Aborted when the page unmounts, so uploads and saves stop instead of
  // running on (and setting state) after the teacher has left.
  const abortRef = useRef(null);
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    return () => controller.abort();
  }, []);
  const isGone = () => Boolean(abortRef.current?.signal.aborted);

  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  const photos = mediaItems.filter((m) => m.media_type === "image");
  // The server's default is the first photos by _id; ObjectId hex strings
  // sort the same way, so this matches what the report would show.
  const reportPhotoIds =
    reportChoice ?? photos.map((p) => p.id).sort().slice(0, DEFAULT_REPORT_PHOTOS);
  const videos = mediaItems.filter((m) => m.media_type === "video");

  const photoUploads = uploads.filter((u) => u.kind === "image");
  const videoUploads = uploads.filter((u) => u.kind === "video");
  const documentUploads = uploads.filter((u) => u.kind === "document");

  const noticeDocuments = documentItems.filter((d) => (d.category || "notice") === "notice");
  const reportDocuments = documentItems.filter((d) => d.category === "report");
  const noticeUploads = documentUploads.filter((u) => (u.category || "notice") === "notice");
  const reportUploads = documentUploads.filter((u) => u.category === "report");

  /** Saved records and in-flight uploads for one upload kind. */
  const bucketFor = (kind) => {
    if (kind === "image") return { items: photos, uploads: photoUploads };
    if (kind === "video") return { items: videos, uploads: videoUploads };
    return { items: documentItems, uploads: documentUploads };
  };

  // Running totals for the budget meters (PRD 9 / 11).
  const photoBytesUsed = usedBytes(photos, photoUploads);
  const videoBytesUsed = usedBytes(videos, videoUploads);
  const documentBytesUsed = usedBytes(documentItems, documentUploads);
  const noticeBytesUsed = usedBytes(noticeDocuments, noticeUploads);
  const reportBytesUsed = usedBytes(reportDocuments, reportUploads);
  // The two document panels share one count cap and one byte budget.
  const activeCount = (docs, pending) => docs.length + pending.filter((u) => !u.error).length;
  const noticeCount = activeCount(noticeDocuments, noticeUploads);
  const reportCount = activeCount(reportDocuments, reportUploads);

  const uploading = uploads.some((u) => !u.error);
  const isDraftEvent = !serverEvent || serverEvent.status === "draft";

  const formSnapshot = snapshotOf(formData);
  const formDirty = formSnapshot !== savedSnapshot;
  const detailsComplete = Object.keys(detailsErrorsOf(formData)).length === 0;
  // Any saved event that is not a draft: submitting it again replaces a live
  // submission, so Save Draft is not offered.
  const resubmitting = Boolean(serverEvent) && serverEvent.status !== "draft";

  // Narrower, and the only thing the feedback banner may key off: an event the
  // Dean actually refused. `resubmitting` alone showed a pending event a
  // "Dean's rejection feedback" panel reading "No explicit rejection reason
  // provided." -- about a decision nobody had made yet.
  const refusalReason = getRefusalReason(serverEvent);
  const wasRevoked = serverEvent?.status === "revoked";

  // --------------------------------------------------
  // Load user, and any draft or event being edited
  // --------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    async function initUserAndData() {
      try {
        const user = await fetchCurrentUser();

        if (!user) {
          navigate("/login", { replace: true });
          return;
        }

        if (cancelled) return;
        setCurrentUser(user);
        userRef.current = user;

        // 1. A local draft saved before any file was attached.
        if (draftIdParam) {
          const draft = getTeacherDraftById(user.id, draftIdParam);
          if (draft && !cancelled) {
            setEditingDraftId(draft.id);
            editingDraftRef.current = draft.id;
            const loaded = {
              eventName: draft.event_name || "",
              eventDate: draft.event_date || "",
              endDate: draft.end_date || draft.event_date || "",
              eventType: draft.event_type || "",
              eventTypeOther: draft.event_type_other || "",
              startTime: draft.start_time || "",
              endTime: draft.end_time || "",
              location: draft.location || "",
              department: draft.department || DEFAULT_HOST_DEPARTMENT,
              organizer: draft.organizer || "",
              expectedParticipants: draft.expected_participants || "",
              contactInfo: draft.contact_info || "",
              description: draft.description || "",
              socialNetworkUrl: draft.social_network_url || "",
            };
            setFormData(loaded);
            setSavedSnapshot(snapshotOf(loaded));
          }
        }

        // 2. An event already on the server: a draft being resumed, or a
        //    rejected event being corrected. Both bring their files with them.
        if (editEventIdParam) {
          try {
            const result = await apiJson(`${panel.api}/events/${editEventIdParam}`);
            const event = result?.event || null;

            if (cancelled) return;

            if (event && !canTeacherEditEvent(event)) {
              setError("This event has already been approved and can no longer be edited.");
              setInitialising(false);
              return;
            }

            if (event) {
              // readEventFields prefers the real columns and falls back to the
              // description blob, so an event created before those fields
              // existed still loads with its times and organiser filled in.
              const fields = readEventFields(event);

              setServerEvent(event);
              setServerEventId(event.id);
              eventIdRef.current = event.id;
              setMediaItems(result.media || []);
              setDocumentItems(result.documents || []);
              if (event.report_photos_chosen) {
                setReportChoice(event.report_photo_ids || []);
              }
              const loaded = {
                eventName: event.event_name || "",
                eventDate: event.event_date || "",
                endDate: event.end_date || event.event_date || "",
                eventType: event.event_type || "",
                eventTypeOther: "",
                startTime: fields.startTime,
                endTime: fields.endTime,
                location: event.location || "",
                department: fields.department,
                organizer: fields.organizer,
                expectedParticipants: fields.expectedParticipants,
                contactInfo: fields.contactInfo || "",
                description: fields.description,
                socialNetworkUrl: event.social_network_url || "",
              };
              setFormData(loaded);
              setSavedSnapshot(snapshotOf(loaded));
              autoFilledContactRef.current = fields.contactInfo || "";
              contactTouchedRef.current = false;

              // Everything is already filled in, so every step is reachable.
              setMaxStepReached(STEPS.length);
            }
          } catch (err) {
            if (!cancelled) {
              setError(err?.message || "Could not load this event.");
            }
          }
        }
      } catch (err) {
        console.error("Init CreateEvent error:", err);
      } finally {
        if (!cancelled) setInitialising(false);
      }
    }

    initUserAndData();
    return () => {
      cancelled = true;
    };
  }, [draftIdParam, editEventIdParam, navigate, panel.api]);

  // --------------------------------------------------
  // Form change
  // --------------------------------------------------
  const clearFieldError = (name) =>
    setFieldErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
    clearFieldError(name);
  };

  /** Same as handleChange, for controls that report a value rather than an event. */
  const setField = (name, value) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
    clearFieldError(name);
  };

  /** Start date change: auto-syncs End Date for the common same-day event case. */
  const handleStartDateChange = (e) => {
    const newStartDate = e.target.value;
    setFormData((prev) => {
      const updated = { ...prev, eventDate: newStartDate };
      if (!prev.endDate || prev.endDate === prev.eventDate) {
        updated.endDate = newStartDate;
      }
      return updated;
    });
    clearFieldError("eventDate");
    setFieldErrors((prev) => {
      if (!prev.endDate) return prev;
      const next = { ...prev };
      if (!newStartDate || formData.endDate >= newStartDate) {
        delete next.endDate;
      }
      return next;
    });
  };

  // --------------------------------------------------
  // Step 1 validation
  // --------------------------------------------------
  // ----------------------------------------------------------------
  // Faculty coordinator directory (PRD 5)
  // ----------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    listFacultyCoordinators()
      .then((list) => {
        if (!cancelled) setCoordinators(list);
      })
      .catch(() => {
        // A directory that will not load must not block typing a name.
        if (!cancelled) setCoordinators([]);
      })
      .finally(() => {
        if (!cancelled) setCoordinatorsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Fill the name, and the mobile number too — but only when doing so cannot
   * destroy something the teacher typed themselves.
   */
  const selectCoordinator = (option) => {
    setField("organizer", option.name);

    const current = formData.contactInfo.trim();
    const safeToOverwrite =
      !current || !contactTouchedRef.current || current === autoFilledContactRef.current;

    if (option.phone && safeToOverwrite) {
      autoFilledContactRef.current = option.phone;
      contactTouchedRef.current = false;
      setField("contactInfo", option.phone);
    }
  };

  // Offered only when the typed name is not already in the directory and there
  // is a number to store with it — a contact card with no number is useless.
  const typedOrganizer = formData.organizer.trim();
  const canSaveCoordinator =
    typedOrganizer.length > 1 &&
    /^\d{10}$/.test(formData.contactInfo.trim()) &&
    !coordinators.some(
      (item) => item.name.toLowerCase() === typedOrganizer.toLowerCase(),
    );

  const saveCoordinator = async () => {
    setSavingCoordinator(true);
    try {
      const created = await createFacultyCoordinator({
        name: typedOrganizer,
        phone: formData.contactInfo.trim(),
      });
      if (created) {
        setCoordinators((current) => [...current, created]);
        autoFilledContactRef.current = created.phone;
      }
    } catch (err) {
      setError(err?.message || "Could not save that coordinator.");
    } finally {
      setSavingCoordinator(false);
    }
  };

  const validateDetails = () => {
    const errors = detailsErrorsOf(formData);
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const buildEventBody = (saveAsDraft) => {
    const data = formDataRef.current;
    return {
      event_name: data.eventName.trim(),
      event_date: data.eventDate,
      // Blank or matching start date means same day; the server stores null for both.
      end_date: data.endDate && data.endDate !== data.eventDate ? data.endDate : null,
      // "Other" stores what the teacher typed, so the event carries a real
      // category rather than the literal word "Other".
      event_type:
        data.eventType === "Other" && data.eventTypeOther.trim()
          ? data.eventTypeOther.trim()
          : data.eventType,
      location: data.location.trim(),
      // The blob is still written for one release so a rollback loses
      // nothing, but these four are real API fields now and the server
      // prefers them over the blob.
      description: encodeEventMetadata(data.description, {
        startTime: data.startTime,
        endTime: data.endTime,
        department: data.department?.trim() || DEFAULT_HOST_DEPARTMENT,
        organizer: data.organizer,
        expectedParticipants: data.expectedParticipants,
        contactInfo: data.contactInfo,
      }),
      start_time: data.startTime || null,
      end_time: data.endTime || null,
      organizer: data.organizer.trim() || null,
      coordinator_contact: data.contactInfo.trim() || null,
      social_network_url: data.socialNetworkUrl.trim() || null,
      save_as_draft: saveAsDraft,
    };
  };

  /**
   * The event id to attach files to, creating a server-side draft the first
   * time one is needed. Concurrent callers share a single in-flight create, so
   * picking four photos at once cannot produce four draft events.
   */
  const ensureEventId = useCallback(async () => {
    if (eventIdRef.current) return eventIdRef.current;
    if (creatingEventRef.current) return creatingEventRef.current;

    creatingEventRef.current = (async () => {
      const sent = formDataRef.current;
      const { event } = await apiJson(`${panel.api}/events`, {
        method: "POST",
        body: buildEventBody(true),
        signal: abortRef.current?.signal,
      });

      eventIdRef.current = event.id;
      setSavedSnapshot(snapshotOf(sent));
      setServerEventId(event.id);
      setServerEvent(event);

      // The draft now lives on the server, so drop the browser copy rather
      // than leaving the teacher with two drafts of the same event.
      const localId = editingDraftRef.current;
      if (localId && userRef.current) {
        deleteTeacherDraft(userRef.current.id, localId);
        editingDraftRef.current = null;
        setEditingDraftId(null);
      }

      return event.id;
    })();

    try {
      return await creatingEventRef.current;
    } finally {
      creatingEventRef.current = null;
    }
    // buildEventBody reads through refs, so this needs no dependencies.
  }, [panel.api]);

  // --------------------------------------------------
  // Auto-save step-1 edits once a server draft exists
  //
  // The draft is created on the first upload. Without this, edits made after
  // that were kept only until the tab closed. Saved after a short pause in
  // typing, and only when the details are complete (the API rejects partial
  // ones). A rejected event being corrected is not a draft and cannot be
  // saved as one, so it relies on the beforeunload warning below instead.
  // --------------------------------------------------
  useEffect(() => {
    if (!serverEventId || !isDraftEvent || !formDirty || !detailsComplete) return undefined;
    if (loading || savingDraft || submitted) return undefined;

    const snapshot = formSnapshot;
    const timer = setTimeout(async () => {
      if (isGone()) return;
      setAutoSave("saving");
      try {
        await apiJson(`${panel.api}/events/${serverEventId}`, {
          method: "PATCH",
          body: buildEventBody(true),
          signal: abortRef.current?.signal,
        });
        if (isGone()) return;
        setSavedSnapshot(snapshot);
        setAutoSave("idle");
      } catch (err) {
        if (isGone() || isAbortError(err)) return;
        console.error("Auto-save error:", err);
        setAutoSave("error");
      }
    }, AUTOSAVE_DELAY_MS);

    return () => clearTimeout(timer);
    // buildEventBody reads through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSnapshot, formDirty, serverEventId, isDraftEvent, detailsComplete, loading, savingDraft, submitted]);

  // Warn before closing the tab while edits or uploads would be lost.
  const hasUnsavedWork = !submitted && (formDirty || uploading);
  useEffect(() => {
    if (!hasUnsavedWork) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasUnsavedWork]);

  // --------------------------------------------------
  // Uploading
  // --------------------------------------------------
  const setUploadState = (key, changes) => {
    setUploads((prev) =>
      prev.map((item) => (item.key === key ? { ...item, ...changes } : item))
    );
  };

  const runUpload = useCallback(async (entry) => {
    const signal = abortRef.current?.signal;
    if (signal?.aborted) return;
    try {
      setUploadState(entry.key, { error: null, progress: 0 });

      const eventId = await ensureEventId();
      if (signal?.aborted) return;

      // Straight to storage, so large videos never pass the API's proxy.
      const result = await uploadEventFile(`${panel.api}/events/${eventId}`, {
        kind: entry.kind,
        file: entry.file,
        category: entry.category,
        signal,
        onProgress: (fraction) => setUploadState(entry.key, { progress: fraction }),
      });
      if (signal?.aborted) return;

      if (entry.kind === "document") {
        if (result?.document) {
          setDocumentItems((prev) => [...prev, result.document]);
          setUploadErrors((prev) => ({ ...prev, documents: false }));
        }
      } else if (result?.media) {
        setMediaItems((prev) => [...prev, result.media]);
        const bucket = result.media.media_type === "image" ? "photos" : "videos";
        setUploadErrors((prev) => ({ ...prev, [bucket]: false }));
      }

      setUploads((prev) => prev.filter((item) => item.key !== entry.key));
    } catch (err) {
      // Left the page: the upload was cancelled on purpose.
      if (signal?.aborted || isAbortError(err)) return;
      console.error("Upload error:", err);
      setUploadState(entry.key, {
        error: err?.message || "Upload failed.",
        progress: null,
      });
    }
  }, [ensureEventId, panel.api]);

  /**
   * Validate a batch against the per-step caps and queue what survives.
   * Counts include files already on the server and still uploading, so the
   * caps hold across repeated picks rather than per batch.
   */
  /** Put files on the upload queue and run them one at a time. */
  const queueUploads = (files, kind, category = "notice") => {
    if (files.length === 0) return;

    const entries = files.map((file) => ({
      key: `u${(uploadKeySeed += 1)}`,
      name: file.name,
      size: file.size,
      kind,
      category,
      file,
      progress: 0,
      error: null,
    }));

    setUploads((prev) => [...prev, ...entries]);

    // One at a time: a single progress bar moving is easier to follow than
    // several crawling together, and it keeps the byte budget honest.
    (async () => {
      for (const entry of entries) {
        if (isGone()) break;
        await runUpload(entry);
      }
    })();
  };

  const handlePick = async (files, kind, category = "notice") => {
    const saved = bucketFor(kind).items;
    const pending = bucketFor(kind).uploads;

    // The server is the authority on names already attached; fall back to
    // what is on screen when the check cannot run.
    let existingNames = saved.map((item) => item.file_name);
    if (eventIdRef.current && (kind === "image" || kind === "video")) {
      const duplicateMap = await checkUploadNames(
        eventIdRef.current,
        Array.from(files).map((file) => file.name),
        "media",
        panel.api,
      );
      existingNames = [
        ...existingNames,
        ...Object.entries(duplicateMap)
          .filter(([, isDuplicate]) => isDuplicate)
          .map(([name]) => name),
      ];
    }

    // Re-read the limits before judging the pick, so a change the Super Admin
    // made since this page loaded is what the teacher is held to -- the same
    // value the server is about to enforce.
    const limits = (await reloadUploadLimits({ force: true })) || uploadLimits;

    const { accepted, duplicates, rejections, overLimit } = validatePick({
      files: Array.from(files),
      kind,
      savedItems: saved,
      pendingUploads: pending,
      existingNames,
      limits,
    });

    setError(rejections.join(" "));

    // PRD 8 / 11: the budget message is a dialog, not a line in the banner —
    // it is the one rejection a teacher must not scroll past.
    if (overLimit) setLimitNotice(overLimit);

    if (duplicates.length > 0) {
      // PRD 10: ask before spending the bytes. Everything non-duplicate goes
      // now so confirming only ever adds files, never re-sends them.
      setDupPrompt({ kind, category, duplicates, names: duplicates.map((file) => file.name) });
    }

    queueUploads(accepted, kind, category);
  };

  const handleRemoveMedia = async (item) => {
    const eventId = eventIdRef.current;
    if (!eventId) return;

    setMediaItems((prev) =>
      prev.map((m) => (m.id === item.id ? { ...m, removing: true } : m))
    );

    try {
      await apiJson(`${panel.api}/events/${eventId}/media/${item.id}`, { method: "DELETE" });
      setMediaItems((prev) => prev.filter((m) => m.id !== item.id));
      // The server drops a deleted photo from the saved choice too.
      setReportChoice((chosen) => chosen && chosen.filter((id) => id !== item.id));
    } catch (err) {
      console.error("Remove media error:", err);
      setError(err?.message || "Could not remove that file.");
      setMediaItems((prev) =>
        prev.map((m) => (m.id === item.id ? { ...m, removing: false } : m))
      );
    }
  };

  const handleRemoveDocument = async (item) => {
    const eventId = eventIdRef.current;
    if (!eventId) return;

    setDocumentItems((prev) =>
      prev.map((d) => (d.id === item.id ? { ...d, removing: true } : d))
    );

    try {
      await apiJson(`${panel.api}/events/${eventId}/documents/${item.id}`, { method: "DELETE" });
      setDocumentItems((prev) => prev.filter((d) => d.id !== item.id));
    } catch (err) {
      console.error("Remove document error:", err);
      setError(err?.message || "Could not remove that file.");
      setDocumentItems((prev) =>
        prev.map((d) => (d.id === item.id ? { ...d, removing: false } : d))
      );
    }
  };

  /** Tick or untick a photo for the report; saved at once, reverted on failure. */
  const toggleReportPhoto = async (photoId) => {
    const eventId = eventIdRef.current;
    if (!eventId || savingReportPhotos) return;

    const next = reportPhotoIds.includes(photoId)
      ? reportPhotoIds.filter((id) => id !== photoId)
      : [...reportPhotoIds, photoId];

    const previous = reportChoice;
    setReportChoice(next);
    setSavingReportPhotos(true);
    try {
      const result = await saveReportPhotos(eventId, next, panel.api);
      setReportChoice(result?.report_photo_ids || next);
    } catch (err) {
      setReportChoice(previous);
      setError(err?.message || "Could not save the report photos.");
    } finally {
      setSavingReportPhotos(false);
    }
  };

  // Saved files' links are signed and expire; refetch them when one fails.
  const refreshMediaLinks = useMediaRefresh(async () => {
    const eventId = eventIdRef.current;
    if (!eventId || isGone()) return;
    const result = await apiJson(`${panel.api}/events/${eventId}`, {
      signal: abortRef.current?.signal,
    });
    if (isGone()) return;
    setMediaItems(result?.media || []);
    setDocumentItems(result?.documents || []);
  });

  const dismissUpload = (entry) =>
    setUploads((prev) => prev.filter((item) => item.key !== entry.key));

  // --------------------------------------------------
  // Navigation
  // --------------------------------------------------
  const goToStep = (next) => {
    setStep(next);
    setMaxStepReached((prev) => Math.max(prev, next));
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /**
   * The first required step before `target` that is not done yet, or null.
   *
   * Moving forward -- "Next" or a later step in the rail -- goes through this,
   * so a mandatory upload step cannot be skipped: an edit opened from My Events
   * starts with every step reachable, and the rail used to jump straight past
   * it. Documents are the last step, so the submit check covers them.
   */
  const blockerBefore = (target) => {
    if (target > 1 && !validateDetails()) {
      return { step: 1, message: "Please complete the required fields before continuing." };
    }
    if (target > 2) {
      if (required.photos && photos.length === 0) {
        setUploadErrors((prev) => ({ ...prev, photos: true }));
        return {
          step: 2,
          message: photoUploads.some((u) => !u.error)
            ? "Please wait for your photos to finish uploading before continuing."
            : "Photo upload is mandatory. Please upload at least one photo before continuing.",
        };
      }
      if (required.documents && documentItems.length === 0) {
        setUploadErrors((prev) => ({ ...prev, documents: true }));
        return {
          step: 2,
          message: documentUploads.some((u) => !u.error)
            ? "Please wait for your documents to finish uploading before continuing."
            : "Document upload is mandatory. Please upload at least one document before continuing.",
        };
      }
    }
    return null;
  };

  /** Go to `target`, unless a required step before it is still incomplete. */
  const goForwardTo = (target) => {
    const blocker = target > step ? blockerBefore(target) : null;
    if (!blocker) {
      goToStep(target);
      return;
    }
    if (blocker.step !== step) goToStep(blocker.step);
    setError(blocker.message);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleNext = () => goForwardTo(Math.min(step + 1, STEPS.length));

  const handleBack = () => goToStep(Math.max(step - 1, 1));

  /**
   * The header arrow: one step back, and only once out of steps does it leave.
   *
   * It used to be a fixed link to the dashboard, so from step 4 of an edit
   * opened from My Events it threw away three steps and the list behind them
   * in a single click. The wizard's steps are component state rather than
   * history entries, so the browser's own Back cannot walk them either --
   * this control is the only thing that can.
   */
  const handleHeaderBack = () => {
    if (step > 1) {
      handleBack();
      return;
    }
    navigate(originPath);
  };

  const headerBackLabel =
    step > 1 ? `Back to ${STEPS[step - 2].label}` : "Back";

  // --------------------------------------------------
  // Save draft
  // --------------------------------------------------
  const handleSaveDraft = async () => {
    setError("");
    setSuccess("");

    if (!currentUser) {
      setError("Please log in to save drafts.");
      return;
    }

    setSavingDraft(true);
    try {
      let where;

      const sent = formDataRef.current;

      if (eventIdRef.current) {
        // Already on the server, with its files attached.
        await apiJson(`${panel.api}/events/${eventIdRef.current}`, {
          method: "PATCH",
          body: buildEventBody(true),
        });
        setSavedSnapshot(snapshotOf(sent));
        where = "server";
      } else if (validateDetails()) {
        // Complete enough for the API to accept: promote it to a server draft
        // so any files added later have somewhere to go.
        await ensureEventId();
        where = "server";
      } else {
        // Still partial. Keep it in the browser, as before, so a half-filled
        // form is never lost.
        const saved = saveTeacherDraft(currentUser.id, {
          id: editingDraftId || undefined,
          ...formData,
        });
        if (!saved) {
          // Storage full, private mode or blocked: say so rather than
          // claiming a save that did not happen.
          setError(
            "The draft could not be saved in this browser (storage is full or blocked). " +
              "Fill in the required details so it can be saved to your account instead."
          );
          return;
        }
        setSavedSnapshot(snapshotOf(sent));
        setEditingDraftId(saved.id);
        editingDraftRef.current = saved.id;
        setFieldErrors({});
        where = "browser";
      }

      setDraftSaved({ where });
    } catch (err) {
      console.error("Save draft error:", err);
      setError(err?.message || "Failed to save draft. Please try again.");
    } finally {
      setSavingDraft(false);
    }
  };

  // --------------------------------------------------
  // Submit
  //
  // The Submit button only asks. Everything that could stop a submission —
  // missing details, uploads still running — is checked first, so the
  // confirm dialog never offers a submission that is bound to fail.
  // --------------------------------------------------
  const handleSubmit = (e) => {
    e.preventDefault();

    // Only the last step submits. Without this the form goes in early in two
    // ways: pressing Enter in any step-1 text field, and clicking "Next" on the
    // step before the last, where React patches the very same DOM button from
    // type="button" to type="submit" mid-click and the browser then runs the
    // form's default action.
    if (step !== STEPS.length) return;

    if (loading || savingDraft) return;

    setError("");
    setSuccess("");

    if (!validateDetails()) {
      setStep(1);
      setError("Please complete the required fields before submitting.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (uploading) {
      setError("Please wait for the uploads to finish.");
      return;
    }

    // Only the kinds the Super Admin has made mandatory, in step order.
    const missing = [
      { step: 2, bucket: "photos", noun: "photo", label: "Photo", count: photos.length },
      { step: 2, bucket: "documents", noun: "document", label: "Document", count: documentItems.length },
      { step: 3, bucket: "videos", noun: "video", label: "Video", count: videos.length },
    ].filter(({ bucket, count }) => required[bucket] && count === 0);

    if (missing.length > 0) {
      setUploadErrors({
        photos: missing.some((m) => m.bucket === "photos"),
        videos: missing.some((m) => m.bucket === "videos"),
        documents: missing.some((m) => m.bucket === "documents"),
      });

      const joinList = (words) =>
        words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
      const labels = joinList(missing.map((m) => m.label));
      const each = joinList(missing.map((m) => `at least one ${m.noun}`));

      setError(
        missing.length === 1
          ? `${labels} upload is mandatory. Please upload ${each} before submitting.`
          : `${labels} uploads are mandatory. Please upload ${each} before submitting.`
      );
      setStep(missing[0].step);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    setConfirmError("");
    setConfirmOpen(true);
  };

  /** Cancel: close the question and leave the form exactly as it was. */
  const cancelSubmit = () => {
    if (loading) return; // never abandon a request mid-flight
    setConfirmOpen(false);
    setConfirmError("");
  };

  /** Confirm: send it. The server puts it in the Dean's queue as pending. */
  const confirmSubmit = async () => {
    if (loading) return;

    setConfirmError("");
    setLoading(true);

    try {
      // The user loaded with the page; no extra /auth/me round trip per
      // submit. An expired session still surfaces: the PATCH below gets 401.
      const user = userRef.current || (await fetchCurrentUser());
      if (!user) throw new Error("Your session has expired. Please log in again.");

      // The server only creates events as drafts (files attach to a draft),
      // then submits them with a PATCH. An upload normally creates that draft
      // along the way; when the Super Admin has made every upload optional
      // and nothing was attached, it is created here first -- sending the
      // event straight to POST as a submission is refused by the API.
      const eventId = eventIdRef.current || (await ensureEventId());
      const result = await apiJson(`${panel.api}/events/${eventId}`, {
        method: "PATCH",
        body: buildEventBody(false),
      });

      if (editingDraftRef.current) {
        deleteTeacherDraft(user.id, editingDraftRef.current);
      }

      setSavedSnapshot(snapshotOf(formDataRef.current));
      setConfirmOpen(false);
      setSubmitted(result?.event || { status: "pending" });
    } catch (err) {
      console.error("Create / Resubmit event error:", err);
      setConfirmError(err?.message || "Something went wrong while submitting the event.");
    } finally {
      setLoading(false);
    }
  };

  /** Leaving the success dialog leaves the form: it has done its job. */
  const finishSubmission = () => {
    setSubmitted(null);
    navigate(`${panel.base}/my-events?filter=${direct ? "recorded" : "submitted"}`);
  };

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  // --------------------------------------------------
  // Copy
  // --------------------------------------------------
  // "Draft" is about how the page was opened, not about whether a draft row
  // exists yet. Someone part-way through creating an event is still creating
  // it, even though the first upload has already parked it as a draft.
  const resumedExisting = Boolean(draftIdParam || editEventIdParam);
  const mode = resubmitting ? "resubmit" : resumedExisting ? "draft" : "new";

  const heroCopy = direct ? {
    resubmit: {
      eyebrow: "Edit Event",
      title: "Edit",
      accent: "Event",
      subtitle: "Update the event's details and files, then save the changes.",
    },
    draft: {
      eyebrow: "Draft Mode",
      title: "Edit Event",
      accent: "Draft",
      subtitle:
        "Resume your saved draft. Anything you upload is kept, so you can finish this later.",
    },
    new: {
      eyebrow: "New Event",
      title: "Create",
      accent: "Event",
      subtitle:
        "Record the event's details and files, or save a draft and finish it later.",
    },
  }[mode] : {
    resubmit: {
      eyebrow: "Resubmission",
      title: "Edit &",
      accent: "Resubmit",
      subtitle:
        "Update the event as advised by the Dean, then resubmit it for approval.",
    },
    draft: {
      eyebrow: "Draft Mode",
      title: "Edit Event",
      accent: "Draft",
      subtitle:
        "Resume your saved draft. Anything you upload is kept, so you can finish this later.",
    },
    new: {
      eyebrow: "New Proposal",
      title: "Create",
      accent: "Event",
      subtitle:
        "Submit event details for Dean approval, or save a draft and finish it later.",
    },
  }[mode];

  const busy = loading || savingDraft;

  if (initialising) {
    return (
      <div className="hv-root flex min-h-screen items-center justify-center">
        <div className="text-center">
          <span className="spin mx-auto mb-4 block h-10 w-10 text-accent" />
          <p className="prose-muted text-sm">Loading event…</p>
        </div>
      </div>
    );
  }

  return (
    <TeacherShell
      active="create"
      profile={
        currentUser
          ? {
              // The whole user, not a two-field copy: the rail footer reads
              // designation and department off it too, and a trimmed object
              // left this one page showing a bare name.
              ...currentUser,
              name: currentUser.name || currentUser.email,
            }
          : null
      }
      onLogout={handleLogout}
      railNote="Photos, videos and documents upload as soon as you pick them, so a saved draft keeps them."
      showToTop={false}
    >
      {/* Sized so the details step fits a laptop screen with at most a short
          scroll: title, step rail and form share one card instead of a hero
          band above it, the fields run three across, and the action bar
          sticks to the bottom of the screen so Next is never out of reach. */}
      <div className="mx-auto w-full max-w-6xl px-4 py-4 sm:px-6 lg:px-8">

        {/* Dean's feedback on a rejected event — the one thing that has to be
            read before anything below it is touched. */}
        {refusalReason && (
          <div
            style={{ "--track": trackOf(serverEvent.status) }}
            className="reveal mb-4 rounded-2xl border p-4"
            data-tint="rejected"
          >
            <div className="flex items-start gap-3">
              <span className="icon-tile icon-tile-track shrink-0">
                <IconAlertTriangle />
              </span>
              <div className="min-w-0">
                <h2 className="h3 text-ink">
                  {wasRevoked
                    ? "Why the Dean withdrew the approval"
                    : "Dean's rejection feedback"}
                </h2>
                <p className="prose-muted mt-1.5 text-sm">{refusalReason}</p>
              </div>
            </div>
          </div>
        )}

        {success && (
          <div className="toast toast-ok mb-4" role="status">
            <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
            <p className="text-sm font-medium text-ink">{success}</p>
          </div>
        )}

        {error && (
          <div className="toast toast-err mb-4" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm font-medium text-ink">{error}</p>
          </div>
        )}

        {/* ------------------------------------------------------------ form */}
        <form onSubmit={handleSubmit} className="glass overflow-clip">

          {/* --------------------------------------- title + step rail */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b hairline px-4 py-3.5 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={handleHeaderBack}
                disabled={busy}
                className="icon-btn icon-btn-sm shrink-0"
                aria-label={headerBackLabel}
                title={headerBackLabel}
              >
                <IconArrowLeft />
              </button>
              <div className="min-w-0">
                <p className="eyebrow text-[11px]">{heroCopy.eyebrow}</p>
                <h1 className="truncate font-display text-xl font-bold leading-tight text-ink" title={heroCopy.subtitle}>
                  {heroCopy.title} <span className="hero-accent">{heroCopy.accent}</span>
                </h1>
              </div>
            </div>

            <div className="wiz-rail" role="list">
              {STEPS.map((item, index) => {
                const number = index + 1;
                const done = number < step;
                const reachable = number <= maxStepReached;

                return (
                  <div key={item.key} className="flex items-center" role="listitem">
                    {index > 0 && <span className="wiz-sep" aria-hidden="true" />}
                    <button
                      type="button"
                      onClick={() => reachable && goForwardTo(number)}
                      disabled={!reachable || busy}
                      aria-current={number === step ? "step" : undefined}
                      data-done={done ? "true" : undefined}
                      className="wiz-step"
                    >
                      <i>{done ? <IconCheck className="h-3 w-3" /> : number}</i>
                      <span className={number === step ? "" : "hidden sm:inline"}>
                        {item.label}
                        {((item.key === "images_and_documents" ? (required.photos || required.documents) : required[item.key])) && <span className="req ml-0.5">*</span>}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* One line for what used to be a three-line band. The step count
              lives here so it survives the rail scrolling on a phone. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b hairline bg-line/2 px-4 py-2.5 sm:px-6">
            <h2 className="text-sm font-semibold text-ink">
              {step === 1 && "Event Information"}
              {step === 2 && (
                <>
                  Images & Documents {(required.photos || required.documents) && <span className="req">*</span>}
                </>
              )}
              {step === 3 && (
                <>
                  Video Upload {required.videos && <span className="req">*</span>}
                </>
              )}
              <span className="ml-2 text-[11px] font-semibold uppercase tracking-wider text-accent">
                Step {step} of {STEPS.length}
              </span>
            </h2>
            <p className="prose-muted text-xs sm:text-sm">
              {step === 1 && (
                <>
                  Core event details. Fields marked <span className="req">*</span> are
                  required before the event can be submitted.
                </>
              )}
              {step === 2 && (
                <>
                  Upload event photos, banners, and documents categorized as notices or reports.
                </>
              )}
              {step === 3 &&
                `${required.videos ? "Required. Teasers and recordings — upload at least 1 video," : "Optional. Teasers and recordings —"} ${formatMb(uploadLimits.max_video_total_mb * 1024 * 1024)} in total${uploadLimits.max_videos_per_event ? `, up to ${uploadLimits.max_videos_per_event} videos` : ", across any number of videos"}.`}
            </p>
          </div>

          {/* ------------------------------------------------ step 1: details */}
          {step === 1 && (
            <div className="grid grid-cols-2 gap-x-3 gap-y-4 px-4 py-5 sm:gap-x-5 sm:px-6">

              <div className="field col-span-2">
                <label htmlFor="eventName">
                  Event Name<span className="req">*</span>
                </label>
                <input
                  id="eventName"
                  name="eventName"
                  type="text"
                  value={formData.eventName}
                  onChange={handleChange}
                  placeholder="e.g. National Science Day Symposium 2026"
                  disabled={busy}
                  aria-invalid={fieldErrors.eventName ? "true" : undefined}
                  className="input min-h-10 py-2"
                />
                {fieldErrors.eventName && <p className="field-error">{fieldErrors.eventName}</p>}
              </div>

              <div className="field col-span-2">
                <EventTypeSelect
                  value={formData.eventType}
                  customValue={formData.eventTypeOther}
                  onChange={(value) => setField("eventType", value)}
                  onCustomChange={(value) => setField("eventTypeOther", value)}
                  types={eventTypes}
                  loading={typesLoading}
                  onAddType={addEventType}
                  disabled={busy}
                  error={fieldErrors.eventType}
                  customError={fieldErrors.eventTypeOther}
                />
              </div>

              <div className="field col-span-2 md:col-span-1">
                <label htmlFor="eventDate">
                  Event Start Date<span className="req">*</span>
                </label>
                <DateInputDMY
                  id="eventDate"
                  name="eventDate"
                  value={formData.eventDate}
                  onChange={handleStartDateChange}
                  disabled={busy}
                  max={localDateKey()}
                  ariaInvalid={fieldErrors.eventDate ? "true" : undefined}
                />
                {fieldErrors.eventDate && <p className="field-error">{fieldErrors.eventDate}</p>}
              </div>

              <div className="field col-span-2 md:col-span-1">
                <label htmlFor="startTime">
                  Event Start Time<span className="req">*</span>
                </label>
                <TimePicker12h
                  id="startTime"
                  value={formData.startTime}
                  onChange={(val) => setField("startTime", val)}
                  disabled={busy}
                  hasError={Boolean(fieldErrors.startTime)}
                  ariaLabel="Event Start Time"
                />
                {fieldErrors.startTime && <p className="field-error">{fieldErrors.startTime}</p>}
              </div>

              <div className="field col-span-2 md:col-span-1">
                <label htmlFor="endDate">
                  Event End Date<span className="req">*</span>
                </label>
                <DateInputDMY
                  id="endDate"
                  name="endDate"
                  value={formData.endDate}
                  onChange={handleChange}
                  disabled={busy}
                  min={formData.eventDate || undefined}
                  max={localDateKey()}
                  ariaInvalid={fieldErrors.endDate ? "true" : undefined}
                />
                {fieldErrors.endDate && <p className="field-error">{fieldErrors.endDate}</p>}
              </div>

              <div className="field col-span-2 md:col-span-1">
                <label htmlFor="endTime">
                  Event End Time<span className="req">*</span>
                </label>
                <TimePicker12h
                  id="endTime"
                  value={formData.endTime}
                  onChange={(val) => setField("endTime", val)}
                  disabled={busy}
                  hasError={Boolean(fieldErrors.endTime)}
                  ariaLabel="Event End Time"
                />
                {fieldErrors.endTime && <p className="field-error">{fieldErrors.endTime}</p>}
              </div>

              <div className="field col-span-2">
                <label htmlFor="location">
                  Venue / Location<span className="req">*</span>
                </label>
                <input
                  id="location"
                  name="location"
                  type="text"
                  value={formData.location}
                  onChange={handleChange}
                  placeholder="e.g. Auditorium Hall B, Medical College Block"
                  disabled={busy}
                  aria-invalid={fieldErrors.location ? "true" : undefined}
                  className="input min-h-10 py-2"
                />
                {fieldErrors.location && <p className="field-error">{fieldErrors.location}</p>}
              </div>

              <div className="field col-span-2">
                <label htmlFor="expectedParticipants">
                  Expected Participants
                  <span className="ml-2 font-normal text-muted">(Optional)</span>
                </label>
                <input
                  id="expectedParticipants"
                  name="expectedParticipants"
                  type="text"
                  value={formData.expectedParticipants}
                  onChange={handleChange}
                  placeholder="e.g. 150 Students & Faculty"
                  disabled={busy}
                  className="input min-h-10 py-2"
                />
              </div>

              <div className="col-span-2 md:col-span-1">
                <Combobox
                  id="organizer"
                  label="Organizer / Faculty Coordinator"
                  required
                  value={formData.organizer}
                  onChange={(value) => setField("organizer", value)}
                  onSelect={selectCoordinator}
                  options={coordinators}
                  loading={coordinatorsLoading}
                  placeholder="e.g. Dr. Rajesh Sharma"
                  disabled={busy}
                  error={fieldErrors.organizer}
                  emptyHint="Not in the list — it will be saved with this event."
                  renderOption={(option) => (
                    <span className="flex items-baseline justify-between gap-3">
                      <span>{option.name}</span>
                      <span className="prose-muted text-xs">{option.phone}</span>
                    </span>
                  )}
                />
                {canSaveCoordinator && (
                  <button
                    type="button"
                    onClick={saveCoordinator}
                    disabled={busy || savingCoordinator}
                    className="btn btn-ghost btn-xs mt-1"
                  >
                    {savingCoordinator
                      ? "Saving…"
                      : `+ Save "${formData.organizer.trim()}" to the directory`}
                  </button>
                )}
              </div>

              <div className="field col-span-2 md:col-span-1">
                <label htmlFor="contactInfo">
                  Coordinator Contact Number
                  <span className="ml-2 font-normal text-muted">(Optional)</span>
                </label>
                <input
                  id="contactInfo"
                  name="contactInfo"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  // Deliberately no maxLength: it counts the raw keystrokes,
                  // so pasting "(98765) 43210" would be cut to 10 characters
                  // before the non-digits are stripped, leaving 9 digits. The
                  // slice below caps the digits themselves instead.
                  value={formData.contactInfo}
                  onChange={(event) => {
                    // PRD 6: digits only, at most ten. Filtering on input beats
                    // an error message for something a keystroke can prevent.
                    contactTouchedRef.current = true;
                    setField("contactInfo", normalizePhoneInput(event.target.value));
                  }}
                  placeholder="9876543210"
                  disabled={busy}
                  aria-invalid={fieldErrors.contactInfo ? "true" : undefined}
                  className="input min-h-10 py-2"
                />
                {fieldErrors.contactInfo && (
                  <p className="field-error">{fieldErrors.contactInfo}</p>
                )}
              </div>

              <div className="field col-span-2">
                <label htmlFor="description">
                  Event Description<span className="req">*</span>
                </label>
                <textarea
                  id="description"
                  name="description"
                  rows="4"
                  value={formData.description}
                  onChange={handleChange}
                  placeholder="Describe event objectives, agenda, keynote speakers, target audience, and expected outcomes…"
                  disabled={busy}
                  aria-invalid={fieldErrors.description ? "true" : undefined}
                  className="input min-h-24 py-2"
                />
                {fieldErrors.description && (
                  <p className="field-error">{fieldErrors.description}</p>
                )}
              </div>

              <div className="field col-span-2 lg:col-span-1">
                <label htmlFor="socialNetworkUrl">
                  Social Network Link
                  <span className="ml-2 font-normal text-muted">(Optional)</span>
                </label>
                <input
                  id="socialNetworkUrl"
                  name="socialNetworkUrl"
                  type="url"
                  value={formData.socialNetworkUrl}
                  onChange={handleChange}
                  placeholder="https://instagram.com/srhu_official"
                  disabled={busy}
                  aria-invalid={fieldErrors.socialNetworkUrl ? "true" : undefined}
                  className="input min-h-10 py-2"
                />
                {fieldErrors.socialNetworkUrl ? (
                  <p className="field-error">{fieldErrors.socialNetworkUrl}</p>
                ) : (
                  <p className="prose-muted text-xs">
                    Instagram, LinkedIn, YouTube, X/Twitter, or Facebook.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ---------------------------------- step 2: images & documents */}
          {step === 2 && (
            <div className="px-4 py-5 sm:px-6 space-y-8">
              {/* Section 1: Images */}
              <section aria-labelledby="section-images-heading">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 id="section-images-heading" className="text-sm font-bold tracking-tight text-ink sm:text-base">
                      Event Images
                    </h3>
                    <p className="prose-muted text-xs">
                      Posters, banners, and photographs — up to {uploadLimits.max_photos_per_event} images, {formatMb(uploadLimits.max_photo_size_mb * 1024 * 1024)} each{uploadLimits.max_photo_total_mb ? ` (${formatMb(uploadLimits.max_photo_total_mb * 1024 * 1024)} total)` : ""}.
                    </p>
                  </div>
                  {required.photos && (
                    <span className="chip chip-sm chip-ember">Mandatory</span>
                  )}
                </div>

                <RequirementNotice
                  required={required.photos}
                  count={photos.length}
                  noun="photo"
                  plural="photos"
                  example="e.g. event poster, banner, or photograph"
                  blocksNextStep
                  failed={uploadErrors.photos}
                  detail={`Up to ${uploadLimits.max_photos_per_event} photos allowed`}
                />

                {photos.length > 0 && (
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/15 bg-accent/6 px-3.5 py-2 text-xs text-ink">
                    <span className="flex items-center gap-2">
                      <IconInfo className="h-4 w-4 shrink-0 text-accent" />
                      <span>
                        Tick the photos to include in the event report, as many as you like; it
                        arranges them to suit their mix of portrait and landscape.
                        {reportChoice === null &&
                          ` Until you choose, the first ${DEFAULT_REPORT_PHOTOS} uploaded are used.`}
                      </span>
                    </span>
                    <span className="font-semibold text-accent">
                      {savingReportPhotos ? "Saving…" : `${reportPhotoIds.length} of ${photos.length} chosen`}
                    </span>
                  </div>
                )}

                <UploadPanel
                  kind="image"
                  accept={IMAGE_ACCEPT}
                  items={photos}
                  uploads={photoUploads}
                  max={uploadLimits.max_photos_per_event}
                  totalLimitBytes={
                    uploadLimits.max_photo_total_mb
                      ? uploadLimits.max_photo_total_mb * 1024 * 1024
                      : null
                  }
                  usedBytes={photoBytesUsed}
                  maxSizeLabel={`JPG, PNG, WebP or GIF up to ${formatMb(uploadLimits.max_photo_size_mb * 1024 * 1024)} each${uploadLimits.max_photo_total_mb ? ` · ${formatMb(uploadLimits.max_photo_total_mb * 1024 * 1024)} total` : ""}`}
                  emptyLabel="Drag photos here"
                  hint="Posters, banners, and photographs of the event."
                  disabled={busy}
                  required={required.photos}
                  reportSelection={{
                    ids: reportPhotoIds,
                    busy: savingReportPhotos,
                    onToggle: toggleReportPhoto,
                  }}
                  onPick={(files) => handlePick(files, "image")}
                  onRemove={handleRemoveMedia}
                  onRetry={runUpload}
                  onDismiss={dismissUpload}
                  onLoadError={refreshMediaLinks}
                />
              </section>

              {/* Section 2: Documents */}
              <section aria-labelledby="section-documents-heading" className="border-t hairline pt-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 id="section-documents-heading" className="text-sm font-bold tracking-tight text-ink sm:text-base">
                      Event Documents
                    </h3>
                    <p className="prose-muted text-xs">
                      PDF, Word, Excel, PowerPoint, TXT or CSV · {formatMb(documentLimitBytes)} total, up to {uploadLimits.max_documents_per_event} files.
                    </p>
                  </div>
                  {required.documents && (
                    <span className="chip chip-sm chip-ember">Mandatory</span>
                  )}
                </div>

                <RequirementNotice
                  required={required.documents}
                  count={documentItems.length}
                  noun="document"
                  plural="documents"
                  example="e.g. event proposal, agenda, circular, or approval letter"
                  failed={uploadErrors.documents}
                  detail={`Total: ${formatMb(documentBytesUsed)} / ${formatMb(documentLimitBytes)}`}
                />

                {/* Categories: Notice & Report */}
                <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
                  {/* Category: Notice */}
                  <div className="rounded-2xl border hairline bg-surface/30 p-4 sm:p-5">
                    <div className="mb-3.5 flex items-center justify-between gap-2 border-b hairline pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center rounded-md bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                            Notice
                          </span>
                          <h4 className="text-sm font-semibold text-ink">Notice Documents</h4>
                        </div>
                        <p className="prose-muted mt-0.5 text-xs">
                          Circulars, event notices, agendas, and invitations
                        </p>
                      </div>
                      <span className="rounded-full bg-raised/80 px-2.5 py-0.5 text-[11px] font-medium text-muted">
                        {noticeDocuments.length}
                      </span>
                    </div>

                    <UploadPanel
                      kind="document"
                      accept={DOC_ACCEPT}
                      items={noticeDocuments}
                      uploads={noticeUploads}
                      max={uploadLimits.max_documents_per_event}
                      totalLimitBytes={documentLimitBytes}
                      usedBytes={noticeBytesUsed}
                      sharedCount={reportCount}
                      sharedBytes={reportBytesUsed}
                      maxSizeLabel={`Notice · PDF, Word, Excel, PPT, TXT, CSV`}
                      emptyLabel="Drag notice documents here"
                      hint="Upload circulars, event notices, or agendas."
                      disabled={busy}
                      onPick={(files) => handlePick(files, "document", "notice")}
                      onRemove={handleRemoveDocument}
                      onRetry={runUpload}
                      onDismiss={dismissUpload}
                      onLoadError={refreshMediaLinks}
                    />
                  </div>

                  {/* Category: Report */}
                  <div className="rounded-2xl border hairline bg-surface/30 p-4 sm:p-5">
                    <div className="mb-3.5 flex items-center justify-between gap-2 border-b hairline pb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center rounded-md bg-ok/10 px-2 py-0.5 text-xs font-semibold text-ok">
                            Report
                          </span>
                          <h4 className="text-sm font-semibold text-ink">Report Documents</h4>
                        </div>
                        <p className="prose-muted mt-0.5 text-xs">
                          Summary reports, attendance lists, and documentation
                        </p>
                      </div>
                      <span className="rounded-full bg-raised/80 px-2.5 py-0.5 text-[11px] font-medium text-muted">
                        {reportDocuments.length}
                      </span>
                    </div>

                    <UploadPanel
                      kind="document"
                      accept={DOC_ACCEPT}
                      items={reportDocuments}
                      uploads={reportUploads}
                      max={uploadLimits.max_documents_per_event}
                      totalLimitBytes={documentLimitBytes}
                      usedBytes={reportBytesUsed}
                      sharedCount={noticeCount}
                      sharedBytes={noticeBytesUsed}
                      maxSizeLabel={`Report · PDF, Word, Excel, PPT, TXT, CSV`}
                      emptyLabel="Drag report documents here"
                      hint="Upload event reports, summary PDFs, or documentation."
                      disabled={busy}
                      onPick={(files) => handlePick(files, "document", "report")}
                      onRemove={handleRemoveDocument}
                      onRetry={runUpload}
                      onDismiss={dismissUpload}
                      onLoadError={refreshMediaLinks}
                    />
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* ------------------------------------------------- step 3: videos */}
          {step === 3 && (
            <div className="px-4 py-5 sm:px-6">
              <RequirementNotice
                required={required.videos}
                count={videos.length}
                noun="video"
                plural="videos"
                example="e.g. a teaser, highlights, or a recording"
                blocksNextStep
                failed={uploadErrors.videos}
              />

              <UploadPanel
                kind="video"
                accept={VIDEO_ACCEPT}
                items={videos}
                uploads={videoUploads}
                max={uploadLimits.max_videos_per_event}
                totalLimitBytes={uploadLimits.max_video_total_mb * 1024 * 1024}
                usedBytes={videoBytesUsed}
                maxSizeLabel={`MP4, WebM or MOV · ${formatMb(uploadLimits.max_video_total_mb * 1024 * 1024)} total${uploadLimits.max_videos_per_event ? `, up to ${uploadLimits.max_videos_per_event} files` : ", any number of files"}${uploadLimits.max_video_size_mb ? ` (${formatMb(uploadLimits.max_video_size_mb * 1024 * 1024)} per file)` : ""}`}
                emptyLabel="Drag videos here"
                hint="Teasers, highlights, or a recording of the event."
                disabled={busy}
                required={required.videos}
                onPick={(files) => handlePick(files, "video")}
                onRemove={handleRemoveMedia}
                onRetry={runUpload}
                onDismiss={dismissUpload}
                onLoadError={refreshMediaLinks}
              />

              <div className="mt-4 flex items-start gap-3 rounded-xl border border-accent/15 bg-accent/6 p-3.5">
                <IconInfo className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <p className="text-sm text-ink">
                  {direct
                    ? resubmitting
                      ? "Saving updates the recorded event and its report."
                      : "Once saved, the event is recorded straight away. No approval is needed, and its report can be downloaded at once."
                    : resubmitting
                    ? "Resubmitting sets the event status back to Pending and notifies the Dean for re-evaluation."
                    : "Once submitted, your event enters the approval workflow and is reviewed by the Dean."}
                </p>
              </div>
            </div>
          )}

          {/* ---------------------------------------------- saved-files note */}
          {serverEventId && isDraftEvent && (
            <div className="border-t hairline px-4 py-2.5 sm:px-6" role="status">
              {uploading ? (
                <p className="prose-muted flex items-center gap-2 text-xs">
                  <span className="spin h-4 w-4 shrink-0 text-accent" />
                  Uploading. Keep this page open until the uploads finish.
                </p>
              ) : !formDirty ? (
                <p className="prose-muted flex items-center gap-2 text-xs">
                  <IconCheckCircle className="h-4 w-4 shrink-0 text-ok" />
                  Saved as a draft with your files. You can close this page and come
                  back to it.
                </p>
              ) : autoSave === "error" ? (
                <p className="flex items-center gap-2 text-xs text-err">
                  <IconAlertTriangle className="h-4 w-4 shrink-0" />
                  Your latest changes could not be saved automatically. Use Save Draft
                  before leaving this page.
                </p>
              ) : !detailsComplete ? (
                <p className="prose-muted flex items-center gap-2 text-xs">
                  <IconInfo className="h-4 w-4 shrink-0 text-accent" />
                  Your files are saved, but your latest edits are not. Complete the
                  required details so they can be saved.
                </p>
              ) : (
                <p className="prose-muted flex items-center gap-2 text-xs">
                  <span className="spin h-4 w-4 shrink-0 text-accent" />
                  Saving your changes…
                </p>
              )}
            </div>
          )}

          {/* ------------------------------------------------------- actions
              Sticky, so Next / Submit and Save Draft stay on screen however
              far down the form the teacher is. One row at every width: on a
              phone Save Draft drops to its icon rather than stacking three
              full-width buttons over the form. */}
          <div className="sticky bottom-0 z-10 flex items-center gap-2 border-t hairline bg-(--card-bg) px-4 py-3 shadow-[0_-10px_24px_-18px_var(--shadow-strong)] sm:gap-3 sm:px-6">
            {step === 1 ? (
              <button
                type="button"
                onClick={() => navigate(originPath)}
                disabled={busy}
                className="btn btn-ghost btn-sm"
              >
                Cancel
              </button>
            ) : (
              <button
                type="button"
                onClick={handleBack}
                disabled={busy}
                className="btn btn-ghost btn-sm"
              >
                <IconArrowLeft />
                Back
              </button>
            )}

            <div className="ml-auto flex min-w-0 items-center gap-2 sm:gap-3">
              {!resubmitting && (
                <button
                  type="button"
                  onClick={handleSaveDraft}
                  disabled={busy || uploading}
                  className="btn btn-ghost btn-sm"
                  aria-label={savingDraft ? "Saving draft" : "Save draft"}
                >
                  {savingDraft ? <span className="spin h-4 w-4" /> : <IconBookmark />}
                  <span className="hidden sm:inline">
                    {savingDraft ? "Saving Draft…" : "Save Draft"}
                  </span>
                </button>
              )}

              {/* Distinct keys matter: with one key React would reuse a single
                  DOM button and only swap its type, which is what let a click
                  on "Next" fall through into a form submit. */}
              {step < STEPS.length ? (
                <button
                  key="wizard-next"
                  type="button"
                  onClick={handleNext}
                  disabled={busy}
                  className="btn btn-primary btn-sm"
                >
                  <span className="sm:hidden">Next</span>
                  <span className="hidden sm:inline">Next: {STEPS[step].label}</span>
                  <IconArrowRight />
                </button>
              ) : (
                <button
                  key="wizard-submit"
                  type="submit"
                  disabled={busy || uploading}
                  className="btn btn-primary btn-sm"
                >
                  {loading && <span className="spin h-4 w-4" />}
                  <span className="sm:hidden">
                    {loading ? "Sending…" : uploading ? "Uploading…" : resubmitting ? "Resubmit" : "Submit"}
                  </span>
                  <span className="hidden sm:inline">
                    {loading
                      ? resubmitting
                        ? "Resubmitting…"
                        : "Submitting…"
                      : uploading
                      ? "Waiting for uploads…"
                      : resubmitting
                      ? direct ? "Save Changes" : "Update & Resubmit for Approval"
                      : direct ? "Save Event" : "Submit for Approval"}
                  </span>
                </button>
              )}
            </div>
          </div>
        </form>

      </div>

      {/* Over the byte budget (PRD 8 / 11). A dialog rather than the page
          banner: the banner sits well above the upload panel the teacher is
          looking at, and this is the message they must not scroll past. */}
      <Modal
        open={Boolean(limitNotice)}
        onClose={() => setLimitNotice(null)}
        eyebrow="Upload limit"
        title="Limit exceeded"
        footer={
          <button
            type="button"
            className="btn btn-brand btn-sm"
            onClick={() => setLimitNotice(null)}
          >
            OK
          </button>
        }
      >
        <p className="text-sm text-ink">{limitNotice}</p>
        <p className="prose-muted mt-2 text-xs">
          Files picked before the limit was reached have been added. Remove
          something to make room for the rest.
        </p>
      </Modal>

      {/* Duplicate file name (PRD 10). Storage keys every file separately, so
          this is a question about the teacher's intent, not a conflict. */}
      <Modal
        open={Boolean(dupPrompt)}
        onClose={() => setDupPrompt(null)}
        eyebrow="Duplicate name"
        title="Are you sure you want to upload a file with the same name?"
        subtitle={
          dupPrompt?.names.length > 1
            ? "These names are already attached to this event."
            : "This name is already attached to this event."
        }
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setDupPrompt(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-brand btn-sm"
              onClick={() => {
                const pending = dupPrompt;
                setDupPrompt(null);
                if (pending) queueUploads(pending.duplicates, pending.kind, pending.category);
              }}
            >
              Upload anyway
            </button>
          </>
        }
      >
        <ul className="space-y-1.5">
          {(dupPrompt?.names || []).map((name) => (
            <li key={name} className="flex items-center gap-2 text-sm text-ink">
              <IconAlertTriangle className="h-4 w-4 shrink-0 text-emberink" />
              <span className="truncate">{name}</span>
            </li>
          ))}
        </ul>
      </Modal>

      {/* Confirmation that the draft is stored. A dialog, not a banner: it is
          centred wherever the page happens to be scrolled, and it names the
          two ways out instead of leaving the teacher on a form they have
          already saved. */}
      <Modal
        open={Boolean(draftSaved)}
        onClose={() => setDraftSaved(null)}
        eyebrow="Draft saved"
        title="Your event is saved as a draft"
        subtitle={direct ? "It is not recorded as an event yet." : "Nothing has been sent to the Dean yet."}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDraftSaved(null)}
              className="btn btn-ghost"
            >
              Keep editing
            </button>
            <Link to={`${panel.base}/my-events?filter=draft`} className="btn btn-primary">
              Go to My Events
              <IconArrowRight />
            </Link>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              “{formData.eventName.trim() || "Untitled event"}” has been saved.
            </p>

            {/* The distinction matters: a browser draft is the one that does
                not follow the teacher to another machine. */}
            <p className="prose-muted mt-1.5 text-sm">
              {draftSaved?.where === "server"
                ? "It is stored on your Campus Capture account, with any files you have already uploaded. Pick it up from My Events whenever you like, on any device."
                : "It is kept in this browser until the required details are filled in, so nothing you have typed is lost. Complete the event details to store it on your account."}
            </p>

            <p className="prose-muted mt-3 text-xs">
              {direct
                ? "Save it as an event from the last step when it is ready."
                : "Submit it for Dean approval from the last step when it is ready."}
            </p>
          </div>
        </div>
      </Modal>

      {/* -------------------------------------------------- 1. are you sure?
          Nothing has been sent while this is open. Cancel (or Escape, or a
          click outside) returns to the form with every field as it was. */}
      <Modal
        open={confirmOpen}
        onClose={cancelSubmit}
        eyebrow="Confirm"
        title={
          direct
            ? resubmitting
              ? "Save the changes to this event?"
              : "Are you sure you want to save this event?"
            : resubmitting
            ? "Are you sure you want to resubmit this event?"
            : "Are you sure you want to submit this event?"
        }
        subtitle={
          direct
            ? "Check everything below, then confirm. It is recorded straight away."
            : "Check everything below, then confirm. It will be sent to the Dean for approval."
        }
        wide
        footer={
          <>
            <button
              type="button"
              onClick={cancelSubmit}
              disabled={loading}
              className="btn btn-ghost btn-sm"
            >
              Back to editing
            </button>
            <button
              type="button"
              onClick={confirmSubmit}
              disabled={loading}
              className="btn btn-primary btn-sm"
              autoFocus
            >
              {loading ? <span className="spin h-4 w-4" /> : <IconCheck />}
              {direct
                ? loading
                  ? "Saving…"
                  : "Confirm and save"
                : loading
                ? resubmitting
                  ? "Resubmitting…"
                  : "Submitting…"
                : resubmitting
                ? "Confirm and resubmit"
                : "Confirm and submit"}
            </button>
          </>
        }
      >
        {/* The whole form, not a four-row digest: PRD 12 asks the teacher to
            review everything they filled in before it reaches the Dean. */}
        <div className="rounded-xl border hairline bg-raised/40 p-4">
          <EventSummary
            event={{
              eventName: formData.eventName.trim() || "Untitled event",
              eventType:
                formData.eventType === "Other"
                  ? formData.eventTypeOther.trim() || "Other"
                  : formData.eventType || "Not set",
              eventDate: formData.eventDate,
              endDate: formData.endDate,
              location: formData.location.trim(),
              socialNetworkUrl: formData.socialNetworkUrl.trim(),
            }}
            fields={{
              startTime: formData.startTime,
              endTime: formData.endTime,
              organizer: formData.organizer.trim(),
              contactInfo: formData.contactInfo.trim(),
              department: formData.department?.trim() || DEFAULT_HOST_DEPARTMENT,
              expectedParticipants: formData.expectedParticipants.trim(),
              description: formData.description.trim(),
            }}
            photos={photos}
            videos={videos}
            documents={documentItems}
          />
        </div>

        <p className="prose-muted mt-3 text-xs">
          {direct
            ? "You can still edit the event afterwards."
            : "You can still edit the event until the Dean approves it."}
        </p>

        {confirmError && (
          <div
            className="mt-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3"
            data-tint=""
            style={{ "--track": trackOf("rejected") }}
            role="alert"
          >
            <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-err" />
            <p className="text-sm text-ink">
              {confirmError} Nothing was {direct ? "saved" : "submitted"} — try again, or cancel to keep editing.
            </p>
          </div>
        )}
      </Modal>

      {/* ---------------------------------------------------- 2. submitted
          Shown only once the server has accepted it, with the status the
          server gave it, so "pending" here is the real state, not a guess. */}
      <Modal
        open={Boolean(submitted)}
        onClose={finishSubmission}
        eyebrow={direct ? "Saved" : resubmitting ? "Resubmitted" : "Submitted"}
        title={
          direct
            ? resubmitting
              ? "Event updated successfully!"
              : "Event saved successfully!"
            : resubmitting
            ? "Event resubmitted successfully!"
            : "Event submitted successfully!"
        }
        subtitle={
          direct
            ? "It is recorded. You can download its report now."
            : "It is now with the Dean for approval."
        }
        footer={
          <>
            {submitted?.id && (
              <Link
                to={`${panel.base}/events/${submitted.id}`}
                onClick={() => setSubmitted(null)}
                className="btn btn-ghost btn-sm"
              >
                View event
              </Link>
            )}
            <button type="button" onClick={finishSubmission} className="btn btn-primary btn-sm">
              Go to My Events
              <IconArrowRight />
            </button>
          </>
        }
      >
        <div className="flex items-start gap-3">
          <span
            className="icon-tile icon-tile-track shrink-0"
            style={{ "--track": trackOf("approved") }}
          >
            <IconCheckCircle />
          </span>

          <div className="min-w-0">
            <p className="font-display text-sm font-semibold text-ink">
              “{submitted?.event_name || formData.eventName.trim() || "Your event"}”
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
              Status:
              <StatusChip status={submitted?.status || (direct ? "recorded" : "pending")} />
              <span>{direct ? "— no approval needed" : "— submitted for Dean approval"}</span>
            </div>

            <p className="prose-muted mt-3 text-sm">
              {direct
                ? "Open the event to choose the photos for its report and download it."
                : "You will get a notification when the Dean approves it or asks for changes, and every step appears in the event’s progress history."}
            </p>
          </div>
        </div>
      </Modal>
    </TeacherShell>
  );
}

export default CreateEvent;
