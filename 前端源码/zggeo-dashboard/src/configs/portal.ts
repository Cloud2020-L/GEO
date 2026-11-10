export type PortalMode = 'admin' | 'client';

const envMode = String(import.meta.env.VITE_ZGEO_PORTAL || '').toLowerCase();

export const PORTAL_MODE: PortalMode = envMode === 'client' ? 'client' : 'admin';

export const isClientPortal = PORTAL_MODE === 'client';
