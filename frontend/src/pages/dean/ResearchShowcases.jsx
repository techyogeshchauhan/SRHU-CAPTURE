import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import DeanShell from "../../components/dean/DeanShell";
import PageHero from "../../components/teacher/PageHero";
import { trackOf } from "../../components/teacher/status";
import { IconAlertTriangle, IconLayers } from "../../components/teacher/icons";
import ResearchNav from "../../components/research/ResearchNav";
import useShellProfile from "../../components/research/useShellProfile";
import { deanListShowcases } from "../../services/research";

const when = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
};

/** Research showcases sent to the Dean, newest first; unopened ones marked. */
export default function DeanResearchShowcases() {
  const { profile, logout } = useShellProfile();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    deanListShowcases()
      .then(setData)
      .catch((err) => setError(err?.message || "Showcases could not be loaded."));
  }, []);

  const showcases = data?.showcases || [];

  return (
    <DeanShell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero compact title="Research" accent="Showcases" />
        <ResearchNav base="/dean/research" active="showcases" role="dean" badge={{ showcases: data?.unviewed }} />

        {error && (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm text-ink">{error}</p>
          </div>
        )}

        {!data && !error ? (
          <div className="flex h-48 items-center justify-center">
            <span className="spin h-8 w-8 text-accent" />
          </div>
        ) : showcases.length === 0 && !error ? (
          <div className="glass mt-5 flex flex-col items-center px-6 py-14 text-center">
            <span className="icon-tile mb-4 h-14 w-14 rounded-2xl">
              <IconLayers className="h-6 w-6" />
            </span>
            <p className="h3 text-ink">No showcases yet</p>
            <p className="prose-muted mt-1 max-w-md text-sm">
              When an Event Manager or a teacher presents research to you, it appears here and you are notified.
            </p>
          </div>
        ) : (
          <ul className="mt-5 grid list-none gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
            {showcases.map((showcase) => (
              <li key={showcase.id}>
                <Link to={`/dean/research/showcases/${showcase.id}`} className="glass group flex h-full flex-col p-5 transition hover:-translate-y-0.5">
                  <span className="flex items-center gap-2 text-xs text-muted">
                    {!showcase.viewed && (
                      <span className="chip chip-sm chip-track" style={{ "--track": trackOf("pending") }}>
                        <span className="dot dot-sm" />
                        New
                      </span>
                    )}
                    {when(showcase.sent_at)}
                    {showcase.sent_count > 1 && " · updated"}
                  </span>
                  <span className="mt-3 font-display text-lg font-semibold leading-snug text-ink group-hover:text-accent">
                    {showcase.title}
                  </span>
                  {showcase.description && <span className="prose-muted mt-1 line-clamp-3 text-sm">{showcase.description}</span>}
                  <span className="mt-auto pt-4 text-xs text-muted">
                    {showcase.record_count} {showcase.record_count === 1 ? "record" : "records"} · presented by{" "}
                    {showcase.owner_name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </DeanShell>
  );
}
