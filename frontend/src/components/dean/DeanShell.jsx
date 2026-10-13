import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
// The white crest: the shell header is SRHU blue in both themes.
import srhuLogo from "../../assets/srhu-logo-dark.png";
import useThemeToggle from "../theme/useThemeToggle";
import NotificationBell from "../NotificationBell";
import LogoutConfirmModal from "../common/LogoutConfirmModal";
import { initialsOf } from "../common/roles";
import {
  IconArrowUp,
  IconArchive,
  IconCalendar,
  IconGrid,
  IconLogout,
  IconMoon,
  IconSun,
  IconUser,
  IconUsers,
  RidgeDivider,
} from "../teacher/icons";

const NAV = [
  { key: "dashboard", to: "/dean/dashboard", label: "Dashboard", Icon: IconGrid },
  { key: "events", to: "/dean/events", label: "All Events", short: "Events", Icon: IconCalendar },
  { key: "archive", to: "/dean/archive", label: "Archive", Icon: IconArchive },
  { key: "teachers", to: "/dean/teachers", label: "Teachers", Icon: IconUsers },
  { key: "profile", to: "/dean/profile", label: "My Profile", short: "Profile", Icon: IconUser },
];

/**
 * The chrome every Dean screen shares: blur-on-scroll header, the navigation
 * rail, the mobile overlay menu, the scroll progress bar, the theme toggle and
 * the back-to-top button. Same bones as the teacher and superadmin shells so the
 * three roles read as one product; only the navigation, the account label and
 * the header slot differ.
 *
 * `locked` is for All Events, which height-locks the viewport so only the
 * results table scrolls; there is no page scroll to track, so the progress bar
 * and the to-top button are left out.
 *
 * The notification bell is part of the shell, so a new or resubmitted event
 * reaches the Dean on whichever screen they are on. `onNotification` lets
 * the page behind it react — the dashboard refreshes its counts.
 */
export default function DeanShell({
  active,
  profile,
  onLogout,
  railNote,
  railBadge,
  onNotification,
  locked = false,
  children,
}) {
  const [dark, toggleTheme] = useThemeToggle();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (locked) return undefined;

    const onScroll = () => {
      const y = window.scrollY;
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrolled(y > 8);
      setProgress(max > 0 ? Math.min(1, y / max) : 0);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [locked]);

  // The scroll lock is tied to the overlay's own state rather than to
  // navigation, so a route change can never leave the page stuck unscrollable.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const initials = initialsOf(profile?.name, profile?.email);
  const displayName = profile?.name || "Dean";

  // Deans and superadmins are provisioned rather than self-registered, so most
  // carry no designation and fall back to the role -- which is all this line
  // used to be able to say for anyone.
  const accountSubtitle = profile?.designation?.trim() || profile?.department?.trim() || "Dean";

  const account = (compact = false) => (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/12 font-display text-xs font-semibold text-accent ring-1 ring-accent/20">
        {initials}
      </span>
      <span className={`min-w-0 leading-tight ${compact ? "hidden md:block" : ""}`}>
        <span className="block truncate text-sm font-semibold text-ink">{displayName}</span>
        <span className="block truncate text-[11px] text-muted">{accountSubtitle}</span>
      </span>
    </>
  );

  return (
    <div className={`hv-root ${locked ? "flex h-screen flex-col overflow-hidden" : "min-h-screen"}`}>
      <a href="#main" className="skip-link">Skip to content</a>

      {!locked && (
        <div id="hv-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      )}

      {/* ---------------------------------------------------------- header */}
      <header className={`hv-header shrink-0 ${scrolled ? "is-scrolled" : ""}`}>
        <div className="flex h-full items-center justify-between gap-3 px-4 sm:px-6">

          <Link to="/dean/dashboard" className="flex min-w-0 items-center gap-3">
            <img
              src={srhuLogo}
              alt="Swami Rama Himalayan University"
              className="h-10 w-auto shrink-0 object-contain sm:h-11"
            />
            <div className="min-w-0 leading-tight">
              <p className="wordmark truncate">Campus Capture</p>
              <p className="truncate text-[11px] font-medium text-muted">
                Dean Panel
                <span className="hidden sm:inline"> · Swami Rama Himalayan University</span>
              </p>
            </div>
          </Link>

          {/* The rail carries the same links, but the header row keeps them
              reachable when the rail is off-screen. */}
          <nav className="hidden items-center gap-6 lg:flex" aria-label="Dean sections">
            {NAV.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                aria-current={active === item.key ? "page" : undefined}
                className="nav-link"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={toggleTheme}
              className="icon-btn icon-btn-sm sm:h-11 sm:w-11 sm:rounded-xl"
              aria-pressed={dark}
              aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
              title={dark ? "Switch to light theme" : "Switch to dark theme"}
            >
              {dark ? <IconSun /> : <IconMoon />}
            </button>

            <NotificationBell currentUser={profile} onNew={onNotification} />

            {/* Only while the rail is off-screen; from lg up the rail has the
                one account block. */}
            <div className="hidden items-center gap-2.5 sm:flex lg:hidden">
              {account(true)}
            </div>

            <button
              type="button"
              onClick={() => setLogoutConfirmOpen(true)}
              className="btn btn-ghost btn-sm hidden sm:inline-flex"
            >
              <IconLogout />
              <span className="hidden md:inline">Logout</span>
            </button>

            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className={`hamburger lg:hidden ${menuOpen ? "is-open" : ""}`}
              aria-expanded={menuOpen}
              aria-label={menuOpen ? "Close menu" : "Open menu"}
            >
              <span /><span /><span />
            </button>
          </div>
        </div>
      </header>

      {/* ------------------------------------------------------ mobile menu */}
      <div className={`hv-menu lg:hidden ${menuOpen ? "is-open" : ""}`}>
        <div className="mx-auto w-full max-w-wrap px-5 py-6 sm:px-8">
          {NAV.map((item) => (
            <Link
              key={item.key}
              to={item.to}
              onClick={() => setMenuOpen(false)}
              aria-current={active === item.key ? "page" : undefined}
              className="menu-link"
            >
              <item.Icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}

          <div className="rail-account mt-6 px-0">
            {account()}
          </div>

          <button
            type="button"
            onClick={() => { setMenuOpen(false); setLogoutConfirmOpen(true); }}
            className="btn btn-ghost btn-block mt-4"
          >
            <IconLogout />
            Logout
          </button>
        </div>
      </div>

      {/* ------------------------------------------------- rail + page body */}
      <div className={`flex ${locked ? "min-h-0 flex-1" : ""}`}>

        {/* Part of the page rather than a slab beside it: same ground tone, a
            hairline edge, and a ridgeline at the foot to tie it to the
            dividers used between sections. */}
        <aside
          className={`hv-rail hidden w-60 shrink-0 flex-col overflow-y-auto px-3 py-6 lg:flex ${
            locked ? "" : "sticky top-(--header-h) h-[calc(100vh-var(--header-h))]"
          }`}
        >
          <p className="rail-label px-3 pb-2.5">Navigation</p>

          <nav className="space-y-1" aria-label="Dean navigation">
            {NAV.map((item) => (
              <Link
                key={item.key}
                to={item.to}
                aria-current={active === item.key ? "page" : undefined}
                className="rail-link"
              >
                <item.Icon />
                {item.short || item.label}
                {item.key === "events" && railBadge != null && (
                  <span className="rail-count">{railBadge}</span>
                )}
              </Link>
            ))}
          </nav>

          <div className="mt-auto">
            {railNote && (
              <div className="rail-note">
                <p className="prose-muted text-xs">{railNote}</p>
              </div>
            )}

            <RidgeDivider className="divider my-3 h-7 shrink-0" />

            <div className="rail-account">
              {account()}
            </div>
          </div>
        </aside>

        <main
          id="main"
          tabIndex={-1}
          className={locked ? "flex min-h-0 min-w-0 flex-1 flex-col" : "min-w-0 flex-1"}
        >
          {children}
        </main>
      </div>

      {!locked && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className={scrolled && progress > 0.08 ? "is-shown" : ""}
          id="hv-to-top"
          aria-label="Back to top"
        >
          <IconArrowUp className="h-4 w-4" />
        </button>
      )}

      <LogoutConfirmModal
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout?.();
        }}
      />
    </div>
  );
}
