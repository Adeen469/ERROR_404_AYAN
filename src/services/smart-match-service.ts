import { EventItem, SmartMatchResult } from '../types';
import { eventsService } from './events-service';
import { authService } from './auth-service';
import { isDemoMode } from './api-client';
import { formatEventLocation, getEventNeighborhood } from '../utils/formatters';

export interface SmartMatchOptions {
  userInterests?: string[];
  // The user's home city (which, under the location rule, is their
  // neighborhood when a state is selected). No separate neighborhood
  // preference exists anymore.
  preferredCity?: string;
  preferFreeOnly?: boolean;
}

export const smartMatchService = {
  async getRecommendations(options?: SmartMatchOptions): Promise<SmartMatchResult[]> {
    // Recommendations are scored HERE, in both live and demo mode.
    // Live mode used to call GET /smart-match/recommendations — an
    // endpoint that was never built on the server (it answers 404),
    // so the page silently showed "Top Matches (0)" for every user
    // even when events matched. The scorer is deterministic and the
    // events already come from the API, so there is nothing for a
    // server round-trip to add. (Owner fix, 2026-11-06.)
    if (isDemoMode()) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    const user = authService.getCurrentUser();
    const interests = options?.userInterests || user?.interests || ['Food & Community', 'Live Music & Culture'];
    // Home city from the saved location: the city is the neighborhood
    // only when a state is selected, otherwise there is no target city.
    const homeCity = options?.preferredCity || (user?.state ? (user?.city || '') : '');
    const preferFree = options?.preferFreeOnly ?? false;

    const { data: events } = await eventsService.getEvents({}, 1, 50);

    const scored: (SmartMatchResult | null)[] = events.map((event: EventItem) => {
      let score = 30; // Baseline score
      const matchReasons: string[] = [];

      // Category / Interest Match (+35)
      const categoryMatched = interests.includes(event.category);
      if (categoryMatched) {
        score += 35;
        matchReasons.push(`Matches your interest in ${event.category}`);
      }

      // Tag Match (+15)
      const matchingTags = event.tags.filter((tag) =>
        interests.some((interest) => interest.toLowerCase().includes(tag.toLowerCase()))
      );
      if (matchingTags.length > 0) {
        score += 15;
        matchReasons.push(`Aligned tags: ${matchingTags.slice(0, 2).join(', ')}`);
      }

      // City Match (+20): the event's derived neighborhood (its city,
      // when it has a state) equals the user's home city.
      const eventNeighborhood = getEventNeighborhood(event);
      if (homeCity && eventNeighborhood && eventNeighborhood === homeCity) {
        score += 20;
        matchReasons.push(`In your city (${homeCity})`);
      } else {
        score += 5;
        const location = formatEventLocation(event);
        if (location) matchReasons.push(`Taking place in ${location}`);
      }

      // Price preference (+10)
      if (preferFree && event.price === 0) {
        score += 10;
        matchReasons.push('Free community admission');
      } else if (!preferFree && event.price === 0) {
        score += 5;
      }

      // High availability boost (+5)
      const remainingCapacity = event.capacity - event.registeredCount;
      if (remainingCapacity > 10) {
        score += 5;
        matchReasons.push('Good seating & registration availability');
      }

      // Cap at 98 for realistic presentation
      const finalScore = Math.min(98, score);

      // Top Matches are recommendations, not the whole catalogue:
      // an event only lists when it genuinely aligns with the
      // selected interests — its category is selected, or one of
      // its tags aligns. Everything used to list with baseline +
      // location/free points (a Technology event scored 60% for a
      // Workshops-only user), so changing interests moved the
      // numbers but never the events. (Owner fix, 2026-11-06.)
      const interestMatched = categoryMatched || matchingTags.length > 0;
      if (!interestMatched) return null;

      return {
        event,
        score: finalScore,
        matchReasons,
      };
    });

    // Sort descending by deterministic score
    return scored
      .filter((r): r is SmartMatchResult => r !== null)
      .sort((a, b) => b.score - a.score);
  },
};
