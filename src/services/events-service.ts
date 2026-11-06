// the session-only /events?payment=1 endpoint; adjustRegisteredCount()
// is now a cache-clear no-op because counts are owned server-side by
// api/registrations.ts (direct count PATCHes are refused with 403).
import { EventFilterOptions, EventItem, PaginatedResponse } from '../types';
import { DEMO_EVENTS } from '../mocks/demo-data';
import { apiClient, isDemoMode } from './api-client';
import {
  addPendingOp,
  applyPendingToPage,
  flushPendingOps,
  getPendingOps,
} from './pending-events';
import { authService } from './auth-service';
import { getEventNeighborhood } from '../utils/formatters';
import { eventDay } from '../utils/date-range';

// Short-lived cache for shared event reads. Measured 2026-10-25:
// every shared API call costs ~2s (five rapid calls to a tiny endpoint all
// took ~2s, so this is per-call latency, not cold starts). Without a cache,
// every navigation (Discover -> details -> back) and every page that
// fetches the same event twice pays that cost again as skeleton time.
// Entries live 60s; in-flight requests are shared, so parallel callers
// for the same data make one request, not several stacked 2s calls.
// The cache is mirrored to sessionStorage so a full reload (which wipes
// in-memory state) still comes back instantly within the TTL.
// Mutations clear the cache (see create/update/delete/adjust below).
const EVENTS_CACHE_TTL_MS = 60_000;
const eventsCache = new Map<string, { at: number; promise: Promise<unknown> }>();
const SS_PREFIX = 'locora-events-cache:';

function ssGet(key: string): { at: number; value: unknown } | null {
  try {
    const raw = sessionStorage.getItem(SS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.at === 'number' && 'value' in parsed) return parsed;
    return null;
  } catch {
    return null;
  }
}

function ssSet(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(SS_PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // Private mode or quota: the in-memory cache still works.
  }
}

function ssClear(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(SS_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // Ignore.
  }
}

function cacheKey(parts: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parts)) {
    if (v !== undefined && v !== null && v !== '') cleaned[k] = v;
  }
  return JSON.stringify(cleaned);
}

function cachedFetch<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
  const hit = eventsCache.get(key);
  if (hit && Date.now() - hit.at < EVENTS_CACHE_TTL_MS) return hit.promise as Promise<T>;
  // A previous visit in this tab may have persisted the value.
  const ss = ssGet(key);
  if (ss && Date.now() - ss.at < EVENTS_CACHE_TTL_MS) {
    const resolved = Promise.resolve(ss.value as T);
    eventsCache.set(key, { at: ss.at, promise: resolved });
    return resolved;
  }
  const promise = fetchFn();
  eventsCache.set(key, { at: Date.now(), promise });
  // Failures must not stick as rejected promises: drop the memory entry
  // so the next call retries. Callers already fall back to the local
  // store on failure. Persisted values simply age out via the TTL.
  promise.then((v) => ssSet(key, v)).catch(() => {
    if (eventsCache.get(key)?.promise === promise) eventsCache.delete(key);
  });
  return promise;
}

function clearEventsCache(): void {
  eventsCache.clear();
  ssClear();
}

// Pending-sync flush (see pending-events.ts). Runs in the background
// after any successful shared read: the server answered, so anything this
// browser saved locally while it was down gets a chance to upload. The
// browser sends the user's session cookie automatically on these
// same-origin calls, so a signed-in organizer's ops succeed once the
// server accepts writes again. Overlapping runs are guarded; failures
// simply leave ops pending for the next successful read.
let flushInFlight = false;

// Whether the most recent getEvents list came from this browser's local
// store because the shared API failed (demo mode excluded: there the
// local store is the intended source). Discover reads this to explain
// why its results can differ from another device's.
let lastListFromLocal = false;

async function flushPending(): Promise<void> {
  if (isDemoMode() || flushInFlight) return;
  flushInFlight = true;
  try {
    const { flushed } = await flushPendingOps(
      localStorage,
      apiClient,
      authService.getCurrentUser()?.email,
    );
    if (flushed.length > 0) {
      // Flushed events stop being "pending" in the local copy too, so a
      // later offline fallback doesn't show them as waiting to sync.
      const events = getStoredEvents();
      let changed = false;
      const cleaned = events.map((e) => {
        if (e._pendingSync && flushed.includes(e.id)) {
          changed = true;
          const { _pendingSync, ...rest } = e;
          return rest;
        }
        return e;
      });
      if (changed) saveStoredEvents(cleaned);
      clearEventsCache();
    }
  } catch {
    // Flush failures leave ops pending; the next successful read retries.
  } finally {
    flushInFlight = false;
  }
}

// Ownership rules for event management — the permission matrix:
// - Edit event details: the event's OWNER only. Admins explicitly cannot
//   edit another organizer's event details.
// - Delete, publish/unpublish, attendees/check-in: the owner OR an admin.
// - Any other organizer: none of the above.
// The owner is the creator's email (createdByEmail, stamped at creation).
// Events created before createdByEmail existed fall back to the
// organizer's email, so legacy events are still owned by whoever their
// organizer record names.
// This is enforced in the app only: the shared API has no session auth,
// so it cannot verify who is calling it.
export function isEventOwner(
  event: EventItem,
  userEmail: string | undefined | null,
): boolean {
  if (!userEmail) return false;
  const email = userEmail.trim().toLowerCase();
  if (event.createdByEmail) {
    return event.createdByEmail.trim().toLowerCase() === email;
  }
  return (event.organizer?.email || '').trim().toLowerCase() === email;
}

export function canManageEvent(
  event: EventItem,
  userEmail: string | undefined | null,
  isAdmin = false,
): boolean {
  return isAdmin || isEventOwner(event, userEmail);
}

export interface OwnershipOptions {
  ownerEmail?: string;
  isAdmin?: boolean;
  // Whether an admin may perform this operation. Delete and status
  // changes allow admins; detail edits do not.
  allowAdmin?: boolean;
}

// Cover images live in src/assets/images. They must be imported so Vite
// bundles them into dist/ for production. A plain src/ URL
// string only works in Vite dev (via vite.middlewares) and 404s in a
// production build, which is why the cards showed broken images.
import heroGatheringImg from '../assets/images/hero_neighborhood_gathering_1792850960020.jpg';
import techHackathonImg from '../assets/images/event_tech_hackathon_1792850960780.jpg';
import farmersMarketImg from '../assets/images/event_farmers_market_1792850961672.jpg';
import acousticMusicImg from '../assets/images/event_acoustic_music_1792850962324.jpg';
import morningYogaImg from '../assets/images/event_morning_yoga_1792850962615.jpg';

const STORAGE_KEY = 'locora_events_db';

// Sample events removed from the app. Any copy already saved in a
// returning visitor's browser is filtered out here, so Discover does
// not keep showing them after the code change.
const SAMPLE_EVENT_IDS = new Set(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6', 'evt-7', 'evt-8']);

// Map an old cover-image filename to its Vite-bundled URL.
//
// Browsers that visited the site before the image fix have events saved
// in localStorage with the old '/src/assets/images/...' URLs, which 404
// in production. Without this migration those saved events would keep
// showing broken thumbnails forever, even though new code uses bundled
// images. New events already use the bundled URLs, so they are untouched.
const BUNDLED_COVER_BY_FILENAME: Record<string, string> = {
  'hero_neighborhood_gathering_1792850960020.jpg': heroGatheringImg,
  'event_tech_hackathon_1792850960780.jpg': techHackathonImg,
  'event_farmers_market_1792850961672.jpg': farmersMarketImg,
  'event_acoustic_music_1792850962324.jpg': acousticMusicImg,
  'event_morning_yoga_1792850962615.jpg': morningYogaImg,
};

function migrateCoverImage(coverImage: string | undefined): string | undefined {
  if (!coverImage) return coverImage;
  const filename = coverImage.split('/').pop() || '';
  // Exact known filename (legacy '/src/assets/...' dev paths and any
  // already-current reference): map straight to the bundled URL.
  if (BUNDLED_COVER_BY_FILENAME[filename]) return BUNDLED_COVER_BY_FILENAME[filename];
  // Stale PRODUCTION asset path: '/assets/<name>-<buildhash>.<ext>'.
  // The hash is content-derived, so any rebuild that changes the
  // image (e.g. the 2026-11-06 recompression) renames the file and
  // the stored URL stops resolving — the server answers with the SPA
  // fallback HTML, the <img> cannot decode it, and the card falls
  // back to the category placeholder. Strip the hash and retry the
  // lookup by the stable filename.
  const stripped = filename.replace(/-[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9]+)$/, '$1');
  if (stripped !== filename && BUNDLED_COVER_BY_FILENAME[stripped]) {
    return BUNDLED_COVER_BY_FILENAME[stripped];
  }
  return coverImage;
}

// One event with its cover run through migrateCoverImage. Applied to
// API-fed events too (getEvents / getEventById): a cover stored in
// Supabase by an older build keeps its stale asset path forever
// unless the client resolves it at read time, like the localStorage
// migration below does for locally saved events.
function withMigratedCover<T extends { coverImage?: string }>(event: T): T {
  if (!event || typeof event.coverImage !== 'string') return event;
  const fixed = migrateCoverImage(event.coverImage);
  return fixed && fixed !== event.coverImage ? { ...event, coverImage: fixed } : event;
}

function getStoredEvents(): EventItem[] {
  // L9 (audit #4): demo events are dev-only now. The local store used
  // to seed itself with DEMO_EVENTS on first run, so a production user
  // with an empty store saw eight fake events presented as real ones.
  // Seeding happens only with VITE_USE_MOCK_API=true (isDemoMode);
  // in production an empty store is just empty.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      if (!isDemoMode()) return [];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(DEMO_EVENTS));
      return DEMO_EVENTS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return isDemoMode() ? DEMO_EVENTS : [];
    let changed = false;
    const migrated = parsed.map((event: EventItem) => {
      const fixed = migrateCoverImage(event.coverImage);
      if (fixed && fixed !== event.coverImage) {
        changed = true;
        return { ...event, coverImage: fixed };
      }
      return event;
    });
    // Persist the migration once, so the next load is already clean.
    const withoutSamples = migrated.filter((event: EventItem) => !SAMPLE_EVENT_IDS.has(event.id));
    if (withoutSamples.length !== migrated.length) {
      changed = true;
    }
    if (changed) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(withoutSamples));
      } catch {
        // If storage is full/blocked, still return the filtered list.
      }
    }
    return withoutSamples;
  } catch {
    // A corrupt store reads as empty in production; demo mode keeps
    // the old behaviour of falling back to the sample events.
    return isDemoMode() ? DEMO_EVENTS : [];
  }
}

function saveStoredEvents(events: EventItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch (err) {
    console.error('Failed to save events to local storage:', err);
  }
}

export const eventsService = {
  async getEvents(filters: EventFilterOptions = {}, page = 1, pageSize = 12, opts: { slim?: boolean } = {}): Promise<PaginatedResponse<EventItem>> {
    if (!isDemoMode()) {
      try {
        // Cache keys are viewer-aware: the server now returns ownership
        // fields only to the event's owner/admin, so a list cached as a
        // guest (stripped) must never serve a signed-in owner after
        // login, and one owner's list must never serve another account
        // on the same browser. Stale entries simply age out (60s TTL).
        // The slim flag is part of the key: a slim card row must never
        // serve a caller that expects the full record.
        const viewer = authService.getCurrentUser()?.email?.trim().toLowerCase() || 'guest';
        const shared = await cachedFetch(
          `list:${viewer}:${cacheKey({ ...filters, page, pageSize, slim: opts.slim ? 1 : undefined })}`,
          () => apiClient.get<PaginatedResponse<EventItem>>('/events', {
            ...filters,
            page,
            pageSize,
            slim: opts.slim ? 1 : undefined,
          }),
        );
        // The server answered, so anything this browser saved locally
        // while it was down gets a chance to upload now (background).
        lastListFromLocal = false;
        void flushPending();
        // Covers stored by older builds can carry stale bundled-asset
        // paths (see migrateCoverImage) — resolve them at read time.
        const migratedPage: PaginatedResponse<EventItem> = {
          ...shared,
          data: (shared.data || []).map((e) => withMigratedCover(e)),
        };
        // Pending ops overlay the default first page only, flagged, so a
        // not-yet-synced event never vanishes from its creator's view.
        return applyPendingToPage(migratedPage, page, filters, getPendingOps(localStorage));
      } catch (err) {
        lastListFromLocal = true;
        console.warn('Backend API /events unavailable, falling back to local events store:', err);
      }
    }

    // Simulated network delay for authentic UI states
    await new Promise((resolve) => setTimeout(resolve, 150));

    let events = getStoredEvents();

    // Query filter (searches title, description, venueName, tags)
    if (filters.query?.trim()) {
      const q = filters.query.toLowerCase().trim();
      events = events.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.summary.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.venueName.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    // Category filter
    if (filters.category && filters.category !== 'All' && filters.category !== 'All Categories') {
      events = events.filter((e) => e.category === filters.category);
    }

    // Worldwide location filter (Country -> State -> City). A set filter
    // matches only events that actually carry that value (case-insensitive);
    // older events without a country/state do not match a filtered region,
    // so browsing a country never shows placeless legacy events.
    const locEq = (eventValue: string | undefined, filterValue: string | undefined) =>
      !!filterValue?.trim() &&
      !!eventValue &&
      eventValue.trim().toLowerCase() === filterValue.trim().toLowerCase();
    if (filters.country?.trim()) {
      events = events.filter((e) => locEq(e.country, filters.country));
    }
    if (filters.state?.trim()) {
      events = events.filter((e) => locEq(e.state, filters.state));
    }
    if (filters.city?.trim()) {
      events = events.filter((e) => locEq(e.city, filters.city));
    }

    // Price type
    if (filters.priceType === 'free') {
      events = events.filter((e) => e.price === 0);
    } else if (filters.priceType === 'paid') {
      events = events.filter((e) => e.price > 0);
    }

    // Date range filtering
    if (filters.dateRange && filters.dateRange !== 'all') {
      const now = new Date();
      events = events.filter((e) => {
        const eventDate = new Date(e.startDate);
        if (filters.dateRange === 'today') {
          return (
            eventDate.getDate() === now.getDate() &&
            eventDate.getMonth() === now.getMonth() &&
            eventDate.getFullYear() === now.getFullYear()
          );
        }
        if (filters.dateRange === 'this_weekend') {
          const day = eventDate.getDay();
          return day === 0 || day === 6; // Saturday or Sunday
        }
        if (filters.dateRange === 'this_month') {
          return eventDate.getMonth() === now.getMonth() && eventDate.getFullYear() === now.getFullYear();
        }
        if (filters.dateRange === 'custom') {
          // Incomplete range (shouldn't happen — the picker only sets
          // 'custom' with both dates) filters nothing, rather than
          // hiding everything.
          if (!filters.startDate || !filters.endDate) return true;
          const day = eventDay(e.startDate);
          return day >= filters.startDate && day <= filters.endDate;
        }
        return true;
      });
    }

    // Sorting
    if (filters.sortBy === 'soonest') {
      events.sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
    } else if (filters.sortBy === 'capacity') {
      events.sort((a, b) => (b.capacity - b.registeredCount) - (a.capacity - a.registeredCount));
    } else {
      // Default: featured first, then soonest
      events.sort((a, b) => {
        if (a.isFeatured && !b.isFeatured) return -1;
        if (!a.isFeatured && b.isFeatured) return 1;
        return new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
      });
    }

    const total = events.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const offset = (page - 1) * pageSize;
    const paginated = events.slice(offset, offset + pageSize);

    return {
      data: paginated,
      total,
      page,
      pageSize,
      totalPages,
    };
  },

  // H11: `strict` mode distinguishes a LOAD FAILURE from a genuinely
  // missing event. The default (non-strict) path swallows remote
  // failures into the local-store fallback and returns null — which
  // made every details page show "Event Not Found" when the API was
  // down. Strict callers (EventDetailsPage) get the error rethrown
  // when the remote fetch fails AND no local copy exists, so the page
  // can show an error state with Retry instead. A 404 from the API
  // is still a genuine "not found" (null, no throw), and a local
  // copy still renders (stale beats missing). Non-strict callers
  // (AttendeesPage, EditEventPage, prefetch) are untouched.
  async getEventById(id: string, opts?: { strict?: boolean }): Promise<EventItem | null> {
    if (!isDemoMode()) {
      try {
        // Single events go through /events?id=<id> on the shared list
        // endpoint, NOT /events/<id>: the dynamic api/events/[id].ts
        // route was never reached on Vercel (it came back as the SPA's
        // HTML 404 page), which made every details page show
        // "Event Not Found" even though the event listed fine on
        // Discover. Fall back to the local store only if that fails too.
        // Same viewer-aware rule as getEvents: a single event cached as
        // a guest (stripped) must not serve a signed-in owner after
        // login, or the edit page's owner check would fail on the
        // cached copy.
        const viewer = authService.getCurrentUser()?.email?.trim().toLowerCase() || 'guest';
        const fetched = await cachedFetch(
          `one:${viewer}:${id}`,
          () => apiClient.get<EventItem>('/events', { id }),
        );
        // Same stale-cover resolution as the list (see getEvents).
        return fetched ? withMigratedCover(fetched) : fetched;
      } catch (err) {
        console.warn('Backend API /events?id unavailable, falling back to local events store:', err);
        if (opts?.strict && (err as any)?.status !== 404) {
          const local = getStoredEvents().find((e) => e.id === id) || null;
          if (!local) throw err instanceof Error ? err : new Error('Failed to load event');
          return local;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = getStoredEvents();
    return events.find((e) => e.id === id) || null;
  },

  // Warm the single-event cache for an event the user is about to
  // open (card hover/focus). Fire-and-forget: failures are swallowed
  // here so a prefetch can never break navigation, and the one-cache
  // dedupes repeat hovers on the same card. With ~2s per call, a
  // hover that starts the fetch early is often the difference
  // between an instant details page and a skeleton.
  prefetchEvent(id: string): void {
    if (!id || isDemoMode()) return;
    void this.getEventById(id).catch(() => {});
  },

  async getRelatedEvents(eventId: string, limit = 3): Promise<EventItem[]> {
    // The event and the list do not depend on each other, so fetch both
    // at once instead of stacking two ~2s calls. The shared cache also
    // dedupes the event fetch if the caller already requested it.
    // Related cards render card fields only, so the list is slim.
    const [current, listData] = await Promise.all([
      this.getEventById(eventId),
      this.getEvents({}, 1, 100, { slim: true }).then((r) => r.data).catch(() => null),
    ]);
    if (!current) return [];

    // Use the shared list when it is available (getEvents already falls
    // back to local storage if the shared API is not configured), so
    // related events are not limited to this browser's local copy.
    const all: EventItem[] = listData ?? getStoredEvents();
    // Related = same category, or same derived neighborhood (the city
    // when a state is selected; no derived neighborhood matches nothing).
    const currentNeighborhood = getEventNeighborhood(current);
    return all
      .filter((e) => e.id !== eventId && (e.category === current.category || (currentNeighborhood !== '' && getEventNeighborhood(e) === currentNeighborhood)))
      .slice(0, limit);
  },

  async createEvent(eventPayload: Partial<EventItem>): Promise<EventItem> {
    // A mutation must not leave stale cached reads behind.
    clearEventsCache();
    // Stamp the creator before either path, so the shared event and the
    // local copy both carry the ownership key. The Create page already
    // passes createdByEmail; this is the fallback for any other caller.
    const payload: Partial<EventItem> = {
      ...eventPayload,
      // Client-generated id, stable per form session (the Create page
      // generates it once): the server returns the existing event on
      // an id conflict, so a double-submit or a retry after a lost
      // response cannot create a duplicate listing.
      id:
        eventPayload.id ||
        `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      createdByEmail:
        eventPayload.createdByEmail || authService.getCurrentUser()?.email,
    };
    if (!isDemoMode()) {
      try {
        return await apiClient.post<EventItem>('/events', payload);
      } catch (err) {
        console.warn('Backend API /events post unavailable, saving locally as pending-sync:', err);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    const events = getStoredEvents();

    // Reuse the payload id when the caller supplied one, so the local
    // pending copy and the later server flush refer to the same event
    // (and the server's id-conflict return can reconcile them).
    const newId = payload.id || `evt-${Date.now()}`;
    const slug = (payload.title || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)+/g, '');

    const newEvent: EventItem = {
      id: newId,
      title: payload.title || 'Untitled Community Event',
      slug,
      summary: payload.summary || payload.description?.slice(0, 140) || 'Local community gathering.',
      description: payload.description || '',
      category: payload.category || 'Food & Community',
      coverImage: payload.coverImage || heroGatheringImg,
      startDate: payload.startDate || new Date(Date.now() + 86400000 * 7).toISOString(),
      endDate: payload.endDate || new Date(Date.now() + 86400000 * 7 + 7200000).toISOString(),
      venueName: payload.venueName || 'Community Hall',
      address: payload.address || '100 Main Street',
      // Location rule: the neighborhood is the city when a state is
      // selected, otherwise none — never a stored free-text value.
      neighborhood: payload.state ? (payload.city || '') : '',
      city: payload.city || 'Metro City',
      state: payload.state,
      country: payload.country,
      createdByEmail: payload.createdByEmail,
      price: Number(payload.price) || 0,
      // Older events predate this flag and behave as if it were on.
      requireAttendeeDetails: payload.requireAttendeeDetails ?? true,
      // Team participation (hackathons only): carried through so a
      // device-only copy still shows the team flow until it syncs.
      participation: payload.participation,
      capacity: Number(payload.capacity) || 50,
      registeredCount: 0,
      status: 'published',
      // L9 (audit #4): the fallback organizer used to be
      // DEMO_ORGANIZERS[0] — a made-up organizer shown as the poster
      // of a real user's event. A locally created event with no
      // organizer record now gets a plain generic organizer built
      // from the creator's own email instead.
      organizer: payload.organizer || {
        id: `local-${(payload.createdByEmail || 'organizer').toLowerCase()}`,
        name: 'Community Organizer',
        slug: 'community-organizer',
        avatar: '',
        bio: '',
        email: payload.createdByEmail || '',
        location: payload.city || '',
        eventsCount: 0,
        totalAttendeesServed: 0,
      },
      tags: payload.tags && payload.tags.length > 0 ? payload.tags : ['Local', 'Community'],
      isFeatured: false,
    };

    // The server did not take it: keep it locally AND queue it for upload,
    // so it is never silently trapped in this browser. The create page
    // tells the user it is device-only until the sync lands.
    const pendingEvent: EventItem = { ...newEvent, _pendingSync: true };
    events.unshift(pendingEvent);
    saveStoredEvents(events);
    addPendingOp(localStorage, { op: 'create', event: pendingEvent }, authService.getCurrentUser()?.email);
    return pendingEvent;
  },

  async updateEvent(id: string, updates: Partial<EventItem>, opts?: OwnershipOptions): Promise<EventItem> {
    // A mutation must not leave stale cached reads behind.
    clearEventsCache();
    // Ownership is MANDATORY: every caller must prove who is acting, or
    // the update is refused. There is no unchecked path anymore — a
    // caller that forgets opts used to silently skip the check entirely.
    // Registration count bumps use adjustRegisteredCount instead.
    if (!opts?.ownerEmail) {
      throw new Error('Ownership check required to update an event.');
    }
    const existing = await this.getEventById(id);
    if (!existing) {
      throw new Error('Event not found');
    }
    const allowed = opts.allowAdmin
      ? canManageEvent(existing, opts.ownerEmail, opts.isAdmin)
      : isEventOwner(existing, opts.ownerEmail);
    if (!allowed) {
      throw new Error(
        opts.isAdmin && !opts.allowAdmin
          ? 'Admins cannot edit event details.'
          : 'You can only edit your own events.',
      );
    }
    if (!isDemoMode()) {
      try {
        return await apiClient.patch<EventItem>('/events', updates, { id });
      } catch (err) {
        console.warn('Backend API update event unavailable, saving locally as pending-sync:', err);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    const events = getStoredEvents();
    const index = events.findIndex((e) => e.id === id);
    // A shared event this browser never stored locally still gets its edit
    // queued: without a local copy the edit would otherwise be lost.
    const base = index === -1 ? existing : events[index];
    const updated: EventItem = { ...base, ...updates, _pendingSync: true };
    if (index === -1) events.unshift(updated);
    else events[index] = updated;
    saveStoredEvents(events);
    addPendingOp(localStorage, { op: 'update', id, updates }, opts.ownerEmail);
    return updated;
  },

  // Server DELETE summary (api/events.ts): deleting an event no
  // longer orphans its registrations — it cancels them, refunds
  // confirmed Razorpay rows, and emails the attendees. The caller
  // surfaces that summary so the organizer sees what happened.
  async deleteEvent(
    id: string,
    opts?: OwnershipOptions,
  ): Promise<{
    deleted: boolean;
    summary?: {
      cancelledCount?: number;
      refundedCount?: number;
      refundFailed?: number;
      emailedCount?: number;
    };
  }> {
    // A mutation must not leave stale cached reads behind.
    clearEventsCache();
    // Delete is an owner-or-admin operation, and the check is mandatory:
    // a caller without ownership proof is refused, never silently allowed.
    if (!opts?.ownerEmail) {
      throw new Error('Ownership check required to delete an event.');
    }
    const existing = await this.getEventById(id);
    if (!existing || !canManageEvent(existing, opts.ownerEmail, opts.isAdmin)) {
      throw new Error('You can only delete your own events.');
    }
    if (!isDemoMode()) {
      try {
        const summary = await apiClient.delete<{
          cancelledCount?: number;
          refundedCount?: number;
          refundFailed?: number;
          emailedCount?: number;
        }>('/events', { id });
        return { deleted: true, summary: summary || undefined };
      } catch (err) {
        console.warn('Backend API delete event unavailable, queuing the delete for sync:', err);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    let events = getStoredEvents();
    events = events.filter((e) => e.id !== id);
    saveStoredEvents(events);
    // Queued, unless the event itself never reached the server: a pending
    // create for this id is simply cancelled by addPendingOp.
    addPendingOp(localStorage, { op: 'delete', id }, opts.ownerEmail);
    return { deleted: true };
  },

  // SECURITY FIX: counts are now updated server-side inside
  // api/registrations.ts (POST confirmed / cancellation) and
  // api/payments.ts (verified payment).
  // This method only clears the cache so the next fetch shows the
  // server count. It no longer PATCHes /events, because a direct
  // count PATCH is now refused (403) for every caller.
  async adjustRegisteredCount(_id: string, _registeredCount: number): Promise<void> {
    clearEventsCache();
    return;
  },

  // Upload anything this browser saved while the server was unreachable.
  // Runs automatically after successful shared reads; exposed so a
  // sign-in flow can also trigger it explicitly.
  async syncPendingEvents(): Promise<void> {
    await flushPending();
  },

  // True when the last getEvents list came from this browser's local
  // store because the shared API failed. Lets pages explain device-only
  // results instead of showing them as if they were the shared list.
  lastEventsFromLocal(): boolean {
    return lastListFromLocal;
  },



  async searchLiveRealEvents(city: string, query?: string): Promise<{ success: boolean; data: EventItem[]; count: number }> {
    return apiClient.post<{ success: boolean; data: EventItem[]; count: number }>('/events/search-live', {
      city,
      query,
    });
  },

  async detectLocationFromCoords(lat: number, lon: number): Promise<{ city: string; neighborhood: string; displayName: string }> {
    return apiClient.get<{ city: string; neighborhood: string; displayName: string }>('/location/reverse', {
      lat,
      lon,
    });
  },
};
