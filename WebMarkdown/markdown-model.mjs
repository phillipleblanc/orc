import { Marked } from 'marked';

const markdown = new Marked({ gfm: true, renderer: {
  checkbox({ checked }) { return checked ? '☑ ' : '☐ '; },
} });
const linkProtocols = new Set(['file:', 'http:', 'https:', 'mailto:']);

export function resolveLink(value, documentURL) {
  try {
    const url = new URL(value, documentURL);
    return linkProtocols.has(url.protocol) ? url : null;
  } catch { return null; }
}

export function imageURL(value, documentURL) {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)) return value;
  const url = resolveLink(value, documentURL);
  if (!url || url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
  return 'orc-markdown-image://local' + url.pathname;
}

export function renderMarkdown(source, documentURL, document, purifier) {
  const html = markdown.parse(source.replace(/^\uFEFF/, ''), { async: false });
  const fragment = purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'base', 'link', 'meta'],
    FORBID_ATTR: ['style', 'srcset', 'target', 'download'],
  });
  const headings = new Map();
  for (const heading of fragment.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const slug = heading.textContent.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'section';
    const count = headings.get(slug) ?? 0;
    headings.set(slug, count + 1);
    heading.id = count ? `${slug}-${count}` : slug;
  }
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href');
    const url = href === null ? null : resolveLink(href, documentURL);
    if (url) link.href = url.href;
    else link.removeAttribute('href');
    link.rel = 'noreferrer noopener';
  }
  for (const image of fragment.querySelectorAll('img')) {
    const src = image.getAttribute('src');
    const url = src === null ? null : imageURL(src, documentURL);
    if (url) image.src = url;
    else {
      const placeholder = document.createElement('span');
      placeholder.className = 'image-unavailable';
      placeholder.textContent = image.alt ? `[Image: ${image.alt}]` : '[External image]';
      image.replaceWith(placeholder);
    }
  }
  return fragment;
}
