import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Ticket, Bookmark, Sparkles, MapPin, ArrowRight, Calendar, Users } from 'lucide-react';
import { AttendeeRegistration, EventItem, UserProfile } from '../types';
import { authService } from '../services/auth-service';
import { registrationsService, TeamMembersResult } from '../services/registrations-service';
import { savedEventsService } from '../services/saved-events-service';
import { formatEventDate, formatEventTimeRange, formatEventLocation } from '../utils/formatters';
import { EventCard } from '../components/events/EventCard';
import { EventListSkeleton } from '../components/ui/LoadingSkeleton';
import Avatar from '../components/ui/Avatar';

export function DashboardPage() {
  const [user, setUser] = useState<UserProfile | null>(() => authService.getCurrentUser());
  const [registrations, setRegistrations] = useState<AttendeeRegistration[]>([]);
  const [savedEvents, setSavedEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  // My Teams rosters, keyed by `${eventId}:${teamCode}`. A failed
  // fetch is recorded per card so one bad team never breaks the page.
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMembersResult>>({});
  const [teamMembersFailed, setTeamMembersFailed] = useState<Record<string, boolean>>({});
  const [copiedTeamCode, setCopiedTeamCode] = useState<string | null>(null);

  // Keep the dashboard in sync if the stored user changes after mount
  // (e.g. a sign-in in another tab, or a storage change outside React).
  useEffect(() => {
    const unsubscribe = authService.subscribe((u) => setUser(u));
    const onStorage = () => setUser(authService.getCurrentUser());
    window.addEventListener('storage', onStorage);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  useEffect(() => {
    async function loadData() {
      setLoading(true);
      try {
        // Independent loads: run together instead of one after another.
        const [regs, saved] = await Promise.all([
          registrationsService.getMyRegistrations(),
          savedEventsService.getSavedEvents(),
        ]);
        const activeRegs = regs.filter((r) => r.status === 'confirmed');
        setRegistrations(activeRegs);
        setSavedEvents(saved);
        // Team rosters for My Hub: one parallel read per team the user
        // belongs to. Each card fails independently — a bad fetch shows
        // an inline error on that card and leaves the rest working.
        const teamRegs = activeRegs.filter((r) => r.participationType === 'team' && r.teamCode);
        const teamResults = await Promise.all(
          teamRegs.map(async (r) => {
            const key = `${r.eventId}:${r.teamCode}`;
            try {
              const data = await registrationsService.getTeamMembers(r.eventId, r.teamCode as string);
              return { key, data };
            } catch {
              return { key, data: null as TeamMembersResult | null };
            }
          }),
        );
        const rosters: Record<string, TeamMembersResult> = {};
        const failedRosters: Record<string, boolean> = {};
        for (const { key, data } of teamResults) {
          if (data) rosters[key] = data;
          else failedRosters[key] = true;
        }
        setTeamMembers(rosters);
        setTeamMembersFailed(failedRosters);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  if (!user) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-4">
        <h2 className="font-editorial text-2xl font-bold text-[#1E2320]">Sign in to view your dashboard</h2>
        <p className="text-sm text-[#5F635D]">
          Sign in or switch to a demo profile to access your tickets, saved events, and recommendations.
        </p>
        <Link
          to="/login"
          className="inline-block px-5 py-2.5 bg-[#1E3F35] text-white rounded-lg text-xs font-semibold hover:bg-[#163028]"
        >
          Sign In
        </Link>
      </div>
    );
  }

  // The next ticket must be a confirmed pass: a pending payment has no
  // ticket code yet, so it must never render as the featured ticket.
  // It must also be for an event that has not ended yet — the same
  // rule as My Registrations (owner, 2026-11-06): a finished event's
  // pass is history, not a "next event". Among the live passes the
  // soonest start wins; the list order is registration order, which
  // is not event order.
  const eventHasEnded = (ev: EventItem): boolean => {
    const endMs = new Date(ev.endDate || ev.startDate).getTime();
    return Number.isFinite(endMs) && endMs < Date.now();
  };
  const nextUpcoming = registrations
    .filter((r) => r.status === 'confirmed' && r.event && !eventHasEnded(r.event))
    .sort((a, b) => new Date(a.event.startDate).getTime() - new Date(b.event.startDate).getTime())[0];

  // The teams this user belongs to (leader or member), for the My Teams
  // section. Individual registrations get no team card.
  const teamRegs = registrations.filter((r) => r.participationType === 'team' && r.teamCode);

  async function handleCopyTeamCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedTeamCode(code);
      window.setTimeout(() => setCopiedTeamCode((c) => (c === code ? null : c)), 2000);
    } catch {
      // Clipboard unavailable (non-secure context): the code stays
      // visible on the card to copy by hand.
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
      {/* Welcome Header */}
      <div className="bg-white rounded-2xl border border-[#E5E1D8] p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6 shadow-xs">
        <div className="flex items-center gap-4">
          <Avatar
            src={user.avatar}
            name={user.name}
            className="w-16 h-16 rounded-full object-cover border-2 border-[#E5E1D8] shrink-0"
            initialClassName="text-xl"
          />
          <div>
            <h1 className="font-editorial text-2xl sm:text-3xl font-bold text-[#1E2320]">
              Welcome back, {user.name}
            </h1>
            <p className="text-xs text-[#5F635D] mt-1 flex items-center gap-1.5">
              {formatEventLocation(user) && (
                <>
                  <MapPin className="w-3.5 h-3.5 text-[#8C887E]" />
                  <span>{formatEventLocation(user)}</span>
                  <span aria-hidden="true" className="text-[#C8C4BC]">·</span>
                </>
              )}
              <span>{user.interests.slice(0, 2).join(', ')}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-stretch sm:self-auto">
          <Link
            to="/profile"
            className="flex-1 sm:flex-none text-center px-4 py-2 bg-[#F4F1EA] hover:bg-[#EBE7DF] text-[#1E2320] text-xs font-medium rounded-lg transition-colors border border-[#E2DFD8]"
          >
            Edit Profile
          </Link>
          <Link
            to="/discover"
            className="flex-1 sm:flex-none text-center px-4 py-2 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors"
          >
            Discover Events
          </Link>
        </div>
      </div>

      {/* Metrics Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="p-5 bg-white rounded-xl border border-[#E5E1D8] space-y-1 shadow-2xs">
          <span className="text-xs font-medium text-[#5F635D] flex items-center gap-1.5">
            <Ticket className="w-4 h-4 text-[#1E3F35]" />
            <span>Active Registrations</span>
          </span>
          <p className="font-editorial text-3xl font-bold text-[#1E2320] tabular-nums">
            {registrations.length}
          </p>
          <Link
            to="/my-registrations"
            className="text-[11px] text-[#1E3F35] font-semibold hover:underline block pt-1"
          >
            View tickets →
          </Link>
        </div>

        <div className="p-5 bg-white rounded-xl border border-[#E5E1D8] space-y-1 shadow-2xs">
          <span className="text-xs font-medium text-[#5F635D] flex items-center gap-1.5">
            <Bookmark className="w-4 h-4 text-[#1E3F35]" />
            <span>Saved Bookmarks</span>
          </span>
          <p className="font-editorial text-3xl font-bold text-[#1E2320] tabular-nums">
            {savedEvents.length}
          </p>
          <Link
            to="/saved"
            className="text-[11px] text-[#1E3F35] font-semibold hover:underline block pt-1"
          >
            View saved list →
          </Link>
        </div>

        <div className="p-5 bg-white rounded-xl border border-[#E5E1D8] space-y-1 shadow-2xs">
          <span className="text-xs font-medium text-[#5F635D] flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-[#1E3F35]" />
            <span>SmartMatch Hub</span>
          </span>
          <p className="font-editorial text-3xl font-bold text-[#1E2320]">Ready</p>
          <Link
            to="/smart-match"
            className="text-[11px] text-[#1E3F35] font-semibold hover:underline block pt-1"
          >
            Explore matches →
          </Link>
        </div>
      </div>

      {/* Next Upcoming Ticket Feature */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-[#E5E1D8] p-6 animate-pulse flex flex-col md:flex-row gap-6">
          <div className="w-full md:w-60 aspect-[16/10] bg-[#EBE7DF] rounded-xl shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-3 w-24 bg-[#EBE7DF] rounded" />
            <div className="h-6 w-2/3 bg-[#EBE7DF] rounded" />
            <div className="h-3 w-1/2 bg-[#EBE7DF] rounded" />
            <div className="h-8 w-40 bg-[#EBE7DF] rounded-lg" />
          </div>
        </div>
      ) : nextUpcoming ? (
        <div className="bg-white rounded-2xl border border-[#E5E1D8] p-6 space-y-4 shadow-xs">
          <div className="flex items-center justify-between pb-3 border-b border-[#EBE7DF]">
            <h2 className="font-editorial text-base font-bold text-[#1E2320]">
              Your Next Event
            </h2>
            <Link
              to="/my-registrations"
              className="text-xs font-semibold text-[#1E3F35] hover:underline"
            >
              All registrations ({registrations.length})
            </Link>
          </div>

          <div className="flex flex-col md:flex-row gap-6 items-start">
            <div className="w-full md:w-60 aspect-[16/10] rounded-xl overflow-hidden bg-[#F4F1EA] shrink-0 border border-[#E2DFD8]">
              <img
                src={nextUpcoming.event.coverImage}
                alt={nextUpcoming.event.title}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>

            <div className="flex-1 space-y-3">
              <div className="text-xs text-[#1E3F35] font-semibold uppercase tracking-wider">
                {nextUpcoming.event.category}
              </div>
              <h3 className="font-editorial text-xl font-bold text-[#1E2320]">
                <Link to={`/events/${nextUpcoming.event.id}`} className="hover:text-[#1E3F35]">
                  {nextUpcoming.event.title}
                </Link>
              </h3>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-[#5F635D]">
                <div className="flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-[#8C887E]" />
                  <span>{formatEventDate(nextUpcoming.event.startDate)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-[#8C887E]" />
                  <span>{nextUpcoming.event.venueName}</span>
                </div>
              </div>

              <div className="pt-2 flex items-center gap-4">
                <span className="text-xs font-mono font-semibold bg-[#F4F1EA] text-[#1E2320] px-3 py-1.5 rounded-lg border border-[#E2DFD8]">
                  Ticket: {nextUpcoming.ticketCode}
                </span>
                <Link
                  to="/my-registrations"
                  className="text-xs font-semibold text-[#1E3F35] hover:underline"
                >
                  View Digital Pass →
                </Link>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* My Teams — hackathon teams this user belongs to. The leader
          and the members see the same list: each other's name + email,
          so they know who is on their team. Phone numbers are never
          shown here (attendee details are "shared with organizer only"). */}
      {!loading && teamRegs.length > 0 && (
        <div className="space-y-4">
          <div>
            <h2 className="font-editorial text-2xl font-bold tracking-tight text-[#1E2320]">
              My Teams
            </h2>
            <p className="text-xs text-[#5F635D] mt-0.5">
              The teams you're on — your teammates can see your name and email, and you can see theirs.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {teamRegs.map((reg) => {
              const key = `${reg.eventId}:${reg.teamCode}`;
              const data = teamMembers[key];
              const failed = teamMembersFailed[key];
              const members = data?.members || [];
              return (
                <div key={key} className="bg-white rounded-xl border border-[#E5E1D8] p-5 space-y-3 shadow-2xs">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        to={`/events/${reg.eventId}`}
                        className="font-editorial text-base font-bold text-[#1E2320] hover:text-[#1E3F35]"
                      >
                        {reg.event.title}
                      </Link>
                      <p className="text-xs text-[#5F635D] mt-0.5">
                        {formatEventDate(reg.event.startDate)}
                      </p>
                    </div>
                    <span className="text-[11px] font-semibold text-[#1E3F35] bg-[#EAF1ED] px-2 py-1 rounded-full whitespace-nowrap flex items-center gap-1">
                      <Users className="w-3.5 h-3.5" />
                      {data ? `${members.length}/${data.teamSize}` : `1/${reg.teamSize || '?'}`}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 p-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg">
                    <span className="text-[11px] text-[#5F635D]">Team code</span>
                    <span className="flex-1 font-mono text-xs font-semibold text-[#1E2320] tracking-wider truncate">
                      {reg.teamCode}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopyTeamCode(reg.teamCode as string)}
                      className="px-2.5 py-1 bg-[#1E3F35] text-white rounded-md text-[11px] font-medium hover:bg-[#163028] shrink-0"
                    >
                      {copiedTeamCode === reg.teamCode ? 'Copied' : 'Copy'}
                    </button>
                  </div>

                  {failed ? (
                    <p className="text-xs text-rose-600">
                      Couldn't load team members — try refreshing the page.
                    </p>
                  ) : !data ? (
                    <p className="text-xs text-[#5F635D]">Loading team members…</p>
                  ) : members.length === 0 ? (
                    <p className="text-xs text-[#5F635D]">No team members found.</p>
                  ) : (
                    <>
                      <ul className="divide-y divide-[#EBE7DF]">
                        {members.map((m) => (
                          <li key={m.email} className="py-2 flex items-center gap-3 first:pt-0 last:pb-0">
                            <Avatar
                              name={m.name}
                              className="w-8 h-8 rounded-full shrink-0"
                              initialClassName="text-xs"
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold text-[#1E2320] truncate">
                                {m.name || m.email}
                              </p>
                              <p className="text-[11px] text-[#5F635D] truncate">{m.email}</p>
                            </div>
                            {m.email.toLowerCase() === user.email.toLowerCase() && (
                              <span className="text-[10px] font-semibold text-[#5F635D] bg-[#F4F1EA] px-2 py-0.5 rounded-full shrink-0">
                                You
                              </span>
                            )}
                            <span
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${
                                m.isTeamLeader ? 'text-[#1E3F35] bg-[#EAF1ED]' : 'text-[#5F635D] bg-[#F4F1EA]'
                              }`}
                            >
                              {m.isTeamLeader ? 'Leader' : 'Member'}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {members.length === 1 && (
                        <p className="text-[11px] text-[#5F635D]">
                          Only you so far — share your team code to add members.
                        </p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Saved Events Strip */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-editorial text-2xl font-bold tracking-tight text-[#1E2320]">
              Saved Events
            </h2>
            <p className="text-xs text-[#5F635D] mt-0.5">
              Events you've bookmarked to check back later.
            </p>
          </div>
          <Link
            to="/saved"
            className="text-xs font-semibold text-[#1E3F35] hover:underline"
          >
            Manage saved ({savedEvents.length})
          </Link>
        </div>

        {loading ? (
          <EventListSkeleton count={3} />
        ) : savedEvents.length === 0 ? (
          <div className="p-8 text-center bg-white rounded-xl border border-dashed border-[#E5E1D8] text-xs text-[#5F635D]">
            No saved events yet. Browse events in{' '}
            <Link to="/discover" className="text-[#1E3F35] font-semibold underline">
              Discover
            </Link>{' '}
            and click the bookmark icon to save them here.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {savedEvents.slice(0, 3).map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
