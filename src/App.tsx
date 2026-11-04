import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/ui/Toast';
import { PageErrorBoundary } from './components/ui/ErrorBoundary';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';

// Pages
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EventDetailsPage } from './pages/EventDetailsPage';
import { SmartMatchPage } from './pages/SmartMatchPage';
import { DashboardPage } from './pages/DashboardPage';
import { RegistrationsPage } from './pages/RegistrationsPage';
import { SavedEventsPage } from './pages/SavedEventsPage';
import { ProfilePage } from './pages/ProfilePage';
import { MessagesPage } from './pages/MessagesPage';
import { OrganizerDashboardPage } from './pages/OrganizerDashboardPage';
import { OrganizerEventsPage } from './pages/OrganizerEventsPage';
import { CreateEventPage } from './pages/CreateEventPage';
import { EditEventPage } from './pages/EditEventPage';
import { AttendeesPage } from './pages/AttendeesPage';
import { OrganizerProfilePage } from './pages/OrganizerProfilePage';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { LogoutPage } from './pages/LogoutPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PrivacyPage } from './pages/PrivacyPage';
import { AdminPage } from './pages/AdminPage';
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
  return (
    <BrowserRouter>
      <ToastProvider>
        <ScrollToTop />
        <div className="min-h-screen flex flex-col bg-[#FAF8F5] text-[#1E2320] font-sans">
          <Navbar />
          <main className="flex-1">
            <PageErrorBoundary>
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
            </PageErrorBoundary>
          </main>
          <Footer />
        </div>
      </ToastProvider>
    </BrowserRouter>
  );
}
