/**
 * The selectable event categories, fetched once and shared.
 *
 * Falls back to a built-in list if the request fails, so the create-event
 * wizard is never left with an empty dropdown.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import {
  FALLBACK_EVENT_TYPES,
  EVENT_TYPES_CHANGED,
  createEventType,
  listEventTypes,
} from "../services/directory";

export default function useEventTypes() {
  const [types, setTypes] = useState(FALLBACK_EVENT_TYPES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async ({ force = false } = {}) => {
    setLoading(true);
    try {
      const list = await listEventTypes({ force });
      if (mounted.current && list.length) setTypes(list);
      if (mounted.current) setError("");
    } catch {
      // Keep whatever is on screen; FALLBACK_EVENT_TYPES is the initial value.
      if (mounted.current) setError("Could not load event types.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const changed = (event) => setTypes(event.detail);
    window.addEventListener(EVENT_TYPES_CHANGED, changed);
    return () => window.removeEventListener(EVENT_TYPES_CHANGED, changed);
  }, [load]);

  /** Add a category and return its canonical spelling, or null on failure. */
  const addType = useCallback(async (name) => {
    const cleaned = (name || "").trim();
    if (!cleaned) return null;

    let previous = [];
    setTypes((current) => {
      previous = current;
      return current.some((item) => item.toLowerCase() === cleaned.toLowerCase())
        ? current
        : [...current, cleaned];
    });

    try {
      const result = await createEventType(cleaned);
      if (mounted.current && result?.event_types?.length) {
        setTypes(result.event_types);
      }
      return result?.event_type || cleaned;
    } catch (err) {
      if (mounted.current) {
        setTypes(previous);
        setError(err?.message || "Could not add that event type.");
      }
      return null;
    }
  }, []);

  return { types, loading, error, addType, reload: load, setError };
}
