import { PORTAL_MODE } from 'configs/portal';

export const LEGACY_TOKEN_STORAGE_KEY = 'tdesign-starter';
export const LEGACY_USER_STORAGE_KEY = 'zggeo-user';
export const ZGEO_TOKEN_STORAGE_KEY = `zggeo-${PORTAL_MODE}-token`;
export const ZGEO_USER_STORAGE_KEY = `zggeo-${PORTAL_MODE}-user`;
const ZGEO_STORAGE_PREFIX = 'zggeo.';
const LEGACY_ZGEO_STORAGE_PREFIX = 'zgeo.';

export const getAuthToken = () => {
  if (typeof window === 'undefined') return '';
  const token = window.localStorage.getItem(ZGEO_TOKEN_STORAGE_KEY) || '';
  return token && token !== 'main_token' ? token : '';
};

export const setAuthToken = (token: string) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ZGEO_TOKEN_STORAGE_KEY, token);
};

export const removeAuthStorage = () => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ZGEO_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(ZGEO_USER_STORAGE_KEY);
};

export const getStoredUser = () => {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(ZGEO_USER_STORAGE_KEY) || '{}') || {};
  } catch {
    return {};
  }
};

export const setStoredUser = (user: Record<string, unknown>) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ZGEO_USER_STORAGE_KEY, JSON.stringify(user));
};

const normalizeScopePart = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');

export const getCurrentStorageScope = () => {
  if (typeof window === 'undefined') return 'anonymous';
  try {
    const user = getStoredUser() as Record<string, unknown>;
    const tenant = normalizeScopePart(user?.tenant_id || user?.tenant_name || user?.company);
    const account = normalizeScopePart(user?.id || user?.email || user?.name);
    return [tenant, account].filter(Boolean).join('__') || 'anonymous';
  } catch {
    return 'anonymous';
  }
};

export const scopedStorageKey = (key: string, scope = getCurrentStorageScope()) => `${key}::${scope}`;

export const getScopedStorageItem = (key: string) => {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(scopedStorageKey(key));
};

export const setScopedStorageItem = (key: string, value: string) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(scopedStorageKey(key), value);
};

export const removeScopedStorageItem = (key: string) => {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(scopedStorageKey(key));
};

export const clearZggeoLocalCaches = () => {
  if (typeof window === 'undefined') return;
  const keys: string[] = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const key = window.localStorage.key(i);
    if (!key) continue;
    if (
      (key.startsWith(ZGEO_STORAGE_PREFIX) || key.startsWith(LEGACY_ZGEO_STORAGE_PREFIX)) &&
      key !== ZGEO_USER_STORAGE_KEY
    ) {
      keys.push(key);
    }
  }
  keys.forEach((key) => window.localStorage.removeItem(key));
};
