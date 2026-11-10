declare module '*.avif' {
  export default src as string;
}

declare module '*.bmp' {
  export default src as string;
}

declare module '*.gif' {
  export default src as string;
}

declare module '*.jpg' {
  export default src as string;
}

declare module '*.jpeg' {
  export default src as string;
}

declare module '*.png' {
  export default src as string;
}

declare module '*.webp' {
  export default src as string;
}

declare module '*.svg' {
  export default src as string;
}
declare module '*.svg?component' {
  export default src as string;
}
declare module '*.module.css' {
  export default classes as { readonly [key: string]: string };
}

declare module '*.module.less' {
  export default classes as { readonly [key: string]: string };
}

declare module '*.less' {
  export default classes as { readonly [key: string]: string };
}

declare module 'tvision-color';

interface ImportMetaEnv {
  readonly MODE: 'development' | 'test' | 'release' | 'mock' | 'site' | 'admin' | 'client';
  readonly VITE_BASE_URL?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_ZGEO_PORTAL?: 'admin' | 'client' | string;
  readonly VITE_ROUTER_BASENAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module 'tdesign-react/es/space/Space' {
  interface SpaceProps {
    wrap?: boolean;
  }
}

declare module 'tdesign-react/es/table/interface' {
  interface PrimaryTableProps<T> {
    locale?: {
      empty?: string;
      [key: string]: unknown;
    };
  }
}

declare module 'tdesign-react/es/tooltip/type' {
  interface TdTooltipProps {
    maxWidth?: number | string;
  }
}
