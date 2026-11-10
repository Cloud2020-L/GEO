export type ArticlePreviewTextSegment = {
  type: 'text';
  text: string;
};

export type ArticlePreviewImageSegment = {
  type: 'image';
  alt: string;
  src: string;
  raw: string;
};

export type ArticlePreviewSegment = ArticlePreviewTextSegment | ArticlePreviewImageSegment;

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\s*\(([^)]*)\)/g;
const IMAGE_SRC_RE = /^(zggeo-image:\/\/|data:image\/[a-zA-Z0-9.+-]+;base64,|https?:\/\/|blob:|\/)/i;

const normalizeImageSrc = (value: string) => {
  const src = String(value || '').trim();
  if (/^data:image\//i.test(src)) return src.replace(/\s+/g, '');
  return src;
};

const isImageSrc = (value: string) => IMAGE_SRC_RE.test(normalizeImageSrc(value));

export const parseArticlePreviewSegments = (body: unknown): ArticlePreviewSegment[] => {
  const text = String(body || '');
  if (!text) return [];

  const segments: ArticlePreviewSegment[] = [];
  let lastIndex = 0;
  let match = MARKDOWN_IMAGE_RE.exec(text);

  while (match) {
    const raw = match[0];
    const src = normalizeImageSrc(match[2] || '');
    if (!isImageSrc(src)) {
      match = MARKDOWN_IMAGE_RE.exec(text);
      continue;
    }

    if (match.index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    segments.push({
      type: 'image',
      alt: (match[1] || '').trim() || '文章配图',
      src,
      raw,
    });
    lastIndex = match.index + raw.length;
    match = MARKDOWN_IMAGE_RE.exec(text);
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return segments.length ? segments : [{ type: 'text', text }];
};

export const hasArticlePreviewImage = (body: unknown) =>
  parseArticlePreviewSegments(body).some((segment) => segment.type === 'image');
