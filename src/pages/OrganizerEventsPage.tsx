import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { PlusCircle, Edit, Users, Trash2, Eye, EyeOff, ArrowLeft, Clock, Wallet } from 'lucide-react';
import { EventItem } from '../types';
import { eventsService, isEventOwner, canManageEvent } from '../services/events-service';
import { registrationsService } from '../services/registrations-service';
import { authService } from '../services/auth-service';
import { isAdminEmail } from '../services/roles-service';
import { formatEventDate, formatPrice } from '../utils/formatters';
import { useToast } from '../components/ui/Toast';
import { ConfirmDialog } from '../components/ui/Modal';
import { ListSkeleton } from '../components/ui/LoadingSkeleton';

export function OrganizerEventsPage() {
  const { toast } = useToast();
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'cancelled'>('all');

  const [deleteTarget, setDeleteTarget] = useState<EventItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Pending Razorpay payments per event (shared table only).
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  // Payouts (assisted manual settlement): totals across this
  // organizer's events + the payout-details form state.
  const [payoutTotals, setPayoutTotals] = useState<{ collected: number; refunds: number } | null>(null);
  const [payoutForm, setPayoutForm] = useState({ holderName: '', upiId: '', accountNumber: '', ifsc: '' });
  const [editingPayout, setEditingPayout] = useState(false);
  const [savingPayout, setSavingPayout] = useState(false);

  // Ownership for this list: an organizer sees only their own events;
  // admins see everything (they may delete and operate events, but not
  // edit details — the Edit button below is owner-only). The service
  // re-checks ownership on every edit/delete, so a filtered list alone
  // is not the protection.
  const currentUser = authService.getCurrentUser();
  const isAdmin =
    !!currentUser &&
    currentUser.role === 'admin' &&
    isAdminEmail(currentUser.email);
  const ownershipOpts = {
    ownerEmail: currentUser?.email,
    isAdmin,
  };

  const loadEvents = async () => {
    setLoading(true);
    try {
      const { data } = await eventsService.getEvents({}, 1, 100);
      setEvents(
        data.filter((e) => canManageEvent(e, currentUser?.email, isAdmin)),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
    registrationsService.getPendingCounts().then(setPendingCounts).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTogglePublish = async (event: EventItem) => {
    const newStatus = event.status === 'published' ? 'draft' : 'published';
    try {
      await eventsService.updateEvent(event.id, { status: newStatus }, { ...ownershipOpts, allowAdmin: true });
      setEvents((prev) =>
        prev.map((e) => (e.id === event.id ? { ...e, status: newStatus } : e))
      );
      toast({
        type: 'success',
        title: `Event ${newStatus === 'published' ? 'Published' : 'Moved to Draft'}`,
      });
    } catch {
      toast({ type: 'error', title: 'Failed to update event status' });
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const result = await eventsService.deleteEvent(deleteTarget.id, ownershipOpts);
      setEvents((prev) => prev.filter((e) => e.id !== deleteTarget.id));
      setDeleteTarget(null);
      // Deleting no longer orphans registrations: the server cancels
      // them, refunds paid rows, and emails attendees — say what
      // happened, including refunds that still need manual action.
      const s = result.summary;
      const parts: string[] = [`"${deleteTarget.title}" was removed from the listings.`];
      if (s && (s.cancelledCount || 0) > 0) {
        parts.push(
          `${s.cancelledCount} registration(s) cancelled, ${s.emailedCount || 0} attendee(s) emailed` +
            ((s.refundedCount || 0) > 0 ? `, ${s.refundedCount} refund(s) initiated` : '') +
            ((s.refundFailed || 0) > 0
              ? `, ${s.refundFailed} refund(s) FAILED — refund manually from the Razorpay dashboard`
              : ''),
        );
      }
      toast({
        type: 'info',
        title: 'Event Deleted',
        description: parts.join(' '),
      });
    } catch {
      toast({ type: 'error', title: 'Failed to delete event' });
    } finally {
      setDeleting(false);
    }
  };

  // Payout totals: collected = confirmed Razorpay registrations,
  // refunds = amounts already returned on cancelled ones, payable =
  // collected - refunds. One event's list failing must not blank
  // the whole card, so each fetch is guarded individually.
  useEffect(() => {
    if (!events.length) { setPayoutTotals({ collected: 0, refunds: 0 }); return; }
    let cancelled = false;
    (async () => {
      let collected = 0;
      let refunds = 0;
      await Promise.all(events.map(async (e) => {
        try {
          const regs = await registrationsService.getEventAttendees(e.id);
          for (const r of regs || []) {
            if (r.status === 'confirmed' && r.paymentMethod === 'razorpay') collected += r.amountPaise || 0;
            if (r.status === 'cancelled') refunds += r.refundAmountPaise || 0;
          }
        } catch { /* guarded per event */ }
      }));
      if (!cancelled) setPayoutTotals({ collected, refunds });
    })();
    return () => { cancelled = true; };
  }, [events]);

  const savedPayout = currentUser?.payoutDetails;
  const fmtPaise = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  const savePayoutDetails = async () => {
    const holderName = payoutForm.holderName.trim();
    const upiId = payoutForm.upiId.trim();
    const accountNumber = payoutForm.accountNumber.replace(/\s/g, '');
    const ifsc = payoutForm.ifsc.trim().toUpperCase();
    if (!holderName) {
      toast({ title: 'Account holder name required', description: 'Enter the name on the bank account or UPI ID that should receive your payout.' });
      return;
    }
    if (!upiId && !(accountNumber && ifsc)) {
      toast({ title: 'Payout destination missing', description: 'Add a UPI ID, or a bank account number together with its IFSC.' });
      return;
    }
    setSavingPayout(true);
    try {
      await authService.updateProfile({
        payoutDetails: {
          holderName,
          ...(upiId ? { upiId } : {}),
          ...(accountNumber ? { accountNumber } : {}),
          ...(ifsc ? { ifsc } : {}),
        },
      });
      toast({ title: 'Payout details saved', description: 'Your ticket earnings will be settled to these details after your events end.' });
      setEditingPayout(false);
    } catch {
      toast({ title: 'Could not save payout details', description: 'Please check your connection and try again.' });
    } finally {
      setSavingPayout(false);
    }
  };

  const filtered = statusFilter === 'all' ? events : events.filter((e) => e.status === statusFilter);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E5E1D8]">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              to="/organizer/dashboard"
              className="text-xs text-[#5F635D] hover:text-[#1E2320] inline-flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Organizer Console</span>
            </Link>
          </div>
          <h1 className="font-editorial text-3xl font-bold tracking-tight text-[#1E2320]">
            Manage All Events
          </h1>
        </div>

        <Link
          to="/organizer/events/new"
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors whitespace-nowrap self-start sm:self-auto shadow-xs"
        >
          <PlusCircle className="w-4 h-4" />
          <span>New Event</span>
        </Link>
      </div>

      {/* Payouts — assisted manual settlement. Ticket money is
          collected into Locora's Razorpay account; the platform
          owner settles each organizer's balance to the details
          saved here after the event, with refunds deducted. */}
      <div className="bg-white border border-[#E7E3DB] rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="font-editorial text-lg font-bold text-[#1E2320] flex items-center gap-2">
              <Wallet className="w-5 h-5 text-[#1E3F35]" />
              Payouts
            </h2>
            <p className="text-xs text-[#5F635D] mt-1">
              Ticket money is collected into Locora&apos;s Razorpay account. After your event ends, your
              earnings are settled to the account below — refunds already given are deducted first.
            </p>
          </div>
          {payoutTotals && (
            <div className="flex gap-5 text-right">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[#5F635D]">Collected</div>
                <div className="text-sm font-bold text-[#1E2320]">{fmtPaise(payoutTotals.collected)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[#5F635D]">Refunds</div>
                <div className="text-sm font-bold text-[#1E2320]">{fmtPaise(payoutTotals.refunds)}</div>
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-[#5F635D]">Payable to you</div>
                <div className="text-sm font-bold text-[#1E3F35]">{fmtPaise(payoutTotals.collected - payoutTotals.refunds)}</div>
              </div>
            </div>
          )}
        </div>

        {savedPayout && !editingPayout ? (
          <div className="flex flex-wrap items-center justify-between gap-3 bg-[#EAF1ED] rounded-xl px-4 py-3">
            <div className="text-sm text-[#1E2320]">
              <span className="font-semibold">{savedPayout.holderName}</span>
              {savedPayout.upiId && <span className="text-[#5F635D]"> · UPI: {savedPayout.upiId}</span>}
              {savedPayout.accountNumber && (
                <span className="text-[#5F635D]">
                  {' '}· Account ••••{savedPayout.accountNumber.slice(-4)}
                  {savedPayout.ifsc ? ` · IFSC ${savedPayout.ifsc}` : ''}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                setPayoutForm({
                  holderName: savedPayout.holderName || '',
                  upiId: savedPayout.upiId || '',
                  accountNumber: savedPayout.accountNumber || '',
                  ifsc: savedPayout.ifsc || '',
                });
                setEditingPayout(true);
              }}
              className="px-3 py-1.5 text-xs font-semibold text-[#1E3F35] bg-white border border-[#C9D6CF] rounded-lg hover:bg-[#F4F8F5] transition-colors"
            >
              Edit
            </button>
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={payoutForm.holderName}
              onChange={(e) => setPayoutForm((f) => ({ ...f, holderName: e.target.value }))}
              placeholder="Account holder name"
              className="w-full px-3 py-2 text-sm border border-[#E2DFD8] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#1E3F35]/30"
            />
            <input
              type="text"
              value={payoutForm.upiId}
              onChange={(e) => setPayoutForm((f) => ({ ...f, upiId: e.target.value }))}
              placeholder="UPI ID (e.g. yourname@okhdfcbank)"
              className="w-full px-3 py-2 text-sm border border-[#E2DFD8] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#1E3F35]/30"
            />
            <input
              type="text"
              value={payoutForm.accountNumber}
              onChange={(e) => setPayoutForm((f) => ({ ...f, accountNumber: e.target.value }))}
              placeholder="Bank account number (optional if UPI given)"
              className="w-full px-3 py-2 text-sm border border-[#E2DFD8] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#1E3F35]/30"
            />
            <input
              type="text"
              value={payoutForm.ifsc}
              onChange={(e) => setPayoutForm((f) => ({ ...f, ifsc: e.target.value }))}
              placeholder="IFSC (with bank account)"
              className="w-full px-3 py-2 text-sm border border-[#E2DFD8] rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-[#1E3F35]/30"
            />
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={savePayoutDetails}
                disabled={savingPayout}
                className="px-4 py-2 text-xs font-semibold text-white bg-[#1E3F35] hover:bg-[#163028] rounded-lg transition-colors disabled:opacity-60"
              >
                {savingPayout ? 'Saving…' : 'Save payout details'}
              </button>
              {savedPayout && (
                <button
                  type="button"
                  onClick={() => setEditingPayout(false)}
                  className="px-4 py-2 text-xs font-medium text-[#5F635D] bg-white border border-[#E2DFD8] rounded-lg hover:text-[#1E2320] transition-colors"
                >
                  Cancel
                </button>
              )}
              <span className="text-[11px] text-[#5F635D]">
                Visible only to you and the Locora team for settlement — never shown publicly.
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Status Filter Tabs */}
      <div className="flex items-center gap-2">
        {(['all', 'published', 'draft', 'cancelled'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${
              statusFilter === s
                ? 'bg-[#1E3F35] text-white font-semibold'
                : 'bg-white text-[#5F635D] hover:text-[#1E2320] border border-[#E2DFD8]'
            }`}
          >
            {s} ({s === 'all' ? events.length : events.filter((e) => e.status === s).length})
          </button>
        ))}
      </div>

      {/* Events List Cards */}
      {loading ? (
        <ListSkeleton count={4} />
      ) : filtered.length === 0 ? (
        <div className="p-12 text-center bg-white rounded-2xl border border-dashed border-[#E5E1D8] text-xs text-[#5F635D]">
          No events found in this category.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((evt) => (
            <div
              key={evt.id}
              className="bg-white rounded-xl border border-[#E5E1D8] p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-2xs hover:border-[#1E3F35]/30 transition-colors"
            >
              <div className="flex items-start gap-4">
                <img
                  src={evt.coverImage}
                  alt={evt.title}
                  referrerPolicy="no-referrer"
                  className="w-16 h-16 rounded-lg object-cover bg-[#F4F1EA] shrink-0 border border-[#E2DFD8]"
                />
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#1E3F35] mb-1">
                    <span>{evt.category}</span>
                    <span aria-hidden="true" className="text-[#C8C4BC]">·</span>
                    <span className="text-[#5F635D] font-normal normal-case">{formatEventDate(evt.startDate)}</span>
                    <span aria-hidden="true" className="text-[#C8C4BC]">·</span>
                    <span className="font-semibold text-[#1E2320] font-normal">{formatPrice(evt.price)}</span>
                  </div>
                  <h3 className="font-editorial text-base font-bold text-[#1E2320]">
                    <Link to={`/events/${evt.id}`} className="hover:text-[#1E3F35]">
                      {evt.title}
                    </Link>
                  </h3>
                  <p className="text-xs text-[#5F635D] mt-0.5">
                    {evt.venueName} · {evt.registeredCount} / {evt.capacity} registered
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 self-end md:self-center shrink-0">
                {pendingCounts[evt.id] ? (
                  <Link
                    to={`/organizer/events/${evt.id}/attendees`}
                    className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors"
                  >
                    <Clock className="w-3 h-3" />
                    <span>{pendingCounts[evt.id]} pending</span>
                  </Link>
                ) : null}
                <Link
                  to={`/organizer/events/${evt.id}/attendees`}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#1E2320] hover:text-[#1E3F35] bg-[#F4F1EA] hover:bg-[#EBE7DF] border border-[#E2DFD8] rounded-lg transition-colors"
                >
                  <Users className="w-3.5 h-3.5 text-[#1E3F35]" />
                  <span>Roster</span>
                </Link>

                {isEventOwner(evt, currentUser?.email) && (
                  <Link
                    to={`/organizer/events/${evt.id}/edit`}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#1E2320] hover:text-[#1E3F35] bg-[#F4F1EA] hover:bg-[#EBE7DF] border border-[#E2DFD8] rounded-lg transition-colors"
                  >
                    <Edit className="w-3.5 h-3.5 text-[#8C887E]" />
                    <span>Edit</span>
                  </Link>
                )}

                <button
                  type="button"
                  onClick={() => handleTogglePublish(evt)}
                  className="p-1.5 text-[#5F635D] hover:text-[#1E2320] rounded-lg hover:bg-[#F4F1EA] transition-colors"
                  title={evt.status === 'published' ? 'Unpublish to draft' : 'Publish event'}
                >
                  {evt.status === 'published' ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4 text-[#1E3F35]" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setDeleteTarget(evt)}
                  className="p-1.5 text-[#8C887E] hover:text-rose-600 rounded-lg hover:bg-rose-50 transition-colors"
                  title="Delete event"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        isLoading={deleting}
        isDestructive
        title="Delete Event"
        message={`Are you sure you want to permanently delete "${deleteTarget?.title}"? All registration records will be cancelled.`}
        confirmLabel="Yes, Delete Event"
      />
    </div>
  );
}
