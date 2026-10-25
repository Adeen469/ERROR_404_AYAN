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
  // Organizer's UPI ID for manual-approval payments on paid events
  // (shown to attendees at registration). Optional: without it, attendees
  // are told to pay the organizer directly and submit their UTR.
  upiId?: string;
  capacity: number;
  registeredCount: number;
  status: EventStatus;
  organizer: Organizer;
  tags: string[];
  isFeatured?: boolean;
  ageRestriction?: string;
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
  // Manual-approval payments: the 12-digit UPI reference the attendee
  // submitted with a paid registration. Empty until approval, when the
  // ticket code is issued. Only present on paid registrations.
  utr?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  avatar: string;
  bio: string;
  neighborhood: string;
  // Home location from the Country -> State -> City picker on Profile.
  country?: string;
  state?: string;
  city?: string;
  interests: EventCategory[];
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
  neighborhood?: string;
  // Worldwide location filter (Country -> State -> City, from Discover).
  country?: string;
  state?: string;
  city?: string;
  dateRange?: 'all' | 'today' | 'tomorrow' | 'this_weekend' | 'this_month';
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

