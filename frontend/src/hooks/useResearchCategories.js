import { useEffect, useMemo, useState } from "react";

import { fetchResearchCategories } from "../services/research";

/**
 * The research categories (fields, outcomes, evidence tags) and the evidence
 * limits, as the server defines them. Fetched once and shared by every screen.
 */
export default function useResearchCategories() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetchResearchCategories()
      .then((body) => {
        if (live) setData(body);
      })
      .catch((err) => {
        if (live) setError(err?.message || "Research categories could not be loaded.");
      });
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    const categories = data?.categories || [];
    return {
      categories,
      byKey: Object.fromEntries(categories.map((c) => [c.key, c])),
      limits: data?.limits || null,
      loading: !data && !error,
      error,
    };
  }, [data, error]);
}
