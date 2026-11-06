import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Menu, X, PlusCircle, User, LogOut, Sparkles, ChevronDown, LayoutDashboard, Ticket, Bookmark, Settings, Briefcase, ShieldCheck } from 'lucide-react';
import { authService } from '../../services/auth-service';
import { messagesService } from '../../services/messages-service';
import { subscribeToPrivateChannel } from '../../services/realtime-service';
import { UserProfile } from '../../types';
import { isDemoMode } from '../../services/api-client';
import {
  fetchAccess,
  isAdminEmail,
  AccessRole,
} from '../../services/roles-service';
import Avatar from '../ui/Avatar';

export function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(() => authService.getCurrentUser());
  const [unreadCount, setUnreadCount] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  // Ref for the profile button + dropdown, used to close the dropdown on
  // an outside click (previously it only closed on a route change, so
  // clicking anywhere else on the page left it open).
  const profileMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!profileDropdownOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setProfileDropdownOpen(false);
      }
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileDropdownOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onEscape);
    };
  }, [profileDropdownOpen]);
  // Organizer/admin access, fetched from the shared record (Supabase via
  // /api/organizer-access). Until it answers, organizer links stay hidden,
  // except for a Google-signed-in admin account (see OrganizerGuard).
  const [accessRole, setAccessRole] = useState<AccessRole | null>(null);

  useEffect(() => {
    if (!currentUser) {
      setAccessRole(null);
      return;
    }
    let cancelled = false;
    fetchAccess(currentUser.email)
      .then((access) => {
        if (!cancelled) setAccessRole(access ? access.role : null);
      })
      .catch(() => {
        // Error status (not 503/network): hide organizer/admin links
        // outright instead of falling back to a local 'admin' claim.
        if (!cancelled) setAccessRole('attendee');
      });
    return () => {
      cancelled = true;
    };
    // Re-checked on every route change too, so an organizer whose access
    // an admin just revoked loses the organizer links on their next
    // navigation instead of keeping them until they sign out and back in.
  }, [currentUser?.email, location.pathname]);

  // Unread message badge: refreshed on sign-in, on every route change
  // (so reading a thread then navigating anywhere clears it), and
  // every 30 seconds while the app is open (previously it only moved
  // on navigation). A failed refresh keeps the previous count instead
  // of resetting the badge to 0; a failure only ever hides the badge,
  // never the Messages link.
  useEffect(() => {
    if (!currentUser?.email) {
      setUnreadCount(0);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      messagesService.getUnreadCount(currentUser.email).then((count) => {
        if (!cancelled && count !== null) setUnreadCount(count);
      });
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentUser?.email, location.pathname]);

  // Realtime badge: a new message on my private channel refreshes
  // the unread count AT ONCE instead of waiting for the 30s interval
  // above (or a route change). The 30s interval stays as fallback.
  // Silent no-op while Realtime is not configured.
  useEffect(() => {
    if (!currentUser?.email) return;
    let unsubscribe = () => {};
    let cancelled = false;
    messagesService.getRealtimeChannel().then((channel) => {
      if (cancelled || !channel) return;
      unsubscribe = subscribeToPrivateChannel(channel, (ev) => {
        if (ev.type === 'message') {
          messagesService.getUnreadCount(currentUser.email).then((count) => {
            if (!cancelled && count !== null) setUnreadCount(count);
          });
        }
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentUser?.email]);

  const canPost =
    accessRole === 'admin' ||
    accessRole === 'organizer' ||
    (accessRole === null &&
      currentUser?.role === 'admin' &&
      currentUser?.email !== undefined &&
      isAdminEmail(currentUser.email));
  const isAdmin =
    accessRole === 'admin' ||
    (accessRole === null &&
      currentUser?.role === 'admin' &&
      currentUser?.email !== undefined &&
      isAdminEmail(currentUser.email));

  useEffect(() => {
    const unsubscribe = authService.subscribe((user) => {
      setCurrentUser(user);
    });
    return () => unsubscribe();
  }, []);

  // Re-read the stored user on every route change, and when another tab
  // changes storage. Without this, the navbar can stay stuck showing
  // "Sign In" (or a stale user) after a sign-in that happened outside
  // React's own notify() path, until a full page reload.
  useEffect(() => {
    setCurrentUser(authService.getCurrentUser());
  }, [location.pathname]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === 'locora_current_user') {
        setCurrentUser(authService.getCurrentUser());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileMenuOpen(false);
    setProfileDropdownOpen(false);
  }, [location.pathname]);

  const handleLogout = async () => {
    await authService.logout();
    navigate('/');
  };

  const isLandingPage = !currentUser && (location.pathname === '/' || location.pathname === '/landing');

  // Auth pages for a guest must not show the logged-in navigation
  // (Discover / SmartMatch / Organizer Hub / Post Event). Previously any
  // guest page that was not '/' or '/landing' fell through to the
  // logged-in nav, so /login and /signup looked signed-in even when
  // nobody was signed in. A signed-in user visiting an auth page keeps
  // the normal nav, so switching accounts still works.
  const isAuthPage =
    !currentUser &&
    (location.pathname === '/login' ||
      location.pathname === '/signup' ||
      location.pathname === '/logout' ||
      location.pathname === '/forgot-password');
  const authOppositePath = location.pathname === '/login' ? '/signup' : '/login';
  const authOppositeLabel = location.pathname === '/login' ? 'Join Free' : 'Sign In';

  const isCurrent = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <header className="sticky top-0 z-40 bg-[#FAF8F5]/95 backdrop-blur-md border-b border-[#E7E3DB]">
      {/* Top Bar Contract: 3 zones, gap-8 */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-8">
        {/* Zone 1: Logo mark + wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <Link
            to="/"
            className="flex items-center gap-2 shrink-0 hover:text-[#1E3F35] transition-colors"
          >
            <img
              src="/locora-logo.png"
              alt="Locora logo"
              className="h-9 w-9 rounded-lg object-cover shrink-0"
            />
            <span className="font-editorial text-2xl font-bold tracking-tight text-[#1E2320] whitespace-nowrap">
              Locora
            </span>
          </Link>
        </div>

        {/* Zone 2: 4-5 single-line clean navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-[#5F635D]">
          {isAuthPage ? (
            <></>
          ) : isLandingPage ? (
            <>
              <a href="#how-it-works" className="hover:text-[#1E2320] transition-colors whitespace-nowrap shrink-0">
                How It Works
              </a>
              <a href="#features" className="hover:text-[#1E2320] transition-colors whitespace-nowrap shrink-0">
                Capabilities
              </a>
              <a href="#community" className="hover:text-[#1E2320] transition-colors whitespace-nowrap shrink-0">
                Community
              </a>
              <a href="#faq" className="hover:text-[#1E2320] transition-colors whitespace-nowrap shrink-0">
                FAQ
              </a>
              <Link to="/discover" className="hover:text-[#1E2320] transition-colors whitespace-nowrap shrink-0">
                Explore Events
              </Link>
            </>
          ) : (
            <>
              <Link
                to="/discover"
                className={`transition-colors whitespace-nowrap shrink-0 pb-1 ${
                  isCurrent('/discover')
                    ? 'text-[#1E2320] border-b-2 border-[#1E3F35] font-semibold'
                    : 'hover:text-[#1E2320]'
                }`}
              >
                Discover
              </Link>

              <Link
                to="/smart-match"
                className={`inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 pb-1 ${
                  isCurrent('/smart-match')
                    ? 'text-[#1E2320] border-b-2 border-[#1E3F35] font-semibold'
                    : 'hover:text-[#1E2320]'
                }`}
              >
                <span>SmartMatch</span>
              </Link>

              {currentUser && (
                <Link
                  to="/dashboard"
                  className={`transition-colors whitespace-nowrap shrink-0 pb-1 ${
                    isCurrent('/dashboard') || isCurrent('/my-registrations') || isCurrent('/saved')
                      ? 'text-[#1E2320] border-b-2 border-[#1E3F35] font-semibold'
                      : 'hover:text-[#1E2320]'
                  }`}
                >
                  My Hub
                </Link>
              )}

              {currentUser && (
                <Link
                  to="/messages"
                  className={`inline-flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 pb-1 ${
                    isCurrent('/messages')
                      ? 'text-[#1E2320] border-b-2 border-[#1E3F35] font-semibold'
                      : 'hover:text-[#1E2320]'
                  }`}
                >
                  Messages
                  {unreadCount > 0 && (
                    <span className="min-w-4 h-4 px-1 rounded-full bg-[#1E3F35] text-white text-[10px] font-bold inline-flex items-center justify-center">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </Link>
              )}

              {currentUser && (
                <Link
                  to="/community"
                  className={`transition-colors whitespace-nowrap shrink-0 pb-1 ${
                    isCurrent('/community')
                      ? 'text-[#1E2320] border-b-2 border-[#1E3F35] font-semibold'
                      : 'hover:text-[#1E2320]'
                  }`}
                >
                  Community
                </Link>
              )}

              {canPost && (
                <Link
                  to="/organizer/dashboard"
                  className={`transition-colors whitespace-nowrap shrink-0 pb-1 ${
                    isCurrent('/organizer')
                      ? 'text-[#1E2320] border-b-2 border-[#1E3F35] font-semibold'
                      : 'hover:text-[#1E2320]'
                  }`}
                >
                  Organizer Hub
                </Link>
              )}
            </>
          )}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="hidden md:flex items-center gap-3 shrink-0">
          {currentUser ? (
            <div className="relative" ref={profileMenuRef}>
              <button
                type="button"
                onClick={() => setProfileDropdownOpen(!profileDropdownOpen)}
                className="flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-full border border-[#E7E3DB] bg-white hover:bg-[#FAF8F5] hover:border-[#1E3F35]/40 transition-colors shadow-2xs text-xs font-semibold text-[#1E2320]"
                aria-expanded={profileDropdownOpen}
              >
                <Avatar
                  src={currentUser.avatar}
                  name={currentUser.name}
                  className="w-6 h-6 rounded-full object-cover shrink-0"
                  initialClassName="text-[10px]"
                />
                <span className="max-w-[120px] truncate">{currentUser.name}</span>
                <ChevronDown className="w-3.5 h-3.5 text-[#285447] shrink-0" />
              </button>

              {/* Profile Dropdown Menu */}
              {profileDropdownOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-white rounded-2xl border border-[#E7E3DB] shadow-[0_20px_45px_-12px_rgba(30,35,32,0.28)] p-1.5 z-50 animate-in fade-in zoom-in-95 duration-100">
                  <div className="flex items-center gap-3 px-3 pt-2.5 pb-3 border-b border-[#E7E3DB] mb-1">
                    <Avatar
                      src={currentUser.avatar}
                      name={currentUser.name}
                      className="w-10 h-10 rounded-full object-cover shrink-0 ring-2 ring-[#EAF1ED]"
                      initialClassName="text-sm"
                    />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold text-[#1E2320] truncate">{currentUser.name}</p>
                      <p className="text-[11px] text-[#5F6B66] truncate">{currentUser.email}</p>
                      <span className="inline-flex items-center gap-1.5 mt-1.5 px-2 py-0.5 rounded-full bg-[#EAF1ED] text-[#1E3F35] text-[9px] font-bold uppercase tracking-[0.08em]">
                        <span className="w-1 h-1 rounded-full bg-[#1E3F35]" />
                        {accessRole ?? currentUser.role}
                      </span>
                    </div>
                  </div>

                  <Link
                    to="/dashboard"
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#1E2320]/75 hover:bg-[#FAF8F5] hover:text-[#1E3F35] transition-colors"
                  >
                    <LayoutDashboard className="w-4 h-4 text-[#285447]/70 shrink-0" />
                    <span>Attendee Dashboard</span>
                  </Link>
                  <Link
                    to="/my-registrations"
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#1E2320]/75 hover:bg-[#FAF8F5] hover:text-[#1E3F35] transition-colors"
                  >
                    <Ticket className="w-4 h-4 text-[#285447]/70 shrink-0" />
                    <span>My Registrations</span>
                  </Link>
                  <Link
                    to="/saved"
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#1E2320]/75 hover:bg-[#FAF8F5] hover:text-[#1E3F35] transition-colors"
                  >
                    <Bookmark className="w-4 h-4 text-[#285447]/70 shrink-0" />
                    <span>Saved Events</span>
                  </Link>
                  <Link
                    to="/profile"
                    className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#1E2320]/75 hover:bg-[#FAF8F5] hover:text-[#1E3F35] transition-colors"
                  >
                    <Settings className="w-4 h-4 text-[#285447]/70 shrink-0" />
                    <span>Profile Settings</span>
                  </Link>

                  {canPost && (
                    <>
                      <div className="border-t border-[#E7E3DB] my-1.5 mx-1" />

                      <Link
                        to="/organizer/dashboard"
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#1E2320]/75 hover:bg-[#FAF8F5] hover:text-[#1E3F35] transition-colors"
                      >
                        <Briefcase className="w-4 h-4 text-[#285447]/70 shrink-0" />
                        <span>Organizer Console</span>
                      </Link>
                      <Link
                        to="/organizer/events/new"
                        className="flex items-center justify-center gap-1.5 mt-1 px-3 py-2 rounded-lg text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] transition-colors"
                      >
                        <PlusCircle className="w-4 h-4" />
                        <span>Create New Event</span>
                      </Link>
                    </>
                  )}

                  {isAdmin && (
                    <>
                      <div className="border-t border-[#E7E3DB] my-1.5 mx-1" />

                      <Link
                        to="/admin"
                        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#1E2320]/75 hover:bg-[#FAF8F5] hover:text-[#1E3F35] transition-colors"
                      >
                        <ShieldCheck className="w-4 h-4 text-[#285447]/70 shrink-0" />
                        <span>Admin — Organizer Requests</span>
                      </Link>
                    </>
                  )}

                  <div className="border-t border-[#E7E3DB] my-1.5 mx-1" />

                  <button
                    onClick={handleLogout}
                    className="w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium text-[#B3402E] hover:bg-[#FAF0ED] transition-colors"
                  >
                    <LogOut className="w-4 h-4 shrink-0" />
                    <span>Sign Out</span>
                  </button>
                </div>
              )}
            </div>
          ) : isAuthPage ? (
            <div className="flex items-center gap-2">
              <Link
                to={authOppositePath}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-2xs"
              >
                {authOppositeLabel}
              </Link>
            </div>
          ) : isLandingPage ? (
            <div className="flex items-center gap-2">
              <Link
                to="/login"
                className="px-3.5 py-2 text-xs font-semibold text-[#1E2320] hover:text-[#1E3F35] transition-colors whitespace-nowrap shrink-0"
              >
                Sign In
              </Link>
              <Link
                to="/signup"
                className="px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-2xs"
              >
                Join Free
              </Link>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                to="/login"
                className="px-4 py-2 text-xs font-medium text-white bg-[#1E3F35] rounded-lg hover:bg-[#163028] transition-colors whitespace-nowrap shrink-0"
              >
                Sign In
              </Link>
              {canPost && (
                <Link
                  to="/organizer/events/new"
                  className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors whitespace-nowrap shrink-0 shadow-2xs"
                >
                  <PlusCircle className="w-3.5 h-3.5" />
                  <span>Post Event</span>
                </Link>
              )}
            </div>
          )}
        </div>

        {/* Mobile Hamburger Toggle */}
        <div className="flex md:hidden items-center gap-2">
          {!isLandingPage && !isAuthPage && canPost && (
            <Link
              to="/organizer/events/new"
              className="p-2 text-[#1E3F35] hover:bg-[#EAF1ED] rounded-lg"
              aria-label="Post event"
            >
              <PlusCircle className="w-5 h-5" />
            </Link>
          )}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="p-2 text-[#1E2320] hover:text-[#1E3F35] rounded-lg"
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-200 bg-white px-4 py-5 space-y-4 shadow-lg animate-in fade-in slide-in-from-top-2 duration-150">
          {isAuthPage ? (
            <div className="space-y-1">
              <Link
                to={authOppositePath}
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                {authOppositeLabel}
              </Link>
            </div>
          ) : isLandingPage ? (
            <div className="space-y-1">
              <a
                href="#how-it-works"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                How It Works
              </a>
              <a
                href="#features"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Capabilities
              </a>
              <a
                href="#community"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Community
              </a>
              <a
                href="#faq"
                onClick={() => setMobileMenuOpen(false)}
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                FAQ
              </a>
              <Link
                to="/discover"
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Explore All Events
              </Link>
            </div>
          ) : (
            <div className="space-y-1">
              <Link
                to="/"
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Home
              </Link>
              <Link
                to="/discover"
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Discover Events
              </Link>
              <Link
                to="/smart-match"
                className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                SmartMatch Recommendations
              </Link>
              {currentUser && (
                <>
                  <Link
                    to="/dashboard"
                    className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    My Dashboard
                  </Link>
                  <Link
                    to="/my-registrations"
                    className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    My Registrations
                  </Link>
                  <Link
                    to="/messages"
                    className="flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Messages
                    {unreadCount > 0 && (
                      <span className="min-w-5 h-5 px-1 rounded-full bg-[#1E3F35] text-white text-[10px] font-bold inline-flex items-center justify-center">
                        {unreadCount > 99 ? '99+' : unreadCount}
                      </span>
                    )}
                  </Link>
                  <Link
                    to="/community"
                    className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Community
                  </Link>
                  <Link
                    to="/saved"
                    className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Saved Events
                  </Link>
                  <Link
                    to="/profile"
                    className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Profile & Preferences
                  </Link>
                </>
              )}
              {canPost && (
                <Link
                  to="/organizer/dashboard"
                  className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Organizer Dashboard
                </Link>
              )}
              {isAdmin && (
                <Link
                  to="/admin"
                  className="block px-3 py-2.5 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Admin — Organizer Requests
                </Link>
              )}
            </div>
          )}

          <div className="pt-4 border-t border-[#E7E3DB] flex flex-col gap-2">
            {currentUser ? (
              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <Avatar
                    src={currentUser.avatar}
                    name={currentUser.name}
                    className="w-8 h-8 rounded-full object-cover"
                    initialClassName="text-xs"
                  />
                  <div>
                    <p className="text-xs font-semibold text-[#1E2320]">{currentUser.name}</p>
                    <p className="text-[11px] text-[#5F6B66]">{currentUser.role}</p>
                  </div>
                </div>
                <button
                  onClick={handleLogout}
                  className="text-xs font-medium text-[#B3402E] p-2 hover:bg-[#FAF0ED] rounded-lg"
                >
                  Sign Out
                </button>
              </div>
            ) : isLandingPage ? (
              <div className="flex flex-col gap-2">
                <Link
                  to="/signup"
                  className="w-full text-center py-2.5 text-xs font-semibold text-white bg-[#1E3F35] rounded-lg"
                >
                  Join Locora Free
                </Link>
                <Link
                  to="/login"
                  className="w-full text-center py-2.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
                >
                  Sign In
                </Link>
              </div>
            ) : isAuthPage ? (
              <div className="flex flex-col gap-2">
                <Link
                  to={authOppositePath}
                  className="w-full text-center py-2.5 text-xs font-medium text-white bg-[#1E3F35] rounded-lg"
                >
                  {authOppositeLabel}
                </Link>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Link
                  to="/login"
                  className="w-full text-center py-2.5 text-xs font-medium text-white bg-[#1E3F35] rounded-lg"
                >
                  Sign In
                </Link>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
