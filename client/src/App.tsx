import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { SessionProvider, useSession } from './lib/session';
import { RealtimeProvider } from './lib/realtime';
import { TimerProvider } from './lib/timer';
import { ToastProvider } from './components/Toasts';
import { Layout } from './components/Layout';
import { ErrorPanel } from './components/ErrorPanel';
import { Loading } from './components/ui';
import { SignIn } from './pages/auth/SignIn';
import { SignUp } from './pages/auth/SignUp';
import { ForgotPassword } from './pages/auth/ForgotPassword';
import { ResetPassword } from './pages/auth/ResetPassword';
import { AcceptInvite } from './pages/auth/AcceptInvite';
import { NoOrganisation } from './pages/NoOrganisation';
import { CreateOrganisation } from './pages/CreateOrganisation';
import { Dashboard } from './pages/Dashboard';
import { MyTasks } from './pages/MyTasks';
import { ProjectsList } from './pages/projects/ProjectsList';
import { ProjectWorkspace } from './pages/projects/ProjectWorkspace';
import { TimeTracker } from './pages/TimeTracker';
import { TeamChat } from './pages/chat/TeamChat';
import { People } from './pages/People';
import { EmployeeProfile } from './pages/EmployeeProfile';
import { Attendance } from './pages/Attendance';
import { Clients } from './pages/Clients';
import { Reports } from './pages/reports/Reports';
import { Assistant } from './pages/Assistant';
import { Notifications } from './pages/Notifications';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { OrganisationSettings } from './pages/settings/OrganisationSettings';
import { MembersSettings } from './pages/settings/MembersSettings';
import { ProfileSettings } from './pages/settings/ProfileSettings';
import { AuditLog } from './pages/settings/AuditLog';
import { PlatformAdmin } from './pages/PlatformAdmin';
import { NotFound } from './pages/NotFound';

function Boot({ children }: { children: ReactNode }) {
  const { loading, error, session, refresh } = useSession();
  if (loading) return <Loading label="Loading WorkPilot AI…" />;
  if (error && !session) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <ErrorPanel error={error} operation="Loading your session" onRetry={() => void refresh()} />
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

/** Signed-in users with an active organisation, with live updates and the shared timer. */
function RequireOrg({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const location = useLocation();
  if (!session) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (!session.org) return <Navigate to="/no-organisation" replace />;
  return (
    <RealtimeProvider>
      <TimerProvider>{children}</TimerProvider>
    </RealtimeProvider>
  );
}

/** Internal members only (clients and guests are sent to the dashboard). */
function InternalOnly({ children }: { children: ReactNode }) {
  const { session } = useSession();
  if (session && !session.roles.some((r) => r !== 'client')) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

function RequireUser({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const location = useLocation();
  if (!session) return <Navigate to={`/signin?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { session } = useSession();
  if (session) return <Navigate to={session.org ? '/dashboard' : '/no-organisation'} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <Boot>
            <Routes>
              <Route path="/signin" element={<GuestOnly><SignIn /></GuestOnly>} />
              <Route path="/signup" element={<GuestOnly><SignUp /></GuestOnly>} />
              <Route path="/forgot-password" element={<GuestOnly><ForgotPassword /></GuestOnly>} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/no-organisation" element={<RequireUser><NoOrganisation /></RequireUser>} />
              <Route path="/organisations/new" element={<RequireUser><CreateOrganisation /></RequireUser>} />

              <Route element={<RequireOrg><Layout /></RequireOrg>}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/tasks" element={<InternalOnly><MyTasks /></InternalOnly>} />
                <Route path="/projects" element={<ProjectsList />} />
                <Route path="/projects/:id/:tab?" element={<ProjectWorkspace />} />
                <Route path="/time" element={<InternalOnly><TimeTracker /></InternalOnly>} />
                <Route path="/chat" element={<TeamChat />} />
                <Route path="/people" element={<InternalOnly><People /></InternalOnly>} />
                <Route path="/people/:userId" element={<InternalOnly><EmployeeProfile /></InternalOnly>} />
                <Route path="/attendance" element={<InternalOnly><Attendance /></InternalOnly>} />
                <Route path="/clients" element={<InternalOnly><Clients /></InternalOnly>} />
                <Route path="/reports" element={<InternalOnly><Reports /></InternalOnly>} />
                <Route path="/assistant" element={<InternalOnly><Assistant /></InternalOnly>} />
                <Route path="/notifications" element={<Notifications />} />
                <Route path="/settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="/settings/profile" replace />} />
                  <Route path="profile" element={<ProfileSettings />} />
                  <Route path="organisation" element={<OrganisationSettings />} />
                  <Route path="members" element={<MembersSettings />} />
                  <Route path="audit" element={<AuditLog />} />
                </Route>
                <Route path="/admin" element={<PlatformAdmin />} />
                <Route path="*" element={<NotFound />} />
              </Route>
            </Routes>
          </Boot>
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
