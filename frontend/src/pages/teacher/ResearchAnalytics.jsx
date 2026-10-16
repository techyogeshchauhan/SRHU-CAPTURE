import PageHero from "../../components/teacher/PageHero";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import ResearchAnalytics from "../../components/research/ResearchAnalytics";
import ResearchNav from "../../components/research/ResearchNav";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";

/** The faculty's research in numbers, for the Event Manager (read-only). */
export default function ResearchAnalyticsPage() {
  const panel = usePanel();
  const { profile, logout } = useShellProfile();
  const { categories } = useResearchCategories();

  return (
    <TeacherShell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero compact title="Research" accent="Analytics" />
        <ResearchNav base={`${panel.base}/research`} active="analytics" role={panel.role} />
        <div className="mt-5">
          {/* No CV column: research CVs are for the Dean and the teacher themselves. */}
          <ResearchAnalytics categories={categories} recordsPath={`${panel.base}/research`} compactCards />
        </div>
      </div>
    </TeacherShell>
  );
}
