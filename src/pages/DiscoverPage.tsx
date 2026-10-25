import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LayoutGrid, List } from 'lucide-react';
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
    neighborhood: searchParams.get('neighborhood') || 'All',
    country: searchParams.get('country') || '',
    state: searchParams.get('state') || '',
    city: searchParams.get('city') || '',
    dateRange: (searchParams.get('dateRange') as EventFilterOptions['dateRange']) || 'all',
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

  const [events, setEvents] = useState<EventItem[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');

  // Sync state with URL params
  const updateFilters = useCallback(
    (newFilters: EventFilterOptions) => {
      setFilters(newFilters);
      setPage(1);

      const params = new URLSearchParams();
      if (newFilters.query) params.set('q', newFilters.query);
      if (newFilters.category && newFilters.category !== 'All') params.set('category', newFilters.category);
      if (newFilters.neighborhood && newFilters.neighborhood !== 'All') params.set('neighborhood', newFilters.neighborhood);
      if (newFilters.country) params.set('country', newFilters.country);
      if (newFilters.state) params.set('state', newFilters.state);
      if (newFilters.city) params.set('city', newFilters.city);
      if (newFilters.dateRange && newFilters.dateRange !== 'all') params.set('dateRange', newFilters.dateRange);
      if (newFilters.priceType && newFilters.priceType !== 'all') params.set('priceType', newFilters.priceType);
      if (newFilters.sortBy && newFilters.sortBy !== 'relevance') params.set('sortBy', newFilters.sortBy);

      setSearchParams(params);
    },
    [setSearchParams]
  );

  // Fetch events on filter or page change
  useEffect(() => {
    let active = true;
    async function fetchEvents() {
      setLoading(true);
      try {
        const response = await eventsService.getEvents(filters, page, 9);
        if (active) {
          setEvents(response.data);
          setTotalResults(response.total);
          setTotalPages(response.totalPages);
        }
      } catch (err) {
        console.error('Failed to load events:', err);
      } finally {
        if (active) setLoading(false);
      }
    }
    fetchEvents();
    return () => {
      active = false;
    };
  }, [filters, page]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header Banner */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-4 border-b border-[#E5E1D8]">
        <div>
          <h1 className="font-editorial text-3xl sm:text-4xl font-bold tracking-tight text-[#1E2320]">
            Discover Local Events
          </h1>
          <p className="text-sm text-[#5F635D] mt-1">
            Explore activities, gatherings, and workshops near you — or pick
            any country, state, and city in the world.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* View Toggle */}
          <div className="hidden sm:flex items-center gap-1 bg-white border border-[#E2DFD8] rounded-lg p-1 self-start md:self-auto shadow-2xs">
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'grid' ? 'bg-[#1E3F35] text-white' : 'text-[#8C887E] hover:text-[#1E2320]'
              }`}
              aria-label="Grid layout"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-md transition-colors ${
                viewMode === 'list' ? 'bg-[#1E3F35] text-white' : 'text-[#8C887E] hover:text-[#1E2320]'
              }`}
              aria-label="List layout"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

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
              neighborhood: 'All',
              country: '',
              state: '',
              city: '',
              dateRange: 'all',
              priceType: 'all',
              sortBy: 'relevance',
            })
          }
        />
      ) : (
        <div
          className={
            viewMode === 'grid'
              ? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6'
              : 'flex flex-col gap-4'
          }
        >
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
