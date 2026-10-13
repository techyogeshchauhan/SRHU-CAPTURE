# Campus Capture: Bug Report for the Event Manager, Dean and Super Admin roles

**Date:** 2026-10-11
**Scope:** The **Event Manager**, **Dean** and **Super Admin** panels: their pages, the backend routes behind them, and the parts of the Research module they use.
**Method:**
- Read the role routers: `event_manager.py`, the Dean half of `events.py`, `reports.py`, `superadmin.py`, `dean_teachers.py` and the research routers.
- Checked every frontend API call against the backend's routes.
- Ran a browser crawl of every page of the three panels.
- Called the API live to reproduce each suspected bug.

All runs used a **local test copy only**: local MongoDB database `campus_capture_e2e`, test ports 8098/8099/5199. The real database and the servers on 8001/5173 were not touched.

Each bug is marked **[reproduced]** if it was triggered on the running app, or **[code]** if it is confirmed from the code but was not run.

---

## Summary

| # | Severity | Role | Bug | Status |
|---|---|---|---|---|
| 1 | **High** | Super Admin, Dean | Deleting a teacher who has research records leaves the records orphaned ("Unknown faculty member") | [reproduced] |
| 2 | **Medium** | Super Admin | "Reset password" for an Event Manager who has not accepted the invite gives a password that cannot sign in | [reproduced] |
| 3 | **Medium** | Super Admin | Make Dean / Make Teacher does not end the user's sessions, so their open panel breaks with 403 errors | [reproduced] |
| 4 | **Medium** | Event Manager, Dean | When the Dean archives an Event Manager's event, the Event Manager is never told and can still edit it and download its report | [reproduced] |
| 5 | Low | Super Admin | The Settings page scrolls sideways on a phone (8 px on Upload limits, 38 px on Document limits) | [reproduced] |
| 6 | Low | Super Admin | The dashboard analytics "Total media" ignores Event Manager photos and videos | [code] |
| 7 | Low | Super Admin | A password-reset email to an Event Manager says "A Teacher account has been created for you" | [code] |

There are no Critical bugs. No page crashed, logged a browser error or had a failed API request during the crawl (see **What was checked and works**).

## Fix status (2026-10-11)

**All 7 bugs are fixed.** Nothing has been committed.

### Verification

- **Backend tests:** 891 passed. The one failure, `test_import_does_not_resolve_srv_dns`, is the existing pymongo-version issue on the global Python and is unrelated to these fixes.
- **New regression tests** cover every bug except #5, which was checked in the browser: in `test_dean_teacher_management.py`, `test_superadmin_features.py` and `test_event_manager.py`.
- **Frontend:** unit tests 140 passed, `oxlint` 0 errors, and the `vite build` passes.
- **Live re-run on the local test stack**, with `REQUIRE_EMAIL_VERIFICATION=true` as in `backend/.env`:
  - every reproduction above now behaves correctly (14 of 14 API checks);
  - 10 of 10 browser checks pass;
  - a full re-crawl of the three panels shows no errors and no sideways scroll.

| # | What changed | Files |
|---|---|---|
| 1 | Accounts with research records, owned (`faculty_id`) or entered (`created_by`), can't be deleted permanently: "Has N research records. Remove the teacher instead." The Dean's teacher list now carries `research_count`, and **Delete permanently** is disabled with that reason as its tooltip. Bulk delete skips these teachers. | `dean_teachers.py`, `superadmin.py`, `pages/dean/Teachers.jsx`, `pages/superadmin/UserManagement.jsx` |
| 2 | A Super Admin password reset now also marks the email as verified, the way a reset link already does, and cancels any pending invitation. The invited Event Manager can sign in with the new password and must change it at first sign-in. | `superadmin.py` |
| 3 | Make Dean / Make Teacher now bumps `token_version`, so the person is signed out and lands in the right panel at their next sign-in. The success message says so. | `superadmin.py` |
| 4 | An event the Dean archived is now **read-only** for the Event Manager. Edit, uploads, file removal, report photos, report download, delete and the consolidated report all answer 409 with "Ask the Dean to restore it". Bulk delete skips it with the reason. The screens show an **Archived** badge and an "Archived by the Dean" banner (with the reason), and hide Edit, Delete and Download Report. | `event_manager.py`, `components/teacher/StatusChip.jsx`, `utils/constants.js`, `pages/teacher/EventDetails.jsx`, `MyEvents.jsx`, `TeacherDashboard.jsx` |
| 5 | The settings card header wraps on narrow screens, so the formats chip drops under the title. | `components/superadmin/settings/SettingsCard.jsx` |
| 6 | "Total media" adds `managed_event_media`. | `superadmin.py` |
| 7 | A new role-neutral email, "Your Campus Capture password has been reset", is used for Super Admin resets. Onboarding still uses the account-created templates. | `email_service.py` (`send_password_set_by_admin_email`), `superadmin.py` |

### Behaviour changes users will notice

- **Deleting accounts:** a teacher or Event Manager with research records must now be removed or deactivated; permanent deletion is refused.
- **Role changes:** the person whose role the Super Admin changes is signed out at once.
- **Archived Event Manager events** can be viewed and duplicated, but not changed, deleted or reported on until the Dean restores them.

---

## 1. Deleting a teacher with research records orphans those records (High) [reproduced]

**Where**
- Super Admin: `DELETE /superadmin/users/{id}`, in [superadmin.py:643](../backend/app/routers/superadmin.py#L643)
- Dean, one teacher: `DELETE /dean/teachers/{id}`, in [dean_teachers.py:1014](../backend/app/routers/dean_teachers.py#L1014)
- Dean, bulk delete: `POST /dean/teachers/bulk-delete`, in [dean_teachers.py:923](../backend/app/routers/dean_teachers.py#L923)
- The cascade: [storage_service.py:662](../backend/app/services/storage_service.py#L662) (`delete_user_cascade`)

**What happens.** Before a permanent delete, all three routes check only whether the person owns **events**. Research records, which belong to a teacher through `faculty_id`, are never counted, and `delete_user_cascade` doesn't touch `research_records` or `research_showcases`. So a teacher whose portfolio holds papers, patents or grants can be deleted permanently. Their records stay behind with no owner, and every screen then shows them as **"Unknown faculty member"**. This also corrupts the NAAC export, analytics and research CVs.

**Steps to reproduce**
1. As the Event Manager, add a faculty member and record a research item for them.
2. As the Super Admin, delete that user from User Management. Alternatively, as the Dean, delete the teacher from Teachers.
3. Open the research record.

**Observed**
```
delete user -> 200 "Probe sa … has been deleted successfully"
record afterwards -> faculty: {'name': 'Unknown faculty member'}
delete teacher (Dean) -> 200 "…'s account was deleted permanently."
record afterwards -> faculty: {'name': 'Unknown faculty member'}
```

**Expected.** These deletes should be refused the same way they are for a teacher with events: "has N research records. Deactivate or remove the teacher instead."

**Suggested fix.**
- Count `research_records` with `{"faculty_id": id}` alongside the event counts in all three places, and refuse while there are any.
- The bulk delete should skip such teachers with the reason, as it already does for events.

---

## 2. Super Admin "Reset password" doesn't let an invited Event Manager sign in (Medium) [reproduced]

**Where**
- [superadmin.py:904-914](../backend/app/routers/superadmin.py#L904) (`reset_user_password`)
- The login check: [auth.py:397](../backend/app/routers/auth.py#L397)

**What happens.** A new Event Manager is created with `email_verified=False` and gets an invitation link. If they never use the link, the Super Admin's natural fix is **Reset password**. The reset sets a password and reports success ("Password reset for … Notification email queued."), but it doesn't mark the email as verified. Your `backend/.env` has `REQUIRE_EMAIL_VERIFICATION=true`, so the login check then refuses the account. The same applies to a teacher who was invited but never accepted.

**Observed** (test backend with `REQUIRE_EMAIL_VERIFICATION=true`, as in your `.env`)
```
reset -> 200 "Password reset for Probe EM2 …. Notification email queued."
sign in with the reset password -> 403 "Your email is not confirmed. Please confirm your email before logging in."
```

**Expected.** Either the reset works, or the Super Admin is told it can't work.

**Suggested fix.** Choose one:
- **Make the reset work:** set `email_verified: True` and `email_verified_at` in the reset, and clear `invite_token_hash`. The Super Admin handing over the password is itself the proof of identity.
- **Refuse clearly:** answer 409 with "This person hasn't accepted their invitation yet. Resend the invitation instead."

---

## 3. Make Dean / Make Teacher leaves the user's session on the old panel (Medium) [reproduced]

**Where:** [superadmin.py:99-112](../backend/app/routers/superadmin.py#L99) (`set_role`), used by `PATCH /superadmin/users/{id}/make-dean` and `/make-teacher`.

**What happens.** The backend reads the role from the database on every request, so a role change takes effect at once. The user's browser, though, keeps the old panel open. Every action there then fails with **403 "Teacher access required"** (or "Dean access required"), and nothing explains why. The Dean's own **Promote to Dean** button avoids this: it bumps `token_version` so the old sessions end ([dean_teachers.py:1054](../backend/app/routers/dean_teachers.py#L1054)). The Super Admin's routes don't.

**Observed**
```
make-dean -> 200
teacher's old token on /users/me -> 200, role now: dean
old token on the Teacher API -> 403 "Teacher access required"
```

**Suggested fix.** In `set_role`, add `"$inc": {"token_version": 1}` so the user is signed out and their next sign-in opens the right panel.

---

## 4. The Event Manager isn't told when the Dean archives their event (Medium) [reproduced]

**Where**
- Backend: [event_manager.py:189](../backend/app/routers/event_manager.py#L189) (`list_events`), [:117](../backend/app/routers/event_manager.py#L117) (`_own_event_or_404`), [:359](../backend/app/routers/event_manager.py#L359) (`update_event`) and [:849](../backend/app/routers/event_manager.py#L849) (`event_report`)
- Frontend: `pages/teacher/MyEvents.jsx` and `EventDetails.jsx`, the screens the Event Manager shares; neither mentions `archived_at`.

**What happens.** The Dean can archive an Event Manager's event, from the list or in bulk. On the Event Manager's side, though:
- The event still appears in **My Events** as an ordinary "Recorded" event, with no archived badge or note.
- The Event Manager can still **edit** it, and the edit doesn't take it off the archive shelf.
- The Event Manager can still **download its report**. The Dean's own report route refuses archived events ("a report must not be generated from the shelf", [reports.py:86](../backend/app/routers/reports.py#L86)).

**Observed**
```
dean archive -> 200
EM list still shows it: True, status: recorded, archived_at: 2026-10-10T18:31:00Z
EM can still edit the archived event: 200
EM can still download its report: 200
```

**Suggested fix.**
- Show an "Archived by the Dean" banner and badge on the Event Manager's screens.
- Then decide the rule: either block edits and reports while an event is archived (the same as the Dean's side), or let them happen but say so.

---

## 5. Super Admin Settings scrolls sideways on a phone (Low) [reproduced]

**Where:** [SettingsCard.jsx:16](../frontend/src/components/superadmin/settings/SettingsCard.jsx#L16) and [:31](../frontend/src/components/superadmin/settings/SettingsCard.jsx#L31)

**What happens.** The card header is a one-line flex row (`flex items-center justify-between`) that can't wrap. The format chip beside the title doesn't shrink, so on a 390 px phone the cards are wider than the screen:
- **Upload limits** tab: 8 px of sideways scroll.
- **Document limits** tab: 38 px, where the "PDF, DOC, XLS, PPT, TXT, CSV" chip pushes the card out.

**Suggested fix.** Add `flex-wrap` to the header row and `min-w-0` to the title block, so the chip drops under the title on narrow screens.

---

## 6. Super Admin analytics "Total media" ignores Event Manager media (Low) [code]

**Where:** [superadmin.py:1211](../backend/app/routers/superadmin.py#L1211)

**What happens.** `total_media = event_media.count_documents({})` counts only teacher uploads. The other numbers on the same dashboard (events, approved, monthly trend, categories) include Event Manager events, so this one card is the odd one out. Photos and videos uploaded to Event Manager events (`managed_event_media`) are never counted.

**Suggested fix.** Add `managed_event_media.count_documents({})`.

---

## 7. An Event Manager's password-reset email says "Teacher account created" (Low) [code]

**Where**
- [superadmin.py:339-343](../backend/app/routers/superadmin.py#L339) (`_send_credentials`)
- [email_service.py:658](../backend/app/services/email_service.py#L658)

**What happens.** `_send_credentials` picks the Dean template for a Dean and the **Teacher** template for everyone else. A Super Admin resetting an Event Manager's password (or their own) therefore sends:
- the subject "Your Campus Capture **Teacher** account credentials";
- the body "A Teacher account **has been created** for you".

The text is wrong twice: the role is wrong, and the account wasn't just created, its password was reset.

**Suggested fix.** Add a role-neutral "your password was reset" template, or pass the role into the email text.

---

## What was checked and works

These were tested and found correct, so they don't need another look:

- **Every page of the three panels**, at desktop (1440 px) and phone (390 px) width, loads with no JavaScript errors, no console errors and no failed API calls. Coverage:
  - **Dean:** dashboard, events, archive, gallery (albums and photo wall), research, analytics, showcases, teachers, profile, event and research detail pages.
  - **Event Manager:** dashboard, create event, my events, profile, research, new record, showcases, analytics, import, record detail.
  - **Super Admin:** dashboard, events, users, audit logs, create Dean, create Event Manager, settings, profile, event detail.
- **API wiring:** all 93 frontend API calls match a backend route and method.
- **Dean decisions on Event Manager events** (approve, reject, revoke, request changes, change stage) are correctly refused (409 / 400). Archive, restore and delete work on both teacher and Event Manager events.
- **Dean report download links** for Event Manager events are signed and point to the Event Manager file route, so they open correctly.
- **Research rules:**
  - An Event Manager's submission is recorded straight away.
  - The Dean can't verify, reject, request changes on or unverify it (409 with a clear message).
  - The Dean can't delete research records (403).
  - The Event Manager can delete a recorded record.
  - The Super Admin has no research access, as designed.
- **DOI fill:** 24 of 24 browser checks pass against real Crossref records (from the previous task).
- **The `/superadmin/departments` redirect** to the dashboard is intentional: the department registry was removed because the platform is SST-only.

## Not covered

- The **Teacher** role was out of scope.
- **Email delivery** was checked only in the server outbox (delivery is off in the test setup).
- **R2 storage:** the test setup stores files in GridFS, so direct browser-to-R2 uploads and signed R2 links weren't exercised.
