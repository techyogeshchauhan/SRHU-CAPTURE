import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import Combobox from "../../components/common/Combobox";
import DateInputDMY from "../../components/common/DateInputDMY";
import PageHero from "../../components/teacher/PageHero";
import Modal from "../../components/teacher/Modal";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconCheck,
  IconSave,
  IconSearch,
  IconUserPlus,
  IconX,
} from "../../components/teacher/icons";
import { DuplicateNotice } from "../../components/research/ResearchNotices";
import AddFacultyModal from "../../components/research/AddFacultyModal";
import CategoryIcon from "../../components/research/CategoryIcon";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { isAbortError } from "../../services/api";
import {
  checkDuplicates,
  createResearch,
  getResearch,
  lookupDoi,
  searchFaculty,
  submitResearch,
  updateResearch,
} from "../../services/research";
import { dmyProblem } from "../../utils/dates";
import { authorIndex, compactDetails, emptyDetails, isFieldRequired, isFieldShown } from "../../utils/research";
import MultiSelectDropdown from "../../components/common/MultiSelectDropdown";

const EMPTY = { title: "", record_date: "", outcome_status: "", link: "" };

/**
 * Add or edit a research record. Both authoring panels:
 *
 * - The Event Manager first picks the teacher the research belongs to.
 * - A teacher always records their own.
 *
 * The form is drawn from the category's definition on the server. A record
 * is saved as a draft and submitted from here or from its own page. Research
 * takes no file uploads. Required fields are marked but only enforced on submission,
 * so a half-known record can be saved and finished later.
 */
// Crossref describes books too, but a book record keeps no DOI: its box only
// fills the form.
const DOI_LOOKUP_ONLY = new Set(["book"]);

export default function ResearchForm() {
  const { recordId } = useParams();
  // "Fill in" on a record's page opens the form with ?fill=1: what is still
  // needed for submission is marked from the start.
  const [searchParams] = useSearchParams();
  const fillMode = searchParams.get("fill") === "1";
  const editing = Boolean(recordId);
  const navigate = useNavigate();
  const panel = usePanel();
  const manager = panel.role === "event_manager";
  const { profile, logout } = useShellProfile();
  const { categories, byKey, loading: categoriesLoading, error: categoriesError } = useResearchCategories();

  const [record, setRecord] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [categoryKey, setCategoryKey] = useState("");
  // A change of research type that would clear details already typed in,
  // waiting for the author to confirm it.
  const [pendingType, setPendingType] = useState("");
  const [form, setForm] = useState(EMPTY);
  const [details, setDetails] = useState({});
  const [faculty, setFaculty] = useState(null);
  // The other SRHU teachers who are authors of the same work (Event Manager).
  const [coFaculty, setCoFaculty] = useState([]);
  const [facultyText, setFacultyText] = useState("");
  const [facultyOptions, setFacultyOptions] = useState([]);
  const [facultyLoading, setFacultyLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [facultyError, setFacultyError] = useState("");
  const [doi, setDoi] = useState("");
  const [doiBusy, setDoiBusy] = useState(false);
  const [doiMessage, setDoiMessage] = useState(null);
  // The paper's full author list from the last DOI look-up, to check the
  // faculty member is on it.
  const [doiAuthors, setDoiAuthors] = useState(null);
  const [duplicates, setDuplicates] = useState([]);
  const [addingFaculty, setAddingFaculty] = useState(false);
  // What is typed in each date box (keyed by input id), so text that is not
  // a date is reported instead of being saved as a blank date.
  const [dateText, setDateText] = useState({});
  const [showMissing, setShowMissing] = useState(fillMode);
  const [facultyNotice, setFacultyNotice] = useState("");

  const category = byKey[categoryKey] || null;
  // What the category calls the person: "Author name", "Name of inventor".
  const personLabel = category?.person_label || "Faculty name";
  const addAnother = {
    "Author name": "Add another author",
    "Name of inventor": "Add another inventor",
  }[personLabel] || "Add another faculty member";
  const authors = faculty ? [faculty, ...coFaculty] : coFaculty;

  // The first teacher chosen is the one the record belongs to; everyone after
  // is a co-author, and the record shows in each one's research too.
  const addAuthor = (person) => {
    setFacultyError("");
    setFacultyText("");
    if (!faculty) setFaculty(person);
    else if (person.id !== faculty.id && !coFaculty.some((p) => p.id === person.id)) setCoFaculty((prev) => [...prev, person]);
  };
  const removeAuthor = (person) => {
    if (person.id === faculty?.id) {
      setFaculty(coFaculty[0] || null);
      setCoFaculty(coFaculty.slice(1));
    } else {
      setCoFaculty((prev) => prev.filter((p) => p.id !== person.id));
    }
  };
  // Whose research this is: the teacher picked by the Event Manager, or the
  // teacher signed in.
  const ownerName = manager ? faculty?.name : profile?.name;
  const ownerMissing = Boolean(doiAuthors?.length && ownerName && authorIndex(ownerName, doiAuthors) < 0);

  // ---------------------------------------------------------- editing
  useEffect(() => {
    if (!editing) return;
    let live = true;
    getResearch(recordId)
      .then(({ record: loaded }) => {
        if (!live) return;
        setRecord(loaded);
        setCategoryKey(loaded.category);
        setForm({
          title: loaded.title || "",
          record_date: loaded.record_date || "",
          outcome_status: loaded.outcome_status || "",
          link: loaded.link || "",
        });
        setDetails(loaded.details || {});
        setFaculty(loaded.faculty || null);
        setCoFaculty(loaded.co_faculty || []);
      })
      .catch((err) => live && setLoadError(err?.message || "This record could not be loaded."));
    return () => {
      live = false;
    };
  }, [editing, recordId]);

  // A new record starts on its category's first outcome with empty fields.
  const chooseCategory = (key) => {
    const next = byKey[key];
    setCategoryKey(key);
    setForm((prev) => ({ ...prev, outcome_status: next?.outcomes?.[0]?.key || "" }));
    setDetails(emptyDetails(next));
    setError("");
  };

  // Another research type has other fields, so what was typed into this
  // one's is lost: asked first, never silently. Title, date and link stay.
  const detailsTyped = Object.values(compactDetails(details)).length > 0;
  const pickType = (key) => {
    if (key === categoryKey) return;
    if (category && detailsTyped) setPendingType(key);
    else chooseCategory(key);
  };

  // ---------------------------------------------------------- faculty search
  const searchRef = useRef(null);
  useEffect(() => {
    if (!manager) return undefined;
    searchRef.current?.abort();
    const controller = new AbortController();
    searchRef.current = controller;
    const timer = setTimeout(() => {
      setFacultyLoading(true);
      searchFaculty(facultyText.trim(), { signal: controller.signal })
        .then((body) => !controller.signal.aborted && setFacultyOptions(body?.faculty || []))
        .catch((err) => {
          if (!isAbortError(err)) console.error("Faculty search error:", err);
        })
        .finally(() => !controller.signal.aborted && setFacultyLoading(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [facultyText, manager]);

  // ---------------------------------------------------------- DOI
  // Crossref suggests; the author checks every field before saving.
  const fillFromDoi = async (value = doiValue) => {
    setDoiMessage(null);
    const typed = value.trim();
    if (!typed) return;
    setDoiBusy(true);
    try {
      const { suggestion } = await lookupDoi(typed);
      const target = byKey[suggestion.category];
      if (!target) throw new Error("Crossref describes this as something the portfolio has no category for.");
      const sameCategory = target.key === categoryKey;
      const blank = emptyDetails(target);
      // The fields the DOI speaks for are replaced -- emptied where Crossref
      // has nothing, so nothing is left over from an earlier DOI. What the
      // author typed elsewhere (indexing, quartile…) stays.
      const next = sameCategory ? { ...blank, ...details } : { ...blank };
      for (const key of suggestion.doi_fields || []) if (key in blank) next[key] = blank[key];
      Object.assign(next, suggestion.details);
      const authors = suggestion.author_names || [];
      if ("author_position" in blank && !next.author_position && authorIndex(ownerName, authors) === 0) {
        next.author_position = "First author / Corresponding author";
      }
      setCategoryKey(target.key);
      setForm((prev) => ({
        ...prev,
        title: suggestion.title || prev.title,
        record_date: suggestion.record_date || prev.record_date,
        outcome_status:
          suggestion.outcome_status || (sameCategory && prev.outcome_status) || target.outcomes[0]?.key || "",
        link: suggestion.link || prev.link,
      }));
      setDetails(next);
      setDoiAuthors(authors);
      const toFill = target.fields
        .filter((field) => field.required && isFieldShown(field, next))
        .filter((field) => (Array.isArray(next[field.key]) ? !next[field.key].length : !next[field.key]))
        .map((field) => field.label);
      setDoiMessage({
        ok: true,
        text: `Filled in as a ${target.label.toLowerCase()} from Crossref. Check every field against the paper.${
          toFill.length ? ` Crossref does not know: ${toFill.join(", ")}.` : ""
        }`,
        notes: suggestion.notes || [],
      });
      setError("");
    } catch (err) {
      setDoiMessage({ ok: false, text: err?.message || "That DOI could not be looked up." });
    } finally {
      setDoiBusy(false);
    }
  };

  // ---------------------------------------------------------- duplicates
  // Checked as the identifying fields change, so the author is warned
  // before saving a second copy of a paper or a patent.
  const identity = JSON.stringify([
    categoryKey,
    form.title.trim().toLowerCase(),
    details.doi,
    details.isbn,
    details.application_number,
    details.patent_number,
    details.sanction_number,
    details.book_type,
  ]);
  useEffect(() => {
    if (!categoryKey || (form.title.trim().length < 12 && !details.doi && !details.isbn && !details.application_number)) {
      setDuplicates([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkDuplicates(
        {
          category: categoryKey,
          title: form.title,
          details: compactDetails(details),
          exclude_id: recordId || null,
          faculty_id: faculty?.id || null,
        },
        { signal: controller.signal },
      )
        .then((body) => !controller.signal.aborted && setDuplicates(body.duplicates || []))
        .catch(() => {});
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // `identity` captures exactly the fields that decide a match.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, recordId, faculty?.id]);

  const setField = (name, value) => setForm((prev) => ({ ...prev, [name]: value }));
  const setDetail = (key, value) => setDetails((prev) => ({ ...prev, [key]: value }));

  const backTo = editing ? `${panel.base}/research/${recordId}` : `${panel.base}/research`;

  const setTyped = (id) => (text) => setDateText((prev) => ({ ...prev, [id]: text }));
  const dateProblems = Object.fromEntries(
    Object.entries(dateText)
      .map(([id, text]) => [id, dmyProblem(text)])
      .filter(([, problem]) => problem),
  );

  // Everything the Dean needs that is still empty, in form order. Saving a
  // draft does not need any of it; submitting does (the server's rule).
  const missingNow = [];
  if (category) {
    if (!form.title.trim()) missingNow.push({ id: "title", label: category.title_label });
    if (!form.record_date) missingNow.push({ id: "record_date", label: category.date_label });
    for (const field of category.fields || []) {
      const value = details[field.key];
      const empty = Array.isArray(value) ? value.length === 0 : value === undefined || value === null || String(value).trim() === "";
      if (empty && isFieldRequired(category, field, form.outcome_status, details)) {
        missingNow.push({ id: `detail-${field.key}`, label: field.label });
      }
    }
  }
  const missingIds = new Set(missingNow.map((m) => m.id));

  const goTo = (id) => {
    const target = document.getElementById(id) || document.getElementById(`${id}-label`);
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus?.({ preventScroll: true });
  };

  // Arriving from "Fill in": take the author straight to the first gap.
  const jumped = useRef(false);
  useEffect(() => {
    if (!fillMode || jumped.current || !category || (editing && !record)) return;
    jumped.current = true;
    const first = missingNow[0];
    if (first) requestAnimationFrame(() => goTo(first.id));
  });

  // Recording / submitting from the form: new records, and any record whose
  // page would offer it (a draft, or one sent back).
  const canSubmitHere = !editing || Boolean(record?.permissions?.can_submit);
  const submitLabel = manager ? "Save & record" : "Save & submit for verification";

  const save = (event) => {
    event.preventDefault();
    persist(false);
  };

  const persist = async (andSubmit) => {
    setError("");
    setFacultyError("");
    const badDate = Object.keys(dateProblems)[0];
    if (badDate) {
      setError("A date is not in DD/MM/YYYY form — see the field marked below. Nothing was saved.");
      goTo(badDate);
      return;
    }
    if (!category) {
      setError("Choose what kind of research this is.");
      return;
    }
    if (manager && !editing && !faculty?.id) {
      setFacultyError("Choose the teacher this research belongs to.");
      return;
    }
    if (!form.title.trim()) {
      setError(`Give the record a ${category.title_label.toLowerCase()}.`);
      return;
    }
    if (andSubmit) {
      const verb = manager ? "record it" : "submit it";
      if (missingNow.length > 0) {
        setShowMissing(true);
        setError(`To ${verb} now, fill in ${missingNow.map((m) => m.label).join(", ")} — or use Save draft.`);
        goTo(missingNow[0].id);
        return;
      }
    }

    const body = {
      title: form.title,
      record_date: form.record_date || null,
      outcome_status: form.outcome_status || undefined,
      link: form.link || null,
      details: compactDetails(details),
    };
    // An older record may hold a status its category no longer offers (a
    // journal paper still "accepted"): it is left as it is.
    if (!category.outcomes.some((outcome) => outcome.key === body.outcome_status)) delete body.outcome_status;

    setSaving(true);
    let saved;
    try {
      if (editing) {
        ({ record: saved } = await updateResearch(recordId, {
          ...body,
          co_faculty_ids: manager ? coFaculty.map((p) => p.id) : undefined,
          expected_updated_at: record?.updated_at,
        }));
      } else {
        ({ record: saved } = await createResearch({
          ...body,
          category: category.key,
          faculty_id: manager ? faculty.id : undefined,
          co_faculty_ids: manager ? coFaculty.map((p) => p.id) : undefined,
        }));
      }
    } catch (err) {
      setError(err?.message || "The record could not be saved.");
      setSaving(false);
      return;
    }

    // The record exists now; whatever happens next is reported on its page.
    let notice = editing ? "saved" : "created";
    let submitError = "";
    if (andSubmit) {
      try {
        const done = await submitResearch(saved.id);
        notice = done.record?.recorded_by_manager ? "recorded" : "submitted";
      } catch (err) {
        submitError = err?.message || "The record was saved but could not be submitted.";
      }
    }
    navigate(`${panel.base}/research/${saved.id}`, {
      replace: true,
      state: { notice, submitError },
    });
  };

  const fields = useMemo(() => category?.fields || [], [category]);
  // One optional DOI box, inside the form. Where the category stores a DOI
  // (journal, conference) the box is that field; for a book it only feeds the
  // Crossref look-up. Categories Crossref does not describe get no box.
  const doiStored = fields.some((field) => field.type === "doi");
  const doiShown = Boolean(category && (doiStored || DOI_LOOKUP_ONLY.has(category.key)));
  const doiValue = doiStored ? details.doi || "" : doi;
  const setDoiValue = (value) => (doiStored ? setDetail("doi", value) : setDoi(value));
  const doiField = doiShown ? (
    <div className={`field col-span-2 ${manager ? "mt-4" : ""}`}>
      <label htmlFor="detail-doi">
        DOI URL<span className="ml-2 font-normal text-muted">(Optional)</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id="detail-doi"
          type="text"
          value={doiValue}
          onChange={(e) => setDoiValue(e.target.value)}
          onPaste={(e) => {
            const pasted = e.clipboardData.getData("text").trim();
            if (!pasted) return;
            e.preventDefault();
            setDoiValue(pasted);
            fillFromDoi(pasted);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              fillFromDoi();
            }
          }}
          placeholder="Paste a DOI URL, e.g. https://doi.org/10.1016/j.cell.2026.01.001"
          aria-invalid={dateProblems["detail-doi"] ? "true" : undefined}
          className="input min-w-0 flex-1 basis-64"
        />
        <button type="button" onClick={fillFromDoi} disabled={doiBusy || !doiValue.trim()} className="btn btn-ghost">
          {doiBusy ? <span className="spin h-4 w-4" /> : <IconSearch />}
          {doiBusy ? "Fetching details" : "Fetch details"}
        </button>
      </div>
      {doiMessage ? (
        <p className={doiMessage.ok ? "mt-1 text-xs text-ink" : "field-error"} role={doiMessage.ok ? "status" : "alert"}>
          {doiMessage.text}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">Paste a DOI URL to fill in available publication details automatically. Review the details before saving.</p>
      )}
      {(doiMessage?.notes?.length > 0 || ownerMissing) && (
        <ul className="mt-1.5 list-none space-y-1.5" aria-label="Check by hand">
          {ownerMissing && (
            <li className="flex items-start gap-2 text-sm text-ink">
              <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: trackOf("pending") }} />
              {ownerName} is not among this paper's {doiAuthors.length === 1 ? "author" : `${doiAuthors.length} authors`} on Crossref.
              Check the DOI{manager ? " and the faculty member" : ""}.
            </li>
          )}
          {doiMessage?.notes?.map((note) => (
            <li key={note} className="flex items-start gap-2 text-sm text-ink">
              <IconAlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: trackOf("pending") }} />
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null;
  const showOutcome = (category?.outcomes || []).length > 1;
  const verified = record?.verification_status === "verified";

  return (
    <TeacherShell active="research" profile={profile} onLogout={logout} showToTop={false}>
      <div className={`mx-auto w-full max-w-wrap px-5 sm:px-8 ${manager ? "py-6" : "py-8"}`}>
        <div className={manager ? "mb-4" : "mb-5"}>
          <div className="flex flex-wrap items-center gap-2">
            <Link to={backTo} className={`btn btn-ghost ${manager ? "btn-xs" : "btn-sm"}`}>
              <IconArrowLeft />
              {editing ? "Back to the record" : "Back to research"}
            </Link>
          </div>
        </div>

        <PageHero
          compact
          eyebrow={editing ? (record && !category ? "Legacy record" : "Edit research record") : "Add research"}
          title={editing ? form.title || "Research record" : category ? category.label : "Add research"}
          subtitle={
            editing
              ? category?.label || record?.category_label
              : manager
                ? undefined
                : "Saved as a draft. Send it to the Dean from here or from the record's page."
          }
        />

        {(loadError || categoriesError) && (
          <div className={`flex items-start gap-3 rounded-2xl border p-4 ${manager ? "mt-4" : "mt-6"}`} data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm text-ink">{loadError || categoriesError}</p>
          </div>
        )}

        {(categoriesLoading || (editing && !record && !loadError)) && (
          <div className="flex h-48 items-center justify-center">
            <span className="spin h-8 w-8 text-accent" />
          </div>
        )}

        {!categoriesLoading && (!editing || record) && (
          <form onSubmit={save} className={manager ? "mt-4 space-y-4" : "mt-6 space-y-6"} noValidate>
            {editing && record && !category && (
              <section className="glass p-5 sm:p-6" role="note">
                <h2 className="h3 text-base text-ink">This category is no longer available</h2>
                <p className="prose-muted mt-1 text-sm">
                  This existing record is still available to view, but it can no longer be edited or submitted.
                </p>
                <Link to={`${panel.base}/research/${record.id}`} className="btn btn-ghost btn-sm mt-4">
                  Back to the record
                </Link>
              </section>
            )}
            {verified && category && (
              <div className="flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("pending") }} role="note">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("pending") }} />
                <p className="text-sm text-ink">
                  {manager
                    ? "This record is accepted. Your changes are saved straight to it — Event Manager changes need no Dean verification."
                    : "This record is verified. Saving a change sends it back to the Dean, who will see exactly what changed. Updating a patent from Filed to Granted, for example, works this way."}
                </p>
              </div>
            )}

            {/* ------------------------------------------------ research type */}
            {!editing && (
              <section className="glass p-5 sm:p-6">
                <div className="field max-w-xl">
                  <label htmlFor="research-type">
                    Select research type<span className="req">*</span>
                  </label>
                  <div className="flex items-center gap-3">
                    {category && (
                      <span className="icon-tile h-10 w-10 shrink-0 rounded-xl" aria-hidden="true">
                        <CategoryIcon category={category.key} />
                      </span>
                    )}
                    <select
                      id="research-type"
                      value={categoryKey}
                      onChange={(e) => pickType(e.target.value)}
                      className={`input min-w-0 flex-1 ${categoryKey ? "" : "is-placeholder"}`}
                    >
                      <option value="" disabled>
                        Choose what you are recording…
                      </option>
                      {categories.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="field-hint mt-1">
                    {category ? category.description : "The form for that kind of research opens below."}
                  </p>
                </div>
              </section>
            )}

            {category && (
              <>
                {/* ------------------------------------------------ whose */}
                {manager && (
                  <section className="glass p-5 sm:p-6">
                    {/* The add action sits in the heading, not under the picker:
                        the picker's open list would cover it right when a
                        search finds nobody, which is when it is needed. */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h2 className="h3 text-base text-ink">{personLabel}</h2>
                      <button type="button" onClick={() => setAddingFaculty(true)} className="btn btn-ghost btn-xs">
                        <IconUserPlus />
                        Add a new faculty member
                      </button>
                    </div>
                    {authors.length > 0 && (
                      <ul className="mt-3 flex list-none flex-wrap gap-2 p-0" aria-label="Selected authors">
                        {authors.map((person, index) => {
                          // The record's own faculty member stays once it is saved.
                          const fixed = editing && index === 0;
                          return (
                            <li key={person.id} className="chip gap-1.5 py-1 pl-3 pr-1.5">
                              <span className="font-medium text-ink">{person.name}</span>
                              {index === 0 && authors.length > 1 && <span className="text-xs text-muted">· first</span>}
                              {!fixed && (
                                <button
                                  type="button"
                                  onClick={() => removeAuthor(person)}
                                  className="icon-btn icon-btn-sm"
                                  aria-label={`Remove ${person.name}`}
                                >
                                  <IconX className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    <div className="mt-3 max-w-xl">
                      <Combobox
                        id="faculty"
                        label={authors.length ? addAnother : personLabel}
                        required={!faculty}
                        value={facultyText}
                        onChange={setFacultyText}
                        onSelect={(option) => {
                          addAuthor(option);
                          setFacultyNotice("");
                        }}
                        options={facultyOptions.filter((option) => !authors.some((p) => p.id === option.id))}
                        loading={facultyLoading}
                        filterLocally={false}
                        placeholder="Search teachers by name or email"
                        error={facultyError}
                        hint="Choose every SRHU teacher involved. The record shows in each one's research."
                        emptyHint="No teacher matches that search. Use “Add a new faculty member” above to add them."
                        renderOption={(option) => (
                          <span className="flex flex-col">
                            <span className="font-medium">{option.name}</span>
                            <span className="text-xs text-muted">
                              {[option.designation, option.email].filter(Boolean).join(" · ")}
                            </span>
                          </span>
                        )}
                      />
                      {facultyNotice && (
                        <p className="mt-2 text-sm text-ink" role="status">
                          {facultyNotice}
                        </p>
                      )}
                    </div>
                    {manager && doiField}
                  </section>
                )}

                {/* ------------------------------------------------ the record */}
                <section className="glass p-5 sm:p-6">
                  <h2 className="h3 text-base text-ink">About the {category.short.toLowerCase()}</h2>
                  <p className="prose-muted mt-0.5 text-xs">
                    Fields marked <span className="req">*</span> are needed before it can go to the Dean.
                  </p>

                  <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-4">
                    <div className="field col-span-2">
                      <label htmlFor="title">
                        {category.title_label}
                        <span className="req">*</span>
                      </label>
                      <input
                        id="title"
                        type="text"
                        value={form.title}
                        onChange={(e) => setField("title", e.target.value)}
                        maxLength={400}
                        aria-invalid={showMissing && missingIds.has("title") ? "true" : undefined}
                        className="input"
                      />
                    </div>

                    <div className="field col-span-2 md:col-span-1">
                      <label htmlFor="record_date">
                        {category.date_label}
                        <span className="req">*</span>
                      </label>
                      <DateInputDMY
                        id="record_date"
                        name="record_date"
                        value={form.record_date}
                        onChange={(e) => setField("record_date", e.target.value)}
                        onTextChange={setTyped("record_date")}
                        ariaInvalid={dateProblems.record_date || (showMissing && missingIds.has("record_date")) ? "true" : undefined}
                      />
                      {dateProblems.record_date ? (
                        <p className="field-error">{dateProblems.record_date}</p>
                      ) : showMissing && missingIds.has("record_date") ? (
                        <p className="field-error">Needed before it can go to the Dean.</p>
                      ) : null}
                    </div>

                    {showOutcome && (
                      <div className="field col-span-2 md:col-span-1">
                        <label htmlFor="outcome_status">
                          Status<span className="req">*</span>
                        </label>
                        <select
                          id="outcome_status"
                          value={form.outcome_status}
                          onChange={(e) => setField("outcome_status", e.target.value)}
                          className="input"
                        >
                          {category.outcomes.map((outcome) => (
                            <option key={outcome.key} value={outcome.key}>
                              {outcome.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Managers see DOI just below the author's name; teachers see it below the details. */}
                    {fields.filter((field) => field.type !== "doi" && isFieldShown(field, details)).map((field) => (
                      <DetailField
                        key={field.key}
                        field={field}
                        value={details[field.key]}
                        required={isFieldRequired(category, field, form.outcome_status, details)}
                        missing={showMissing && missingIds.has(`detail-${field.key}`)}
                        problem={dateProblems[`detail-${field.key}`]}
                        onTextChange={setTyped(`detail-${field.key}`)}
                        onChange={(value) => setDetail(field.key, value)}
                      />
                    ))}

                    <div className="field col-span-2">
                      <label htmlFor="link">
                        Link<span className="ml-2 font-normal text-muted">(Optional)</span>
                      </label>
                      <input
                        id="link"
                        type="url"
                        value={form.link}
                        onChange={(e) => setField("link", e.target.value)}
                        placeholder="https://"
                        className="input"
                      />
                    </div>

                    {!manager && doiField}
                  </div>
                </section>
              </>
            )}

            <DuplicateNotice
              duplicates={duplicates}
              linkTo={(id) => `${panel.base}/research/${id}`}
              title="Already recorded for someone else"
            />

            {category && missingNow.length > 0 && (
              <div
                className="flex flex-wrap items-start gap-3 rounded-2xl border p-4"
                data-tint=""
                style={{ "--track": trackOf("pending") }}
                role="status"
              >
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("pending") }} />
                <div className="min-w-0 flex-1 text-sm text-ink">
                  <p>
                    You can save this as a draft now. Before it can be <b>submitted to the Dean</b> it also needs:
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {missingNow.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          setShowMissing(true);
                          goTo(m.id);
                        }}
                        className="chip chip-sm hover:border-accent/50 hover:text-accent"
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
                <p className="text-sm text-ink">{error}</p>
              </div>
            )}

            {(editing || category) && (
              <div className="flex flex-wrap items-center justify-end gap-3">
                <Link to={backTo} className="btn btn-ghost">
                  Cancel
                </Link>
                <button
                  disabled={saving || !category}
                  type="submit"
                  className={`btn ${canSubmitHere ? "btn-ghost" : "btn-primary"}`}
                >
                  {saving ? <span className="spin h-4 w-4" /> : <IconSave />}
                  {editing ? (verified && !manager ? "Save and send for re-verification" : "Save changes") : "Save draft"}
                </button>
                {canSubmitHere && (
                  <button
                    type="button"
                    onClick={() => persist(true)}
                    disabled={saving || !category}
                    className="btn btn-primary"
                  >
                    {saving ? <span className="spin h-4 w-4" /> : <IconCheck />}
                    {submitLabel}
                  </button>
                )}
              </div>
            )}
          </form>
        )}
      </div>
      <Modal
        open={Boolean(pendingType)}
        onClose={() => setPendingType("")}
        eyebrow="Change research type"
        title={`Switch to ${byKey[pendingType]?.label || "another type"}?`}
        subtitle={`The ${category?.label.toLowerCase() || "record"} details you filled in will be cleared. The title, date and link stay.`}
        footer={
          <>
            <button type="button" onClick={() => setPendingType("")} className="btn btn-ghost">
              Keep {category?.label || "this type"}
            </button>
            <button
              type="button"
              onClick={() => {
                chooseCategory(pendingType);
                setPendingType("");
              }}
              className="btn btn-primary"
            >
              Switch and clear details
            </button>
          </>
        }
      />
      {manager && (
        <AddFacultyModal
          open={addingFaculty}
          initialName={facultyText}
          onClose={() => setAddingFaculty(false)}
          onAdded={(person, message) => {
            addAuthor(person);
            setFacultyNotice(message);
            setAddingFaculty(false);
          }}
        />
      )}
    </TeacherShell>
  );
}

/** One category field, drawn by its type. */
function DetailField({ field, value, required, missing, problem, onTextChange, onChange }) {
  const id = `detail-${field.key}`;
  // Full width: long text, the multi-select, and a conditional field, which
  // then sits directly under the field that reveals it.
  const wide = field.type === "textarea" || field.type === "multiselect" || Boolean(field.shown_if);
  const label = (
    <>
      {field.label}
      {required ? <span className="req">*</span> : <span className="ml-2 font-normal text-muted">(Optional)</span>}
    </>
  );

  let control;
  if (field.type === "select") {
    control = (
      <select
        id={id}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={missing ? "true" : undefined}
        className={`input ${value ? "" : "is-placeholder"}`}
      >
        <option value="">Choose…</option>
        {(value && !field.options.includes(value) ? [...field.options, value] : field.options).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else if (field.type === "multiselect") {
    control = (
      <MultiSelectDropdown
        id={id}
        labelledBy={`${id}-label`}
        options={[...field.options, ...(Array.isArray(value) ? value.filter((v) => !field.options.includes(v)) : [])]}
        value={Array.isArray(value) ? value : []}
        onChange={onChange}
        placeholder="Choose all that apply"
        invalid={missing}
      />
    );
  } else if (field.type === "textarea") {
    control = (
      <textarea
        id={id}
        rows={3}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={missing ? "true" : undefined}
        className="input"
      />
    );
  } else if (field.type === "date") {
    control = (
      <DateInputDMY
        id={id}
        name={field.key}
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        onTextChange={onTextChange}
        ariaInvalid={problem || missing ? "true" : undefined}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
        inputMode={field.type === "number" ? "decimal" : undefined}
        min={field.type === "number" ? 0 : undefined}
        step={field.type === "number" ? "any" : undefined}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder || undefined}
        aria-invalid={missing ? "true" : undefined}
        className="input"
      />
    );
  }

  return (
    <div className={`field col-span-2 ${wide ? "" : "md:col-span-1"}`}>
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      {control}
      {problem ? (
        <p className="field-error">{problem}</p>
      ) : missing ? (
        <p className="field-error">
          {field.type === "multiselect" ? "Choose at least one — needed before it can go to the Dean." : "Needed before it can go to the Dean."}
        </p>
      ) : null}
      {field.help && <p className="field-hint">{field.help}</p>}
    </div>
  );
}
