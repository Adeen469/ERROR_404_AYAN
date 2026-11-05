// SECURITY FIX — Phase 1 Finding 1: this service no longer sends userId /
// approverEmail as identity. The server derives identity from the
// locora_session JWT cookie only; those body/query fields are ignored
// server-side. getMyRegistrations() calls /registrations with no params.
import { AttendeeRegistration, EventItem } from '../types';
import { DEMO_EVENTS } from '../mocks/demo-data';
import { eventsService } from './events-service';
import { authService } from './auth-service';
import { apiClient, ApiError, isDemoMode } from './api-client';

const REG_STORAGE_KEY = 'locora_registrations';

function getInitialRegistrations(): AttendeeRegistration[] {
  // No sample registrations: sample events (evt-1..evt-8) were removed,
  // so the prepopulated registrations for them are removed too.
  return [];
}

function getStoredRegistrations(): AttendeeRegistration[] {
  try {
    const raw = localStorage.getItem(REG_STORAGE_KEY);
    if (!raw) {
      const initial = getInitialRegistrations();
      localStorage.setItem(REG_STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }
    const parsed = JSON.parse(raw);
    // Drop registrations for removed sample events (evt-1..evt-8).
    const sampleIds = new Set(['evt-1', 'evt-2', 'evt-3', 'evt-4', 'evt-5', 'evt-6', 'evt-7', 'evt-8']);
    const filtered = Array.isArray(parsed) ? parsed.filter((r: AttendeeRegistration) => !sampleIds.has(r.eventId)) : parsed;
    if (Array.isArray(parsed) && filtered.length !== parsed.length) {
      try { localStorage.setItem(REG_STORAGE_KEY, JSON.stringify(filtered)); } catch { /* keep filtered list in memory */ }
    }
    return filtered;
  } catch {
    return getInitialRegistrations();
  }
}

function saveStoredRegistrations(list: AttendeeRegistration[]): void {
  try {
    localStorage.setItem(REG_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.error('Failed to save registrations:', err);
  }
}

// Client fallback only (the server issues the real code): 6
// crypto-random characters, same alphabet as the server. The old
// LOC-<1000..9999>-TK via Math.random had only 9,000 values.
function newTicketCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    let out = '';
    for (const b of bytes) out += chars[b % chars.length];
    return `LOC-${out}-TK`;
  } catch {
    return `LOC-${Date.now().toString(36).toUpperCase()}-TK`;
  }
}

// Shared rows win over local rows with the same id. Every registration
// the user creates is written to both, so the merge is how a pass bought
// on one device shows up on another.
function mergeRegistrations(
  shared: AttendeeRegistration[],
  local: AttendeeRegistration[],
): AttendeeRegistration[] {
  const byId = new Map<string, AttendeeRegistration>();
  for (const r of local) byId.set(r.id, r);
  for (const r of shared) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (b.registeredAt || '').localeCompare(a.registeredAt || ''));
}

export const registrationsService = {
  async getMyRegistrations(): Promise<AttendeeRegistration[]> {
    const user = authService.getCurrentUser();
    if (!user) return [];
    const local = getStoredRegistrations().filter((r) => r.userId === user.id);
    if (isDemoMode()) return local;
    try {
      const shared = await apiClient.get<AttendeeRegistration[]>('/registrations');
      return mergeRegistrations(Array.isArray(shared) ? shared : [], local);
    } catch (err) {
      // Shared registrations table not set up (or unreachable): fall back
      // to this browser's local registrations, like the event list does.
      console.warn('Shared registrations unavailable, falling back to local registrations:', err);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return local;
    }
  },

  async isRegistered(eventId: string): Promise<boolean> {
    const user = authService.getCurrentUser();
    if (!user) return false;

    if (!isDemoMode()) {
      try {
        const regs = await this.getMyRegistrations();
        return regs.some((r) => r.eventId === eventId && r.status === 'confirmed');
      } catch {
        return false;
      }
    }

    const all = getStoredRegistrations();
    return all.some((r) => r.eventId === eventId && r.userId === user.id && r.status === 'confirmed');
  },

  // The attendee's live registration for an event: the newest pending or
  // confirmed one (so the event page can show "payment pending" as well
  // as "you're registered"), else the newest rejected one (so the page
  // can offer another attempt), else null.
  async getRegistrationForEvent(eventId: string): Promise<AttendeeRegistration | null> {
    const user = authService.getCurrentUser();
    if (!user) return null;

    const mine = (await this.getMyRegistrations()).filter((r) => r.eventId === eventId);
    const active = mine.find((r) => r.status === 'pending' || r.status === 'confirmed');
    if (active) return active;
    return mine.find((r) => r.status === 'rejected') || null;
  },

  // Free events only: instant confirmed pass. Paid events must go through
  // registerWithRazorpay — a paid event must never get an instant pass.
  async register(event: EventItem): Promise<AttendeeRegistration> {
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Please sign in or select a demo user profile to register for events.');
    }
    if (event.price > 0) {
      throw new Error('This is a paid event. Please pay with Razorpay.');
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    // Capacity verification
    if (event.registeredCount >= event.capacity) {
      throw new Error('This event is at full capacity. Join the waitlist or explore nearby alternatives.');
    }

    // Merged-state check: a pass bought on another device lives in the
    // shared table, not this browser's local copy. Checking only local
    // state used to create duplicate pendings across devices.
    if (!isDemoMode()) {
      const merged = await this.getRegistrationForEvent(event.id);
      if (merged && merged.status === 'confirmed') return merged;
    }

    const all = getStoredRegistrations();
    const existing = all.find((r) => r.eventId === event.id && r.userId === user.id);

    if (existing && existing.status === 'confirmed') {
      return existing;
    }

    const newReg: AttendeeRegistration = {
      id: `reg-${Date.now()}`,
      eventId: event.id,
      event,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      // Saved by the details gate before registration; shared with the
      // organizer only, for events that require attendee details.
      userPhone: user.phone || undefined,
      // Snapshot of the profile's verified flag. The server re-checks
      // this against the verification rows before storing (see
      // api/registrations.ts), so a client-sent value is never trusted.
      phoneVerified: user.phoneVerified || undefined,
      status: 'confirmed',
      registeredAt: new Date().toISOString(),
      ticketCode: newTicketCode(),
      checkedIn: false,
    };

    // Server first in non-demo mode: a failed shared write used to be
    // swallowed and a local "confirmed" row returned — a phantom pass
    // the server knew nothing about. Only a 503 (backend unconfigured)
    // still falls back to the local row; any other failure is thrown
    // so the UI can say registration failed instead of faking a pass.
    if (!isDemoMode()) {
      try {
        const saved = await apiClient.post<AttendeeRegistration>(
          '/registrations',
          existing
            ? { ...existing, status: 'confirmed', ticketCode: newReg.ticketCode }
            : newReg,
        );
        const row = saved || newReg;
        if (existing) Object.assign(existing, row);
        else all.unshift(row);
        saveStoredRegistrations(all);
        try {
          await eventsService.adjustRegisteredCount(
            event.id,
            Math.min(event.capacity, event.registeredCount + 1),
          );
        } catch (e) {
          console.warn('Could not increment event registered count:', e);
        }
        return row;
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          console.warn('Shared registration unavailable (backend unconfigured), keeping local registration:', err);
        } else {
          throw err;
        }
      }
    }

    if (existing) {
      existing.status = 'confirmed';
      existing.ticketCode = newReg.ticketCode;
      existing.userPhone = newReg.userPhone || existing.userPhone;
      existing.phoneVerified = newReg.phoneVerified || existing.phoneVerified;
    } else {
      all.unshift(newReg);
    }
    saveStoredRegistrations(all);

    // Update event registered count (system count bump, not a user edit,
    // so it does not go through the ownership check).
    try {
      await eventsService.adjustRegisteredCount(
        event.id,
        Math.min(event.capacity, event.registeredCount + 1),
      );
    } catch (e) {
      console.warn('Could not increment event registered count:', e);
    }

    return existing || newReg;
  },



  // Razorpay path (the ONLY paid path): the row is created pending
  // with paymentMethod 'razorpay'; api/payments.ts then creates the
  // order for this row and confirms it (issuing the pass) only after
  // a verified captured payment. There is no organizer approval step
  // anywhere in this flow.
  async registerWithRazorpay(event: EventItem): Promise<AttendeeRegistration> {
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Please sign in or select a demo user profile to register for events.');
    }
    if (event.registeredCount >= event.capacity) {
      throw new Error('This event is at full capacity. Join the waitlist or explore nearby alternatives.');
    }

    // Merged-state check (see register): reuse a pending row created
    // on another device instead of duplicating it.
    if (!isDemoMode()) {
      const merged = await this.getRegistrationForEvent(event.id);
      if (merged && (merged.status === 'confirmed' || merged.status === 'pending')) return merged;
    }

    const all = getStoredRegistrations();
    const existing = all.find((r) => r.eventId === event.id && r.userId === user.id);
    if (existing && (existing.status === 'confirmed' || existing.status === 'pending')) {
      return existing;
    }

    const newReg: AttendeeRegistration = {
      id: `reg-${Date.now()}`,
      eventId: event.id,
      event,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userPhone: user.phone || undefined,
      phoneVerified: user.phoneVerified || undefined,
      holdsSpot: false,
      status: 'pending',
      registeredAt: new Date().toISOString(),
      ticketCode: '',
      checkedIn: false,
      paymentMethod: 'razorpay',
    };

    // Server first in non-demo mode (see register): only a 503 falls
    // back to a local pending row; other failures are thrown, so a
    // failed Razorpay row can never pretend to be pending.
    if (!isDemoMode()) {
      try {
        const saved = await apiClient.post<AttendeeRegistration>('/registrations', newReg);
        const row = saved || newReg;
        all.unshift(row);
        saveStoredRegistrations(all);
        return row;
      } catch (err) {
        if (err instanceof ApiError && err.status === 503) {
          console.warn('Shared registration unavailable (backend unconfigured), keeping local pending registration:', err);
        } else {
          throw err;
        }
      }
    }

    all.unshift(newReg);
    saveStoredRegistrations(all);

    // No count change: a pending payment holds no spot. The slot is
    // taken only on verified payment (api/payments.ts).

    return newReg;
  },

  async cancelRegistration(registrationId: string): Promise<boolean> {
    // Load the record (shared first, local fallback) so a pass bought on
    // another device can be cancelled from here too.
    let target: AttendeeRegistration | undefined;
    if (!isDemoMode()) {
      try {
        target = await apiClient.get<AttendeeRegistration>('/registrations', { id: registrationId });
      } catch {
        target = undefined;
      }
    }
    const all = getStoredRegistrations();
    const localTarget = all.find((r) => r.id === registrationId);
    const record = target || localTarget;
    if (!record) return false;
    if (record.status === 'cancelled') return true;

    // Only a held slot is released: confirmed passes always hold one;
    // pending payments hold one only if they predate the holdsSpot flag
    // (legacy rows). New pending payments hold nothing, so cancelling
    // one changes no count.
    const heldSpot =
      record.status === 'confirmed' ||
      (record.status === 'pending' && record.holdsSpot !== false);
    const user = authService.getCurrentUser();

    if (!isDemoMode()) {
      try {
        await apiClient.patch('/registrations', { status: 'cancelled' }, { id: registrationId });
      } catch (err) {
        // Same honesty rule as register: only a 503 (backend
        // unconfigured) falls back to a local cancel. Any other
        // failure is thrown — claiming "cancelled" while the server
        // still holds a confirmed pass would strand the seat and the
        // attendee's refund.
        if (err instanceof ApiError && err.status === 503) {
          console.warn('Shared cancellation unavailable (backend unconfigured), cancelling locally:', err);
        } else {
          throw err;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    if (localTarget) {
      localTarget.status = 'cancelled';
      saveStoredRegistrations(all);
    }

    if (heldSpot) {
      try {
        const event = await eventsService.getEventById(record.eventId);
        if (event && event.registeredCount > 0) {
          await eventsService.adjustRegisteredCount(
            record.eventId,
            event.registeredCount - 1,
          );
        }
      } catch (e) {
        console.warn('Could not decrement event count:', e);
      }
    }

    return true;
  },

  async getEventAttendees(eventId: string): Promise<AttendeeRegistration[]> {
    const local = getStoredRegistrations().filter((r) => r.eventId === eventId);
    if (isDemoMode()) return local;
    try {
      const shared = await apiClient.get<AttendeeRegistration[]>('/registrations', { eventId });
      return mergeRegistrations(Array.isArray(shared) ? shared : [], local);
    } catch (err) {
      console.warn('Shared attendees unavailable, falling back to local registrations:', err);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return local;
    }
  },

  async toggleCheckIn(registrationId: string, approverEmail?: string): Promise<AttendeeRegistration> {
    const all = getStoredRegistrations();
    const localTarget = all.find((r) => r.id === registrationId);
    let current = localTarget?.checkedIn;
    if (!isDemoMode()) {
      try {
        const shared = await apiClient.get<AttendeeRegistration>('/registrations', { id: registrationId });
        if (shared) current = shared.checkedIn;
        const updated = await apiClient.patch<AttendeeRegistration>(
          '/registrations',
          { checkedIn: !current },
          { id: registrationId },
        );
        if (localTarget) {
          localTarget.checkedIn = updated.checkedIn;
          saveStoredRegistrations(all);
        }
        return updated;
      } catch (err) {
        // Only a 503 (server unavailable) or a network failure (no
        // status) falls back to a local flip. A 401/403/404/400 means
        // the server refused the change — flipping locally would show
        // a check-in the server never recorded. Re-throw those.
        const status = (err as { status?: unknown } | null)?.status;
        if (typeof status === 'number' && status !== 503) throw err;
        console.warn('Shared check-in unavailable, toggling locally:', err);
      }
    }

    if (!localTarget) throw new Error('Registration record not found');
    localTarget.checkedIn = !localTarget.checkedIn;
    saveStoredRegistrations(all);
    return localTarget;
  },







  // Pending-payment counts per event, for the organizer list badge
  // (pending = Razorpay checkout not yet completed). Empty when the
  // shared table is not set up.
  async getPendingCounts(): Promise<Record<string, number>> {
    if (isDemoMode()) return {};
    try {
      const res = await apiClient.get<{ counts: Record<string, number> }>('/registrations', {
        pendingCounts: '1',
      });
      return res?.counts || {};
    } catch {
      return {};
    }
  },
};
