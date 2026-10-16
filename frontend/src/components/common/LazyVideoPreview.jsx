import { useEffect, useRef, useState } from "react";

/** Metadata previews load near the viewport; the active player stays eager. */
export default function LazyVideoPreview({ src, ...props }) {
  const videoRef = useRef(null);
  const [nearby, setNearby] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearby(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(videoRef.current);
    return () => observer.disconnect();
  }, []);
  return <video {...props} ref={videoRef} src={nearby ? src : undefined} preload={nearby ? "metadata" : "none"} />;
}
