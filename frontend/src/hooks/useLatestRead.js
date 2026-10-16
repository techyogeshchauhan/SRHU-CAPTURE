import { useCallback, useEffect, useRef } from "react";

/** Cancel superseded table reads and stop them from updating an unmounted page. */
export default function useLatestRead() {
  const current = useRef(null);
  useEffect(() => () => current.current?.abort(), []);
  return useCallback(() => {
    current.current?.abort();
    current.current = new AbortController();
    return current.current;
  }, []);
}
