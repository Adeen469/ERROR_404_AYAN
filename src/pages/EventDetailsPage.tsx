import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  Calendar,
  Clock,
  MapPin,
  Users,
  Bookmark,
  Share2,
  ExternalLink,
  ArrowLeft,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Shield,
  Copy,
  Check,
  MessageCircle,
} from 'lucide-react';
import { EventItem, AttendeeRegistration } from '../types';
import { eventsService, isEventOwner } from '../services/events-service';
import { registrationsService, getRefundQuote, TeamRegistrationOptions } from '../services/registrations-service';
import { paymentsService } from '../services/payments-service';
import { savedEventsService } from '../services/saved-events-service';
import { authService } from '../services/auth-service';
import { AttendeeDetailsGate } from '../components/events/AttendeeDetailsGate';
import { formatEventDate, formatEventTimeRange, formatPrice, formatPaise, getMapsSearchUrl, formatEventLocation, getEventNeighborhood } from '../utils/formatters';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog, Modal } from '../components/ui/Modal';
import { EventDetailsSkeleton } from '../components/ui/LoadingSkeleton';
import { EventCard } from '../components/events/EventCard';
import Avatar from '../components/ui/Avatar';
import { CommunityChat } from '../components/events/CommunityChat';

// "Add to Google Calendar" link. This uses Google Calendar's public template
// URL, which prefills an event in the visitor's own Google Calendar — no
// OAuth, no Locora connection, and no Google verification required, so it
// works for every visitor, including guests. This is now the only calendar
// action on the page: the OAuth connect button and its automatic add/remove
// code were removed.
function toGoogleTemplateDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// SECURITY FIX — Phase 1 Finding 5: the calendar link no longer embeds
// the full event description (which once contained pasted AI-conversation
// text). It uses a plain-text summary only, HTML stripped, truncated to
// 200 characters, so a long or pasted description can never leak into an
// external Google Calendar URL.
function calendarSummary(event: EventItem): string {
  const raw = event.summary || event.description || '';
  const plain = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.length > 200 ? plain.slice(0, 200).trimEnd() + '…' : plain;
}

function buildGoogleCalendarTemplateUrl(event: EventItem): string {
  const start = toGoogleTemplateDate(event.startDate);
  const end = event.endDate
    ? toGoogleTemplateDate(event.endDate)
    : toGoogleTemplateDate(
        new Date(new Date(event.startDate).getTime() + 2 * 60 * 60 * 1000).toISOString(),
      );
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: `${start}/${end}`,
    details: calendarSummary(event),
    location: [event.venueName, event.address, event.city].filter(Boolean).join(', '),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function EventDetailsPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [event, setEvent] = useState<EventItem | null>(null);
  const [relatedEvents, setRelatedEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSaved, setIsSaved] = useState(false);
  const [registration, setRegistration] = useState<AttendeeRegistration | null>(null);

  // Modals state
  const [confirmRegisterOpen, setConfirmRegisterOpen] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  // Attendee details gate state: which registration flow to continue
  // once the user has provided/confirmed their details.
  const [detailsGateOpen, setDetailsGateOpen] = useState(false);
  // Aggregate pending-payment count for the capacity block
  // (pending / approved / total). No attendee details, and a failure
  // here never blocks the event itself.
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (!eventId) return;
    registrationsService.getPendingCounts()
      .then((counts) => setPendingCount(counts[eventId] || 0))
      .catch(() => {});
  }, [eventId]);
  const [detailsGateTarget, setDetailsGateTarget] = useState<'free' | 'paid' | null>(null);
  // Razorpay payment dialog state (paid events only). There is no
  // manual payment path anymore: no UPI ID, no QR, no UTR.
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [razorpayError, setRazorpayError] = useState('');
  // Team participation (hackathons, f-1 + f-2): the attendee's picks
  // in the team modal, shown after the details gate (if any) and
  // before the payment / confirm step. teamOpts carries the leader's
  // create choices into the payment dialog, whose Pay button fires
  // later; the free path passes them straight to the confirm handler.
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [teamModalTarget, setTeamModalTarget] = useState<'free' | 'paid'>('free');
  const [teamParticipationType, setTeamParticipationType] = useState<'individual' | 'team'>('individual');
  const [teamAction, setTeamAction] = useState<'create' | 'join'>('create');
  const [teamSize, setTeamSize] = useState(2);
  const [teamCodeInput, setTeamCodeInput] = useState('');
  const [teamError, setTeamError] = useState('');
  const [teamOpts, setTeamOpts] = useState<TeamRegistrationOptions | undefined>(undefined);
  const [copiedTeamCode, setCopiedTeamCode] = useState(false);

  useEffect(() => {
    async function loadEventData() {
      if (!eventId) return;
      setLoading(true);
      try {
        // These three do not depend on each other, so run them together
        // instead of stacking three ~2s calls (the shared event cache
        // also dedupes the event fetch inside getRelatedEvents).
        const [data, reg, related] = await Promise.all([
          eventsService.getEventById(eventId),
          registrationsService.getRegistrationForEvent(eventId),
          eventsService.getRelatedEvents(eventId),
        ]);
        setEvent(data);
        if (data) {
          setIsSaved(savedEventsService.isSaved(data.id));
          setRegistration(reg);
          setRelatedEvents(related);
        }
      } catch (err) {
        console.error('Failed to load event details:', err);
      } finally {
        setLoading(false);
      }
    }
    loadEventData();
  }, [eventId]);

  if (loading) {
    return <EventDetailsSkeleton />;
  }

  if (!event) {
    return (
      <div className="max-w-lg mx-auto px-4 py-20 text-center space-y-4">
        <div className="w-12 h-12 bg-rose-50 text-rose-600 rounded-xl flex items-center justify-center mx-auto">
          <AlertCircle className="w-6 h-6" />
        </div>
        <h2 className="font-editorial text-2xl font-bold text-[#1E2320]">Event Not Found</h2>
        <p className="text-sm text-[#5F635D]">
          The event you are looking for may have been removed or does not exist.
        </p>
        <Link
          to="/discover"
          className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#1E3F35] text-white rounded-lg text-xs font-semibold hover:bg-[#163028] transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Discover</span>
        </Link>
      </div>
    );
  }

  const isFull = event.registeredCount >= event.capacity;
  const isRegistered = Boolean(registration && registration.status === 'confirmed');
  const isPaymentPending = Boolean(registration && registration.status === 'pending');
  // Refund preview for the cancel dialog (client-side preview only —
  // the server computes the real refund on cancel). Paid confirmed
  // passes only; free/pending rows get no refund line.
  const cancelRefundQuote =
    registration && registration.status === 'confirmed' ? getRefundQuote(registration) : null;
  const cancelRefundMessage = !cancelRefundQuote
    ? 'Are you sure you want to cancel your RSVP? This will free your spot for other attendees.'
    : cancelRefundQuote.isFull
      ? `Are you sure you want to cancel your RSVP? You will get a full refund of ${formatPaise(cancelRefundQuote.refundAmountPaise)}. Your ticket will be cancelled immediately.`
      : `Are you sure you want to cancel your RSVP? You will get ${formatPaise(cancelRefundQuote.refundAmountPaise)} back (90%). A 10% cancellation fee of ${formatPaise(cancelRefundQuote.refundFeePaise)} applies because it has been more than 24 hours since you bought the ticket. Your ticket will be cancelled immediately.`;
  const isPaymentRejected = Boolean(registration && registration.status === 'rejected');
  const isPaidEvent = event.price > 0;
  // Team participation config (hackathons only, f-1 + f-2): mode
  // 'team' or 'both' opens the team modal before registration;
  // 'individual' (or no config) keeps the plain flow. The price is
  // per team for team registrations — the leader pays it once — and
  // per person for individual ones.
  const participation = event?.participation;
  const teamEnabled = Boolean(participation && (participation.mode === 'team' || participation.mode === 'both'));
  const minTeamSize = participation?.minTeamSize ?? 2;
  const maxTeamSize = participation?.maxTeamSize ?? 4;
  const priceSuffix =
    event.price === 0
      ? '/ attendee'
      : participation?.mode === 'team'
        ? '/ team'
        : participation?.mode === 'both'
          ? '/ person · / team'
          : undefined;
  const spotsLeft = Math.max(0, event.capacity - event.registeredCount);
  // Owner state: since the server GET is now session-aware, an owner
  // viewing their own event receives createdByEmail/organizer.email and
  // this is true. Guests and other viewers still get the stripped
  // public shape, so they never see themselves as the owner. Owners
  // get Manage/Edit links instead of Register, and no "Message
  // organizer" button (messaging yourself is blocked server-side).
  const viewerEmail = (authService.getCurrentUser()?.email || '').toLowerCase();
  const isOwner = Boolean(viewerEmail) && isEventOwner(event, viewerEmail);
  // Dead-event state: the server rejects registrations for draft,
  // cancelled, or ended events, so the page must say so instead of
  // offering a Register button that can only fail.
  const eventEnded = Boolean(event.endDate) && new Date(event.endDate).getTime() < Date.now();
  const eventStateNote =
    event.status === 'cancelled'
      ? 'This event has been cancelled by the organizer.'
      : event.status === 'draft'
        ? 'This event is still a draft and is not open for registration.'
        : eventEnded
          ? 'This event has already ended.'
          : null;

  const handleToggleBookmark = async () => {
    try {
      const state = await savedEventsService.toggleSave(event.id);
      setIsSaved(state);
      toast({
        type: 'success',
        title: state ? 'Event saved' : 'Removed from bookmarks',
      });
    } catch {
      toast({ type: 'error', title: 'Failed to bookmark event' });
    }
  };

  // Attendee details gate: events require attendee details unless the
  // organizer opted out (missing flag on older events means required).
  // Guests skip the gate — registration itself requires sign-in, and
  // the existing service error covers that path unchanged.
  const detailsRequired = event ? event.requireAttendeeDetails !== false : false;
  // After the details gate (or straight away when the gate does not
  // apply): team events pause at the team modal so the attendee picks
  // Individual / Team and Create / Join first; the modal's own
  // buttons then open the payment or confirm step.
  const continueAfterGate = (target: 'free' | 'paid') => {
    if (teamEnabled) {
      setTeamParticipationType(participation?.mode === 'team' ? 'team' : 'individual');
      setTeamAction('create');
      setTeamSize(minTeamSize);
      setTeamCodeInput('');
      setTeamError('');
      setTeamOpts(undefined);
      setTeamModalTarget(target);
      setTeamModalOpen(true);
      return;
    }
    if (target === 'paid') setPaymentOpen(true);
    else setConfirmRegisterOpen(true);
  };
  const openRegistration = (target: 'free' | 'paid') => {
    if (!detailsRequired || !authService.getCurrentUser()) {
      continueAfterGate(target);
      return;
    }
    setDetailsGateTarget(target);
    setDetailsGateOpen(true);
  };

  // Leader's team code, appended to the success toast so they can
  // share it right away (it also stays visible in the "You're
  // registered!" area afterwards).
  const leaderTeamCodeLine = (reg: AttendeeRegistration | null | undefined) =>
    reg?.participationType === 'team' && reg.isTeamLeader && reg.teamCode
      ? ` Share your team code ${reg.teamCode} with your team so they can join.`
      : '';

  const handleRegisterConfirm = async (team?: TeamRegistrationOptions) => {
    setActionLoading(true);
    try {
      const reg = await registrationsService.register(event, team);
      setRegistration(reg);
      setEvent((prev) => (prev ? { ...prev, registeredCount: prev.registeredCount + 1 } : null));
      setConfirmRegisterOpen(false);
      toast({
        type: 'success',
        title: team?.participationType === 'team' ? 'Team Created!' : 'Registration Confirmed!',
        description: `Your ticket code is ${reg.ticketCode}. View it anytime in My Registrations.${leaderTeamCodeLine(reg)}`,
      });
    } catch (err: unknown) {
      toast({
        type: 'error',
        title: 'Registration failed',
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setActionLoading(false);
    }
  };

  // Team modal's Continue button. Individual: straight to the
  // payment / confirm step. Team create: the leader registers (and
  // pays, for paid events) — the server generates the team code.
  // Team join is a separate button (handleTeamJoin): no payment.
  const handleTeamContinue = () => {
    if (!event) return;
    if (teamParticipationType === 'individual') {
      setTeamModalOpen(false);
      if (teamModalTarget === 'paid') setPaymentOpen(true);
      else setConfirmRegisterOpen(true);
      return;
    }
    const size = Math.min(maxTeamSize, Math.max(minTeamSize, teamSize));
    const opts: TeamRegistrationOptions = { participationType: 'team', teamAction: 'create', teamSize: size };
    setTeamModalOpen(false);
    if (teamModalTarget === 'paid') {
      setTeamOpts(opts);
      setPaymentOpen(true);
      return;
    }
    void handleRegisterConfirm(opts);
  };

  // Team modal's Join button: the member joins with the leader's
  // code and is confirmed immediately — no payment step, the leader
  // already paid. Server errors (bad code, leader not paid yet, team
  // full) show inside the modal so the code can be corrected.
  const handleTeamJoin = async () => {
    if (!event) return;
    setTeamError('');
    setActionLoading(true);
    try {
      const reg = await registrationsService.joinTeam(event, teamCodeInput);
      setRegistration(reg);
      setEvent((prev) => (prev ? { ...prev, registeredCount: prev.registeredCount + 1 } : null));
      setTeamModalOpen(false);
      toast({
        type: 'success',
        title: 'You joined the team!',
        description: `Your ticket code is ${reg.ticketCode}. View it anytime in My Registrations.`,
      });
    } catch (err: unknown) {
      setTeamError(err instanceof Error ? err.message : 'Could not join the team. Please try again.');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyTeamCode = () => {
    if (!registration?.teamCode) return;
    navigator.clipboard.writeText(registration.teamCode);
    setCopiedTeamCode(true);
    setTimeout(() => setCopiedTeamCode(false), 2000);
  };



  // Razorpay Standard Checkout: the pass is issued automatically, but
  // ONLY after the server verifies the payment (signature + captured
  // payment from Razorpay itself). The checkout success callback alone
  // never issues a pass — handleRazorpayPay always calls verify first.
  // Dismissing the modal or a failed payment leaves the registration
  // pending, so the attendee can retry or fall back to manual UPI.
  const handleRazorpayPay = async (team?: TeamRegistrationOptions) => {
    if (!event) return;
    setRazorpayError('');
    setActionLoading(true);
    try {
      // Reuse the shared pending registration if one already exists
      // (e.g. created on another device); otherwise create a Razorpay
      // pending row. Never create a second pending row for this user.
      let reg = registration && registration.status === 'pending' ? registration : null;
      if (!reg) {
        reg = await registrationsService.registerWithRazorpay(event, team);
        setRegistration(reg);
      }
      const order = await paymentsService.createOrder(reg.id);
      if (order.alreadyPaid) {
        // Payment was captured but verify never completed (browser
        // closed, network drop): recover server-side, no checkout.
        const result = await paymentsService.verifyPayment({
          registrationId: reg.id,
          razorpay_order_id: order.order_id,
        });
        if (result.success) {
          const updated = await registrationsService.getRegistrationForEvent(event.id);
          if (updated) setRegistration(updated);
          setEvent((prev) => (prev ? { ...prev, registeredCount: prev.registeredCount + 1 } : null));
          setPaymentOpen(false);
          toast({
            type: 'success',
            title: 'Payment confirmed!',
            description: `Your ticket code is ${result.ticketCode}. View it anytime in My Registrations.${leaderTeamCodeLine(updated)}`,
          });
        } else {
          // Previously the Pay button stayed stuck loading here with no
          // message: the recovery finished without a pass and the
          // loading flag was never cleared.
          setRazorpayError('Payment could not be recovered. If money was deducted, contact the organizer with your order ID.');
        }
        setActionLoading(false);
        return;
      }
      const user = authService.getCurrentUser();
      await paymentsService.openCheckout({
        order,
        eventTitle: event.title,
        attendeeName: user?.name,
        attendeeEmail: user?.email,
        attendeePhone: user?.phone,
        onSuccess: async (response) => {
          try {
            const result = await paymentsService.verifyPayment({
              registrationId: reg!.id,
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            if (result.success) {
              const updated = await registrationsService.getRegistrationForEvent(event.id);
              if (updated) setRegistration(updated);
              setEvent((prev) => (prev ? { ...prev, registeredCount: prev.registeredCount + 1 } : null));
              setPaymentOpen(false);
              toast({
                type: 'success',
                title: 'Payment confirmed!',
                description: `Your ticket code is ${result.ticketCode}. View it anytime in My Registrations.${leaderTeamCodeLine(updated)}`,
              });
            }
          } catch (err: unknown) {
            setRazorpayError(
              err instanceof Error
                ? err.message
                : 'Payment verification failed. If money was deducted, contact the organizer with your payment ID.',
            );
          } finally {
            setActionLoading(false);
          }
        },
        onDismiss: () => {
          setActionLoading(false);
          toast({
            type: 'info',
            title: 'Payment cancelled',
            description: 'Your registration is still pending — you can try again with the Pay Now button.',
          });
        },
        onError: (message) => {
          setActionLoading(false);
          setRazorpayError(message);
        },
      });
    } catch (err: unknown) {
      setActionLoading(false);
      setRazorpayError(
        err instanceof Error
          ? err.message
          : 'Could not start Razorpay payment. Please try again.',
      );
    }
  };

  const handleCancelConfirm = async () => {
    if (!registration) return;
    setActionLoading(true);
    try {
      const cancelled = await registrationsService.cancelRegistration(registration.id);
      // Only a held slot frees a count: confirmed passes always hold
      // one; pending payments hold one only if they predate holdsSpot.
      const heldSpot =
        registration.status === 'confirmed' ||
        (registration.status === 'pending' && registration.holdsSpot !== false);
      setRegistration(null);
      if (heldSpot) {
        setEvent((prev) => (prev ? { ...prev, registeredCount: Math.max(0, prev.registeredCount - 1) } : null));
      }
      setConfirmCancelOpen(false);
      // The cancelled row carries the refund the server actually
      // initiated (refundAmountPaise / refundStatus) — state it, don't
      // guess: a failed Razorpay call means the organizer must refund
      // manually from the dashboard.
      const refundPaise = cancelled?.refundAmountPaise;
      const refundFailed = cancelled?.refundStatus === 'failed';
      toast({
        type: 'info',
        title: 'Registration Cancelled',
        description: refundPaise
          ? refundFailed
            ? `Your ticket is cancelled. The refund of ${formatPaise(refundPaise)} could not be initiated automatically — please contact the organizer so they can refund it from the Razorpay dashboard.`
            : `Your ticket is cancelled. A refund of ${formatPaise(refundPaise)} has been initiated to your original payment method.`
          : heldSpot
            ? 'Your spot has been freed up for other community members.'
            : 'Your pending payment request has been withdrawn.',
      });
    } catch {
      toast({
        type: 'error',
        title: 'Cancellation failed',
      });
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-10">
      {/* Back Link */}
      <Link
        to="/discover"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#5F635D] hover:text-[#1E2320] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to events</span>
      </Link>

      {/* Main Cover Banner */}
      <div className="relative rounded-2xl overflow-hidden aspect-[16/9] sm:aspect-[21/9] bg-[#1E2320] shadow-md border border-[#E5E1D8]">
        <img
          src={event.coverImage}
          alt={event.title}
          referrerPolicy="no-referrer"
          decoding="async"
          fetchPriority="high"
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-[#1E2320]/80 via-transparent to-transparent" />

        {/* Floating Top Buttons */}
        <div className="absolute top-4 right-4 flex items-center gap-2">
          <button
            type="button"
            onClick={handleToggleBookmark}
            className="p-2.5 rounded-lg bg-white/95 hover:bg-white text-[#1E2320] hover:text-[#1E3F35] shadow-xs backdrop-blur-xs transition-colors"
            aria-label={isSaved ? 'Remove from saved' : 'Save event'}
          >
            <Bookmark className={`w-4 h-4 ${isSaved ? 'fill-[#1E3F35] text-[#1E3F35]' : ''}`} />
          </button>
          <button
            type="button"
            onClick={() => setShareModalOpen(true)}
            className="p-2.5 rounded-lg bg-white/95 hover:bg-white text-[#1E2320] hover:text-[#1E3F35] shadow-xs backdrop-blur-xs transition-colors"
            aria-label="Share event"
          >
            <Share2 className="w-4 h-4" />
          </button>
        </div>

        {/* Bottom Title Metadata Bar */}
        <div className="absolute bottom-4 left-4 right-4 text-white">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#A3D9C9] mb-1">
            <span>{event.category}</span>
            {formatEventLocation(event) && (
              <>
                <span aria-hidden="true">·</span>
                <span>{formatEventLocation(event)}</span>
              </>
            )}
          </div>
          <h1 className="font-editorial text-2xl sm:text-4xl font-bold tracking-tight text-white leading-tight">
            {event.title}
          </h1>
        </div>
      </div>

      {/* Split Grid: Details & Registration Card */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column (8 cols): Description & Details */}
        <div className="lg:col-span-8 space-y-8">
          {/* Quick Info Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5 bg-white rounded-xl border border-[#E5E1D8]">
            <div className="flex items-start gap-3">
              <Calendar className="w-5 h-5 text-[#1E3F35] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-[#1E2320]">Date</p>
                <p className="text-xs text-[#5F635D] mt-0.5">{formatEventDate(event.startDate)}</p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Clock className="w-5 h-5 text-[#1E3F35] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-[#1E2320]">Time</p>
                <p className="text-xs text-[#5F635D] mt-0.5">
                  {formatEventTimeRange(event.startDate, event.endDate)}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 sm:col-span-2 pt-2 border-t border-[#EBE7DF]">
              <MapPin className="w-5 h-5 text-[#1E3F35] shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-[#1E2320]">{event.venueName}</p>
                  <a
                    href={event.mapUrl || getMapsSearchUrl(event.address, event.city)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-[#1E3F35] hover:underline"
                  >
                    <span>View in Maps</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
                <p className="text-xs text-[#5F635D] mt-0.5">{event.address}</p>
              </div>
            </div>
          </div>

          {/* About Event Section */}
          <div className="space-y-4">
            <h2 className="font-editorial text-2xl font-bold text-[#1E2320]">About this event</h2>
            <div className="text-sm text-[#1E2320]/80 leading-relaxed space-y-3 whitespace-pre-line">
              {event.description}
            </div>
          </div>

          {/* Tags */}
          {event.tags && event.tags.length > 0 && (
            <div className="pt-4 border-t border-[#E5E1D8]">
              <h3 className="text-xs font-semibold text-[#8C887E] uppercase tracking-wider mb-2">
                Event Tags
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {event.tags.map((tag) => (
                  <span
                    key={tag}
                    className="px-2.5 py-1 text-xs text-[#5F635D] bg-[#F4F1EA] rounded-md border border-[#E2DFD8]"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Organizer Info Card */}
          <div className="p-6 bg-white rounded-xl border border-[#E5E1D8] space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#8C887E] uppercase tracking-wider">
                Posted by
              </span>
              <Link
                to={`/organizers/${event.organizer.slug || event.organizer.id}`}
                className="text-xs font-semibold text-[#1E3F35] hover:underline"
              >
                View full profile
              </Link>
            </div>

            <div className="flex items-center gap-4">
              <Avatar
                src={event.organizer.avatar}
                name={event.organizer.name}
                className="w-12 h-12 rounded-full object-cover shrink-0 border border-[#E5E1D8]"
                initialClassName="text-lg"
              />
              <div className="flex-1 min-w-0">
                <h3 className="font-editorial text-base font-bold text-[#1E2320] truncate">
                  {event.organizer.name}
                </h3>
                <p className="text-xs text-[#5F635D] mt-0.5 line-clamp-2">
                  {event.organizer.bio}
                </p>
              </div>
            </div>

            {/* Message the organizer: SECURITY FIX (P2-4) — the link
                is /messages?eventId=x&to=organizer, an opaque slug,
                never an email. Hidden for the event's own owner (the
                server GET is session-aware, so owners can now be
                recognised here); the server still blocks messaging
                yourself as a backstop. Guests go to sign-in first,
                like the gated View Event button. */}
            {!isOwner && (
              <Link
                to={
                  viewerEmail
                    ? `/messages?eventId=${event.id}&to=organizer`
                    : '/login'
                }
                className="flex items-center justify-center gap-2 w-full px-4 py-2.5 text-xs font-semibold text-[#1E3F35] bg-white hover:bg-[#F4F1EA] border border-[#1E3F35] rounded-lg transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                Message organizer
              </Link>
            )}
          </div>

          {/* Community Chat: one group chat per event, below the
              organizer card. Membership is enforced server-side
              (confirmed registrants + organizer + admins); everyone
              else sees a locked placeholder inside the section. The
              private "Message organizer" button above is unchanged. */}
          <CommunityChat
            eventId={event.id}
            eventTitle={event.title}
            isRegistered={isRegistered}
            isOwner={isOwner}
          />
        </div>

        {/* Right Column (4 cols): Registration Card & Status */}
        <div className="lg:col-span-4 space-y-6 lg:sticky lg:top-24">
          <div className="p-6 bg-white rounded-xl border border-[#E5E1D8] shadow-xs space-y-5">
            {/* Price & Admission */}
            <div className="flex items-baseline justify-between pb-4 border-b border-[#EBE7DF]">
              <div>
                <span className="font-editorial text-2xl font-bold text-[#1E2320] tabular-nums">
                  {formatPrice(event.price)}
                </span>
                {priceSuffix && (
                  <span className="text-xs text-[#5F635D] ml-1.5">{priceSuffix}</span>
                )}
              </div>
              <span className="text-xs text-[#5F635D]">
                {event.ageRestriction || 'All Ages'}
              </span>
            </div>

            {/* Capacity Progress Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#5F635D] font-medium">Capacity</span>
                <span className="tabular-nums font-semibold text-[#1E2320]">
                  {event.registeredCount} / {event.capacity} registered
                </span>
              </div>
              <div className="w-full h-2 bg-[#F4F1EA] rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    isFull ? 'bg-rose-500' : 'bg-[#1E3F35]'
                  }`}
                  style={{
                    width: `${Math.min(100, (event.registeredCount / event.capacity) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-[11px] text-[#5F635D]">
                {isFull ? (
                  <span className="text-rose-600 font-medium">Event reached maximum capacity</span>
                ) : (
                  <span>{spotsLeft} open spots remaining</span>
                )}
              </p>
              {pendingCount > 0 && (
                <p className="text-[11px] text-[#8C887E]">
                  {pendingCount} awaiting payment — these do not hold a spot
                </p>
              )}
            </div>

            {/* Action State: owner, dead event, registered, or open */}
            {isOwner ? (
              <div className="space-y-3 pt-2">
                <div className="p-3 bg-[#EAF1ED] border border-[#D0E2D9] rounded-lg flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-[#1E3F35] shrink-0 mt-0.5" />
                  <div className="text-xs text-[#1E3F35]">
                    <p className="font-semibold">This is your event</p>
                    <p className="text-[11px] text-[#1E3F35]/80 mt-0.5">
                      Organizers cannot register for their own event.
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link
                    to={`/organizer/events/${event.id}/attendees`}
                    className="flex-1 text-center py-2.5 px-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
                  >
                    Manage Attendees
                  </Link>
                  <Link
                    to={`/organizer/events/${event.id}/edit`}
                    className="flex-1 text-center py-2.5 px-3 text-xs font-semibold text-[#1E3F35] bg-[#EAF1ED] hover:bg-[#DCEAE3] border border-[#D0E2D9] rounded-lg transition-colors"
                  >
                    Edit Event
                  </Link>
                </div>
              </div>
            ) : isRegistered ? (
              <div className="space-y-3 pt-2">
                <div className="p-3 bg-[#EAF1ED] border border-[#D0E2D9] rounded-lg flex items-start gap-2.5">
                  <CheckCircle2 className="w-4 h-4 text-[#1E3F35] shrink-0 mt-0.5" />
                  <div className="text-xs text-[#1E3F35]">
                    <p className="font-semibold">You're registered!</p>
                    <p className="text-[11px] text-[#1E3F35]/80 mt-0.5">
                      Pass code: <span className="font-mono font-bold">{registration?.ticketCode}</span>
                    </p>
                    {/* Team leader's code, shown again after leaving
                        the page so it can be shared with the team.
                        Only the leader sees it: members joined with
                        it and never need it again. */}
                    {registration?.participationType === 'team' && registration.isTeamLeader && registration.teamCode && (
                      <p className="text-[11px] text-[#1E3F35]/80 mt-1 flex items-center gap-1.5 flex-wrap">
                        Your team code: <span className="font-mono font-bold">{registration.teamCode}</span>
                        <button
                          type="button"
                          onClick={handleCopyTeamCode}
                          className="inline-flex items-center gap-1 px-2 py-0.5 bg-white border border-[#D0E2D9] rounded-md text-[11px] font-semibold text-[#1E3F35] hover:bg-[#FAF8F5]"
                        >
                          {copiedTeamCode ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedTeamCode ? 'Copied' : 'Copy'}</span>
                        </button>
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Link
                    to="/my-registrations"
                    className="flex-1 text-center py-2.5 px-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
                  >
                    View Ticket Pass
                  </Link>
                  <button
                    type="button"
                    onClick={() => setConfirmCancelOpen(true)}
                    className="py-2.5 px-3 text-xs font-medium text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors"
                  >
                    Cancel RSVP
                  </button>
                </div>

              </div>
            ) : isPaymentPending ? (
              <div className="space-y-3 pt-2">
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5">
                  <Clock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                  <div className="text-xs text-amber-800">
                    <p className="font-semibold">Payment pending</p>
                    <p className="text-[11px] mt-0.5">
                      Your Razorpay payment is not complete yet. Pay now and your pass will be issued automatically once the payment is verified.
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPaymentOpen(true)}
                    className="flex-1 text-center py-2.5 px-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors"
                  >
                    Pay Now
                  </button>
                  <Link
                    to="/my-registrations"
                    className="flex-1 text-center py-2.5 px-3 text-xs font-semibold text-[#1E3F35] bg-[#EAF1ED] hover:bg-[#DCEAE3] border border-[#D0E2D9] rounded-lg transition-colors"
                  >
                    View Registration
                  </Link>
                  <button
                    type="button"
                    onClick={() => setConfirmCancelOpen(true)}
                    className="py-2.5 px-3 text-xs font-medium text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors"
                  >
                    Withdraw Request
                  </button>
                </div>
              </div>
            ) : isPaymentRejected ? (
              <div className="space-y-3 pt-2">
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg flex items-start gap-2.5">
                  <XCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  <div className="text-xs text-rose-700">
                    <p className="font-semibold">Payment not approved</p>
                    <p className="text-[11px] mt-0.5">
                      This payment was not approved. You can pay again with Razorpay below.
                    </p>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="button"
                    disabled={isFull}
                    onClick={() => openRegistration('paid')}
                    className={`w-full py-3 text-xs font-semibold text-white rounded-lg transition-colors shadow-xs ${
                      isFull
                        ? 'bg-slate-300 cursor-not-allowed'
                        : 'bg-[#1E3F35] hover:bg-[#163028] cursor-pointer'
                    }`}
                  >
                    {isFull ? 'Event Sold Out' : 'Pay & Register Again'}
                  </button>
                </div>
              </div>
            ) : eventStateNote ? (
              <div className="space-y-3 pt-2">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                  <div className="text-xs text-slate-600">
                    <p className="font-semibold">Registration closed</p>
                    <p className="text-[11px] mt-0.5">{eventStateNote}</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="pt-2">
                <button
                  type="button"
                  disabled={isFull}
                  onClick={() => openRegistration(isPaidEvent ? 'paid' : 'free')}
                  className={`w-full py-3 text-xs font-semibold text-white rounded-lg transition-colors shadow-xs ${
                    isFull
                      ? 'bg-slate-300 cursor-not-allowed'
                      : 'bg-[#1E3F35] hover:bg-[#163028] cursor-pointer'
                  }`}
                >
                  {isFull ? 'Event Sold Out' : isPaidEvent ? `Register · ${formatPrice(event.price)}` : 'Register for Event'}
                </button>
              </div>
            )}

            <div className="pt-2 space-y-1.5">
              <a
                href={buildGoogleCalendarTemplateUrl(event)}
                target="_blank"
                rel="noreferrer"
                className="w-full py-2.5 px-3 text-xs font-semibold text-[#1E3F35] bg-white border border-[#D0E2D9] hover:bg-[#FAF8F5] rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                <Calendar className="w-3.5 h-3.5" />
                <span>Add to Google Calendar</span>
              </a>
              <p className="text-[11px] text-[#8C887E] text-center">
                Opens Google Calendar with this event prefilled — works for
                everyone, no connection needed.
              </p>
            </div>

            <div className="pt-2 text-center">
              <p className="text-[11px] text-[#8C887E]">
                {isPaidEvent
                  ? 'Payment verified by Razorpay · Digital entry'
                  : 'Instant confirmation · No booking fees · Digital entry'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Related Events Section */}
      {relatedEvents.length > 0 && (
        <section className="pt-12 border-t border-[#E5E1D8] space-y-6">
          <h2 className="font-editorial text-2xl font-bold tracking-tight text-[#1E2320]">
            {getEventNeighborhood(event)
              ? `More Events in ${getEventNeighborhood(event)} & ${event.category}`
              : `More Events in ${event.category}`}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {relatedEvents.map((rel) => (
              <EventCard key={rel.id} event={rel} />
            ))}
          </div>
        </section>
      )}

      {/* Confirm Registration Dialog */}
      <ConfirmDialog
        isOpen={confirmRegisterOpen}
        onClose={() => setConfirmRegisterOpen(false)}
        onConfirm={handleRegisterConfirm}
        isLoading={actionLoading}
        title="Confirm Event Registration"
        message={`Would you like to register for "${event.title}" on ${formatEventDate(
          event.startDate
        )}? A digital entry ticket will be generated for your attendee profile.`}
        confirmLabel="Confirm & Get Pass"
      />

      {/* Attendee details gate (events that require details) */}
      {detailsGateOpen && event && (
        <AttendeeDetailsGate
          open={detailsGateOpen}
          eventTitle={event.title}
          organizerName={event.organizer?.name || 'the organizer'}
          onClose={() => {
            setDetailsGateOpen(false);
            setDetailsGateTarget(null);
          }}
          onProceed={() => {
            const target = detailsGateTarget;
            setDetailsGateOpen(false);
            setDetailsGateTarget(null);
            if (target) continueAfterGate(target);
          }}
        />
      )}

      {/* Confirm Cancellation Dialog */}
      <ConfirmDialog
        isOpen={confirmCancelOpen}
        onClose={() => setConfirmCancelOpen(false)}
        onConfirm={handleCancelConfirm}
        isLoading={actionLoading}
        isDestructive
        title={isPaymentPending ? 'Withdraw Payment Request' : 'Cancel Registration'}
        message={
          isPaymentPending
            ? 'Withdraw your pending payment request? Any held spot will be released for other attendees.'
            : cancelRefundMessage
        }
        confirmLabel={isPaymentPending ? 'Yes, Withdraw Request' : 'Yes, Cancel RSVP'}
      />

      {/* Payment dialog (paid events only): Razorpay Standard
          Checkout is the ONLY way to pay. The manual UPI/UTR flow
          and organizer approval were removed in full — no QR code,
          no UPI ID, no UTR field. Dismissing the checkout or a
          failed payment leaves the registration pending, so the
          attendee retries from the Pay Now button. */}
      <Modal
        isOpen={paymentOpen}
        onClose={() => {
          setPaymentOpen(false);
          setRazorpayError('');
        }}
        title="Pay & Register"
        description={`This is a paid event (${formatPrice(event.price)}). Pay securely with Razorpay — your pass is issued automatically once the payment is verified.`}
      >
        <div className="space-y-4">
          <div className="p-4 bg-[#EAF1ED] border border-[#D0E2D9] rounded-lg space-y-2">
            <p className="text-xs font-semibold text-[#1E3F35]">Pay with Razorpay — automatic pass</p>
            <p className="text-[11px] text-[#5F635D] leading-relaxed">
              Pay by UPI, card, or netbanking in the Razorpay checkout. Your pass is issued
              automatically once the payment is verified — no organizer approval needed.
            </p>
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => handleRazorpayPay(teamOpts)}
              className="w-full py-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors disabled:opacity-60"
            >
              {actionLoading ? 'Starting payment…' : `Pay ${formatPrice(event.price)} with Razorpay`}
            </button>
            {razorpayError && <p className="text-[11px] text-rose-600">{razorpayError}</p>}
          </div>
          <p className="text-[11px] text-[#5F635D] text-center leading-relaxed">
            Payments go through Razorpay to the event account. If your payment
            succeeds but no pass appears, use Pay Now again — it recovers
            the payment instead of charging you twice.
          </p>
        </div>
      </Modal>

      {/* Team participation modal (hackathons, f-1 + f-2): shown
          after the details gate, before payment / confirm. The
          leader pays once for the whole team; members join free
          with the leader's code and never see a payment step. */}
      <Modal
        isOpen={teamModalOpen}
        onClose={() => {
          setTeamModalOpen(false);
          setTeamError('');
        }}
        title="How are you registering?"
        description={
          participation?.mode === 'team'
            ? 'This hackathon is for teams only. Create a team and pay once for the whole team, or join your leader’s team with their code.'
            : 'You can register on your own or as part of a team. Team leaders pay once for the whole team; members join free with the team code.'
        }
      >
        <div className="space-y-4">
          {participation?.mode === 'both' && (
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setTeamParticipationType('individual')}
                className={`text-left p-3 rounded-xl border text-xs transition-colors ${
                  teamParticipationType === 'individual'
                    ? 'border-[#1E3F35] bg-[#EAF1ED]'
                    : 'border-[#E2DFD8] bg-white hover:border-[#1E3F35]'
                }`}
              >
                <span className="block font-semibold text-[#1E2320]">Individual</span>
                <span className="block text-[11px] text-[#5F635D] mt-0.5">
                  {event.price === 0 ? 'Free' : `${formatPrice(event.price)} per person`}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setTeamParticipationType('team')}
                className={`text-left p-3 rounded-xl border text-xs transition-colors ${
                  teamParticipationType === 'team'
                    ? 'border-[#1E3F35] bg-[#EAF1ED]'
                    : 'border-[#E2DFD8] bg-white hover:border-[#1E3F35]'
                }`}
              >
                <span className="block font-semibold text-[#1E2320]">Team</span>
                <span className="block text-[11px] text-[#5F635D] mt-0.5">
                  {event.price === 0 ? 'Free' : `${formatPrice(event.price)} per team`}
                </span>
              </button>
            </div>
          )}
          {teamParticipationType === 'team' ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTeamAction('create')}
                  className={`text-left p-3 rounded-xl border text-xs transition-colors ${
                    teamAction === 'create'
                      ? 'border-[#1E3F35] bg-[#EAF1ED]'
                      : 'border-[#E2DFD8] bg-white hover:border-[#1E3F35]'
                  }`}
                >
                  <span className="block font-semibold text-[#1E2320]">Create a team</span>
                  <span className="block text-[11px] text-[#5F635D] mt-0.5">You’re the leader — you pay</span>
                </button>
                <button
                  type="button"
                  onClick={() => setTeamAction('join')}
                  className={`text-left p-3 rounded-xl border text-xs transition-colors ${
                    teamAction === 'join'
                      ? 'border-[#1E3F35] bg-[#EAF1ED]'
                      : 'border-[#E2DFD8] bg-white hover:border-[#1E3F35]'
                  }`}
                >
                  <span className="block font-semibold text-[#1E2320]">Join a team</span>
                  <span className="block text-[11px] text-[#5F635D] mt-0.5">Free — your leader paid</span>
                </button>
              </div>
              {teamAction === 'create' ? (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                      Team size
                    </label>
                    <select
                      value={teamSize}
                      onChange={(e) => setTeamSize(Number(e.target.value))}
                      className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
                    >
                      {Array.from({ length: maxTeamSize - minTeamSize + 1 }, (_, i) => minTeamSize + i).map((n) => (
                        <option key={n} value={n}>
                          {n} {n === 1 ? 'person' : 'people'}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-[#5F635D] mt-1 leading-relaxed">
                      {event.price === 0
                        ? 'Free for the whole team. Your team code is shown after registration — share it so your team can join.'
                        : `You’ll pay ${formatPrice(event.price)} once for the whole team — members join free. Your team code is shown after registration, so share it with your team.`}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={actionLoading}
                    onClick={handleTeamContinue}
                    className="w-full py-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors disabled:opacity-60"
                  >
                    {actionLoading
                      ? 'Please wait…'
                      : teamModalTarget === 'paid'
                        ? `Continue to payment · ${formatPrice(event.price)}`
                        : 'Create team & Register'}
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                      Team code
                    </label>
                    <input
                      type="text"
                      value={teamCodeInput}
                      onChange={(e) => setTeamCodeInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                      placeholder="e.g. K7M2QX"
                      maxLength={6}
                      autoCapitalize="characters"
                      autoComplete="off"
                      className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 font-mono tracking-[0.2em] uppercase text-[#1E2320] focus:border-[#1E3F35]"
                    />
                    <p className="text-[11px] text-[#5F635D] mt-1 leading-relaxed">
                      Ask your team leader for the 6-character code. No payment — your leader has
                      already paid for the team, and they must have finished paying before you can join.
                    </p>
                  </div>
                  {teamError && <p className="text-[11px] text-rose-600">{teamError}</p>}
                  <button
                    type="button"
                    disabled={actionLoading || teamCodeInput.trim().length !== 6}
                    onClick={handleTeamJoin}
                    className="w-full py-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors disabled:opacity-60"
                  >
                    {actionLoading ? 'Joining…' : 'Join team'}
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-[11px] text-[#5F635D] leading-relaxed">
                You’ll register as an individual
                {event.price === 0 ? ' — free.' : ` — ${formatPrice(event.price)} per person.`}
              </p>
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleTeamContinue}
                className="w-full py-3 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors disabled:opacity-60"
              >
                {teamModalTarget === 'paid' ? `Continue to payment · ${formatPrice(event.price)}` : 'Continue'}
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* Share Modal */}
      <Modal
        isOpen={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        title="Share Event"
        description="Share this gathering with your neighbors and friends."
      >
        <div className="space-y-4">
          <div className="flex items-center gap-2 p-2 bg-[#F4F1EA] border border-[#E2DFD8] rounded-lg">
            <input
              type="text"
              readOnly
              value={window.location.href}
              className="flex-1 bg-transparent text-xs text-[#1E2320] border-0 focus:outline-hidden truncate"
            />
            <button
              onClick={handleCopyLink}
              className="px-3 py-1.5 bg-[#1E3F35] text-white rounded-md text-xs font-medium hover:bg-[#163028] flex items-center gap-1 shrink-0"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedLink ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
