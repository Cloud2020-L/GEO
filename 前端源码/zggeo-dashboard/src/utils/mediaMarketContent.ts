export type MediaMarketImageStatus = 'local' | 'remote' | 'uploaded' | 'failed' | 'unused';

export interface MediaMarketImageAsset {
  id: string;
  index: number;
  alt: string;
  src: string;
  mime: string;
  format: string;
  size?: number;
  placeholder: string;
  uploadRequired: boolean;
  status: MediaMarketImageStatus;
  uploaded_url?: string;
  error?: string;
}

export interface MediaMarketEditableContent {
  displayContent: string;
  images: MediaMarketImageAsset[];
}

export interface PreparedMediaMarketContent {
  html: string;
  images: MediaMarketImageAsset[];
  uploadedCount: number;
}

type UploadImage = (file: File) => Promise<string>;

const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
const IMAGE_PLACEHOLDER_RE = /\[图片 \d+：[^\]\n]+\]/g;
const HTML_BLOCK_RE = /<\s*(p|div|br|img|h[1-6]|ul|ol|li|table|blockquote|figure)\b/i;
const DATA_IMAGE_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,/i;

const isUploadRequired = (src: string) => /^data:image\//i.test(src) || /^blob:/i.test(src);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = (value: string) => escapeHtml(value).replace(/`/g, '&#96;');

const safeImageName = (value: string) =>
  String(value || '文章配图')
    .replace(/[\]\n\r]/g, ' ')
    .trim() || '文章配图';

const imageTag = (src: string, alt = '') => {
  const cleanSrc = src.trim();
  const cleanAlt = alt.trim();
  return `<p><img src="${escapeAttr(cleanSrc)}"${cleanAlt ? ` alt="${escapeAttr(cleanAlt)}"` : ''}/></p>`;
};

const paragraphizeText = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br/>')}</p>`)
    .join('');

const normalizeDisplayText = (value: string) =>
  value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const dataUrlMeta = (src: string) => {
  const match = src.match(DATA_IMAGE_RE);
  if (!match) return null;
  const mime = src.slice(5, src.indexOf(';'));
  const format = (match[1] || 'png').toUpperCase();
  const base64 = src.slice(src.indexOf(',') + 1).replace(/\s+/g, '');
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const size = Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
  return { mime, format, size };
};

const remoteImageMeta = (src: string) => {
  const ext = src.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)?.[1] || '';
  const format = ext ? ext.toUpperCase() : '图片';
  return { mime: ext ? `image/${ext.toLowerCase()}` : 'image/*', format };
};

const formatImageSize = (size?: number) => {
  if (!size) return '';
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
};

const makePlaceholder = (index: number, alt: string, format: string, uploadRequired: boolean) =>
  uploadRequired
    ? `[图片 ${index}：${safeImageName(alt)}，${format || '图片'}，提交时自动上传]`
    : `[图片 ${index}：${safeImageName(alt)}，公网图片]`;

const makeAsset = (index: number, alt: string, src: string): MediaMarketImageAsset => {
  const cleanSrc = String(src || '').trim();
  const uploadRequired = isUploadRequired(cleanSrc);
  const dataMeta = dataUrlMeta(cleanSrc);
  const remoteMeta = dataMeta || remoteImageMeta(cleanSrc);
  const cleanAlt = safeImageName(alt || `图片 ${index}`);
  return {
    id: `media-image-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    index,
    alt: cleanAlt,
    src: cleanSrc,
    mime: remoteMeta.mime,
    format: remoteMeta.format,
    size: dataMeta?.size,
    placeholder: makePlaceholder(index, cleanAlt, remoteMeta.format, uploadRequired),
    uploadRequired,
    status: uploadRequired ? 'local' : 'remote',
  };
};

const htmlToEditableText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

export const buildMediaMarketEditableContent = (
  input: unknown,
  existingImages: MediaMarketImageAsset[] = [],
): MediaMarketEditableContent => {
  const text = String(input || '');
  if (!text.trim()) return { displayContent: '', images: existingImages };
  if (existingImages.length > 0 && !/data:image\/|!\[[^\]]*\]\([^)]+\)|<img\b/i.test(text)) {
    return { displayContent: normalizeDisplayText(text), images: existingImages };
  }

  const images: MediaMarketImageAsset[] = [];
  let nextIndex = 1;
  const pushAsset = (alt: string, src: string) => {
    const asset = makeAsset(nextIndex, alt, src);
    nextIndex += 1;
    images.push(asset);
    return asset.placeholder;
  };

  const replaced = text
    .replace(HTML_IMAGE_RE, (raw: string, _quote: string, src: string) => {
      const alt = raw.match(/\balt=(["'])(.*?)\1/i)?.[2] || '';
      return `\n\n${pushAsset(alt, src)}\n\n`;
    })
    .replace(MARKDOWN_IMAGE_RE, (_raw: string, alt: string, src: string) => `\n\n${pushAsset(alt, src)}\n\n`);

  return {
    displayContent: normalizeDisplayText(HTML_BLOCK_RE.test(replaced) ? htmlToEditableText(replaced) : replaced),
    images,
  };
};

export const extractMediaMarketPlaceholders = (input: unknown) => String(input || '').match(IMAGE_PLACEHOLDER_RE) || [];

export const getUsedMediaMarketImages = (displayContent: unknown, images: MediaMarketImageAsset[]) => {
  const placeholders = new Set(extractMediaMarketPlaceholders(displayContent));
  return images.filter((image) => placeholders.has(image.placeholder));
};

export const getUnknownMediaMarketPlaceholders = (displayContent: unknown, images: MediaMarketImageAsset[]) => {
  const known = new Set(images.map((image) => image.placeholder));
  return extractMediaMarketPlaceholders(displayContent).filter((placeholder) => !known.has(placeholder));
};

const dataUrlToFile = (src: string, alt: string, index: number) => {
  const match = src.match(DATA_IMAGE_RE);
  if (!match) throw new Error('图片格式不是有效的 base64 图片');
  const mime = src.slice(5, src.indexOf(';'));
  const ext = match[1]?.toLowerCase() || 'png';
  const binary = atob(src.slice(src.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const safeName = (alt || `article-image-${index + 1}`).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return new File([bytes], `${safeName || `article-image-${index + 1}`}.${ext}`, { type: mime });
};

const blobUrlToFile = async (src: string, alt: string, index: number) => {
  const response = await fetch(src);
  if (!response.ok) throw new Error('临时图片读取失败，请重新选择文章或重新上传图片');
  const blob = await response.blob();
  const mime = blob.type || 'image/png';
  const ext = mime.split('/')[1] || 'png';
  const safeName = (alt || `article-image-${index + 1}`).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return new File([blob], `${safeName || `article-image-${index + 1}`}.${ext}`, { type: mime });
};

export const prepareMediaMarketContent = async (
  displayContent: unknown,
  images: MediaMarketImageAsset[],
  uploadImage: UploadImage,
): Promise<PreparedMediaMarketContent> => {
  const text = String(displayContent || '').trim();
  if (!text) return { html: '', images, uploadedCount: 0 };

  const unknownPlaceholders = getUnknownMediaMarketPlaceholders(text, images);
  if (unknownPlaceholders.length > 0) {
    throw new Error('图片占位符已被修改，可能无法自动上传，请恢复占位符或移除图片');
  }

  const usedAssets = getUsedMediaMarketImages(text, images);
  const usedAssetIds = new Set(usedAssets.map((image) => image.id));
  const nextImages = images.map((image) =>
    usedAssetIds.has(image.id) ? image : { ...image, status: 'unused' as const },
  );
  const assetByPlaceholder = new Map(nextImages.map((image) => [image.placeholder, image]));
  let uploadedCount = 0;

  const resolveImageUrl = async (asset: MediaMarketImageAsset) => {
    if (!asset.uploadRequired) return asset.uploaded_url || asset.src;
    if (asset.status === 'uploaded' && asset.uploaded_url) return asset.uploaded_url;
    const file = /^blob:/i.test(asset.src)
      ? // eslint-disable-next-line no-await-in-loop
        await blobUrlToFile(asset.src, asset.alt, asset.index)
      : dataUrlToFile(asset.src, asset.alt, asset.index);
    const uploadedUrl = await uploadImage(file);
    uploadedCount += 1;
    const idx = nextImages.findIndex((image) => image.id === asset.id);
    if (idx >= 0) nextImages[idx] = { ...asset, status: 'uploaded', uploaded_url: uploadedUrl, error: undefined };
    return uploadedUrl;
  };

  const parts: string[] = [];
  let cursor = 0;
  let match = IMAGE_PLACEHOLDER_RE.exec(text);
  while (match) {
    if (match.index > cursor) parts.push(paragraphizeText(text.slice(cursor, match.index)));
    const placeholder = match[0];
    const asset = assetByPlaceholder.get(placeholder);
    if (!asset) throw new Error('图片占位符已被修改，可能无法自动上传，请恢复占位符或移除图片');
    // eslint-disable-next-line no-await-in-loop
    const url = await resolveImageUrl(asset);
    parts.push(imageTag(url, asset.alt));
    cursor = match.index + placeholder.length;
    match = IMAGE_PLACEHOLDER_RE.exec(text);
  }
  if (cursor < text.length) parts.push(paragraphizeText(text.slice(cursor)));

  return {
    html: parts.join(''),
    images: nextImages,
    uploadedCount,
  };
};

export const previewMediaMarketHtml = (displayContent: unknown, images: MediaMarketImageAsset[]) => {
  const text = String(displayContent || '').trim();
  if (!text) return '';
  const assetByPlaceholder = new Map(images.map((image) => [image.placeholder, image]));
  const parts: string[] = [];
  let cursor = 0;
  let match = IMAGE_PLACEHOLDER_RE.exec(text);
  while (match) {
    if (match.index > cursor) parts.push(paragraphizeText(text.slice(cursor, match.index)));
    const asset = assetByPlaceholder.get(match[0]);
    parts.push(asset ? imageTag(asset.uploaded_url || asset.src, asset.alt) : paragraphizeText(match[0]));
    cursor = match.index + match[0].length;
    match = IMAGE_PLACEHOLDER_RE.exec(text);
  }
  if (cursor < text.length) parts.push(paragraphizeText(text.slice(cursor)));
  return parts.join('');
};

export const sanitizeMediaMarketPreviewHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+=(["']).*?\1/gi, '')
    .replace(/\s(href|src)=(["'])javascript:[\s\S]*?\2/gi, '');

export const formatMediaMarketImageSize = formatImageSize;
