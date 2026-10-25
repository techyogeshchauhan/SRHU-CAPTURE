import {
  IconAward,
  IconBookmark,
  IconFileText,
  IconShield,
  IconSparkle,
  IconUsers,
} from "../teacher/icons";

const ICONS = {
  journal: IconFileText,
  conference: IconUsers,
  patent: IconShield,
  project: IconSparkle, // Retained only for legacy records already in the portfolio.
  book: IconBookmark,
  funded_project: IconSparkle,
  other: IconAward,
};

/** The glyph that marks a research category everywhere it is listed. */
export default function CategoryIcon({ category, className = "h-4 w-4" }) {
  const Icon = ICONS[category] || IconAward;
  return <Icon className={className} />;
}
