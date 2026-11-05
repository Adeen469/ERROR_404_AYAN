/**
 * Locora Core Types and Domain Models
 * Defines data structures for events, attendees, organizers, and API contracts.
 */

export type EventCategory =
  | 'Technology & Hackathons'
  | 'Workshops & Learning'
  | 'Live Music & Culture'
  | 'Fitness & Outdoors'
  | 'Food & Community'
  | 'Art & Creative'
  | 'Volunteering & Impact';

export type EventStatus = 'published' | 'draft' | 'cancelled' | 'completed';

export type RegistrationStatus = 'confirmed' | 'waitlist' | 'cancelled' | 'pending' | 'rejected';

export interface Organizer {
  id: string;
  name: string;
  slug: string;
  avatar: string;
  bio: string;
  website?: string;
  email: string;
  location: string;
  eventsCount: number;
  totalAttendeesServed: number;
}

export type ParticipationMode = 'individual' | 'team' | 'both';

// Team participation for Technology & Hackathons events (f-1 + f-2).
// The organizer picks the mode while creating the event: attendees
// register as individuals only, as teams only, or either. In team
// mode the leader registers and pays once; members join free with
// the leader's team code (see api/registrations.ts). minTeamSize /
// maxTeamSize bound the team size the attendee picks (2..10).
export interface EventParticipation {
  mode: ParticipationMode;
  minTeamSize: number;
  maxTeamSize: number;
}

// Category registration options (Workshops & Learning, Live Music &
// Culture): the organizer defines choices per group; the attendee
// picks one per group at registration. extraPrice is added to the
// event base price (₹, integer >= 0); cap limits how many attendees
// may take that choice (undefined = unlimited). Labels are unique
// within a group, so a label identifies the choice.
export interface EventOptionChoice {
  label: string;
  extraPrice: number;
  cap?: number;
}
export type EventOptions = Record<string, EventOptionChoice[]>;
export type RegistrationSelections = Record<string, string>;

export interface EventItem {
  id: string;
  title: string;
  slug: string;
  description: string;
  summary: string;
  category: EventCategory;
  coverImage: string;
  startDate: string; // ISO String (e.g. '2026-11-14T18:30:00Z')
  endDate: string;   // ISO String
  venueName: string;
  address: string;
  // Organizer-pasted map link (e.g. a Google Maps share link). When
  // present, the details page "View in Maps" opens this exact location;
  // when absent it falls back to a Maps search for the street address.
  mapUrl?: string;
  // Legacy stored value, kept for old records. Never displayed or
  // filtered on: the neighborhood is derived — the city when a state is
  // selected, otherwise none (see getEventNeighborhood in formatters).
  neighborhood: string;
  city: string;
  // Worldwide location, set by the Country -> State -> City picker on the
  // create page. Older events predate this and may not carry them.
  state?: string;
  country?: string;
  // Ownership key: the creator's email, stamped at creation. Only this
  // user (or an admin) may edit or delete the event. Older events predate
  // this field and fall back to their organizer's email for ownership.
  createdByEmail?: string;
  price: number; // 0 for free
  // Legacy only: organizer's UPI ID from the old manual-payment flow.
  // No new event collects one, and nothing in the UI reads it anymore.
  // Kept so old stored rows still parse.
  upiId?: string;
  // Attendee details gate: when true (or absent — older events predate
  // this flag), registering requires the attendee's name, mobile number
  // and email, plus a per-registration confirmation that those details
  // are shared with the organizer only. When false, registration needs
  // no details at all. Set on the create/edit forms.
  requireAttendeeDetails?: boolean;
  // Team participation config (Technology & Hackathons only; see
  // EventParticipation). Absent on older events and every other
  // category — those are individual-only. Never sent in ?slim=1 lists.
  participation?: EventParticipation;
  // Category registration options (Workshops & Learning, Live Music &
  // Culture only; see EventOptions). Absent on older events and every
  // other category — those behave exactly as before. Never sent in
  // ?slim=1 lists.
  options?: EventOptions;
  capacity: number;
  registeredCount: number;
  status: EventStatus;
  organizer: Organizer;
  tags: string[];
  isFeatured?: boolean;
  ageRestriction?: string;
  // Local-only marker (never stored on the server): the event was saved
  // in this browser because the shared API was unreachable, and is
  // queued to upload. Stripped before any server POST/PATCH.
  _pendingSync?: boolean;
}

export interface AttendeeRegistration {
  id: string;
  eventId: string;
  event: EventItem;
  userId: string;
  userName: string;
  userEmail: string;
  status: RegistrationStatus;
  registeredAt: string;
  ticketCode: string;
  checkedIn: boolean;
  // Legacy only: the 12-digit UPI reference from the old
  // manual-payment flow. No new registration collects one.
  // Kept so old stored rows still parse.
  utr?: string;
  // Attendee contact details, shared with the organizer only, for
  // events that require them (see EventItem.requireAttendeeDetails).
  // Only present on registrations made after the details gate.
  userPhone?: string;
  // True when the server confirmed, at registration time, that a
  // Telegram-verified row matches this registration's email + phone
  // (api/registrations.ts). A client-sent value is never trusted: the
  // server overwrites it from the verification rows.
  phoneVerified?: boolean;
  // Slot accounting: pending registrations created BEFORE this flag
  // existed held a spot (registeredCount +1 at payment time). Those
  // rows predate the flag and are treated as holding one. New pending
  // registrations set holdsSpot: false: they hold NO slot while the
  // organizer decides, so a rejected request never blocked a spot.
  // Approval of a holdsSpot: false registration takes a slot (+1),
  // guarded by capacity; approval of a legacy one does not.
  holdsSpot?: boolean;
  // Razorpay Standard Checkout payments. 'manual' is the original
  // UPI/UTR flow (or absent on older rows); 'razorpay' rows are
  // confirmed automatically by api/payments.ts on verified payment,
  // never by organizer approval. 'team' rows are members who joined
  // a leader-paid team with a team code: confirmed immediately, no
  // payment of their own, amountPaise 0 (see participationType /
  // teamCode below). The order id is stored on the pending row so verify can bind the payment to exactly this registration;
  // the payment id is stored on confirmation. Neither field is ever
  // set from an unverified client claim.
  paymentMethod?: 'manual' | 'razorpay' | 'team';
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  // Price snapshot at payment time, in paise (server-set from the
  // stored event price — never from a client claim), shown to the
  // organizer on pending rows so approval can check the amount paid.
  amountPaise?: number;
  currency?: string;
  // Refund bookkeeping for cancelled Razorpay rows (server-set):
  // 'initiated' with a refund id means Razorpay accepted the refund,
  // 'failed' means the organizer must refund manually from the
  // Razorpay dashboard; absent means no refund was attempted.
  // refundAmountPaise is the amount actually requested from Razorpay
  // (full price within 24h of purchase, 90% after that) and
  // refundFeePaise is the 10% cancellation fee kept after 24h (0
  // within 24h). paidAt is set by api/payments.ts when the payment
  // is verified — it is the anchor for the 24h refund window.
  refundStatus?: 'initiated' | 'failed';
  refundId?: string;
  refundAmountPaise?: number;
  refundFeePaise?: number;
  paidAt?: string;
  // Team participation (Technology & Hackathons only, server-set —
  // a client-sent value is never trusted, see api/registrations.ts).
  // 'team' rows belong to one team: teamCode is the leader-generated
  // 6-character code, teamSize is the size the leader picked, and
  // isTeamLeader marks the one registration that paid for the team.
  // Members join with the code and are confirmed immediately with
  // paymentMethod 'team' and amountPaise 0 — only the leader pays.
  participationType?: 'individual' | 'team';
  teamCode?: string;
  teamSize?: number;
  isTeamLeader?: boolean;
  // Category registration options (server-set — a client-sent value
  // is never trusted, see api/registrations.ts). groupKey -> the
  // label of the choice the attendee picked; labels are unique per
  // group, so a label identifies the choice. The amountPaise snapshot
  // on the row already includes the chosen extras.
  selections?: RegistrationSelections;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  // Mobile number, collected once via the attendee details gate before
  // the first registration for an event that requires details, then
  // reused (with a per-registration sharing confirmation). Never
  // displayed publicly; shared with the event organizer only.
  phone?: string;
  // Free Telegram verification (see api/telegram-verify.ts): true once
  // the user shared, via the bot, a Telegram-verified number matching
  // this profile number. Changing the number resets it to false.
  // Note: this flag itself is set from the browser after polling, so
  // in this app's session model it is a display flag; the registration
  // badge is the server-attested one (api/registrations.ts checks the
  // verification rows before stamping it).
  phoneVerified?: boolean;
  avatar: string;
  bio: string;
  // Legacy: the home-neighborhood field is retired. Home location is
  // country/state/city; the neighborhood, where needed, is the city
  // when a state is selected, otherwise none.
  neighborhood: string;
  // Home location from the Country -> State -> City picker on Profile.
  country?: string;
  state?: string;
  city?: string;
  // Interest categories: the 7 presets plus any custom ones the user
  // adds on Profile. Plain strings (not EventCategory) so a custom
  // interest is a first-class value everywhere — SmartMatch, the saved
  // profile, and the server-side recommendation match.
  interests: string[];
  role: 'attendee' | 'organizer' | 'admin';
  // How this account's email was verified: 'google' for Google sign-in
  // (email verified by Google), 'local' for the local password fallback.
  // Admin status is only trusted for Google-signed-in accounts.
  authProvider?: 'google' | 'local';
  createdAt: string;
}

export interface SmartMatchResult {
  event: EventItem;
  score: number; // 0 - 100
  matchReasons: string[];
}

export interface EventFilterOptions {
  query?: string;
  category?: string;
  // Worldwide location filter (Country -> State -> City, from Discover).
  country?: string;
  state?: string;
  city?: string;
  dateRange?: 'all' | 'today' | 'tomorrow' | 'this_weekend' | 'this_month' | 'custom';
  // Custom calendar range (Discover date picker). Only meaningful when
  // dateRange is 'custom'; both are local calendar dates (YYYY-MM-DD).
  // Empty means no custom range.
  startDate?: string;
  endDate?: string;
  priceType?: 'all' | 'free' | 'paid';
  sortBy?: 'soonest' | 'relevance' | 'capacity';
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
}

