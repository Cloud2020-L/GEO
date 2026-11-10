import { getScopedStorageItem, removeScopedStorageItem, scopedStorageKey, setScopedStorageItem } from './scopedStorage';
import type { MediaMarketImageAsset } from './mediaMarketContent';

const MEDIA_MARKET_DRAFT_KEY = 'example.com.v1';

export interface MediaMarketDistributionDraft {
  draft_id?: string;
  title: string;
  content: string;
  display_content?: string;
  content_format?: 'text' | 'markdown' | 'html';
  images?: MediaMarketImageAsset[];
  link?: string;
  source?: string;
  updated_at: string;
}

const parseDraft = (raw: string | null): MediaMarketDistributionDraft | null => {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MediaMarketDistributionDraft;
    if (!parsed || (!parsed.title && !parsed.content)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const readMediaMarketDraft = (): MediaMarketDistributionDraft | null => {
  try {
    const scopedSessionDraft = parseDraft(window.sessionStorage.getItem(scopedStorageKey(MEDIA_MARKET_DRAFT_KEY)));
    if (scopedSessionDraft) return scopedSessionDraft;
    const legacySessionDraft = parseDraft(window.sessionStorage.getItem(MEDIA_MARKET_DRAFT_KEY));
    if (legacySessionDraft) return legacySessionDraft;
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(`${MEDIA_MARKET_DRAFT_KEY}::`)) {
        const fallback = parseDraft(window.sessionStorage.getItem(key));
        if (fallback) return fallback;
      }
    }
    return parseDraft(getScopedStorageItem(MEDIA_MARKET_DRAFT_KEY));
  } catch {
    return null;
  }
};

export const saveMediaMarketDraft = (draft: Omit<MediaMarketDistributionDraft, 'updated_at'>) => {
  const nextDraft: MediaMarketDistributionDraft = {
    ...draft,
    title: String(draft.title || '').trim(),
    content: String(draft.content || '').trim(),
    display_content: String(draft.display_content || draft.content || '').trim(),
    content_format: draft.content_format || 'markdown',
    images: draft.images || [],
    updated_at: new Date().toISOString(),
  };
  const serialized = JSON.stringify(nextDraft);
  try {
    window.sessionStorage.setItem(scopedStorageKey(MEDIA_MARKET_DRAFT_KEY), serialized);
    window.sessionStorage.setItem(MEDIA_MARKET_DRAFT_KEY, serialized);
  } catch {
    // sessionStorage may be unavailable in private or embedded browsers.
  }
  setScopedStorageItem(MEDIA_MARKET_DRAFT_KEY, serialized);
  return nextDraft;
};

export const clearMediaMarketDraft = () => {
  try {
    window.sessionStorage.removeItem(scopedStorageKey(MEDIA_MARKET_DRAFT_KEY));
    window.sessionStorage.removeItem(MEDIA_MARKET_DRAFT_KEY);
    const keys: string[] = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key?.startsWith(`${MEDIA_MARKET_DRAFT_KEY}::`)) keys.push(key);
    }
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // no-op
  }
  removeScopedStorageItem(MEDIA_MARKET_DRAFT_KEY);
};
