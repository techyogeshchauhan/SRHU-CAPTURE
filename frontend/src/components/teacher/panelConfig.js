/**
 * The Teacher panel's screens are shared with the Event Manager role: the
 * same shell, dashboard, create-event wizard, My Events, event page and
 * profile. What differs is carried here --
 *
 *   base      where the panel's own pages live ("/teacher/dashboard" ...)
 *   api       where its event API lives ("/teacher/events" ...)
 *   approval  whether events go to the Dean for review. Both roles submit
 *             for approval and can correct and resubmit rejected events.
 *   reports   whether the panel generates event reports itself.
 *
 * Nothing wraps the teacher routes, so they get TEACHER_PANEL by default and
 * behave exactly as they always have.
 */
export const TEACHER_PANEL = {
  role: "teacher",
  base: "/teacher",
  api: "/teacher",
  label: "Teacher Panel",
  roleLabel: "Teacher",
  approval: true,
  reports: false,
};

export const EVENT_MANAGER_PANEL = {
  role: "event_manager",
  base: "/event_manager",
  api: "/event-manager",
  label: "Event Manager Panel",
  roleLabel: "Event Manager",
  approval: true,
  reports: true,
};
