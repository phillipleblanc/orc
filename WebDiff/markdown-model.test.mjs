import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import { renderMarkdown, resolveLink, imageURL } from './markdown-model.mjs';

const base = 'file:///workspace/docs/readme.md';
function render(source) {
  const window = new JSDOM('<!doctype html><body></body>').window;
  window.document.body.append(renderMarkdown(source, base, window.document, DOMPurify(window)));
  return window.document.body;
}

test('renders headings, lists, code, tables, quotes, and emphasis', () => {
  const body = render('# Document\n\n## Section\n\n**Bold** and *italic*.\n\n- First\n- Second\n\n> Quote\n\n```swift\nlet x = "<tag>"\n```\n\n| Name | Value |\n| --- | --- |\n| one | two |');
  assert.equal(body.querySelector('h1').textContent, 'Document');
  assert.equal(body.querySelector('h2').id, 'section');
  assert.equal(body.querySelector('strong').textContent, 'Bold');
  assert.equal(body.querySelector('em').textContent, 'italic');
  assert.equal(body.querySelectorAll('li').length, 2);
  assert.equal(body.querySelector('blockquote').textContent.trim(), 'Quote');
  assert.equal(body.querySelector('pre code').textContent, 'let x = "<tag>"\n');
  assert.equal(body.querySelectorAll('tbody td').length, 2);
  assert.equal(body.querySelector('tag'), null);
});

test('task lists render read-only check marks', () => {
  const body = render('- [x] Done\n- [ ] Pending');
  assert.deepEqual([...body.querySelectorAll('li')].map(li => li.textContent.replace(/\s+/g, ' ').trim()), ['☑ Done', '☐ Pending']);
  assert.equal(body.querySelector('input'), null);
});

test('relative file links and heading anchors resolve against the Markdown document', () => {
  const body = render('[Guide](guide.md#setup) [Up](../README.md) [Here](#details) [Web](https://example.com/doc.md)');
  assert.deepEqual([...body.querySelectorAll('a')].map(a => a.href), [
    'file:///workspace/docs/guide.md#setup', 'file:///workspace/README.md',
    base + '#details', 'https://example.com/doc.md',
  ]);
});

test('headings have stable unique Unicode anchors', () => {
  const body = render('# Hello, World!\n\n## Hello, World!\n\n## 한글 제목');
  assert.deepEqual([...body.querySelectorAll('h1,h2')].map(h => h.id), ['hello-world', 'hello-world-1', '한글-제목']);
});

test('untrusted Markdown cannot inject scripts, event handlers, styles, forms, or active URLs', () => {
  const body = render(`<script>window.pwned = true</script>
<iframe src="https://evil.example"></iframe><style>body{display:none}</style>
<form action="https://evil.example"><input name="secret"></form>
<img src="local.png" onerror="alert(1)" style="background:url(https://evil.example)">
<a href="javascript:alert(1)" onclick="alert(2)">bad</a>
<a href="data:text/html,bad">data</a>
<a href="orca://open">scheme</a>
<a href="https://example.com" target="_blank" download>safe</a>`);
  assert.equal(body.querySelector('script,iframe,style,form,input'), null);
  for (const element of body.querySelectorAll('*')) {
    for (const attr of element.attributes) assert.ok(!/^on/i.test(attr.name) && attr.name !== 'style');
  }
  assert.deepEqual([...body.querySelectorAll('a')].map(a => a.getAttribute('href')), [null, null, null, 'https://example.com/']);
  assert.equal(body.querySelector('a[target],a[download]'), null);
});

test('local images use a scoped native loader and remote images are not requested', () => {
  const body = render('![Local](images/screen%20shot.png) ![External](https://example.com/tracking.png)');
  assert.equal(body.querySelector('img').getAttribute('src'), 'orc-markdown-image://local/workspace/docs/images/screen%20shot.png');
  assert.equal(body.querySelectorAll('img').length, 1);
  assert.equal(body.querySelector('.image-unavailable').textContent, '[Image: External]');
  assert.equal(imageURL('data:image/png;base64,AAAA', base), 'data:image/png;base64,AAAA');
  assert.equal(imageURL('file://remote-host/secret.png', base), null);
  assert.equal(imageURL('javascript:alert(1)', base), null);
});

test('unsupported protocols and invalid URLs do not become clickable', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'orca://open', 'https://[invalid']) {
    assert.equal(resolveLink(url, base), null);
  }
  assert.equal(resolveLink('mailto:user@example.com', base).protocol, 'mailto:');
});
