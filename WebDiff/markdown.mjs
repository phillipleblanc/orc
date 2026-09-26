import DOMPurify from 'dompurify';
import { renderMarkdown } from './markdown-model.mjs';

const content = document.getElementById('markdown');
let currentDocument;

function scrollToFragment(fragment) {
  if (!fragment) return;
  let id = fragment.replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch {}
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

window.renderMarkdown = (source, documentURL, appearance, fragment) => {
  currentDocument = new URL(documentURL);
  document.documentElement.dataset.appearance = appearance;
  content.replaceChildren(renderMarkdown(source, documentURL, document, DOMPurify));
  window.scrollTo(0, 0);
  scrollToFragment(fragment);
};

content.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || !currentDocument) return;
  const url = new URL(link.href);
  if (url.protocol === currentDocument.protocol && url.host === currentDocument.host &&
      url.pathname === currentDocument.pathname && url.hash) {
    event.preventDefault();
    scrollToFragment(url.hash);
  } else {
    event.preventDefault();
    window.webkit.messageHandlers.markdownLink.postMessage({ url: url.href });
  }
});
