import { AttendeeRegistration, EventItem } from '../types';
import { DEMO_EVENTS } from '../mocks/demo-data';
import { eventsService } from './events-service';
import { authService } from './auth-service';
import { apiClient, isDemoMode } from './api-client';

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
      const shared = await apiClient.get<AttendeeRegistration[]>('/registrations', {
        userId: user.id,
      });
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
  // registerWithPayment — a paid event must never get an instant pass.
  async register(event: EventItem): Promise<AttendeeRegistration> {
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Please sign in or select a demo user profile to register for events.');
    }
    if (event.price > 0) {
      throw new Error('This is a paid event. Please pay and submit your payment for organizer approval.');
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    // Capacity verification
    if (event.registeredCount >= event.capacity) {
      throw new Error('This event is at full capacity. Join the waitlist or explore nearby alternatives.');
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
      status: 'confirmed',
      registeredAt: new Date().toISOString(),
      ticketCode: newTicketCode(),
      checkedIn: false,
    };

    if (existing) {
      existing.status = 'confirmed';
      existing.ticketCode = newReg.ticketCode;
    } else {
      all.unshift(newReg);
    }
    saveStoredRegistrations(all);

    // Shared copy first (best effort); the local copy above is the
    // fallback when the shared table is not set up yet.
    if (!isDemoMode()) {
      try {
        await apiClient.post('/registrations', existing || newReg);
      } catch (err) {
        console.warn('Shared registration unavailable, keeping local registration:', err);
      }
    }

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

  // Paid events: the attendee pays the organizer directly (UPI) and
  // submits the 12-digit UTR. This creates a PENDING registration that
  // holds a spot (count +1) but issues NO pass until the organizer
  // approves it (approveRegistration).
  async registerWithPayment(event: EventItem, utr: string): Promise<AttendeeRegistration> {
    const user = authService.getCurrentUser();
    if (!user) {
      throw new Error('Please sign in or select a demo user profile to register for events.');
    }
    const cleanUtr = (utr || '').replace(/\s+/g, '');
    if (!/^\d{12}$/.test(cleanUtr)) {
      throw new Error('Enter the 12-digit UTR from your UPI payment.');
    }
    if (event.registeredCount >= event.capacity) {
      throw new Error('This event is at full capacity. Join the waitlist or explore nearby alternatives.');
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
      status: 'pending',
      registeredAt: new Date().toISOString(),
      ticketCode: '',
      checkedIn: false,
      utr: cleanUtr,
    };

    all.unshift(newReg);
    saveStoredRegistrations(all);

    if (!isDemoMode()) {
      try {
        await apiClient.post('/registrations', newReg);
      } catch (err) {
        console.warn('Shared registration unavailable, keeping local pending registration:', err);
      }
    }

    // A pending payment holds a spot until it is approved or rejected.
    try {
      await eventsService.adjustRegisteredCount(
        event.id,
        Math.min(event.capacity, event.registeredCount + 1),
      );
    } catch (e) {
      console.warn('Could not increment event registered count:', e);
    }

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

    // Confirmed passes and pending payments both hold a spot; releasing
    // it is part of cancelling either.
    const heldSpot = record.status === 'confirmed' || record.status === 'pending';
    const user = authService.getCurrentUser();

    if (!isDemoMode()) {
      try {
        await apiClient.patch('/registrations', { status: 'cancelled', userId: user?.id }, { id: registrationId });
      } catch (err) {
        console.warn('Shared cancellation unavailable, cancelling locally:', err);
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
          { checkedIn: !current, approverEmail },
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

  // Organizer approves a pending payment: the pass is issued now (the
  // ticket code is generated here, not at payment time). No count change:
  // the pending payment already held a spot.
  async approveRegistration(registrationId: string, approverEmail: string): Promise<AttendeeRegistration> {
    const ticketCode = newTicketCode();
    if (!isDemoMode()) {
      try {
        const updated = await apiClient.patch<AttendeeRegistration>(
          '/registrations',
          { status: 'confirmed', ticketCode, approverEmail },
          { id: registrationId },
        );
        const all = getStoredRegistrations();
        const localTarget = all.find((r) => r.id === registrationId);
        if (localTarget) {
          localTarget.status = 'confirmed';
          localTarget.ticketCode = ticketCode;
          saveStoredRegistrations(all);
        }
        return updated;
      } catch (err) {
        console.warn('Shared approval unavailable, approving locally:', err);
      }
    }
    const all = getStoredRegistrations();
    const target = all.find((r) => r.id === registrationId);
    if (!target) throw new Error('Registration record not found');
    target.status = 'confirmed';
    target.ticketCode = ticketCode;
    saveStoredRegistrations(all);
    return target;
  },

  // Organizer rejects a pending payment: the held spot is released.
  async rejectRegistration(registrationId: string, approverEmail: string): Promise<AttendeeRegistration> {
    if (!isDemoMode()) {
      try {
        const updated = await apiClient.patch<AttendeeRegistration>(
          '/registrations',
          { status: 'rejected', approverEmail },
          { id: registrationId },
        );
        const all = getStoredRegistrations();
        const localTarget = all.find((r) => r.id === registrationId);
        if (localTarget) {
          localTarget.status = 'rejected';
          saveStoredRegistrations(all);
        }
        await this.releaseSpot(updated.eventId);
        return updated;
      } catch (err) {
        console.warn('Shared rejection unavailable, rejecting locally:', err);
      }
    }
    const all = getStoredRegistrations();
    const target = all.find((r) => r.id === registrationId);
    if (!target) throw new Error('Registration record not found');
    target.status = 'rejected';
    saveStoredRegistrations(all);
    await this.releaseSpot(target.eventId);
    return target;
  },

  // Release one held spot (used when a pending payment is rejected).
  async releaseSpot(eventId: string): Promise<void> {
    try {
      const event = await eventsService.getEventById(eventId);
      if (event && event.registeredCount > 0) {
        await eventsService.adjustRegisteredCount(eventId, event.registeredCount - 1);
      }
    } catch (e) {
      console.warn('Could not release event spot:', e);
    }
  },

  // Pending-payment counts per event, for the organizer list badge.
  // Empty when the shared table is not set up (local pending payments
  // are same-browser only, so they are not counted here).
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
