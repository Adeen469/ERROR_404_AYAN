import React, { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/ui/Toast';
import { PageErrorBoundary } from './components/ui/ErrorBoundary';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';

// Pages
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EventDetailsPage } from './pages/EventDetailsPage';
const SmartMatchPage = lazy(() => import('./pages/SmartMatchPage').then((m) => ({ default: m.SmartMatchPage })));
const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const RegistrationsPage = lazy(() => import('./pages/RegistrationsPage').then((m) => ({ default: m.RegistrationsPage })));
const SavedEventsPage = lazy(() => import('./pages/SavedEventsPage').then((m) => ({ default: m.SavedEventsPage })));
const ProfilePage = lazy(() => import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const MessagesPage = lazy(() => import('./pages/MessagesPage').then((m) => ({ default: m.MessagesPage })));
const OrganizerDashboardPage = lazy(() => import('./pages/OrganizerDashboardPage').then((m) => ({ default: m.OrganizerDashboardPage })));
const OrganizerEventsPage = lazy(() => import('./pages/OrganizerEventsPage').then((m) => ({ default: m.OrganizerEventsPage })));
const CreateEventPage = lazy(() => import('./pages/CreateEventPage').then((m) => ({ default: m.CreateEventPage })));
const EditEventPage = lazy(() => import('./pages/EditEventPage').then((m) => ({ default: m.EditEventPage })));
const AttendeesPage = lazy(() => import('./pages/AttendeesPage').then((m) => ({ default: m.AttendeesPage })));
const OrganizerProfilePage = lazy(() => import('./pages/OrganizerProfilePage').then((m) => ({ default: m.OrganizerProfilePage })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import('./pages/SignupPage').then((m) => ({ default: m.SignupPage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const LogoutPage = lazy(() => import('./pages/LogoutPage').then((m) => ({ default: m.LogoutPage })));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
import { OrganizerGuard } from './components/OrganizerGuard';

import { LandingPage } from './pages/LandingPage';
import { authService } from './services/auth-service';
import { UserProfile } from './types';

function HomeOrLanding() {
  const [currentUser, setCurrentUser] = React.useState<UserProfile | null>(() => authService.getCurrentUser());

  useEffect(() => {
    const unsub = authService.subscribe((u) => {
      setCurrentUser(u);
    });
    return unsub;
  }, []);

  if (currentUser) {
    return <HomePage />;
  }
  return <LandingPage />;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

// Attendee pages used to have no route guard at all: a guest opening
// /my-registrations or /messages got each page's own inconsistent
// handling (one rendered an empty list). Now guests are sent to sign
// in with ?returnTo= so they land back on the page they wanted, and
// the server APIs still enforce the session themselves — this is a UX
// guard, not the security boundary.
function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [currentUser, setCurrentUser] = React.useState(() => authService.getCurrentUser());

  useEffect(() => {
    const unsub = authService.subscribe((u) => setCurrentUser(u));
    return unsub;
  }, []);

  if (!currentUser) {
    return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  // Once per page load, re-check the stored session against the
  // server (see authService.validateSession): without this, a session
  // revoked elsewhere — "sign out everywhere", password reset — kept
  // showing as signed in on this browser, because the app only ever
  // read localStorage.
  useEffect(() => {
    void authService.validateSession();
  }, []);

  return (
    <BrowserRouter>
      <ToastProvider>
        <ScrollToTop />
        <div className="min-h-screen flex flex-col bg-[#FAF8F5] text-[#1E2320] font-sans">
          <Navbar />
          <main className="flex-1">
            <PageErrorBoundary>
            <Suspense
              fallback={
                <div className="min-h-[60vh] flex items-center justify-center">
                  <p className="text-sm text-[#5F635D]">Loading…</p>
                </div>
              }
            >
            <Routes>
              {/* Root Route: Shows Landing Page if guest/logged out; shows Community HomePage if logged in */}
              <Route path="/" element={<HomeOrLanding />} />
              <Route path="/landing" element={<LandingPage />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/discover" element={<DiscoverPage />} />
              <Route path="/events/:eventId" element={<EventDetailsPage />} />
              <Route path="/organizers/:organizerId" element={<OrganizerProfilePage />} />
              <Route path="/smart-match" element={<SmartMatchPage />} />

              {/* Attendee Protected Areas */}
              <Route path="/dashboard" element={<RequireAuth><DashboardPage /></RequireAuth>} />
              <Route path="/my-registrations" element={<RequireAuth><RegistrationsPage /></RequireAuth>} />
              <Route path="/saved" element={<RequireAuth><SavedEventsPage /></RequireAuth>} />
              <Route path="/profile" element={<RequireAuth><ProfilePage /></RequireAuth>} />
              <Route path="/messages" element={<RequireAuth><MessagesPage /></RequireAuth>} />

              {/* Organizer Hub — guarded: only approved organizers and
                  admins may open these pages. Attendees get a page that
                  explains the rule and lets them request access. */}
              <Route path="/organizer/dashboard" element={<OrganizerGuard><OrganizerDashboardPage /></OrganizerGuard>} />
              <Route path="/organizer/events" element={<OrganizerGuard><OrganizerEventsPage /></OrganizerGuard>} />
              <Route path="/organizer/events/new" element={<OrganizerGuard><CreateEventPage /></OrganizerGuard>} />
              <Route path="/organizer/events/:eventId/edit" element={<OrganizerGuard><EditEventPage /></OrganizerGuard>} />
              <Route path="/organizer/events/:eventId/attendees" element={<OrganizerGuard><AttendeesPage /></OrganizerGuard>} />

              {/* Admin — organizer request approvals (AdminPage guards itself) */}
              <Route path="/admin" element={<AdminPage />} />

              {/* Authentication */}
              <Route path="/login" element={<LoginPage />} />
              <Route path="/signup" element={<SignupPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route path="/logout" element={<LogoutPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />

              {/* 404 Fallback */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </Suspense>
            </PageErrorBoundary>
          </main>
          <Footer />
        </div>
      </ToastProvider>
    </BrowserRouter>
  );
}
