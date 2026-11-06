import { apiClient } from './api-client';

export interface CalendarStatus {
  connected: boolean;
  google_email: string | null;
}

export interface CalendarAddResult {
  connected: boolean;
  revoked?: boolean;
  calendarEventId?: string;
  htmlLink?: string | null;
  message?: string;
}

// Which Google Calendar event Locora created for each Locora event, kept
// in this browser only as a convenience hint. The server is authoritative:
// it records every id it creates (calendar_connections.created_event_ids)
// and DELETE only ever removes a recorded id, so the hint is never
// trusted on its own. No caller id is ever sent: the server identifies
// the caller from the signed-in session alone (audit #4 C2).
const MAPPING_KEY = 'locora_calendar_event_ids';

function readMapping(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(MAPPING_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const calendarService = {
  async getStatus(): Promise<CalendarStatus> {
    try {
      return await apiClient.get<CalendarStatus>('/calendar/status');
    } catch {
      return { connected: false, google_email: null };
    }
  },

  // Full-page redirect to Google's consent screen. After consent the
  // callback sends the user back to `returnTo` (same-site paths only).
  connectCalendar(returnTo = '/profile'): void {
    const url = `/api/auth/google-calendar?returnTo=${encodeURIComponent(returnTo)}`;
    window.location.href = url;
  },

  async disconnectCalendar(): Promise<boolean> {
    try {
      await apiClient.delete('/calendar/status');
      return true;
    } catch {
      return false;
    }
  },

  async addEventToCalendar(eventId: string): Promise<CalendarAddResult> {
    return apiClient.post<CalendarAddResult>('/calendar/events', { eventId });
  },

  async removeEventFromCalendar(eventId: string): Promise<boolean> {
    try {
      const calendarEventId = readMapping()[eventId] || undefined;
      await apiClient.delete('/calendar/events', { eventId, calendarEventId });
      return true;
    } catch {
      return false;
    }
  },

  getCalendarEventId(eventId: string): string | null {
    return readMapping()[eventId] || null;
  },

  setCalendarEventId(eventId: string, calendarEventId: string): void {
    try {
      const mapping = readMapping();
      mapping[eventId] = calendarEventId;
      localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping));
    } catch {
      // Optional bookkeeping only; the calendar event itself is already created.
    }
  },

  clearCalendarEventId(eventId: string): void {
    try {
      const mapping = readMapping();
      delete mapping[eventId];
      localStorage.setItem(MAPPING_KEY, JSON.stringify(mapping));
    } catch {
      // Ignore.
    }
  },
};
