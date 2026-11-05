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

function newTicketCode(): string {
  return `LOC-${Math.floor(1000 + Math.random() * 9000)}-TK`;
}

// Team participation options, passed from the event page when the
// event's participation mode allows teams (see src/types).
export interface TeamRegistrationOptions {
  participationType: 'individual' | 'team';
  teamAction?: 'create' | 'join';
  teamSize?: number;
  teamCode?: string;
}

// Client-side team code, used ONLY for local/demo rows (the shared
// server always generates the real code — see api/registrations.ts).
// Same no-lookalike alphabet as the server code.
function newTeamCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Body fields for a team registration. For a leader (create) the
// teamCode here is a local placeholder — the server generates the
// real code and returns it on the stored row. For a member (join)
// the code is the leader's code, uppercased; the server validates
// it, the leader's confirmed status, and the team size cap.
function teamBodyFields(team?: TeamRegistrationOptions): Partial<AttendeeRegistration> & { teamAction?: 'create' | 'join' } {
  if (!team || team.participationType !== 'team') return { participationType: 'individual' };
  if (team.teamAction === 'join') {
    return {
      participationType: 'team',
      teamAction: 'join',
      teamCode: (team.teamCode || '').trim().toUpperCase(),
      isTeamLeader: false,
      paymentMethod: 'team',
      amountPaise: 0,
    };
  }
  return {
    participationType: 'team',
    teamAction: 'create',
    teamSize: team.teamSize,
    teamCode: newTeamCode(),
    isTeamLeader: true,
  };
}

// Refund preview — CLIENT-SIDE ONLY. The server is the source of
// truth (api/registrations.ts has the identical refundQuote logic);
// this is what the cancel dialogs show before the user confirms.
// Rule (2026-11-05, user-confirmed): cancel within 24 hours of
// PURCHASE for a full refund; after 24 hours the user gets 90% back
// (a 10% cancellation fee is kept). Amounts in paise. Anchor: paidAt
// (set at payment verification), else createdAt, else registeredAt;
// a missing anchor refunds in full. amountPaise <= 100 (₹1 or less)
// always refunds in full, as does any computed refund under 100 paise.
export const REFUND_WINDOW_MS = 24 * 60 * 60 * 1000;
export interface RefundQuote {
  refundAmountPaise: number;
  refundFeePaise: number;
  isFull: boolean;
}
export function getRefundQuote(
  reg: { amountPaise?: number; paymentMethod?: string; razorpayPaymentId?: string; paidAt?: string; createdAt?: string; registeredAt?: string },
  nowMs?: number,
): RefundQuote | null {
  const amount = Number(reg?.amountPaise);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (reg?.paymentMethod !== "razorpay") return null;
  if (!reg?.razorpayPaymentId) return null;
  const now = typeof nowMs === "number" ? nowMs : Date.now();
  const anchorMs = Date.parse(reg.paidAt || "") || Date.parse(reg.createdAt || "") || Date.parse(reg.registeredAt || "");
  if (!Number.isFinite(anchorMs)) return { refundAmountPaise: amount, refundFeePaise: 0, isFull: true };
  if (amount <= 100) return { refundAmountPaise: amount, refundFeePaise: 0, isFull: true };
  if (now - anchorMs <= REFUND_WINDOW_MS) return { refundAmountPaise: amount, refundFeePaise: 0, isFull: true };
  const fee = Math.round(amount * 0.10);
  const refund = amount - fee;
  if (refund < 100) return { refundAmountPaise: amount, refundFeePaise: 0, isFull: true };
  return { refundAmountPaise: refund, refundFeePaise: fee, isFull: false };
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
  // The exception is a team JOIN on a paid event (joinTeam below): the
  // member pays nothing because the leader already paid.
  async register(event: EventItem, team?: TeamRegistrationOptions): Promise<AttendeeRegistration> {
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

    const teamFields = teamBodyFields(team);
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
      ...teamFields,
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
          // A reactivation reuses the cancelled row's id server-side:
          // overlay the team choices the user just picked, so a
          // changed team size or a different team code wins over the
          // stale values on the old row (the server re-validates and,
          // for a leader, generates a fresh code).
          existing
            ? { ...existing, ...teamFields, status: 'confirmed', ticketCode: newReg.ticketCode }
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
      Object.assign(existing, teamFields);
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
  async registerWithRazorpay(event: EventItem, team?: TeamRegistrationOptions): Promise<AttendeeRegistration> {
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
      // Team leader path: the pending row carries the team fields so
      // the leader's code is on the row from the start; the server
      // generates the real code (the client one is a placeholder).
      ...teamBodyFields(team),
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

  // Team join (Technology & Hackathons, paid or free): the member
  // registers with the leader's 6-character team code and is
  // confirmed immediately — no payment step, because the leader
  // already paid for the team. The server validates the code, that
  // the leader's row is confirmed (a still-pending leader has not
  // finished paying), and that the team is not full. Works for free
  // events too (same instant confirm, same no-payment rule).
  async joinTeam(event: EventItem, teamCode: string): Promise<AttendeeRegistration> {
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Please sign in or select a demo user profile to register for events.');
    }
    const code = (teamCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      throw new Error('Enter the 6-character team code shared by your team leader.');
    }
    if (event.registeredCount >= event.capacity) {
      throw new Error('This event is at full capacity. Join the waitlist or explore nearby alternatives.');
    }

    // Merged-state check (see register): a confirmed pass bought on
    // another device means this user is already in.
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
      userPhone: user.phone || undefined,
      phoneVerified: user.phoneVerified || undefined,
      status: 'confirmed',
      registeredAt: new Date().toISOString(),
      ticketCode: newTicketCode(),
      checkedIn: false,
      participationType: 'team',
      teamCode: code,
      isTeamLeader: false,
      paymentMethod: 'team',
      amountPaise: 0,
    };
    // teamAction is a request-only field (not stored on the row):
    // it tells the server this is a join, not a leader create.
    const body = { ...newReg, teamAction: 'join' as const };

    // Server first in non-demo mode (see register): only a 503 falls
    // back to the local row; other failures are thrown, so a bad code
    // or a full team is reported instead of faking a pass.
    if (!isDemoMode()) {
      try {
        const saved = await apiClient.post<AttendeeRegistration>('/registrations', body);
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
      Object.assign(existing, newReg, { status: 'confirmed' });
    } else {
      all.unshift(newReg);
    }
    saveStoredRegistrations(all);

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

  // Returns the cancelled row as the server stored it (carrying
  // refundAmountPaise / refundStatus for paid passes), so the caller
  // can tell the user exactly what refund was initiated. Returns the
  // local record when the server is unreachable (503 fallback), and
  // null when no record exists at all.
  async cancelRegistration(registrationId: string): Promise<AttendeeRegistration | null> {
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
    if (!record) return null;
    if (record.status === 'cancelled') return record;

    // Only a held slot is released: confirmed passes always hold one;
    // pending payments hold one only if they predate the holdsSpot flag
    // (legacy rows). New pending payments hold nothing, so cancelling
    // one changes no count.
    const heldSpot =
      record.status === 'confirmed' ||
      (record.status === 'pending' && record.holdsSpot !== false);
    const user = authService.getCurrentUser();

    let updated: AttendeeRegistration | undefined;
    if (!isDemoMode()) {
      try {
        updated = await apiClient.patch<AttendeeRegistration>('/registrations', { status: 'cancelled' }, { id: registrationId });
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
      if (updated) Object.assign(localTarget, updated);
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

    return updated || localTarget || { ...record, status: 'cancelled' };
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
