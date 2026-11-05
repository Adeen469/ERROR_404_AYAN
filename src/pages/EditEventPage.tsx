import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Check, AlertCircle } from 'lucide-react';
import { EventCategory, EventItem } from '../types';
import { DEMO_CATEGORIES } from '../mocks/demo-data';
import { eventsService, isEventOwner } from '../services/events-service';
import { authService } from '../services/auth-service';
import { isAdminEmail } from '../services/roles-service';
import { useToast } from '../components/ui/Toast';
import { ThemedSelect } from '../components/ui/ThemedSelect';
import { FormSkeleton } from '../components/ui/LoadingSkeleton';
import { PRESET_COVER_IMAGES } from './CreateEventPage';
import { getOptionGroups } from '../utils/event-options';

export function EditEventPage() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [event, setEvent] = useState<EventItem | null>(null);
  // True when the loaded event belongs to another organizer. The form is
  // never rendered in that case, and the save is ownership-checked too.
  const [notOwner, setNotOwner] = useState(false);

  // Ownership for this page: the event's owner ONLY. Admins may delete
  // and operate events, but they cannot edit event details.
  const currentUser = authService.getCurrentUser();
  const isAdmin =
    !!currentUser &&
    currentUser.role === 'admin' &&
    isAdminEmail(currentUser.email);
  const ownershipOpts = {
    ownerEmail: currentUser?.email,
    isAdmin,
  };

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('Food & Community');
  const [coverImage, setCoverImage] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  // Optional exact map link (see CreateEventPage). Empty clears it.
  const [mapUrl, setMapUrl] = useState('');

  const [price, setPrice] = useState('0');
  // Attendee details gate (see CreateEventPage): on unless the
  // organizer opted out. Older events predate this flag and behave as
  // if it were on.
  const [requireAttendeeDetails, setRequireAttendeeDetails] = useState(true);
  // Team participation (hackathons only, f-1 + f-2; see CreateEventPage).
  const [participationMode, setParticipationMode] = useState<'individual' | 'team' | 'both'>('individual');
  const [minTeamSize, setMinTeamSize] = useState('2');
  const [maxTeamSize, setMaxTeamSize] = useState('4');
  // Category registration options (workshops & concerts; see
  // CreateEventPage). Drafts are strings until save (blank extra
  // price = 0, blank cap = unlimited).
  const [optionDrafts, setOptionDrafts] = useState<Record<string, { label: string; extraPrice: string; cap: string }[]>>({});
  const addOptionChoice = (groupKey: string) =>
    setOptionDrafts((prev) => ({ ...prev, [groupKey]: [...(prev[groupKey] || []), { label: '', extraPrice: '', cap: '' }] }));
  const updateOptionChoice = (groupKey: string, idx: number, patch: Partial<{ label: string; extraPrice: string; cap: string }>) =>
    setOptionDrafts((prev) => ({
      ...prev,
      [groupKey]: (prev[groupKey] || []).map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  const removeOptionChoice = (groupKey: string, idx: number) =>
    setOptionDrafts((prev) => ({ ...prev, [groupKey]: (prev[groupKey] || []).filter((_, i) => i !== idx) }));
  const [capacity, setCapacity] = useState('50');
  const [tagsInput, setTagsInput] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadEvent() {
      if (!eventId) return;
      setLoading(true);
      try {
        const data = await eventsService.getEventById(eventId);
        if (data) {
          if (!isEventOwner(data, currentUser?.email)) {
            setNotOwner(true);
            setEvent(data);
            return;
          }
          setEvent(data);
          setTitle(data.title);
          setSummary(data.summary);
          setDescription(data.description);
          setCategory(data.category);
          setCoverImage(data.coverImage);
          setStartDate(data.startDate.slice(0, 16));
          setEndDate(data.endDate.slice(0, 16));
          setVenueName(data.venueName);
          setAddress(data.address);
          setMapUrl(data.mapUrl || '');
          setPrice(String(data.price));
          setRequireAttendeeDetails(data.requireAttendeeDetails ?? true);
          // Team participation: older events and non-hackathons carry
          // none, so they load as individual-only.
          setParticipationMode(data.participation?.mode || 'individual');
          setMinTeamSize(String(data.participation?.minTeamSize ?? 2));
          setMaxTeamSize(String(data.participation?.maxTeamSize ?? 4));
          // Category registration options: older events and other
          // categories carry none, so the groups load empty.
          const loadedOptions: Record<string, { label: string; extraPrice: string; cap: string }[]> = {};
          if (data.options && typeof data.options === 'object') {
            for (const g of getOptionGroups(data.category)) {
              const list = Array.isArray(data.options[g.key]) ? data.options[g.key] : [];
              loadedOptions[g.key] = list.map((c: any) => ({
                label: String(c?.label || ''),
                extraPrice: c?.extraPrice ? String(c.extraPrice) : '',
                cap: c?.cap !== undefined && c?.cap !== null ? String(c.cap) : '',
              }));
            }
          }
          setOptionDrafts(loadedOptions);
          setCapacity(String(data.capacity));
          setTagsInput(data.tags.join(', '));
        }
      } finally {
        setLoading(false);
      }
    }
    loadEvent();
  }, [eventId]);

  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    if (!title.trim()) errs.title = 'Title is required.';
    if (!description.trim()) errs.description = 'Description is required.';
    if (!venueName.trim()) errs.venueName = 'Venue name is required.';
    if (!address.trim()) errs.address = 'Street address is required.';
    if (mapUrl.trim()) {
      try {
        const u = new URL(mapUrl.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          errs.mapUrl = 'Map link must start with http:// or https://.';
        } else if (mapUrl.trim().length > 500) {
          errs.mapUrl = 'Map link is too long.';
        }
      } catch {
        errs.mapUrl = 'Map link must be a valid link.';
      }
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime())) errs.startDate = 'Valid start date & time required.';
    if (isNaN(end.getTime())) errs.endDate = 'Valid end date & time required.';
    if (end < start) errs.endDate = 'End date & time must be the same as or after the start date & time.';

    const capNum = Number(capacity);
    if (isNaN(capNum) || capNum <= 0) errs.capacity = 'Capacity must be at least 1 spot.';
    // Mirror the server rules: capacity can never drop below the seats
    // already taken, and an upcoming event's start cannot be moved into
    // the past (already-past events stay editable for corrections).
    const registered = event?.registeredCount || 0;
    if (!isNaN(capNum) && capNum < registered) {
      errs.capacity = `Capacity cannot be below the ${registered} already registered.`;
    }
    const origStart = event ? new Date(event.startDate) : null;
    if (
      origStart &&
      !isNaN(origStart.getTime()) &&
      origStart.getTime() > Date.now() &&
      !isNaN(start.getTime()) &&
      start.getTime() < Date.now() - 5 * 60 * 1000
    ) {
      errs.startDate = 'Start cannot be moved into the past for an upcoming event.';
    }
    if (Number(price) < 0) errs.price = 'Price cannot be negative.';

    // Team participation only applies to hackathons (the section is
    // hidden for every other category).
    if (category === 'Technology & Hackathons' && participationMode !== 'individual') {
      const min = Number(minTeamSize);
      const max = Number(maxTeamSize);
      if (!Number.isInteger(min) || min < 2 || min > 10) errs.minTeamSize = 'Minimum team size must be between 2 and 10.';
      if (!Number.isInteger(max) || max < 2 || max > 10) errs.maxTeamSize = 'Maximum team size must be between 2 and 10.';
      if (Number.isInteger(min) && Number.isInteger(max) && min > max) errs.maxTeamSize = 'Maximum team size cannot be below the minimum.';
    }

    // Category registration options: only workshops and concerts show
    // the section; mirror the server rules (see CreateEventPage).
    for (const g of getOptionGroups(category)) {
      const rows = optionDrafts[g.key] || [];
      if (rows.length > 20) errs[`options_${g.key}`] = 'At most 20 choices per group.';
      const seen = new Set<string>();
      rows.forEach((row, i) => {
        const label = row.label.trim();
        if (!label) errs[`options_${g.key}_${i}`] = 'Choice label is required.';
        else if (label.length > 60) errs[`options_${g.key}_${i}`] = 'Labels must be 60 characters or fewer.';
        else if (seen.has(label.toLowerCase())) errs[`options_${g.key}_${i}`] = 'Labels must be unique within a group.';
        else seen.add(label.toLowerCase());
        const extra = row.extraPrice.trim() === '' ? 0 : Number(row.extraPrice);
        if (!Number.isInteger(extra) || extra < 0 || extra > 100000) errs[`options_${g.key}_${i}`] = 'Extra price must be a whole number of rupees between 0 and 100000.';
        if (row.cap.trim() !== '') {
          const cap = Number(row.cap);
          if (!Number.isInteger(cap) || cap < 1 || cap > 10000) errs[`options_${g.key}_${i}`] = 'Cap must be a whole number between 1 and 10000.';
        }
      });
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!eventId || !validate()) return;

    setSubmitting(true);
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      // Category registration options (workshops & concerts only):
      // null clears the config (no choices left, or the category
      // changed away); the server validates the same rules.
      const buildOptions = () => {
        const out: Record<string, { label: string; extraPrice: number; cap?: number }[]> = {};
        for (const g of getOptionGroups(category)) {
          const rows = (optionDrafts[g.key] || []).filter((r) => r.label.trim());
          if (rows.length === 0) continue;
          out[g.key] = rows.map((r) => {
            const choice: { label: string; extraPrice: number; cap?: number } = {
              label: r.label.trim(),
              extraPrice: r.extraPrice.trim() === '' ? 0 : Number(r.extraPrice),
            };
            if (r.cap.trim() !== '') choice.cap = Number(r.cap);
            return choice;
          });
        }
        return Object.keys(out).length > 0 ? out : null;
      };

      await eventsService.updateEvent(eventId, {
        title: title.trim(),
        summary: summary.trim(),
        description: description.trim(),
        category,
        coverImage,
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate).toISOString(),
        venueName: venueName.trim(),
        address: address.trim(),
        // Empty string clears a previously saved link (the server
        // stores it as-is; the details page falls back to a Maps
        // search whenever it is empty).
        mapUrl: mapUrl.trim(),
        // Location rule: the neighborhood is the city when a state is
        // selected, otherwise none (state/city are carried from the
        // stored event, since the edit form has no location picker).
        neighborhood: event?.state ? (event?.city || '') : '',
        price: Number(price),
        requireAttendeeDetails,
        // Team participation (hackathons only): the server validates
        // the mode and size bounds, and strips this whenever the
        // event is not a hackathon.
        participation:
          category === 'Technology & Hackathons'
            ? { mode: participationMode, minTeamSize: Number(minTeamSize), maxTeamSize: Number(maxTeamSize) }
            : null,
        // Category registration options (workshops & concerts only):
        // null clears a previously saved config.
        options: buildOptions(),
        capacity: Number(capacity),
        tags,
      }, { ...ownershipOpts, allowAdmin: false });

      toast({
        type: 'success',
        title: 'Event Updated',
        description: 'Changes have been saved to your listing.',
      });

      navigate(`/events/${eventId}`);
    } catch {
      toast({
        type: 'error',
        title: 'Failed to update event',
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <FormSkeleton />;
  }

  if (!event) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-4">
        <h2 className="text-xl font-bold text-slate-900">Event Not Found</h2>
        <Link to="/organizer/events" className="text-xs font-semibold text-indigo-600 underline">
          Return to Events
        </Link>
      </div>
    );
  }

  if (notOwner) {
    return (
      <div className="max-w-md mx-auto px-4 py-20 text-center space-y-4">
        <h2 className="font-editorial text-2xl font-bold text-[#1E2320]">
          {isAdmin
            ? 'Admins cannot edit event details'
            : 'This event belongs to another organizer'}
        </h2>
        <p className="text-sm text-[#5F635D]">
          {isAdmin
            ? 'You can delete and manage this event from the Events list, but its details can only be edited by the organizer who created it.'
            : 'You can only edit events you created. This event\'s details are shown to its own organizer, not here.'}
        </p>
        <Link to="/organizer/events" className="text-xs font-semibold text-[#1E3F35] hover:underline">
          Return to Events
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <Link
        to="/organizer/events"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#5F635D] hover:text-[#1E2320] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Events</span>
      </Link>

      <div className="pb-4 border-b border-[#E5E1D8]">
        <h1 className="font-editorial text-3xl font-bold tracking-tight text-[#1E2320]">
          Edit Event Details
        </h1>
        <p className="text-sm text-[#5F635D] mt-1">
          Update event schedules, capacity limits, or venue location.
        </p>
      </div>

      <form onSubmit={handleUpdate} className="space-y-8 bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Event Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
            />
            {errors.title && <p className="text-[11px] text-rose-600 mt-1">{errors.title}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Category *
              </label>
              <ThemedSelect
                value={category}
                options={DEMO_CATEGORIES.map((cat) => ({ value: cat, label: cat }))}
                onChange={(v) => setCategory(v as EventCategory)}
                ariaLabel="Category"
                size="form"
              />
            </div>

          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Description *
            </label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Start Date & Time *
              </label>
              <input
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                End Date & Time *
              </label>
              <input
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Venue Name *
              </label>
              <input
                type="text"
                value={venueName}
                onChange={(e) => setVenueName(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Street Address *
              </label>
              <input
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Map Location Link
            </label>
            <input
              type="url"
              value={mapUrl}
              onChange={(e) => setMapUrl(e.target.value)}
              placeholder="Paste a Google Maps link, e.g. https://maps.app.goo.gl/…"
              className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                errors.mapUrl ? 'border-rose-500' : 'border-[#E2DFD8]'
              }`}
            />
            <p className="text-[11px] text-[#5F635D] mt-1">
              Optional — visitors tap “View in Maps” on your event to open
              this exact location. Clear it to link a search for the street
              address instead.
            </p>
            {errors.mapUrl && (
              <p className="text-[11px] text-rose-600 mt-1">{errors.mapUrl}</p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Capacity *
              </label>
              <input
                type="number"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Price (₹)
              </label>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>


            <div className="flex items-start gap-3 bg-[#FAF8F5] border border-[#E5E1D8] rounded-xl p-4">
              <input
                type="checkbox"
                checked={requireAttendeeDetails}
                onChange={(e) => setRequireAttendeeDetails(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-[#1E3F35]"
              />
              <div>
                <p className="text-xs font-semibold text-[#1E2320]">Require attendee details for registration</p>
                <p className="text-[11px] text-[#8C887E] leading-relaxed mt-0.5">
                  Attendees must provide their full name, mobile number and email, and confirm sharing them with you (the organizer) only, before they can register. Turn this off to let anyone register with no details.
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Tags
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>
          </div>

          {/* Participation — hackathons only (f-1 + f-2). Hidden for
              every other category. Changing the category away from
              hackathons clears this on save. */}
          {category === 'Technology & Hackathons' && (
            <div className="space-y-4">
              <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
                Participation
              </h2>
              <p className="text-[11px] text-[#5F635D] leading-relaxed">
                Choose how attendees register. The ticket price is per person for individual
                registrations and per team for team registrations: the team leader pays once, and
                members join free with the leader&apos;s team code.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  { value: 'individual', label: 'Individual only', hint: 'Everyone registers alone' },
                  { value: 'team', label: 'Team only', hint: 'Everyone registers in a team' },
                  { value: 'both', label: 'Individual or Team', hint: 'Each attendee chooses' },
                ] as const).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setParticipationMode(opt.value)}
                    className={`text-left p-3 rounded-xl border text-xs transition-colors ${
                      participationMode === opt.value
                        ? 'border-[#1E3F35] bg-[#EAF1ED]'
                        : 'border-[#E2DFD8] bg-white hover:border-[#1E3F35]'
                    }`}
                  >
                    <span className="block font-semibold text-[#1E2320]">{opt.label}</span>
                    <span className="block text-[11px] text-[#5F635D] mt-0.5">{opt.hint}</span>
                  </button>
                ))}
              </div>
              {participationMode !== 'individual' && (
                <div className="grid grid-cols-2 gap-4 max-w-sm">
                  <div>
                    <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                      Minimum team size
                    </label>
                    <input
                      type="number"
                      min="2"
                      max="10"
                      value={minTeamSize}
                      onChange={(e) => setMinTeamSize(e.target.value)}
                      className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                        errors.minTeamSize ? 'border-rose-500' : 'border-[#E2DFD8]'
                      }`}
                    />
                    {errors.minTeamSize && <p className="text-[11px] text-rose-600 mt-1">{errors.minTeamSize}</p>}
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                      Maximum team size
                    </label>
                    <input
                      type="number"
                      min="2"
                      max="10"
                      value={maxTeamSize}
                      onChange={(e) => setMaxTeamSize(e.target.value)}
                      className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                        errors.maxTeamSize ? 'border-rose-500' : 'border-[#E2DFD8]'
                      }`}
                    />
                    {errors.maxTeamSize && <p className="text-[11px] text-rose-600 mt-1">{errors.maxTeamSize}</p>}
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Registration Options — workshops & concerts only.
              Hidden for every other category. Changing the category
              away from workshops/concerts clears this on save. */}
          {getOptionGroups(category).length > 0 && (
            <div className="space-y-4">
              <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
                Registration Options
              </h2>
              <p className="text-[11px] text-[#5F635D] leading-relaxed">
                Add the choices attendees pick when registering. Each choice can add an
                extra amount to the ticket price and can have a limit on how many
                attendees may take it. Leave a group empty to skip it.
              </p>
              {getOptionGroups(category).map((g) => (
                <div key={g.key} className="space-y-2">
                  <h3 className="text-xs font-semibold text-[#1E2320]">{g.label}</h3>
                  {(optionDrafts[g.key] || []).map((row, i) => (
                    <div key={i}>
                      <div className="grid grid-cols-[1fr_84px_84px_32px] gap-2 items-center">
                        <input
                          type="text"
                          value={row.label}
                          onChange={(e) => updateOptionChoice(g.key, i, { label: e.target.value })}
                          placeholder="Choice label, e.g. VIP"
                          className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                            errors[`options_${g.key}_${i}`] ? 'border-rose-500' : 'border-[#E2DFD8]'
                          }`}
                        />
                        <input
                          type="number"
                          min="0"
                          max="100000"
                          value={row.extraPrice}
                          onChange={(e) => updateOptionChoice(g.key, i, { extraPrice: e.target.value })}
                          placeholder="+ ₹0"
                          title="Extra price in ₹ (blank = included)"
                          className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
                        />
                        <input
                          type="number"
                          min="1"
                          max="10000"
                          value={row.cap}
                          onChange={(e) => updateOptionChoice(g.key, i, { cap: e.target.value })}
                          placeholder="No limit"
                          title="How many attendees may take this choice (blank = unlimited)"
                          className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
                        />
                        <button
                          type="button"
                          onClick={() => removeOptionChoice(g.key, i)}
                          aria-label="Remove choice"
                          className="w-8 h-8 text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors"
                        >
                          ×
                        </button>
                      </div>
                      {errors[`options_${g.key}_${i}`] && <p className="text-[11px] text-rose-600 mt-1">{errors[`options_${g.key}_${i}`]}</p>}
                    </div>
                  ))}
                  {errors[`options_${g.key}`] && <p className="text-[11px] text-rose-600">{errors[`options_${g.key}`]}</p>}
                  <button
                    type="button"
                    onClick={() => addOptionChoice(g.key)}
                    className="text-xs font-semibold text-[#1E3F35] hover:underline"
                  >
                    + Add choice
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pt-6 border-t border-[#EBE7DF] flex items-center justify-end gap-3">
          <Link
            to="/organizer/events"
            className="px-4 py-2.5 text-xs font-medium text-[#5F635D] hover:text-[#1E2320]"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors shadow-xs"
          >
            {submitting ? 'Saving Changes...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
