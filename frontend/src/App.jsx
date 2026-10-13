import { lazy, Suspense } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
} from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/common/ProtectedRoute";
import { PanelProvider } from "./components/teacher/panel";
import { EVENT_MANAGER_PANEL } from "./components/teacher/panelConfig";
import PublicOnlyRoute from "./components/common/PublicOnlyRoute";
import EndSessionOnHistoryReturn from "./components/common/EndSessionOnHistoryReturn";

// Landing & Authentication.
//
// Eager: these are what an unauthenticated visitor lands on, so splitting them
// out would only add a round trip before the first paint.
import Landing from "./pages/Landing";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import VerifyEmail from "./pages/auth/VerifyEmail";
import ForgotPassword from "./pages/auth/ForgotPassword";
import ResetPassword from "./pages/auth/ResetPassword";
import AcceptInvite from "./pages/auth/AcceptInvite";
import NotFound from "./pages/NotFound";

// The three role areas are loaded on demand.
//
// Every visitor used to download all of them in one 1.09 MB chunk -- a teacher
// opening the login page on campus mobile data paid for the Dean's review
// screens, the whole Super Admin console and its charting library before
// anything rendered. A person only ever holds one role.

// Teacher
const TeacherDashboard = lazy(() => import("./pages/teacher/TeacherDashboard"));
const CreateEvent = lazy(() => import("./pages/teacher/CreateEvent"));
const MyEvents = lazy(() => import("./pages/teacher/MyEvents"));
const TeacherEventDetails = lazy(() => import("./pages/teacher/EventDetails"));
const TeacherProfile = lazy(() => import("./pages/teacher/Profile"));

// Dean
const DeanDashboard = lazy(() => import("./pages/dean/DeanDashboard"));
const DeanAllEvents = lazy(() => import("./pages/dean/AllEvents"));
const DeanArchive = lazy(() => import("./pages/dean/Archive"));
const DeanEventDetails = lazy(() => import("./pages/dean/EventDetails"));
const DeanProfile = lazy(() => import("./pages/dean/Profile"));
const DeanTeachers = lazy(() => import("./pages/dean/Teachers"));

// Super Admin
const SuperAdminDashboard = lazy(
  () => import("./pages/superadmin/SuperAdminDashboard"),
);
const UserManagement = lazy(() => import("./pages/superadmin/UserManagement"));
const CreateDean = lazy(() => import("./pages/superadmin/CreateDean"));
const CreateEventManager = lazy(() => import("./pages/superadmin/CreateEventManager"));
const SuperAdminEvents = lazy(() => import("./pages/superadmin/Events"));
const SuperAdminEventDetails = lazy(
  () => import("./pages/superadmin/EventDetails"),
);
const Settings = lazy(() => import("./pages/superadmin/Settings"));
const AuditLogs = lazy(() => import("./pages/superadmin/AuditLogs"));
const SuperAdminProfile = lazy(() => import("./pages/superadmin/Profile"));


/** Shown only while a role area's chunk is being fetched. */
function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <span className="spin h-8 w-8 text-accent" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/**
 * The create-event wizard keeps a lot of state in refs (the server event id,
 * the local draft id, the step). Keying it by the query string remounts it
 * whenever the target changes -- e.g. "Create Event" in the sidebar while
 * editing an event -- so it can never PATCH or delete the previous record.
 */
function CreateEventRoute() {
  const location = useLocation();
  return <CreateEvent key={location.search} />;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <EndSessionOnHistoryReturn />
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* ================= AUTH ================= */}
            <Route path="/" element={<Landing />} />
            {/* Sign-in and registration are for signed-out visitors only:
                PublicOnlyRoute sends anyone who opens them with a session to
                their dashboard. Reaching them with Back/Forward instead ends
                the session (EndSessionOnHistoryReturn). */}
            <Route
              path="/login"
              element={
                <PublicOnlyRoute>
                  <Login />
                </PublicOnlyRoute>
              }
            />
            <Route
              path="/register"
              element={
                <PublicOnlyRoute>
                  <Register />
                </PublicOnlyRoute>
              }
            />
            <Route path="/verify-email" element={<VerifyEmail />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/accept-invite" element={<AcceptInvite />} />

            {/* ================= TEACHER ================= */}
            <Route
              path="/teacher/dashboard"
              element={
                <ProtectedRoute allowedRoles={["teacher"]}>
                  <TeacherDashboard />
                </ProtectedRoute>
              }
            />

            <Route
              path="/teacher/create-event"
              element={
                <ProtectedRoute allowedRoles={["teacher"]}>
                  <CreateEventRoute />
                </ProtectedRoute>
              }
            />

            <Route
              path="/teacher/my-events"
              element={
                <ProtectedRoute allowedRoles={["teacher"]}>
                  <MyEvents />
                </ProtectedRoute>
              }
            />

            <Route
              path="/teacher/events/:eventId"
              element={
                <ProtectedRoute allowedRoles={["teacher"]}>
                  <TeacherEventDetails />
                </ProtectedRoute>
              }
            />

            <Route
              path="/teacher/profile"
              element={
                <ProtectedRoute allowedRoles={["teacher"]}>
                  <TeacherProfile />
                </ProtectedRoute>
              }
            />

            {/* ================= DEAN ================= */}
            <Route
              path="/dean"
              element={<Navigate to="/dean/dashboard" replace />}
            />
            <Route
              path="/dean/dashboard"
              element={
                <ProtectedRoute allowedRoles={["dean"]}>
                  <DeanDashboard />
                </ProtectedRoute>
              }
            />

            <Route
              path="/dean/events"
              element={
                <ProtectedRoute allowedRoles={["dean"]}>
                  <DeanAllEvents />
                </ProtectedRoute>
              }
            />

            <Route
              path="/dean/archive"
              element={
                <ProtectedRoute allowedRoles={["dean"]}>
                  <DeanArchive />
                </ProtectedRoute>
              }
            />

            <Route
              path="/dean/events/:eventId"
              element={
                <ProtectedRoute allowedRoles={["dean"]}>
                  <DeanEventDetails />
                </ProtectedRoute>
              }
            />

            <Route
              path="/dean/teachers"
              element={
                <ProtectedRoute allowedRoles={["dean"]}>
                  <DeanTeachers />
                </ProtectedRoute>
              }
            />

            <Route
              path="/dean/profile"
              element={
                <ProtectedRoute allowedRoles={["dean"]}>
                  <DeanProfile />
                </ProtectedRoute>
              }
            />

            {/* ================= SUPER ADMIN ================= */}
            <Route
              path="/superadmin/dashboard"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <SuperAdminDashboard />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/events"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <SuperAdminEvents />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/events/:eventId"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <SuperAdminEventDetails />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/users"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <UserManagement />
                </ProtectedRoute>
              }
            />

            {/* The department registry was removed: the platform serves SST
                only. Old bookmarks land on the dashboard. */}
            <Route
              path="/superadmin/departments"
              element={<Navigate to="/superadmin/dashboard" replace />}
            />

            <Route
              path="/superadmin/audit-logs"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <AuditLogs />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/create-dean"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <CreateDean />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/create-event-manager"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <CreateEventManager />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/settings"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <Settings />
                </ProtectedRoute>
              }
            />

            <Route
              path="/superadmin/profile"
              element={
                <ProtectedRoute allowedRoles={["superadmin"]}>
                  <SuperAdminProfile />
                </ProtectedRoute>
              }
            />

            {/* ================= EVENT MANAGER =================
                The Teacher panel's own screens, in the Event Manager panel:
                same UI, no Dean approval workflow. */}
            <Route
              path="/event_manager/dashboard"
              element={
                <ProtectedRoute allowedRoles={["event_manager"]}>
                  <PanelProvider panel={EVENT_MANAGER_PANEL}>
                    <TeacherDashboard />
                  </PanelProvider>
                </ProtectedRoute>
              }
            />
            <Route
              path="/event_manager/create-event"
              element={
                <ProtectedRoute allowedRoles={["event_manager"]}>
                  <PanelProvider panel={EVENT_MANAGER_PANEL}>
                    <CreateEventRoute />
                  </PanelProvider>
                </ProtectedRoute>
              }
            />
            <Route
              path="/event_manager/my-events"
              element={
                <ProtectedRoute allowedRoles={["event_manager"]}>
                  <PanelProvider panel={EVENT_MANAGER_PANEL}>
                    <MyEvents />
                  </PanelProvider>
                </ProtectedRoute>
              }
            />
            <Route
              path="/event_manager/events/:eventId"
              element={
                <ProtectedRoute allowedRoles={["event_manager"]}>
                  <PanelProvider panel={EVENT_MANAGER_PANEL}>
                    <TeacherEventDetails />
                  </PanelProvider>
                </ProtectedRoute>
              }
            />
            <Route
              path="/event_manager/profile"
              element={
                <ProtectedRoute allowedRoles={["event_manager"]}>
                  <PanelProvider panel={EVENT_MANAGER_PANEL}>
                    <TeacherProfile />
                  </PanelProvider>
                </ProtectedRoute>
              }
            />

            {/* Old /admin bookmarks from before the superadmin rename */}
            <Route
              path="/admin/*"
              element={<Navigate to="/superadmin/dashboard" replace />}
            />

            {/* Anything else: a real 404 page instead of a blank screen */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
