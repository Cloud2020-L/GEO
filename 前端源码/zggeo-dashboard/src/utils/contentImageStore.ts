import { getAuthToken, getScopedStorageItem, removeScopedStorageItem, setScopedStorageItem } from './scopedStorage';

export const GROUP_STORAGE_KEY = 'example.com.v1';
export const IMAGE_STORAGE_KEY = 'example.com.v1';

const DB_NAME = 'zggeo-content-images';
const STORE_NAME = 'image-blobs';
const DB_VERSION = 1;

export interface StoredImageGroup {
  id: string;
  lead_id?: string;
  lead_name?: string;
  name: string;
  description?: string;
  usage?: 'article' | 'product' | 'case' | 'banner' | 'other' | string;
  created_at: string;
  updated_at?: string;
  image_count?: number;
  is_local_only?: boolean;
}

export interface StoredManagedImage {
  id: string;
  group_id: string;
  lead_id?: string;
  group_name: string;
  name: string;
  alt: string;
  url?: string;
  file_url?: string;
  mime_type?: string;
  size?: number;
  created_at: string;
  storage?: 'backend' | 'indexeddb';
  indexeddb_key?: string;
  is_local_only?: boolean;
}

const canUseIndexedDb = () => typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!canUseIndexedDb()) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
  });

const runStore = async <T>(mode: IDBTransactionMode, handler: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = handler(tx.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('IndexedDB transaction failed'));
    };
  });
};

export const saveImageBlob = (key: string, blob: Blob) => runStore('readwrite', (store) => store.put(blob, key));

export const deleteImageBlob = (key: string) => runStore('readwrite', (store) => store.delete(key));

export const loadImageBlob = (key: string) => runStore<Blob | undefined>('readonly', (store) => store.get(key));

export const loadImageBlobUrl = async (key?: string) => {
  if (!key) return '';
  const blob = await loadImageBlob(key);
  return blob ? URL.createObjectURL(blob) : '';
};

export const loadProtectedImageUrl = async (url?: string) => {
  const value = String(url || '').trim();
  if (!value || value.startsWith('blob:') || value.startsWith('data:')) return value;
  const token = getAuthToken();
  try {
    const response = await fetch(value, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
    if (!response.ok) return '';
    return URL.createObjectURL(await response.blob());
  } catch {
    return '';
  }
};

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = getScopedStorageItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = <T>(key: string, value: T) => {
  setScopedStorageItem(key, JSON.stringify(value));
};

export const readFallbackGroups = () => readJson<StoredImageGroup[]>(GROUP_STORAGE_KEY, []);

export const writeFallbackGroups = (groups: StoredImageGroup[]) => writeJson(GROUP_STORAGE_KEY, groups);

export const readFallbackImages = () => readJson<StoredManagedImage[]>(IMAGE_STORAGE_KEY, []);

export const writeFallbackImages = (images: StoredManagedImage[]) => writeJson(IMAGE_STORAGE_KEY, images);

export const clearFallbackImageMaterials = () => {
  removeScopedStorageItem(GROUP_STORAGE_KEY);
  removeScopedStorageItem(IMAGE_STORAGE_KEY);
};

export const createLocalId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
