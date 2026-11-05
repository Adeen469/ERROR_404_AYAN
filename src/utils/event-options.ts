import { EventItem, EventOptionChoice } from '../types';

// Per-category registration option groups (f-1/f-2/f-3, in order).
// The organizer defines the choices for each group; the attendee
// picks one per group at registration. The server carries the same
// group keys (api/events.ts EVENT_OPTION_GROUPS) — keep them in sync.
export interface EventOptionGroupDef {
  key: string;
  label: string;
}

export const EVENT_OPTION_GROUPS: Record<string, EventOptionGroupDef[]> = {
  'Workshops & Learning': [
    { key: 'activity', label: 'Workshop / Activity' },
    { key: 'session', label: 'Session / Batch' },
    { key: 'kit', label: 'Material Kit' },
  ],
  'Live Music & Culture': [
    { key: 'ticketCategory', label: 'Ticket Category' },
    { key: 'seatingZone', label: 'Seating Zone' },
    { key: 'showTiming', label: 'Show Timing' },
  ],
};

export function getOptionGroups(category: string): EventOptionGroupDef[] {
  return EVENT_OPTION_GROUPS[category] || [];
}

export interface ConfiguredOptionGroup {
  key: string;
  label: string;
  choices: EventOptionChoice[];
}

// The groups actually configured on an event, in f-1/f-2/f-3 order.
// A group with no choices is not configured and never shown.
export function getConfiguredOptionGroups(event: EventItem | null | undefined): ConfiguredOptionGroup[] {
  if (!event || !event.options || typeof event.options !== 'object') return [];
  return getOptionGroups(event.category)
    .map((g) => ({
      ...g,
      choices: Array.isArray(event.options![g.key]) ? event.options![g.key] : [],
    }))
    .filter((g) => g.choices.length > 0);
}

export function hasConfiguredOptions(event: EventItem | null | undefined): boolean {
  return getConfiguredOptionGroups(event).length > 0;
}

export function hasOptionExtras(event: EventItem | null | undefined): boolean {
  return getConfiguredOptionGroups(event).some((g) =>
    g.choices.some((c) => Number(c.extraPrice || 0) > 0),
  );
}

// Client-side total preview (the server recomputes it and is the
// source of truth — see api/registrations.ts). Amounts in ₹.
export function computeOptionsTotal(
  event: EventItem,
  selections: Record<string, string>,
): { base: number; extras: number; total: number } {
  const base = Number(event.price || 0);
  let extras = 0;
  for (const g of getConfiguredOptionGroups(event)) {
    const choice = g.choices.find((c) => c.label === selections[g.key]);
    if (choice) extras += Number(choice.extraPrice || 0);
  }
  return { base, extras, total: base + extras };
}

// "Workshop / Activity: Pottery · Session / Batch: Morning" — for the
// roster, the attendee's own registration, and the pass modal.
export function formatSelectionsSummary(
  event: EventItem | null | undefined,
  selections: Record<string, string> | undefined,
): string {
  if (!event || !selections) return '';
  return getConfiguredOptionGroups(event)
    .map((g) => (selections[g.key] ? `${g.label}: ${selections[g.key]}` : ''))
    .filter(Boolean)
    .join(' · ');
}
