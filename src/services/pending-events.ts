// Pending-sync outbox for events.
//
// Why this exists: events-service falls back to this browser's
// localStorage whenever the shared API is unreachable. That fallback used
// to be silent — an event created while the server was down looked saved,
// but it lived only in that one browser, so the same email on another
// device (or any other user) never saw it. This module makes that state
// explicit and recoverable:
//
// - Every create/update/delete that falls back to local storage is also
//   recorded here as a pending op, and the event carries _pendingSync.
// - The next time the shared API answers (a Discover/Home load after a
//   successful fetch), flushPendingOps replays the ops to the server.
//   The browser sends the user's session cookie automatically on these
//   same-origin calls, so a signed-in organizer's ops succeed once the
//   server accepts writes again.
// - Until an op flushes, getEvents merges pending ops into the default
//   (unfiltered) first page, flagged, so a pending event never vanishes
//   from its creator's view the moment the server comes back.
//
// Honest limit, stated wherever this is surfaced: nothing in a browser
// can move data out of another browser's localStorage. An event created
// on desktop while the server is down can only reach other devices once
// THIS browser flushes it to the server. Until then it is visible only
// here, and the UI says so instead of pretending it is shared.
//
// This module is deliberately dependency-free (type-only imports) so its
// logic can be node-tested without the app's bundled-image/demo imports.
// Storage is injected (localStorage in the app, a mock in tests).
import type { EventItem, EventFilterOptions, PaginatedResponse } from '../types';

export type PendingOp =
  | { op: 'create'; event: EventItem; creatorEmail?: string }
  | { op: 'update'; id: string; updates: Partial<EventItem>; creatorEmail?: string }
  | { op: 'delete'; id: string; creatorEmail?: string };

export const PENDING_KEY = 'locora_events_pending';

export function opId(op: PendingOp): string {
  return op.op === 'create' ? op.event.id : op.id;
}

export function getPendingOps(storage: Storage): PendingOp[] {
  try {
    const raw = storage.getItem(PENDING_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingOp[]) : [];
  } catch {
    return [];
  }
}

export function savePendingOps(storage: Storage, ops: PendingOp[]): void {
  try {
    storage.setItem(PENDING_KEY, JSON.stringify(ops));
  } catch {
    // Private mode or quota: ops stay in memory only for this session.
    // The local event copy still exists; only the retry is lost.
  }
}

// Add an op, coalescing with earlier ops for the same event:
// - An update folds into a pending create (the create snapshot carries
//   the edit), so the server never sees a create-then-patch pair.
// - A delete cancels a pending create outright: the event never reached
//   the server, so there is nothing to delete there.
// - A delete supersedes pending updates for the same id.
// - Repeated updates merge, newest fields win.
// creatorEmail stamps who queued the op. Ops queued before this field
// existed (no creatorEmail) still flush for anyone — they predate the
// fix and blocking them would strand legitimate drafts.
export function addPendingOp(storage: Storage, op: PendingOp, creatorEmail?: string): PendingOp[] {
  const ops = getPendingOps(storage);
  // Stamp the creator so a later flush can refuse to publish one
  // user's draft under another user's session (see flushPendingOps).
  // Folds below preserve the stamped op (and an existing create's own
  // creator when an update folds into it).
  const opIn: PendingOp = creatorEmail ? { ...op, creatorEmail } : op;
  const id = opId(opIn);
  let next: PendingOp[];
  if (opIn.op === 'delete') {
    const without = ops.filter((o) => opId(o) !== id);
    const hadCreate = ops.some((o) => o.op === 'create' && o.event.id === id);
    next = hadCreate ? without : [...without, opIn];
  } else if (opIn.op === 'update') {
    let folded = false;
    next = ops.map((o) => {
      if (o.op === 'create' && o.event.id === id) {
        folded = true;
        return { op: 'create', event: { ...o.event, ...opIn.updates }, creatorEmail: o.creatorEmail || opIn.creatorEmail } as PendingOp;
      }
      return o;
    });
    if (!folded) {
      let merged = false;
      next = next.map((o) => {
        if (o.op === 'update' && o.id === id) {
          merged = true;
          return { op: 'update', id, updates: { ...o.updates, ...opIn.updates }, creatorEmail: o.creatorEmail || opIn.creatorEmail } as PendingOp;
        }
        return o;
      });
      if (!merged) next = [...next, opIn];
    }
  } else {
    next = [...ops.filter((o) => opId(o) !== id), opIn];
  }
  savePendingOps(storage, next);
  return next;
}

// The pending flag is a local display marker only: it must never be
// stored in the shared record.
export function stripPendingFlag(event: EventItem): EventItem {
  const { _pendingSync, ...rest } = event as EventItem & { _pendingSync?: boolean };
  return rest as EventItem;
}

function stripPendingFromUpdates(updates: Partial<EventItem>): Partial<EventItem> {
  const { _pendingSync, ...rest } = updates as Partial<EventItem> & { _pendingSync?: boolean };
  return rest;
}

// True only for the default Discover/Home view: no search, no category
// other than All, no location, no price filter, no date range, default
// sort. With filters active the merge is skipped — matching them is the
// server's job once the op flushes, and showing a non-matching pending
// event in filtered results would be wrong.
export function isDefaultView(filters: EventFilterOptions): boolean {
  const noQuery = !filters.query?.trim();
  const noCategory =
    !filters.category || filters.category === 'All' || filters.category === 'All Categories';
  const noLocation = !filters.country?.trim() && !filters.state?.trim() && !filters.city?.trim();
  const noPrice = !filters.priceType;
  const noDates = !filters.dateRange || filters.dateRange === 'all';
  const defaultSort = !filters.sortBy || filters.sortBy === 'relevance';
  return noQuery && noCategory && noLocation && noPrice && noDates && defaultSort;
}

// Overlay pending ops onto a shared page for display: pending deletes
// hide their event, pending updates replace fields, pending creates are
// prepended (flagged). Totals count pending creates, so "Showing N"
// stays truthful. Only page 1 of the default view is merged.
export function applyPendingToPage(
  page: PaginatedResponse<EventItem>,
  pageNum: number,
  filters: EventFilterOptions,
  ops: PendingOp[],
  currentEmail?: string,
): PaginatedResponse<EventItem> {
  if (pageNum !== 1 || ops.length === 0 || !isDefaultView(filters)) return page;
  // Same creator rule as flushPendingOps: one user's offline drafts
  // must never appear in another user's view on a shared browser.
  // Untagged ops (queued before creator tagging existed) are visible
  // only to guests: a signed-in viewer must not see another user's
  // pre-tagging draft overlaid on their page. Tagged ops show only to
  // their creator. (Flush still accepts untagged ops — see
  // flushPendingOps — so nothing is stranded by this.)
  const mine = ops.filter(
    (op) =>
      (!op.creatorEmail && !currentEmail) ||
      (!!op.creatorEmail && !!currentEmail && op.creatorEmail.toLowerCase() === currentEmail.toLowerCase()),
  );
  if (mine.length === 0) return page;
  let data = page.data.slice();
  let created = 0;
  for (const op of mine) {
    if (op.op === 'delete') {
      data = data.filter((e) => e.id !== op.id);
    } else if (op.op === 'update') {
      data = data.map((e) =>
        e.id === op.id ? { ...e, ...stripPendingFromUpdates(op.updates), _pendingSync: true } : e,
      );
    } else if (!data.some((e) => e.id === op.event.id)) {
      data.unshift({ ...op.event, _pendingSync: true });
      created += 1;
    }
  }
  // Re-slice to the page size: prepending pending creates used to let
  // page 1 show more cards than the page size (the total was adjusted,
  // the slice was not).
  const pageSize = page.pageSize || data.length || 12;
  const total = page.total + created;
  return {
    ...page,
    data: data.slice(0, pageSize),
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export interface PendingApi {
  get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  patch<T>(path: string, body?: unknown, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
  delete<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>;
}

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : null;
}

// Replay pending ops in order. Returns the ids that reached the server.
// - A create that fails is re-checked: if the event already exists on
//   the server (an earlier attempt landed but its response was lost),
//   the op counts as flushed instead of retrying into a duplicate-key
//   failure forever.
// - On any other failure the round stops: further ops would hit the same
//   wall (server down, or no session), and each would cost a round trip.
//   Failed ops stay pending for the next attempt.
// - Ops added to storage mid-flush are preserved: the final write removes
//   only the ids this round flushed.
export async function flushPendingOps(
  storage: Storage,
  api: PendingApi,
  currentEmail?: string,
): Promise<{ flushed: string[]; remaining: PendingOp[] }> {
  const ops = getPendingOps(storage);
  const flushed: string[] = [];
  for (const op of ops) {
    const id = opId(op);
    // Never publish one user's draft under another user's session:
    // the server stamps createdByEmail from the session, so flushing
    // user A's offline create after user B signed in on the same
    // browser would have made B the owner of A's event. Mismatched ops
    // stay pending for their creator's next sign-in. Ops queued before
    // creator tagging existed carry no creator and still flush.
    // Lowercase BOTH sides: the old comparison lowercased only the
    // session email, so an op tagged with a mixed-case creator email
    // never matched and stayed pending forever.
    if (op.creatorEmail && currentEmail && op.creatorEmail.toLowerCase() !== currentEmail.toLowerCase()) {
      continue;
    }
    try {
      if (op.op === 'create') {
        await api.post('/events', stripPendingFlag(op.event));
      } else if (op.op === 'update') {
        await api.patch('/events', stripPendingFromUpdates(op.updates), { id });
      } else {
        await api.delete('/events', { id });
      }
      flushed.push(id);
    } catch (err) {
      if (op.op === 'create') {
        try {
          const found = await api.get('/events', { id });
          if (found) {
            flushed.push(id);
            continue;
          }
        } catch {
          // Still not on the server: stays pending.
        }
      }
      // 401/403 means no session or not an approved organizer: retrying
      // now is pointless, but a later sign-in may fix it, so keep pending.
      void statusOf(err);
      break;
    }
  }
  if (flushed.length > 0) {
    const current = getPendingOps(storage);
    savePendingOps(
      storage,
      current.filter((o) => !flushed.includes(opId(o))),
    );
  }
  return { flushed, remaining: getPendingOps(storage) };
}
