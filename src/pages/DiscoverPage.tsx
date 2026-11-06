import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { EventItem, EventFilterOptions } from '../types';
import { eventsService } from '../services/events-service';
import { authService } from '../services/auth-service';
import { EventCard } from '../components/events/EventCard';
import { EventFilters } from '../components/events/EventFilters';
import { EventListSkeleton, EmptyState } from '../components/ui/LoadingSkeleton';
import { useToast } from '../components/ui/Toast';

export function DiscoverPage() {
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const [filters, setFilters] = useState<EventFilterOptions>({
    query: searchParams.get('q') || '',
    category: searchParams.get('category') || 'All',
    country: searchParams.get('country') || '',
    state: searchParams.get('state') || '',
    city: searchParams.get('city') || '',
    dateRange: (searchParams.get('dateRange') as EventFilterOptions['dateRange']) || 'all',
    startDate: searchParams.get('startDate') || '',
    endDate: searchParams.get('endDate') || '',
    priceType: (searchParams.get('priceType') as EventFilterOptions['priceType']) || 'all',
    sortBy: (searchParams.get('sortBy') as EventFilterOptions['sortBy']) || 'relevance',
  });

  // Saved home location (from Profile) for the one-tap "Near me" filter.
  const savedUser = authService.getCurrentUser();
  const savedLocationLabel = savedUser?.city
    ? [savedUser.city, savedUser.state, savedUser.country].filter(Boolean).join(', ')
    : '';
  const handleSavedLocation = () => {
    if (!savedUser?.city) return;
    updateFilters({
      ...filters,
      country: savedUser.country || '',
      state: savedUser.state || '',
      city: savedUser.city,
    });
  };

  // The location filter is NEVER auto-filled on this page (owner's
  // call, 2026-11-06): no IP-based detection and no silent copy of
  // the saved home location. It starts on "Anywhere" and changes
  // only when the visitor picks a place in the picker, follows a
  // link carrying location URL params, or taps the explicit
  // "Near me: <saved location>" button in the filter bar.
  // (detectLocationByIp is still used by Profile and Create Event —
  // only Discover dropped automatic location.)

  const [events, setEvents] = useState<EventItem[]>([]);
  const [showingLocalOnly, setShowingLocalOnly] = useState(false);
  const [totalResults, setTotalResults] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Sync state with URL params
  const updateFilters = useCallback(
    (newFilters: EventFilterOptions) => {
      setFilters(newFilters);
      setPage(1);

      const params = new URLSearchParams();
      if (newFilters.query) params.set('q', newFilters.query);
      if (newFilters.category && newFilters.category !== 'All') params.set('category', newFilters.category);
      if (newFilters.country) params.set('country', newFilters.country);
      if (newFilters.state) params.set('state', newFilters.state);
      if (newFilters.city) params.set('city', newFilters.city);
      if (newFilters.dateRange && newFilters.dateRange !== 'all') params.set('dateRange', newFilters.dateRange);
      if (newFilters.dateRange === 'custom' && newFilters.startDate && newFilters.endDate) {
        params.set('startDate', newFilters.startDate);
        params.set('endDate', newFilters.endDate);
      }
      if (newFilters.priceType && newFilters.priceType !== 'all') params.set('priceType', newFilters.priceType);
      if (newFilters.sortBy && newFilters.sortBy !== 'relevance') params.set('sortBy', newFilters.sortBy);

      setSearchParams(params);
    },
    [setSearchParams]
  );

  // Debounce the search text for fetching: typing currently refetches
  // (a ~2s call plus a skeleton flash) on every keystroke. The search
  // box and the URL still update immediately; only the fetch waits for
  // a pause in typing. Other filters fetch at once, as before.
  const [debouncedQuery, setDebouncedQuery] = useState(filters.query);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(filters.query), 350);
    return () => clearTimeout(t);
  }, [filters.query]);
  const effectiveFilters = useMemo(
    () => ({ ...filters, query: debouncedQuery }),
    [filters, debouncedQuery],
  );

  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  // Fetch events on filter or page change. A failed refresh used to
  // fail silently (console.error only) and leave the previous list on
  // screen with no indication it was stale — now the page says so and
  // offers a retry.
  useEffect(() => {
    let active = true;
    async function fetchEvents() {
      setLoading(true);
      try {
        const response = await eventsService.getEvents(effectiveFilters, page, 9, { slim: true });
        if (active) {
          setEvents(response.data);
          setShowingLocalOnly(eventsService.lastEventsFromLocal());
          setTotalResults(response.total);
          setTotalPages(response.totalPages);
          setLoadError(false);
        }
      } catch (err) {
        console.error('Failed to load events:', err);
        if (active) setLoadError(true);
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchEvents();
    return () => {
      active = false;
    };
  }, [effectiveFilters, page, retryTick]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header Banner */}
      <div className="pb-4 border-b border-[#E5E1D8]">
        <h1 className="font-editorial text-3xl sm:text-4xl font-bold tracking-tight text-[#1E2320]">
          Discover Local Events
        </h1>
        <p className="text-sm text-[#5F635D] mt-1">
          Explore activities, gatherings, and workshops near you — or pick
          any country, state, and city in the world.
        </p>
      </div>

      {/* Local-only notice: when the shared API fails, this list is just
          this browser's saved events — the reason another device can show
          different results for the same email. */}
      {!loading && showingLocalOnly && (
        <div className="rounded-xl border border-[#E7C87A] bg-[#FDF6E3] px-4 py-3 text-sm text-[#5F635D]">
          <span className="font-semibold text-[#1E2320]">Shared server unreachable — </span>
          showing events saved on this device only. That is why another
          device can show different results right now.
        </div>
      )}

      {!loading && loadError && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex items-center justify-between gap-3">
          <span>
            Couldn't refresh events — showing the last loaded list, which may be out of date.
          </span>
          <button
            type="button"
            onClick={() => setRetryTick((t) => t + 1)}
            className="shrink-0 px-3 py-1.5 bg-white border border-rose-200 rounded-lg text-xs font-semibold hover:bg-rose-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filter Toolbar */}
      <EventFilters
        filters={filters}
        onChange={updateFilters}
        totalResults={totalResults}
        onSavedLocation={savedLocationLabel ? handleSavedLocation : undefined}
        savedLocationLabel={savedLocationLabel}
      />

      {/* Main Events Presentation */}
      {loading ? (
        <EventListSkeleton count={6} />
      ) : events.length === 0 ? (
        <EmptyState
          icon="search"
          title="No events found"
          description="We couldn't find any events matching your selected filters. Try broadening your search or resetting category filters."
          actionLabel="Reset all filters"
          onAction={() =>
            updateFilters({
              query: '',
              category: 'All',
              country: '',
              state: '',
              city: '',
              dateRange: 'all',
              startDate: '',
              endDate: '',
              priceType: 'all',
              sortBy: 'relevance',
            })
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="pt-8 border-t border-[#E5E1D8] flex items-center justify-between text-xs text-[#5F635D]">
          <p>
            Page <span className="font-semibold tabular-nums text-[#1E2320]">{page}</span> of{' '}
            <span className="font-semibold tabular-nums text-[#1E2320]">{totalPages}</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="px-3.5 py-1.5 rounded-lg border border-[#E2DFD8] bg-white hover:bg-[#F4F1EA] text-[#1E2320] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="px-3.5 py-1.5 rounded-lg border border-[#E2DFD8] bg-white hover:bg-[#F4F1EA] text-[#1E2320] disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}

    </div>
  );
}
