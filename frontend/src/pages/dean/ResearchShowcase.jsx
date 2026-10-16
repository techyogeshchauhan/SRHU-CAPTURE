import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import DeanShell from "../../components/dean/DeanShell";
import { trackOf } from "../../components/teacher/status";
import { IconAlertTriangle, IconArrowLeft, IconDownload, IconInfo } from "../../components/teacher/icons";
import ShowcaseView from "../../components/research/ShowcaseView";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";
import { deanGetShowcase, downloadShowcasePdf } from "../../services/research";

/** One showcase, presented: the Dean reads it here or takes it away as a PDF. */
export default function DeanResearchShowcase() {
  const { showcaseId } = useParams();
  const { profile, logout } = useShellProfile();
  const { categories } = useResearchCategories();
  const [showcase, setShowcase] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    deanGetShowcase(showcaseId)
      .then((body) => setShowcase(body.showcase))
      .catch((err) => setError(err?.message || "This showcase could not be loaded."));
  }, [showcaseId]);

  const pdf = async () => {
    setBusy(true);
    setError("");
    try {
      await downloadShowcasePdf(showcaseId, { dean: true });
    } catch (err) {
      setError(err?.message || "The PDF could not be generated.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <DeanShell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Link to="/dean/research/showcases" className="btn btn-ghost btn-sm">
            <IconArrowLeft />
            All showcases
          </Link>
          {showcase && (
            <button type="button" onClick={pdf} disabled={busy} className="btn btn-primary btn-sm">
              {busy ? <span className="spin h-4 w-4" /> : <IconDownload />}
              Download PDF
            </button>
          )}
        </div>

        {error && (
          <div className="mb-5 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("rejected") }} role="alert">
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <p className="text-sm text-ink">{error}</p>
          </div>
        )}
        {!showcase && !error && (
          <div className="flex h-48 items-center justify-center">
            <span className="spin h-8 w-8 text-accent" />
          </div>
        )}
        {showcase && (
          <>
            {showcase.withdrawn_count > 0 && (
              <div className="mb-5 flex items-start gap-3 rounded-2xl border p-4" data-tint="" style={{ "--track": trackOf("under_review") }}>
                <IconInfo className="mt-0.5 h-5 w-5 shrink-0" style={{ color: trackOf("under_review") }} />
                <p className="text-sm text-ink">
                  {showcase.withdrawn_count} {showcase.withdrawn_count === 1 ? "record is" : "records are"} left out
                  because {showcase.withdrawn_count === 1 ? "it is" : "they are"} no longer verified.
                </p>
              </div>
            )}
            <ShowcaseView showcase={showcase} categories={categories} recordLink={(record) => `/dean/research/${record.id}`} />
          </>
        )}
      </div>
    </DeanShell>
  );
}
