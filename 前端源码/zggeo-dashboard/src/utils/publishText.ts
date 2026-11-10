export function stripMarkdownForPublish(input: unknown) {
  let text = String(input || '').replace(/\r\n?/g, '\n');

  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt: string) => (alt.trim() ? `图片：${alt.trim()}` : ''));
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => {
    const cleanLabel = label.trim();
    const cleanUrl = url.trim();
    return cleanLabel && cleanUrl ? `${cleanLabel}：${cleanUrl}` : cleanLabel || cleanUrl;
  });
  text = text.replace(/^ {0,3}#{1,6}\s+/gm, '');
  text = text.replace(/^ {0,3}>\s?/gm, '');
  text = text.replace(/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '');
  text = text.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '');
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, row: string) =>
    row
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join('  '),
  );
  text = text.replace(/^(\s*)[-*+]\s+/gm, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2');
  text = text.replace(/(^|[^\w_])_([^_\n]+)_/g, '$1$2');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/p\s*>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function decodeStoredPublishText(input: unknown) {
  return String(input || '')
    .replace(/\\\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

export function composePublishClipboardText(title: unknown, body: unknown) {
  return [decodeStoredPublishText(title).trim(), stripMarkdownForPublish(decodeStoredPublishText(body))]
    .filter(Boolean)
    .join('\n\n');
}
