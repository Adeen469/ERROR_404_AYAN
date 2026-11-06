import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Image, AlertCircle, Sparkles, Check } from 'lucide-react';
import { EventCategory, EventItem } from '../types';
import { DEMO_CATEGORIES } from '../mocks/demo-data';
import { LocationPicker } from '../components/LocationPicker';
import { ThemedSelect } from '../components/ui/ThemedSelect';
import { ImageUploadField } from '../components/events/ImageUploadField';
import { DateTimePicker } from '../components/events/DateTimePicker';
import { eventsService } from '../services/events-service';
import { detectLocationByIp } from '../services/location-service';
import { authService } from '../services/auth-service';
import { useToast } from '../components/ui/Toast';

// Cover images live in src/assets/images. They must be imported so Vite
// bundles them into dist/ for production. A plain src/ URL
// string only works in Vite dev (via vite.middlewares) and 404s in a
// production build, which is why the cards showed broken images.
import techHackathonImg from '../assets/images/event_tech_hackathon_1792850960780.jpg';
import farmersMarketImg from '../assets/images/event_farmers_market_1792850961672.jpg';
import acousticMusicImg from '../assets/images/event_acoustic_music_1792850962324.jpg';
import morningYogaImg from '../assets/images/event_morning_yoga_1792850962615.jpg';
import { getOptionGroups } from '../utils/event-options';

// One preset per category (7 categories, 7 covers). Four are the bundled
// images; the other three are stable Unsplash photos, because binary
// images cannot be pushed through the text-only push route used here.
// The hero gathering image is still used on Home/Landing, just not as a
// preset anymore.
export const PRESET_COVER_IMAGES: { name: string; url: string; category: EventCategory }[] = [
  {
    name: 'Tech & Hackathon',
    url: techHackathonImg,
    category: 'Technology & Hackathons',
  },
  {
    name: 'Workshop & Learning',
    url: 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=800&auto=format&fit=crop&q=80',
    category: 'Workshops & Learning',
  },
  {
    name: 'Acoustic Concert',
    url: acousticMusicImg,
    category: 'Live Music & Culture',
  },
  {
    name: 'Morning Wellness & Yoga',
    url: morningYogaImg,
    category: 'Fitness & Outdoors',
  },
  {
    name: 'Farmers & Food Market',
    url: farmersMarketImg,
    category: 'Food & Community',
  },
  {
    name: 'Art & Creative',
    url: 'https://images.unsplash.com/photo-1541961017774-22349e4a1262?w=800&auto=format&fit=crop&q=80',
    category: 'Art & Creative',
  },
  {
    name: 'Volunteering & Impact',
    url: 'https://images.unsplash.com/photo-1593113598332-cd288d649433?w=800&auto=format&fit=crop&q=80',
    category: 'Volunteering & Impact',
  },
];

// Category -> its preset cover. Used when the dropdown category changes.
export const CATEGORY_COVER: Record<EventCategory, string> = Object.fromEntries(
  PRESET_COVER_IMAGES.map((preset) => [preset.category, preset.url]),
) as Record<EventCategory, string>;

// Format a Date as a datetime-local value (local time, YYYY-MM-DDTHH:MM).
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Default schedule: tomorrow 18:00-21:00, so the form never opens with a
// past date (the old hardcoded 2026-11-20 defaults would go stale).
function defaultStart(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(18, 0, 0, 0);
  return toLocalInput(d);
}
function defaultEnd(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(21, 0, 0, 0);
  return toLocalInput(d);
}

export function CreateEventPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const currentUser = authService.getCurrentUser();

  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('Food & Community');
  // Free-text category. When non-empty it wins over the dropdown, and no
  // preset cover is selected (see handleCustomCategoryChange).
  const [customCategory, setCustomCategory] = useState('');
  const [coverImage, setCoverImage] = useState(CATEGORY_COVER['Food & Community']);
  // Uploaded cover (data URL from ImageUploadField). Only one cover source
  // is active at a time: picking a preset or uploading clears the other.
  const [uploadedImage, setUploadedImage] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultEnd);

  // Dropdown category -> auto-select that category's preset cover, and
  // clear any custom category text.
  const handleCategoryChange = (v: string) => {
    const next = v as EventCategory;
    setCategory(next);
    setCustomCategory('');
    setCoverImage(CATEGORY_COVER[next]);
    setUploadedImage(null);
  };

  // Custom category text -> no preset cover is selected. Clearing the
  // text restores the dropdown category's cover.
  const handleCustomCategoryChange = (text: string) => {
    setCustomCategory(text);
    if (text.trim()) {
      setCoverImage('');
      setUploadedImage(null);
    } else {
      setCoverImage(CATEGORY_COVER[category]);
    }
  };

  // "Now", recomputed on each render: the Start picker's earliest
  // allowed datetime. The End picker's earliest is the Start value.
  const nowInput = toLocalInput(new Date());

  // Moving Start later must never leave End before it: snap End to the
  // new Start (same date & time is allowed) instead of leaving an
  // invalid pair for submit validation to catch.
  const handleStartChange = (v: string) => {
    setStartDate(v);
    if (endDate && endDate < v) setEndDate(v);
  };

  // Worldwide event location (Country -> State -> City). Previously every
  // event was silently fixed to 'Metro City' with no way to change it.
  const [location, setLocation] = useState({ country: '', state: '', city: '' });

  // Hover preview for preset covers: the enlarged image, fitted to the
  // viewport, with NO blurred or dimmed background — the page behind it
  // stays exactly as it is. The preview only appears after the cursor
  // has rested on a cover for 1.8 seconds, so merely passing over the grid
  // never pops a preview up. Leaving the enlarged picture (or clicking
  // outside it) closes it again.
  const [hoveredCover, setHoveredCover] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHoverPreview = () => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const startHoverPreview = (url: string) => {
    // A different cover: drop any preview already showing, then wait the
    // full 1.8 seconds for this one. Leaving the card cancels the timer
    // (see onMouseLeave on the preset button) without closing a preview
    // that is already showing — that one closes on its own mouse-leave.
    setHoveredCover(null);
    cancelHoverPreview();
    hoverTimer.current = setTimeout(() => {
      setHoveredCover(url);
      hoverTimer.current = null;
    }, 1800);
  };

  // Close the preview on Escape as well as on mouse-leave / outside click.
  useEffect(() => {
    if (!hoveredCover) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHoveredCover(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [hoveredCover]);

  // Never let a pending preview timer fire after leaving the page.
  useEffect(() => cancelHoverPreview, []);

  // Country/state/city from the organizer's IP address, filled once on
  // open. Only fills blank fields: if the organizer has already picked a
  // location, their choice is never overwritten. Fails silently (the
  // manual picker stays) when the lookup service is unreachable.
  const [locationAutoFilled, setLocationAutoFilled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void detectLocationByIp().then((loc) => {
      if (cancelled || !loc) return;
      setLocation((prev) =>
        prev.country || prev.state || prev.city ? prev : loc,
      );
      setLocationAutoFilled(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [venueName, setVenueName] = useState('');
  const [address, setAddress] = useState('');
  // Optional exact map link (e.g. a Google Maps share link) the
  // organizer pastes. The details page "View in Maps" opens this exact
  // location; when blank it falls back to a Maps search for the address.
  const [mapUrl, setMapUrl] = useState('');
  // Optional community links (WhatsApp group invite / community
  // page). The event page reveals them only to attendees with a
  // confirmed registration.
  const [whatsappGroupUrl, setWhatsappGroupUrl] = useState('');
  const [communityUrl, setCommunityUrl] = useState('');
  const [price, setPrice] = useState('0');
  // Attendee details gate: on by default. When on, registering requires
  // the attendee's name, mobile number and email, plus a confirmation
  // that those details are shared with the organizer only.
  const [requireAttendeeDetails, setRequireAttendeeDetails] = useState(true);
  // Team participation (Technology & Hackathons only, f-1 + f-2):
  // Individual only / Team only / Individual or Team, plus the
  // min/max team size the attendee picks (2..10). The ticket price
  // is per team for team registrations — the leader pays once and
  // members join free with the leader's team code.
  const [participationMode, setParticipationMode] = useState<'individual' | 'team' | 'both'>('individual');
  const [minTeamSize, setMinTeamSize] = useState('2');
  const [maxTeamSize, setMaxTeamSize] = useState('4');
  // Category registration options (Workshops & Learning, Live Music &
  // Culture): organizer-defined choices per group — label, optional
  // extra price in ₹, optional cap. A group with no choices is not
  // shown to attendees. Drafts are strings until submit (blank extra
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
  const [tagsInput, setTagsInput] = useState('Community, Gathering');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  // One stable id per form session: a double-submit or a retry after a
  // lost response reuses it, and the server returns the existing event
  // instead of creating a duplicate listing.
  const formEventIdRef = useRef(`evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

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
    for (const [key, val] of [['whatsappGroupUrl', whatsappGroupUrl], ['communityUrl', communityUrl]] as const) {
      if (val.trim()) {
        try {
          const u = new URL(val.trim());
          if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            errs[key] = 'Link must start with http:// or https://.';
          } else if (val.trim().length > 500) {
            errs[key] = 'Link is too long.';
          }
        } catch {
          errs[key] = 'Link must be a valid link.';
        }
      }
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    const now = new Date();
    if (isNaN(start.getTime())) errs.startDate = 'Valid start date & time required.';
    else if (start < now) errs.startDate = 'Start date & time cannot be in the past.';
    if (isNaN(end.getTime())) errs.endDate = 'Valid end date & time required.';
    else if (end < now) errs.endDate = 'End date & time cannot be in the past.';
    else if (end < start) errs.endDate = 'End date & time must be the same as or after the start date & time.';

    const capNum = Number(capacity);
    if (isNaN(capNum) || capNum <= 0) errs.capacity = 'Capacity must be at least 1 spot.';

    const priceNum = Number(price);
    if (isNaN(priceNum) || priceNum < 0) errs.price = 'Price cannot be negative.';

    // Team participation only applies to hackathons (the section is
    // hidden for every other category, custom categories included).
    const isHackathon = (customCategory.trim() ? customCategory.trim() : category) === 'Technology & Hackathons';
    if (isHackathon && participationMode !== 'individual') {
      const min = Number(minTeamSize);
      const max = Number(maxTeamSize);
      if (!Number.isInteger(min) || min < 2 || min > 10) errs.minTeamSize = 'Minimum team size must be between 2 and 10.';
      if (!Number.isInteger(max) || max < 2 || max > 10) errs.maxTeamSize = 'Maximum team size must be between 2 and 10.';
      if (Number.isInteger(min) && Number.isInteger(max) && min > max) errs.maxTeamSize = 'Maximum team size cannot be below the minimum.';
    }

    // Category registration options: only workshops and concerts show
    // the section; mirror the server rules (labels unique per group,
    // extra price 0..100000, cap 1..10000 or blank, max 20 choices).
    const optCategory = customCategory.trim() ? customCategory.trim() : category;
    for (const g of getOptionGroups(optCategory)) {
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Entry guard: the button disables only after a render, so two
    // rapid submits could previously reach the server as two events.
    if (submitting) return;
    if (!validate()) {
      toast({
        type: 'error',
        title: 'Validation Error',
        description: 'Please correct the highlighted fields before submitting.',
      });
      return;
    }

    // Ownership: the event is attributed to the signed-in user, not to a
    // shared demo organizer. Without a signed-in user there is no owner,
    // so the event cannot be created (the OrganizerGuard already blocks
    // guests from reaching this page; this is the defensive second check).
    if (!currentUser) {
      toast({
        type: 'error',
        title: 'Sign in required',
        description: 'Please sign in before creating an event.',
      });
      return;
    }

    setSubmitting(true);
    try {
      const activeImage = uploadedImage || coverImage;
      // Custom category text wins over the dropdown; it is not one of the
      // preset EventCategory values, so it is cast at the boundary here.
      const effectiveCategory = customCategory.trim()
        ? (customCategory.trim() as EventCategory)
        : category;
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      // Category registration options (workshops & concerts only):
      // groups with no choices are dropped; a blank extra price is 0
      // (included) and a blank cap is unlimited. The server validates
      // the same rules and strips this for any other category.
      const buildOptions = () => {
        const out: Record<string, { label: string; extraPrice: number; cap?: number }[]> = {};
        for (const g of getOptionGroups(effectiveCategory)) {
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
        return Object.keys(out).length > 0 ? out : undefined;
      };

      const newEvent = await eventsService.createEvent({
        id: formEventIdRef.current,
        title: title.trim(),
        summary: summary.trim() || description.trim().slice(0, 140),
        description: description.trim(),
        category: effectiveCategory,
        coverImage: activeImage,
        startDate: new Date(startDate).toISOString(),
        endDate: new Date(endDate).toISOString(),
        venueName: venueName.trim(),
        address: address.trim(),
        mapUrl: mapUrl.trim() || undefined,
        whatsappGroupUrl: whatsappGroupUrl.trim() || undefined,
        communityUrl: communityUrl.trim() || undefined,
        // Location rule: the neighborhood is the city when a state is
        // selected, otherwise none.
        neighborhood: location.state.trim() ? (location.city.trim() || 'Metro City') : '',
        city: location.city.trim() || 'Metro City',
        state: location.state.trim() || undefined,
        country: location.country.trim() || undefined,
        price: Number(price),
        requireAttendeeDetails,
        // Team participation (hackathons only): the server validates
        // the mode and size bounds, and strips this for any other
        // category. The price above is per team for team registrations.
        participation:
          effectiveCategory === 'Technology & Hackathons'
            ? { mode: participationMode, minTeamSize: Number(minTeamSize), maxTeamSize: Number(maxTeamSize) }
            : undefined,
        // Category registration options (workshops & concerts only).
        options: getOptionGroups(effectiveCategory).length > 0 ? buildOptions() : undefined,
        capacity: Number(capacity),
        tags,
        organizer: {
          id: currentUser.id,
          name: currentUser.name,
          slug: currentUser.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          avatar: currentUser.avatar,
          bio: currentUser.bio,
          email: currentUser.email,
          location: [currentUser.state, currentUser.city].filter(Boolean).join(', '),
          eventsCount: 0,
          totalAttendeesServed: 0,
        },
        createdByEmail: currentUser.email,
      });

      if (newEvent._pendingSync) {
        // The shared server did not take it: it lives only in this
        // browser until the sync lands. Say so plainly instead of
        // claiming it is published for everyone.
        toast({
          type: 'info',
          title: 'Saved on this device only',
          description: `"${newEvent.title}" could not reach the shared server, so other devices and users can't see it yet. It will sync automatically once the server is reachable.`,
        });
      } else {
        toast({
          type: 'success',
          title: 'Event Created Successfully',
          description: `"${newEvent.title}" is now published and open for RSVPs.`,
        });
      }

      navigate(`/events/${newEvent.id}`);
    } catch {
      toast({
        type: 'error',
        title: 'Failed to create event',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Back button */}
      <Link
        to="/organizer/dashboard"
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#5F635D] hover:text-[#1E2320] transition-colors"
      >
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Organizer Console</span>
      </Link>

      {/* Header */}
      <div className="pb-4 border-b border-[#E5E1D8]">
        <h1 className="font-editorial text-3xl font-bold tracking-tight text-[#1E2320]">
          Create New Community Event
        </h1>
        <p className="text-sm text-[#5F635D] mt-1">
          Publish a gathering, workshop, meetup, or performance for local residents.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-8 bg-white p-6 sm:p-8 rounded-2xl border border-[#E5E1D8] shadow-xs">
        {/* Section: Basics */}
        <div className="space-y-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            1. Event Overview
          </h2>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Event Title *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Downtown Weekend Artisan & Coffee Walk"
              className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] focus:ring-1 focus:ring-[#1E3F35] ${
                errors.title ? 'border-rose-500' : 'border-[#E2DFD8]'
              }`}
            />
            {errors.title && <p className="text-[11px] text-rose-600 mt-1">{errors.title}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Category *
              </label>
              <ThemedSelect
                value={customCategory.trim() ? customCategory : category}
                options={DEMO_CATEGORIES.map((cat) => ({ value: cat, label: cat }))}
                onChange={handleCategoryChange}
                ariaLabel="Category"
                size="form"
                customValue={customCategory}
                onCustomChange={handleCustomCategoryChange}
                customPlaceholder="e.g. Charity Run"
                customLabel="Or type a custom category"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Short Summary (1-2 sentences)
              </label>
              <input
                type="text"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Brief takeaway shown on discovery cards"
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Detailed Description *
            </label>
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What can attendees expect? Outline schedule, what to bring, and special guidelines."
              className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] focus:ring-1 focus:ring-[#1E3F35] ${
                errors.description ? 'border-rose-500' : 'border-[#E2DFD8]'
              }`}
            />
            {errors.description && (
              <p className="text-[11px] text-rose-600 mt-1">{errors.description}</p>
            )}
          </div>
        </div>

        {/* Section: Visual Asset Selection */}
        <div className="space-y-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            2. Cover Artwork
          </h2>
          <p className="text-[11px] text-[#5F635D]">
            Tip: hover over a cover for 1.8 seconds to preview it enlarged.
          </p>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {PRESET_COVER_IMAGES.map((preset) => {
              const selected =
                coverImage === preset.url && !uploadedImage;
              return (
                <button
                  key={preset.name}
                  type="button"
                  onMouseEnter={() => startHoverPreview(preset.url)}
                  onMouseLeave={cancelHoverPreview}
                  onClick={() => {
                    // Clicking selects at once — a preview must not pop up
                    // 1.8 seconds later for a cover the user already picked.
                    cancelHoverPreview();
                    // Picking a preset also switches back to its category,
                    // so a custom category can never sit under a preset.
                    setCoverImage(preset.url);
                    setCategory(preset.category);
                    setCustomCategory('');
                    setUploadedImage(null);
                  }}
                  className={`relative rounded-xl overflow-hidden aspect-[4/3] border-2 transition-all cursor-pointer ${
                    selected ? 'border-[#1E3F35] shadow-md ring-2 ring-[#D0E2D9]' : 'border-transparent opacity-80 hover:opacity-100'
                  }`}
                >
                  <img
                    src={preset.url}
                    alt={preset.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                  {selected && (
                    <div className="absolute top-1.5 right-1.5 p-1 bg-[#1E3F35] text-white rounded-full">
                      <Check className="w-3 h-3" />
                    </div>
                  )}
                  <div className="absolute bottom-0 inset-x-0 bg-[#1E2320]/80 p-1 text-[10px] text-white text-center truncate">
                    {preset.name}
                  </div>
                </button>
              );
            })}
          </div>

          {customCategory.trim() && !uploadedImage && !coverImage && (
            <p className="text-[11px] text-[#5F635D]">
              No cover selected for this custom category — upload one below.
            </p>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Or Upload Your Own Image
            </label>
            <ImageUploadField
              uploadedImage={uploadedImage}
              onUpload={(dataUrl) => {
                setUploadedImage(dataUrl);
              }}
              onRemove={() => setUploadedImage(null)}
            />
          </div>
        </div>

        {/* Hover preview, preview only: no dimming, no backdrop blur —
            the page behind stays fully visible. The wrapper (not just the
            image) owns the mouse-leave, so the Close button below the
            image can actually be clicked without the preview vanishing
            first. Clicking outside the picture, or pressing Escape, also
            closes it. */}
        {hoveredCover && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={() => setHoveredCover(null)}
          >
            <div
              className="flex flex-col items-center gap-2"
              onMouseLeave={() => setHoveredCover(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={hoveredCover}
                alt="Cover preview"
                className="max-w-[90vw] max-h-[85vh] w-auto h-auto object-contain rounded-2xl shadow-2xl"
              />
              <button
                type="button"
                onClick={() => setHoveredCover(null)}
                className="px-3 py-1.5 text-xs font-semibold text-white bg-[#1E2320]/90 hover:bg-[#1E2320] rounded-lg cursor-pointer"
              >
                Close preview
              </button>
            </div>
          </div>
        )}

        {/* Section: Date, Time & Venue */}
        <div className="space-y-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            3. Schedule & Location
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Start Date & Time *
              </label>
              <DateTimePicker
                value={startDate}
                onChange={handleStartChange}
                earliest={nowInput}
                ariaLabel="Start date and time"
                hasError={!!errors.startDate}
              />
              {errors.startDate && (
                <p className="text-[11px] text-rose-600 mt-1">{errors.startDate}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                End Date & Time *
              </label>
              <DateTimePicker
                value={endDate}
                onChange={(v) => setEndDate(v)}
                earliest={startDate || nowInput}
                ariaLabel="End date and time"
                hasError={!!errors.endDate}
              />
              {errors.endDate && (
                <p className="text-[11px] text-rose-600 mt-1">{errors.endDate}</p>
              )}
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
                placeholder="e.g. Waterfront Community Hall"
                className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                  errors.venueName ? 'border-rose-500' : 'border-[#E2DFD8]'
                }`}
              />
              {errors.venueName && (
                <p className="text-[11px] text-rose-600 mt-1">{errors.venueName}</p>
              )}
            </div>

          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Event Location — Country, State, City
            </label>
            <LocationPicker mode="form" value={location} onChange={setLocation} />
            <p className="text-[11px] text-[#5F635D] mt-1">
              Pick anywhere in the world. If left blank, the event stays
              listed under Metro City as before.
              {locationAutoFilled &&
                ' Country and state were filled from your connection — change them if the event is elsewhere.'}
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Street Address *
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g. 240 Pier Street"
              className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                errors.address ? 'border-rose-500' : 'border-[#E2DFD8]'
              }`}
            />
            {errors.address && (
              <p className="text-[11px] text-rose-600 mt-1">{errors.address}</p>
            )}
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
              this exact location. Leave it blank to link a search for the
              street address instead.
            </p>
            {errors.mapUrl && (
              <p className="text-[11px] text-rose-600 mt-1">{errors.mapUrl}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
              Community Links
            </label>
            <div className="space-y-2">
              <input
                type="url"
                value={whatsappGroupUrl}
                onChange={(e) => setWhatsappGroupUrl(e.target.value)}
                placeholder="WhatsApp group link, e.g. https://chat.whatsapp.com/…"
                className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                  errors.whatsappGroupUrl ? 'border-rose-500' : 'border-[#E2DFD8]'
                }`}
              />
              <input
                type="url"
                value={communityUrl}
                onChange={(e) => setCommunityUrl(e.target.value)}
                placeholder="Community link, e.g. https://…"
                className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                  errors.communityUrl ? 'border-rose-500' : 'border-[#E2DFD8]'
                }`}
              />
            </div>
            <p className="text-[11px] text-[#5F635D] mt-1">
              Optional — these links stay hidden until an attendee registers
              for your event; only registered attendees can see and open them.
            </p>
            {errors.whatsappGroupUrl && (
              <p className="text-[11px] text-rose-600 mt-1">{errors.whatsappGroupUrl}</p>
            )}
            {errors.communityUrl && (
              <p className="text-[11px] text-rose-600 mt-1">{errors.communityUrl}</p>
            )}
          </div>
        </div>

        {/* Section: Capacity & Pricing */}
        <div className="space-y-4">
          <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
            4. Capacity & Pricing
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Attendee Capacity *
              </label>
              <input
                type="number"
                min="1"
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                  errors.capacity ? 'border-rose-500' : 'border-[#E2DFD8]'
                }`}
              />
              {errors.capacity && (
                <p className="text-[11px] text-rose-600 mt-1">{errors.capacity}</p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#1E2320] mb-1.5">
                Ticket Price (₹) *
              </label>
              <input
                type="number"
                min="0"
                step="1"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="0 for free"
                className={`w-full text-xs bg-white border rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35] ${
                  errors.price ? 'border-rose-500' : 'border-[#E2DFD8]'
                }`}
              />
              <span className="text-[11px] text-[#8C887E]">Set 0 for free community RSVP</span>
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
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="Outdoor, Music, Workshop"
                className="w-full text-xs bg-white border border-[#E2DFD8] rounded-lg p-3 text-[#1E2320] focus:border-[#1E3F35]"
              />
            </div>
          </div>
        </div>

        {/* Section: Participation — hackathons only (f-1 + f-2). Hidden
            for every other category, custom categories included. */}
        {(customCategory.trim() ? customCategory.trim() : category) === 'Technology & Hackathons' && (
          <div className="space-y-4">
            <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
              5. Participation
            </h2>
            <p className="text-[11px] text-[#5F635D] leading-relaxed">
              Choose how attendees register. The ticket price above is per person for individual
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

        {/* Section: Registration Options — workshops & concerts only.
            Hidden for every other category, custom categories included. */}
        {getOptionGroups(customCategory.trim() ? customCategory.trim() : category).length > 0 && (
          <div className="space-y-4">
            <h2 className="font-editorial text-base font-bold text-[#1E2320] pb-2 border-b border-[#EBE7DF]">
              6. Registration Options
            </h2>
            <p className="text-[11px] text-[#5F635D] leading-relaxed">
              Add the choices attendees pick when registering. Each choice can add an
              extra amount to the ticket price and can have a limit on how many
              attendees may take it. Leave a group empty to skip it.
            </p>
            {getOptionGroups(customCategory.trim() ? customCategory.trim() : category).map((g) => (
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

        {/* Submit Bar */}
        <div className="pt-6 border-t border-[#EBE7DF] flex items-center justify-end gap-3">
          <Link
            to="/organizer/dashboard"
            className="px-4 py-2.5 text-xs font-medium text-[#5F635D] hover:text-[#1E2320]"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="px-6 py-2.5 bg-[#1E3F35] hover:bg-[#163028] text-white text-xs font-semibold rounded-lg transition-colors shadow-xs"
          >
            {submitting ? 'Publishing Event...' : 'Publish Event'}
          </button>
        </div>
      </form>
    </div>
  );
}
