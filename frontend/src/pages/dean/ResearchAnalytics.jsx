import DeanShell from "../../components/dean/DeanShell";
import PageHero from "../../components/teacher/PageHero";
import ResearchAnalytics from "../../components/research/ResearchAnalytics";
import ResearchNav from "../../components/research/ResearchNav";
import useShellProfile from "../../components/research/useShellProfile";
import useResearchCategories from "../../hooks/useResearchCategories";

/** The faculty's research in numbers, for the Dean. */
export default function DeanResearchAnalytics() {
  const { profile, logout } = useShellProfile();
  const { categories } = useResearchCategories();

  return (
    <DeanShell active="research" profile={profile} onLogout={logout}>
      <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
        <PageHero compact title="Research" accent="Analytics" />
        <ResearchNav base="/dean/research" active="analytics" role="dean" />
        <div className="mt-5">
          <ResearchAnalytics dean categories={categories} cvLinks recordsPath="/dean/research" />
        </div>
      </div>
    </DeanShell>
  );
}
