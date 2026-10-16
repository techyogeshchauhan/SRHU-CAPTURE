import { Link } from "react-router-dom";

import { IconAward } from "../teacher/icons";

/**
 * The Research section's own tabs, under each page's hero.
 *
 * `base` is where the role's research pages live ("/teacher/research",
 * "/event_manager/research", "/dean/research").
 */
export default function ResearchNav({ base, active, role, badge = {} }) {
  if (role !== "teacher") return null;

  const items = [
    { key: "records", to: base, label: "Records", Icon: IconAward },
  ];
  return (
    <nav className="mt-5 flex flex-wrap gap-1.5" aria-label="Research sections">
      {items.map((item) => (
        <Link
          key={item.key}
          to={item.to}
          aria-current={active === item.key ? "page" : undefined}
          className="tab"
        >
          <item.Icon className="h-4 w-4" />
          {item.label}
          {badge[item.key] ? <span className="tab-count">{badge[item.key]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}
