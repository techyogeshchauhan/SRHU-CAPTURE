import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  changePassword,
  fetchCurrentUser,
  requestPasswordReset,
  resendVerification,
  signOut,
} from "../../services/auth";
import { useOriginState } from "../../hooks/useOriginState";
import TeacherShell from "../../components/teacher/TeacherShell";
import { usePanel } from "../../components/teacher/panel";
import LogoutConfirmModal from "../../components/common/LogoutConfirmModal";
import EditProfileModal from "../../components/common/EditProfileModal";
import PasswordField from "../../components/common/PasswordField";
import { useAuth } from "../../context/AuthContext";
import {
  initialsOf,
  labelOfRole,
  mustChangePassword as needsNewPassword,
  trackOfRole,
} from "../../components/common/roles";
import { trackOf } from "../../components/teacher/status";
import {
  IconAlertTriangle,
  IconArrowRight,
  IconCalendar,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconEdit,
  IconGrid,
  IconInfo,
  IconKey,
  IconList,
  IconLogout,
  IconMail,
  IconPhone,
  IconPlus,
  IconRefresh,
  IconShield,
  IconX,
} from "../../components/teacher/icons";

function formatDateTime(value) {
  if (!value) {
    return "—";
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return "—";
  }

  return parsed.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ACTION_CLASS =
  "flex w-full items-center gap-3 rounded-xl border border-transparent px-2.5 py-1.5 text-left transition hover:border-accent/25 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-transparent disabled:hover:bg-transparent";

export default function TeacherProfile() {
  const navigate = useNavigate();
  const panel = usePanel();
  const originState = useOriginState();
  const { user: authUser } = useAuth();

  const [profile, setProfile] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState("");
  const [copied, setCopied] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const copiedTimer = useRef(null);

  const mustChange = needsNewPassword(authUser);

  // In-page change-password form
  const [pwOpen, setPwOpen] = useState(false);
  const [pwForm, setPwForm] = useState({ current: "", next: "", confirm: "" });
  const [pwError, setPwError] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const showPasswordForm = mustChange || pwOpen;

  const loadProfile = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const user = await fetchCurrentUser();

      if (!user) {
        navigate("/login", { replace: true });
        return;
      }

      setProfile(user);
      setAccount({
        id: user.id,
        email: user.email,
        createdAt: user.created_at,
        lastSignInAt: user.last_sign_in_at,
        emailConfirmedAt: user.email_verified_at,
      });
    } catch (err) {
      console.error("Load teacher profile error:", err);
      setError(err.message || "Unable to load your profile.");
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const handleLogout = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  const handleProfileSaved = (updatedUser) => {
    setProfile(updatedUser);
    setNotice({ kind: "ok", text: "Profile updated successfully." });
  };

  const displayName = profile?.name?.trim() || panel.roleLabel;
  const displayEmail = profile?.email || account?.email || "—";
  const accountId = profile?.id || account?.id || "";
  const isVerified = Boolean(account?.emailConfirmedAt);
  const role = profile?.role || panel.role;
  // The rank the teacher registered with ("Assistant Professor", ...). Every
  // account on this page is a teacher, so the bare role word says nothing;
  // it is only the fallback for an account with no designation on record.
  const designation = profile?.designation?.trim() || "";
  const hasEmail = displayEmail !== "—";

  const handlePasswordReset = async () => {
    if (!hasEmail || busy) return;

    try {
      setBusy("password");
      setNotice(null);

      const result = await requestPasswordReset(displayEmail);

      setNotice({
        kind: "ok",
        text:
          result?.message ||
          `A link to set a new password has been sent to ${displayEmail}.`,
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err?.message || "Unable to send the reset email right now.",
      });
    } finally {
      setBusy("");
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (pwSaving) return;
    setPwError("");

    if (!pwForm.current || !pwForm.next) {
      setPwError("Enter your current password and a new one.");
      return;
    }
    if (pwForm.next.length < 6) {
      setPwError("The new password must be at least 6 characters.");
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwError("The new passwords do not match.");
      return;
    }
    if (pwForm.next === pwForm.current) {
      setPwError("Choose a password different from the current one.");
      return;
    }

    try {
      setPwSaving(true);
      const result = await changePassword(pwForm.current, pwForm.next);
      if (result?.user) setProfile(result.user);
      setPwForm({ current: "", next: "", confirm: "" });
      setPwOpen(false);
      setNotice({ kind: "ok", text: result?.message || "Password changed successfully." });
    } catch (err) {
      if (err?.status === 401) {
        navigate("/login", { replace: true });
        return;
      }
      setPwError(err?.message || "Unable to change your password right now.");
    } finally {
      setPwSaving(false);
    }
  };

  const handleResendVerification = async () => {
    if (!hasEmail || busy) return;

    try {
      setBusy("verify");
      setNotice(null);

      const result = await resendVerification(displayEmail);

      setNotice({
        kind: "ok",
        text: result?.message || `Verification email sent to ${displayEmail}.`,
      });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err?.message || "Unable to send the verification email right now.",
      });
    } finally {
      setBusy("");
    }
  };

  const handleCopyId = async () => {
    if (!accountId) return;

    try {
      await navigator.clipboard.writeText(accountId);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setNotice({ kind: "err", text: "Copy failed — select the ID and copy it manually." });
    }
  };

  const facts = [
    {
      label: "Designation",
      value: designation || "Not specified",
      Icon: IconShield,
      track: trackOfRole(role),
    },
    {
      label: "Mobile number",
      value: profile?.phone?.trim() || "Not specified",
      Icon: IconPhone,
    },
    {
      label: "Email verified",
      value: isVerified ? formatDateTime(account?.emailConfirmedAt) : "Not verified",
      Icon: IconCheckCircle,
      track: trackOf(isVerified ? "approved" : "pending"),
      action: !isVerified && (
        <button
          type="button"
          onClick={handleResendVerification}
          disabled={!hasEmail || Boolean(busy)}
          className="link text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-55"
        >
          {busy === "verify" ? "Sending…" : "Resend email"}
        </button>
      ),
    },
    {
      label: "Member since",
      value: formatDateTime(profile?.created_at || account?.createdAt),
      Icon: IconCalendar,
    },
    {
      label: "Last sign in",
      value: formatDateTime(account?.lastSignInAt),
      Icon: IconClock,
    },
  ];

  const navActions = [
    {
      key: "dashboard",
      to: `${panel.base}/dashboard`,
      label: "Dashboard",
      hint: "Overview and draft events",
      Icon: IconGrid,
    },
    {
      key: "create",
      to: `${panel.base}/create-event`,
      label: "Create event",
      hint: panel.approval ? "Submit a new proposal" : "Record a new event",
      Icon: IconPlus,
    },
    {
      key: "events",
      to: `${panel.base}/my-events`,
      label: "My events",
      hint: panel.approval ? "Track proposal progress" : "View events and download reports",
      Icon: IconList,
    },
  ];

  const accountActions = [
    {
      key: "edit-profile",
      label: "Edit profile",
      hint: "Update name, phone",
      Icon: IconEdit,
      onClick: () => setEditOpen(true),
    },
    {
      key: "password",
      label: "Change password",
      hint: "Set a new password now",
      Icon: IconKey,
      onClick: () => {
        setPwError("");
        setPwOpen((value) => !value);
      },
      disabled: mustChange,
    },
    {
      key: "reset-link",
      label: busy === "password" ? "Sending link…" : "Email a reset link",
      hint: "If you forgot your password",
      Icon: IconMail,
      onClick: handlePasswordReset,
      disabled: !hasEmail || Boolean(busy),
    },
    {
      key: "refresh",
      label: "Refresh details",
      hint: "Reload your account",
      Icon: IconRefresh,
      onClick: loadProfile,
      disabled: loading,
    },
  ];

  return (
    <TeacherShell
      active="profile"
      profile={profile}
      onLogout={handleLogout}
    >
      <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6 sm:py-5 lg:px-8">

        {error && (
          <div
            className="mb-4 flex items-start gap-3 rounded-2xl border p-3.5"
            data-tint=""
            style={{ "--track": trackOf("rejected") }}
            role="alert"
          >
            <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">Profile unavailable</p>
              <p className="prose-muted mt-0.5 text-sm">{error}</p>
            </div>
            <button
              type="button"
              onClick={loadProfile}
              className="btn btn-ghost btn-xs shrink-0"
            >
              <IconRefresh />
              Retry
            </button>
          </div>
        )}

        {mustChange && (
          <div
            className="mb-4 flex items-start gap-3 rounded-2xl border p-3.5"
            data-tint=""
            style={{ "--track": trackOf("pending") }}
            role="alert"
          >
            <IconKey className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">
                Please set a new password to replace your temporary one.
              </p>
              <p className="prose-muted mt-0.5 text-sm">
                The rest of the portal opens once your new password is saved.
              </p>
            </div>
          </div>
        )}

        {showPasswordForm && (
          <section
            className="glass mb-4 p-4 sm:p-5"
            aria-labelledby="change-password-heading"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="change-password-heading" className="text-sm font-semibold text-ink">
                Change password
              </h2>
              {!mustChange && (
                <button
                  type="button"
                  onClick={() => setPwOpen(false)}
                  aria-label="Close change password"
                  className="shrink-0 text-muted transition hover:text-ink"
                >
                  <IconX className="h-4 w-4" />
                </button>
              )}
            </div>

            <form onSubmit={handleChangePassword} className="grid gap-3 sm:grid-cols-3">
              <PasswordField
                id="pw-current"
                label={mustChange ? "Temporary password" : "Current password"}
                autoComplete="current-password"
                value={pwForm.current}
                onChange={(e) => setPwForm((f) => ({ ...f, current: e.target.value }))}
                disabled={pwSaving}
              />
              <PasswordField
                id="pw-next"
                label="New password"
                autoComplete="new-password"
                value={pwForm.next}
                onChange={(e) => setPwForm((f) => ({ ...f, next: e.target.value }))}
                disabled={pwSaving}
              />
              <PasswordField
                id="pw-confirm"
                label="Confirm new password"
                autoComplete="new-password"
                value={pwForm.confirm}
                onChange={(e) => setPwForm((f) => ({ ...f, confirm: e.target.value }))}
                disabled={pwSaving}
              />

              {pwError && (
                <p className="text-sm font-medium text-err sm:col-span-3" role="alert">
                  {pwError}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
                <button type="submit" disabled={pwSaving} className="btn btn-primary">
                  {pwSaving && <span className="spin h-4 w-4" />}
                  {pwSaving ? "Saving…" : "Save new password"}
                </button>
                <span className="text-xs text-muted">
                  Other devices signed in to this account will be signed out.
                </span>
              </div>
            </form>
          </section>
        )}

        {loading && !profile ? (
          <div className="glass p-12 text-center">
            <span className="spin mx-auto mb-4 block h-10 w-10 text-accent" />
            <p className="prose-muted text-sm">Loading your profile…</p>
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18.5rem]">

            {/* ---------------------------------------------------- identity */}
            <section className="glass reveal relative overflow-hidden p-4 sm:p-5 lg:col-span-2">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 w-1"
                style={{ background: trackOfRole(role) }}
              />

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-accent/12 font-display text-lg font-bold text-accent ring-1 ring-accent/20">
                  {initialsOf(displayName, displayEmail)}
                </span>

                <div className="min-w-0 flex-1 basis-44">
                  <p className="eyebrow text-[11px]">My Profile</p>
                  <h1 className="truncate font-display text-xl font-bold leading-tight text-ink sm:text-2xl">
                    {displayName}
                  </h1>
                  <p className="mt-0.5 truncate text-sm text-muted" title={displayEmail}>
                    {displayEmail}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditOpen(true)}
                    className="btn btn-ghost btn-sm"
                  >
                    <IconEdit className="h-4 w-4" />
                    <span>Edit profile</span>
                  </button>

                  <span
                    className="chip chip-sm chip-track"
                    style={{ "--track": trackOfRole(role) }}
                    title={designation || undefined}
                  >
                    <span className="dot dot-sm" />
                    {designation || labelOfRole(role)}
                  </span>

                  <span
                    className="chip chip-sm chip-track"
                    style={{
                      "--track": trackOf(isVerified ? "approved" : "pending"),
                    }}
                  >
                    <span className="dot dot-sm" />
                    {isVerified ? "Email verified" : "Email not verified"}
                  </span>
                </div>
              </div>
            </section>

            {/* ----------------------------------------------- account details */}
            <section
              className="glass reveal flex flex-col p-4 sm:p-5"
              style={{ "--i": 1 }}
              aria-labelledby="profile-details-heading"
            >
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 id="profile-details-heading" className="text-sm font-semibold text-ink">
                  Account details
                </h2>
                {loading && (
                  <span className="text-xs text-muted" role="status">Refreshing…</span>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-2 sm:gap-2.5">
                {facts.map((fact, index) => (
                  <div
                    key={fact.label}
                    // On a phone the Account ID below takes a full row, so an
                    // odd last fact does too rather than leaving half a row empty.
                    className={`flex items-center gap-3 rounded-xl border hairline bg-line/2 px-3 py-2.5 ${
                      facts.length % 2 === 1 && index === facts.length - 1 ? "col-span-2 sm:col-span-1" : ""
                    }`}
                  >
                    <span
                      className={`icon-tile hidden h-9 w-9 rounded-lg min-[480px]:inline-flex ${fact.track ? "icon-tile-track" : ""}`}
                      style={fact.track ? { "--track": fact.track } : undefined}
                    >
                      <fact.Icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">
                        {fact.label}
                      </dt>
                      <dd className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-semibold leading-snug text-ink sm:text-sm">
                        <span className="min-w-0 min-[480px]:truncate" title={fact.value}>
                          {fact.value}
                        </span>
                        {fact.action}
                      </dd>
                    </div>
                  </div>
                ))}

                {/* Fills the empty half beside the last fact when their count is
                    odd; full width on a phone, where half is too narrow for the
                    id and its Copy button. */}
                <div
                  className={`col-span-2 flex items-center gap-3 rounded-xl border hairline bg-line/2 px-3 py-2.5 ${
                    facts.length % 2 === 1 ? "sm:col-span-1" : ""
                  }`}
                >
                  <span className="icon-tile hidden h-9 w-9 rounded-lg min-[480px]:inline-flex">
                    <IconKey className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <dt className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      Account ID
                    </dt>
                    <dd className="wrap-break-word font-mono text-xs text-ink">
                      {accountId || "—"}
                    </dd>
                  </div>
                  {accountId && (
                    <button
                      type="button"
                      onClick={handleCopyId}
                      className="btn btn-ghost btn-xs shrink-0"
                      aria-label={copied ? "Account ID copied" : "Copy account ID"}
                    >
                      {copied ? <IconCheck /> : <IconCopy />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                  )}
                </div>
              </dl>

              <p className="mt-3 flex items-start gap-2 text-xs text-muted lg:mt-auto lg:pt-3">
                <IconInfo className="mt-px h-3.5 w-3.5 shrink-0" />
                <span>
                  Email comes from your university account. Use "Edit profile" to update your name or mobile number.
                </span>
              </p>
            </section>

            {/* ------------------------------------------------------ actions */}
            <section
              className="glass reveal p-4 sm:p-5"
              style={{ "--i": 2 }}
              aria-labelledby="profile-actions-heading"
            >
              <h2 id="profile-actions-heading" className="mb-3 text-sm font-semibold text-ink">
                Quick actions
              </h2>

              <div className="grid grid-cols-2 gap-1 lg:grid-cols-1">
                {navActions.map((action) => (
                  <Link
                    key={action.key}
                    to={action.to}
                    state={originState}
                    className={`${ACTION_CLASS} group`}
                  >
                    <span className="icon-tile h-9 w-9 rounded-lg">
                      <action.Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-ink">{action.label}</span>
                      <span className="hidden truncate text-xs text-muted sm:block">{action.hint}</span>
                    </span>
                    <IconArrowRight className="hidden h-4 w-4 shrink-0 text-muted transition sm:block group-hover:translate-x-0.5 group-hover:text-accent" />
                  </Link>
                ))}

                {accountActions.map((action) => (
                  <button
                    key={action.key}
                    type="button"
                    onClick={action.onClick}
                    disabled={action.disabled}
                    className={ACTION_CLASS}
                  >
                    <span className="icon-tile h-9 w-9 rounded-lg">
                      <action.Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block text-sm font-semibold text-ink">{action.label}</span>
                      <span className="hidden truncate text-xs text-muted sm:block">{action.hint}</span>
                    </span>
                  </button>
                ))}

                <button
                  type="button"
                  onClick={() => setLogoutConfirmOpen(true)}
                  className={`${ACTION_CLASS} hover:border-err/30 hover:bg-err/5 col-span-2 lg:col-span-1`}
                >
                  <span
                    className="icon-tile icon-tile-track h-9 w-9 rounded-lg"
                    style={{ "--track": trackOf("rejected") }}
                  >
                    <IconLogout className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block text-sm font-semibold text-err">Logout</span>
                    <span className="hidden truncate text-xs text-muted sm:block">End this session</span>
                  </span>
                </button>
              </div>
            </section>
          </div>
        )}
      </div>

      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-85 max-w-[calc(100vw-2.5rem)] flex-col gap-3">
        {notice && (
          <div
            className={`toast pointer-events-auto ${notice.kind === "ok" ? "toast-ok" : "toast-err"}`}
            role={notice.kind === "ok" ? "status" : "alert"}
          >
            {notice.kind === "ok" ? (
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok/15 text-ok">
                <IconCheck className="h-3 w-3" />
              </span>
            ) : (
              <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-err" />
            )}
            <p className="min-w-0 flex-1 text-sm font-medium text-ink">{notice.text}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss message"
              className="shrink-0 text-muted transition hover:text-ink"
            >
              <IconX className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
      <LogoutConfirmModal
        open={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={handleLogout}
      />
      <EditProfileModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        profile={profile}
        onSaved={handleProfileSaved}
      />
    </TeacherShell>
  );
}
