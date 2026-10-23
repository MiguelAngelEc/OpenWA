import { BadRequestException, Injectable, NotImplementedException } from '@nestjs/common';
import { SearchProviderRegistry } from './search-provider.registry';
import { SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX, SEARCH_OFFSET_MAX, SEARCH_TERMS_MAX } from './search.constants';
import { searchTermCount } from './search-terms';
import type { SearchQuery, SearchResults } from './search.types';

@Injectable()
export class SearchService {
  constructor(private readonly registry: SearchProviderRegistry) {}

  async search(query: SearchQuery, callerSessionIds?: string[], callerChatIds?: string[]): Promise<SearchResults> {
    const provider = this.registry.active();
    if (!provider) throw new NotImplementedException('Search is not configured (no active search provider).');
    // Bounded here, ahead of every provider: the cost of a query grows with its words, whatever backend
    // runs it. Counted as the index counts them, so a token with punctuation inside it is several.
    if (searchTermCount(query.q) > SEARCH_TERMS_MAX) {
      throw new BadRequestException(`q may hold at most ${SEARCH_TERMS_MAX} words, punctuation included.`);
    }
    // Auth scoping is authoritative — a caller cannot override it via the query. This covers both
    // fences: sessions (allowedSessions) and chats (allowedChats, expanded lid-aware by the caller),
    // each undefined for an unrestricted key. Bound pagination host-side so EVERY provider
    // (built-in + plugin) receives capped values: the built-in re-clamps in its own SQL, but a
    // plugin would otherwise receive the raw caller value and could pressure host heap by
    // returning an oversized page.
    const scoped: SearchQuery = {
      ...query,
      sessionIds: callerSessionIds,
      chatIds: callerChatIds,
      limit: Math.min(query.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_LIMIT_MAX),
      offset: Math.min(query.offset ?? 0, SEARCH_OFFSET_MAX),
    };
    return provider.search(scoped);
  }

  async health() {
    const provider = this.registry.active();
    if (!provider) return { ok: false, detail: 'no provider' };
    return provider.health();
  }
}
