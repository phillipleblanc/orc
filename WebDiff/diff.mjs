import { FileDiff } from '@pierre/diffs';
import { prepareDiffs } from './render-model.mjs';

const host = document.getElementById('diffs');
let renderers = [], currentPayload;
const send = message => window.webkit?.messageHandlers.diffView.postMessage(message);
const reportHeight = () => send({ type: 'height', value: Math.ceil(host.getBoundingClientRect().height) });
new ResizeObserver(reportHeight).observe(host);
// WKWebView does not chain wheel events to the enclosing native chat scroll view.
host.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const atEdge = event.deltaY < 0 ? host.scrollTop <= 0 : host.scrollTop + host.clientHeight >= host.scrollHeight - 1;
  if (!atEdge) return;
  event.preventDefault();
  send({ type: 'scroll', delta: event.deltaY, mode: event.deltaMode });
}, { passive: false });

window.renderDiff = (payload, style, appearance) => {
  try {
    document.documentElement.style.colorScheme = appearance;
    const key = JSON.stringify(payload);
    if (key !== currentPayload) {
      const entries = prepareDiffs(payload);
      for (const renderer of renderers) renderer.cleanUp();
      renderers = []; host.replaceChildren(); currentPayload = key;
      for (const entry of entries) {
        const section = document.createElement('section');
        host.append(section);
        if (entry.notice) {
          const text = document.createElement('p'); text.className = 'notice';
          text.textContent = entry.name + '\n' + entry.notice; section.append(text); continue;
        }
        if (entry.excerpt) {
          const caption = document.createElement('p'); caption.className = 'caption';
          caption.textContent = 'Edited excerpt · Line numbers are relative to this excerpt'; section.append(caption);
        }
        const renderer = new FileDiff(options(style, appearance));
        renderer.render({ fileDiff: entry.fileDiff, containerWrapper: section });
        renderers.push(renderer);
      }
    } else {
      for (const renderer of renderers) { renderer.setOptions(options(style, appearance)); renderer.rerender(); }
    }
    requestAnimationFrame(reportHeight);
  } catch {
    send({ type: 'error', message: 'This diff could not be rendered. The original tool input is available below.' });
  }
};
function options(style, appearance) {
  return { theme: { light: 'pierre-light', dark: 'pierre-dark' }, themeType: appearance,
    diffStyle: style, overflow: 'scroll', diffIndicators: 'classic', lineDiffType: 'word',
    preferredHighlighter: 'shiki-js', tokenizeMaxLength: 100000, tokenizeMaxLineLength: 2000,
    onPostRender: reportHeight };
}
send({ type: 'ready' });
