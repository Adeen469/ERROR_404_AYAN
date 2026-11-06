import React, { useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { ToastProvider } from './components/ui/Toast';
import { PageErrorBoundary, reloadOnceForChunkError, clearChunkReloadGuard } from './components/ui/ErrorBoundary';
import { Navbar } from './components/layout/Navbar';
import { Footer } from './components/layout/Footer';

// Pages
import { HomePage } from './pages/HomePage';
import { DiscoverPage } from './pages/DiscoverPage';
import { EventDetailsPage } from './pages/EventDetailsPage';

// Lazy pages with stale-chunk recovery. Every page below is a
// separate build chunk whose URL carries a content hash. When a new
// deployment lands while a visitor's tab is open (several deploys a
// day during active development), that tab's chunk map points at
// files the new deployment no longer serves — the server answers
// with the SPA fallback HTML, the dynamic import fails, and the
// error boundary's "Reload page" card was the only way in. Recover
// automatically instead: on a chunk-load failure, reload ONCE
// (sessionStorage-guarded, so a genuinely broken build still ends
// at the error card instead of looping) to pick up the fresh shell
// and chunk map. A successful import clears the guard, so the next
// deployment can recover the same way. The helpers live in
// components/ui/ErrorBoundary.tsx, whose boundary applies the same
// one-shot recovery to chunk errors thrown while rendering.
function lazyPage<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      const mod = await factory();
      clearChunkReloadGuard();
      return mod;
    } catch (err) {
      reloadOnceForChunkError(err);
      throw err;
    }
  });
}

const SmartMatchPage = lazyPage(() => import('./pages/SmartMatchPage').then((m) => ({ default: m.SmartMatchPage })));
const DashboardPage = lazyPage(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const RegistrationsPage = lazyPage(() => import('./pages/RegistrationsPage').then((m) => ({ default: m.RegistrationsPage })));
const SavedEventsPage = lazyPage(() => import('./pages/SavedEventsPage').then((m) => ({ default: m.SavedEventsPage })));
const ProfilePage = lazyPage(() => import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })));
const MessagesPage = lazyPage(() => import('./pages/MessagesPage').then((m) => ({ default: m.MessagesPage })));
const CommunityPage = lazyPage(() => import('./pages/CommunityPage').then((m) => ({ default: m.CommunityPage })));
const OrganizerDashboardPage = lazyPage(() => import('./pages/OrganizerDashboardPage').then((m) => ({ default: m.OrganizerDashboardPage })));
const OrganizerEventsPage = lazyPage(() => import('./pages/OrganizerEventsPage').then((m) => ({ default: m.OrganizerEventsPage })));
const CreateEventPage = lazyPage(() => import('./pages/CreateEventPage').then((m) => ({ default: m.CreateEventPage })));
const EditEventPage = lazyPage(() => import('./pages/EditEventPage').then((m) => ({ default: m.EditEventPage })));
const AttendeesPage = lazyPage(() => import('./pages/AttendeesPage').then((m) => ({ default: m.AttendeesPage })));
const OrganizerProfilePage = lazyPage(() => import('./pages/OrganizerProfilePage').then((m) => ({ default: m.OrganizerProfilePage })));
const LoginPage = lazyPage(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const SignupPage = lazyPage(() => import('./pages/SignupPage').then((m) => ({ default: m.SignupPage })));
const ForgotPasswordPage = lazyPage(() => import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazyPage(() => import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const VerifyEmailPage = lazyPage(() => import('./pages/VerifyEmailPage').then((m) => ({ default: m.VerifyEmailPage })));
const LogoutPage = lazyPage(() => import('./pages/LogoutPage').then((m) => ({ default: m.LogoutPage })));
const NotFoundPage = lazyPage(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })));
const PrivacyPage = lazyPage(() => import('./pages/PrivacyPage').then((m) => ({ default: m.PrivacyPage })));
const AdminPage = lazyPage(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));
const ChatWidget = lazyPage(() => import('./components/ChatWidget').then((m) => ({ default: m.ChatWidget })));
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

// Loco's floating bubble is hidden on /messages: the page already
// has Loco as a conversation there, so a second bubble would be
// redundant. Everywhere else the widget mounts as before.
function ChatWidgetSlot() {
  const { pathname } = useLocation();
  if (pathname === '/messages' || pathname.startsWith('/messages/')) return null;
  return <ChatWidget />;
}

// Messages and Community are full-height WhatsApp-style pages: the
// chat already fills the viewport, so the footer's usual 80px top
// margin would leave an empty band between the chat and the footer.
// On /messages and /community the footer sits flush under the chat
// instead; every other page keeps the margin.
function FooterSlot() {
  const { pathname } = useLocation();
  if (
    pathname === '/messages' ||
    pathname.startsWith('/messages/') ||
    pathname === '/community' ||
    pathname.startsWith('/community/')
  )
    return <Footer flush />;
  return <Footer />;
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

// Guests must not browse the app: Home, Discover, SmartMatch, event
// details and organizer profiles all redirect a signed-out visitor to
// the landing page. This is a UX guard (the server APIs still enforce
// the session themselves). It subscribes to auth state, so when a
// session is revoked elsewhere — "sign out everywhere" on another
// device — the revalidation in App's mount effect flips the user to
// null and the page the user is sitting on redirects to /landing by
// itself, with no manual refresh. Account pages (dashboard,
// registrations, profile, messages, organizer hub) keep RequireAuth's
// sign-in redirect with returnTo; only the public browsing routes
// land here.
function RequireSignedIn({ children }: { children: React.ReactNode }) {
  const [currentUser, setCurrentUser] = React.useState(() => authService.getCurrentUser());

  useEffect(() => {
    const unsub = authService.subscribe((u) => setCurrentUser(u));
    return unsub;
  }, []);

  if (!currentUser) {
    return <Navigate to="/landing" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  // Re-check the stored session against the server (see
  // authService.validateSession): without this, a session revoked
  // elsewhere — "sign out everywhere", password reset — kept showing
  // as signed in on this browser, because the app only ever read
  // localStorage. Page load alone is not enough: a tab left open
  // while the sign-out happens on another device would stay stale
  // until a manual refresh. So re-check whenever the tab becomes
  // visible or the window regains focus (the moment the user
  // switches back to this tab), plus a 60s backstop while the tab
  // stays visible. Background tabs are skipped.
  useEffect(() => {
    void authService.validateSession();
    const recheck = () => {
      if (document.visibilityState === 'visible') void authService.validateSession();
    };
    const onVisibility = () => {
      if (!document.hidden) recheck();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', recheck);
    const timer = window.setInterval(recheck, 60000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', recheck);
      window.clearInterval(timer);
    };
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
              <Route path="/home" element={<RequireSignedIn><HomePage /></RequireSignedIn>} />
              <Route path="/discover" element={<RequireSignedIn><DiscoverPage /></RequireSignedIn>} />
              <Route path="/events/:eventId" element={<RequireSignedIn><EventDetailsPage /></RequireSignedIn>} />
              <Route path="/organizers/:organizerId" element={<RequireSignedIn><OrganizerProfilePage /></RequireSignedIn>} />
              <Route path="/smart-match" element={<RequireSignedIn><SmartMatchPage /></RequireSignedIn>} />
              <Route path="/community" element={<RequireSignedIn><CommunityPage /></RequireSignedIn>} />

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
              <Route path="/verify-email" element={<VerifyEmailPage />} />
              <Route path="/logout" element={<LogoutPage />} />
              <Route path="/privacy" element={<PrivacyPage />} />

              {/* 404 Fallback */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
            </Suspense>
            </PageErrorBoundary>
          </main>
          <FooterSlot />
          <Suspense fallback={null}>
            <ChatWidgetSlot />
          </Suspense>
        </div>
      </ToastProvider>
    </BrowserRouter>
  );
}

