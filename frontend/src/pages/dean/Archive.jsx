import { useCallback, useEffect, useRef, useState } from "react";

import { apiJson, isAbortError } from "../../services/api";
import { fetchCurrentUser, signOut } from "../../services/auth";
import DeanShell from "../../components/dean/DeanShell";
import EventsTable from "../../components/dean/EventsTable";
import Modal from "../../components/teacher/Modal";
import Pagination from "../../components/common/Pagination";
import useTableQuery from "../../hooks/useTableQuery";
import {
  IconAlertTriangle,
  IconArchiveRestore,
  IconCheckCircle,
  IconEye,
  IconTrash,
  IconX,
} from "../../components/teacher/icons";
import { Link, useNavigate } from "react-router-dom";

/**
 * The Dean's archive shelf (PRD 1).
 *
 * Archiving is a second axis, not a status: an archived event keeps the status
 * it had, which is what restore puts it back to. So the rows here are the same
 * rows as All Events — same columns, same component — with restore and delete
 * in place of approve and reject.
 */

function ArchiveActions({ event, isProcessing, onRestore, onDelete }) {
  return (
    <>
      <Link
        to={`/dean/events/${event.id}`}
        title="View full details"
        aria-label={`View full details for ${event.event_name}`}
        className="icon-btn icon-btn-sm"
      >
        <IconEye />
      </Link>

      <button
        type="button"
        onClick={() => onRestore(event)}
        disabled={isProcessing}
        title="Restore this event"
        className="btn btn-ok btn-xs"
      >
        {isProcessing ? <span className="spin h-3.5 w-3.5" /> : <IconArchiveRestore />}
        Restore
      </button>

      <button
        type="button"
        onClick={() => onDelete(event)}
        disabled={isProcessing}
        title="Delete this event permanently"
        className="btn btn-danger btn-xs"
      >
        <IconTrash />
        Delete
      </button>
    </>
  );
}

function Archive() {
  const navigate = useNavigate();
  const { query, setPage, setPerPage } = useTableQuery();
  const { page, per } = query;

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState(null);
  const [deanProfile, setDeanProfile] = useState(null);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pendingDelete, setPendingDelete] = useState(null);

  const loadControllerRef = useRef(null);
  useEffect(() => () => loadControllerRef.current?.abort(), []);

  const loadArchive = useCallback(async () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;

    try {
      setLoading(true);
      setError("");
      const data = await apiJson(
        `/dean/archive/events?skip=${query.skip}&limit=${per}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setEvents(data?.events || []);
      setTotal(data?.total || 0);
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setError(err?.message || "Failed to load the archive.");
      setEvents([]);
      setTotal(0);
    } finally {
      if (loadControllerRef.current === controller) setLoading(false);
    }
  }, [query.skip, per]);

  useEffect(() => {
    loadArchive();
  }, [loadArchive]);

  useEffect(() => {
    fetchCurrentUser()
      .then((data) => data && setDeanProfile(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!success) return undefined;
    const timer = setTimeout(() => setSuccess(""), 4000);
    return () => clearTimeout(timer);
  }, [success]);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const restore = async (event) => {
    try {
      setProcessingId(event.id);
      setError("");
      await apiJson(`/dean/events/${event.id}/restore`, { method: "PATCH" });
      setSuccess(`"${event.event_name}" was restored.`);
      await loadArchive();
    } catch (err) {
      setError(err?.message || "Failed to restore the event.");
    } finally {
      setProcessingId(null);
    }
  };

  const confirmDelete = async () => {
    const event = pendingDelete?.event;
    if (!event) return;

    try {
      setProcessingId(event.id);
      setError("");
      await apiJson(`/dean/events/${event.id}`, { method: "DELETE" });
      setPendingDelete(null);
      setSuccess(`"${event.event_name}" was deleted permanently.`);
      await loadArchive();
    } catch (err) {
      setError(err?.message || "Failed to delete the event.");
      setPendingDelete(null);
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <DeanShell
      active="archive"
      profile={deanProfile}
      onLogout={handleLogout}
      railBadge={total}
      railNote="Archived events keep their media and their history. Restore one to put it back in the review list."
      locked
    >
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-85 max-w-[calc(100vw-2.5rem)] flex-col gap-3">
        {error && (
          <div className="toast toast-err pointer-events-auto" role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{error}</p>
            <button
              type="button"
              onClick={() => setError("")}
              aria-label="Dismiss error"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}

        {success && (
          <div className="toast toast-ok pointer-events-auto" role="status">
            <IconCheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-ok" />
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{success}</p>
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="glass flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="eyebrow text-accent">Dean Panel</p>
            <h1 className="h3 text-ink">Archive</h1>
          </div>
          <p className="prose-muted text-xs">
            {total === 0
              ? "Nothing archived"
              : `${total} archived event${total === 1 ? "" : "s"}`}
          </p>
        </div>

        <div className="glass relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {loading && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface/70 backdrop-blur-[1px]">
              <div className="flex items-center gap-2.5 text-sm font-medium text-muted">
                <span className="spin h-4 w-4 text-accent" />
                Loading archive…
              </div>
            </div>
          )}

          <EventsTable
            events={events}
            loading={loading}
            formatEventDate={(value) =>
              value
                ? new Date(`${value}T00:00:00`).toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })
                : "—"
            }
            emptyTitle="Nothing archived"
            emptyHint="Events you archive from All Events appear here."
            renderActions={(event) => (
              <ArchiveActions
                event={event}
                isProcessing={processingId === event.id}
                onRestore={restore}
                onDelete={(e) => setPendingDelete({ event: e, confirmText: "" })}
              />
            )}
          />

          {total > 0 && (
            <Pagination
              page={page}
              perPage={per}
              total={total}
              onPageChange={setPage}
              onPerPageChange={setPerPage}
              disabled={loading}
            />
          )}
        </div>
      </div>

      {/* Deleting from the archive is the same irreversible action as deleting
          from All Events, so it asks the same way. */}
      <Modal
        open={Boolean(pendingDelete)}
        onClose={() => !processingId && setPendingDelete(null)}
        eyebrow="Delete"
        title="Delete this event permanently?"
        subtitle={pendingDelete?.event?.event_name || ""}
        footer={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setPendingDelete(null)}
              disabled={Boolean(processingId)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={confirmDelete}
              disabled={
                Boolean(processingId) || pendingDelete?.confirmText !== "DELETE"
              }
            >
              {processingId ? <span className="spin h-3.5 w-3.5" /> : <IconTrash />}
              Delete permanently
            </button>
          </>
        }
      >
        <p className="text-sm text-ink">
          This removes the event, its photos, videos, documents and any
          generated report. It cannot be undone.
        </p>

        <div className="field mt-4">
          <label htmlFor="archiveDeleteConfirm">
            Type <span className="font-semibold">DELETE</span> to confirm
          </label>
          <input
            id="archiveDeleteConfirm"
            type="text"
            value={pendingDelete?.confirmText || ""}
            onChange={(event) =>
              setPendingDelete((current) => ({
                ...current,
                confirmText: event.target.value,
              }))
            }
            autoComplete="off"
            placeholder="DELETE"
            className="input"
          />
        </div>
      </Modal>
    </DeanShell>
  );
}

export default Archive;
