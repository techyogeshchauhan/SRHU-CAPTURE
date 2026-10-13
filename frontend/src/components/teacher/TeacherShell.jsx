import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
// The white crest: the shell header is SRHU blue in both themes.
import srhuLogo from "../../assets/srhu-logo-dark.png";
import NotificationBell from "../NotificationBell";
import useThemeToggle from "../theme/useThemeToggle";
import LogoutConfirmModal from "../common/LogoutConfirmModal";
import FirstLoginPasswordModal from "../common/FirstLoginPasswordModal";
import { useAuth } from "../../context/AuthContext";
import { usePanel } from "./panel";
import ReportReadyPrompt from "./ReportReadyPrompt";
import {
  IconArrowUp,
  IconGrid,
  IconList,
  IconLogout,
  IconMoon,
  IconPlus,
  IconSun,
  IconUser,
  RidgeDivider,
} from "./icons";

// Paths are relative to the panel's base: "/teacher", or "/event_manager"
// for the Event Manager, which shares these screens.
const NAV = [
  { key: "dashboard", to: "/dashboard", label: "Dashboard", Icon: IconGrid },
  { key: "create", to: "/create-event", label: "Create Event", Icon: IconPlus },
  { key: "events", to: "/my-events", label: "My Events", Icon: IconList },
  { key: "profile", to: "/profile", label: "My Profile", Icon: IconUser },
];

/**
 * The chrome every teacher screen shares: blur-on-scroll header, the
 * navigation rail, the mobile overlay menu, the scroll progress bar and the
 * back-to-top button.
 *
 * `locked` is for My Events, which height-locks the viewport so only the
 * results list scrolls; there is no page scroll to track, so the progress bar
 * and the to-top button are left out.
 *
 * `showToTop={false}` is for Create Event, whose sticky action bar sits where
 * the to-top button would float and would be covered by it.
 */
export default function TeacherShell({
  active,
  profile,
  onLogout,
  railNote,
  railBadge,
  locked = false,
  showToTop = true,
  children,
}) {
  const [dark, toggleTheme] = useThemeToggle();
  const { user } = useAuth();
  const panel = usePanel();
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

  // A route change unmounts the page but not always the overlay's scroll lock,
  // so the lock is tied to the overlay's own state rather than to navigation.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [menuOpen]);

  const initial = (profile?.name || "T").charAt(0).toUpperCase();

  /**
   * The line under the name: the academic rank the teacher registered with.
   *
   * Designation is collected on the registration form and comes back on
   * /users/me, but nothing read it -- this line showed the department, and
   * fell back to the literal word "Teacher" for the many accounts with no
   * department set. Department stays as the middle fallback so an account
   * that has one but no designation still says something useful.
   */
  const accountSubtitle =
    profile?.designation?.trim() || profile?.department?.trim() || panel.roleLabel;

  return (
    <div className={`hv-root ${locked ? "flex h-screen flex-col overflow-hidden" : "min-h-screen"}`}>
      <a href="#main" className="skip-link">Skip to content</a>

      {!locked && (
        <div id="hv-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      )}

      {/* ---------------------------------------------------------- header */}
      <header className={`hv-header shrink-0 ${scrolled ? "is-scrolled" : ""}`}>
        <div className="flex h-full items-center justify-between gap-3 px-4 sm:px-6">

          <Link to={`${panel.base}/dashboard`} className="flex min-w-0 items-center gap-3">
            <img
              src={srhuLogo}
              alt="Swami Rama Himalayan University"
              className="h-10 w-auto shrink-0 object-contain sm:h-11"
            />
            <div className="min-w-0 leading-tight">
              <p className="wordmark truncate">Campus Capture</p>
              <p className="truncate text-[11px] font-medium text-muted">
                {panel.label}
                <span className="hidden sm:inline"> · Swami Rama Himalayan University</span>
              </p>
            </div>
          </Link>

          {/* Desktop nav — the rail carries the same links, but the header row
              keeps them reachable when the rail is off-screen. */}
          <nav className="hidden items-center gap-6 lg:flex" aria-label={`${panel.roleLabel} sections`}>
            {NAV.map((item) => (
              <Link
                key={item.key}
                to={`${panel.base}${item.to}`}
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

            {/* The bell carries the Dean's decisions; a panel without the
                approval workflow has nothing to put in it. */}
            {panel.approval && (
              <div className="relative">
                <NotificationBell currentUser={profile} />
              </div>
            )}

            {/* Only while the rail is off-screen; from lg up the rail's own
                account block is the one place the signed-in user appears. */}
            <Link to={`${panel.base}/profile`} className="hidden items-center gap-2.5 sm:flex lg:hidden transition hover:opacity-80">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/12 font-display text-xs font-semibold text-accent ring-1 ring-accent/20">
                {initial}
              </span>
              <span className="hidden leading-tight md:block">
                <span className="block text-sm font-semibold text-ink">
                  {profile?.name || panel.roleLabel}
                </span>
                <span className="block text-[11px] text-muted truncate max-w-[120px]">
                  {accountSubtitle}
                </span>
              </span>
            </Link>

            {/* On the narrowest screens this would be a fifth icon crowding
                the menu button, so there it stays in the overlay menu only. */}
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
              to={`${panel.base}${item.to}`}
              onClick={() => setMenuOpen(false)}
              aria-current={active === item.key ? "page" : undefined}
              className="menu-link"
            >
              <item.Icon className="h-5 w-5" />
              {item.label}
            </Link>
          ))}

          {/* Same account block as the Dean and Super Admin menus. */}
          <Link
            to={`${panel.base}/profile`}
            onClick={() => setMenuOpen(false)}
            className="rail-account mt-6 px-0 transition hover:opacity-80"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/12 font-display text-xs font-semibold text-accent ring-1 ring-accent/20">
              {initial}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-sm font-semibold text-ink">
                {profile?.name || panel.roleLabel}
              </span>
              <span className="block text-[11px] text-muted truncate">
                {accountSubtitle}
              </span>
            </span>
          </Link>

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
          className={`hv-rail relative hidden w-60 shrink-0 flex-col overflow-y-auto px-3 py-6 lg:flex ${
            locked ? "" : "sticky top-(--header-h) h-[calc(100vh-var(--header-h))]"
          }`}
        >
          <p className="rail-label px-3 pb-2.5">Navigation</p>

          <nav className="space-y-1" aria-label={`${panel.roleLabel} navigation`}>
            {NAV.map((item) => (
              <Link
                key={item.key}
                to={`${panel.base}${item.to}`}
                aria-current={active === item.key ? "page" : undefined}
                className="rail-link"
              >
                <item.Icon />
                {item.label}
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

            <Link to={`${panel.base}/profile`} className="rail-account transition hover:bg-accent/5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent/12 font-display text-xs font-semibold text-accent ring-1 ring-accent/20">
                {initial}
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-semibold text-ink">
                  {profile?.name || panel.roleLabel}
                </span>
                <span className="block text-[11px] text-muted truncate">
                  {accountSubtitle}
                </span>
              </span>
            </Link>
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

      {!locked && showToTop && (
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className={`${scrolled && progress > 0.08 ? "is-shown" : ""}`}
          id="hv-to-top"
          aria-label="Back to top"
        >
          <IconArrowUp className="h-4 w-4" />
        </button>
      )}

      {/* Panels that generate reports (the Event Manager). */}
      {panel.reports && <ReportReadyPrompt />}

      <LogoutConfirmModal
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout?.();
        }}
      />

      {user?.role === panel.role && user?.must_change_password === true && (
        <FirstLoginPasswordModal isOpen={true} />
      )}
    </div>
  );
}
