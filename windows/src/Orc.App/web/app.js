// The terminal surfaces: one xterm.js 6.1 terminal per attached session (the build the runtime's @xterm/headless
// matches), with the kitty keyboard protocol on. Only the shown terminal is fitted to the pane and reports keys and
// size; hidden ones keep their screen and scrollback. The host (MainWindow) owns the Orc protocol.
'use strict';

const host = window.chrome.webview;
const post = (message) => host.postMessage(message);
const container = document.getElementById('terminals');

// GitHub Dark, the Mac app's default without a Ghostty config.
const theme = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#2f81f7', cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff'
};

const options = {
  allowProposedApi: true,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 14,
  scrollback: 10000,
  cursorBlink: true,
  theme,
  // Shift+Enter and friends: programs that push kitty flags get CSI-u key reports.
  vtExtensions: { kittyKeyboard: true }
};

const terminals = new Map();
let visibleId = null;

// With ORC_DIAGNOSTICS=1 the host loads this page with ?diagnostics and logs what each wheel burst did:
// the buffer, the mouse mode, and the reports or keys it produced (%LOCALAPPDATA%\Orc\logs\terminal.log).
const diagnostics = new URLSearchParams(location.search).has('diagnostics');
let wheel = null;

function report(event, extra = {}) {
  const entry = terminals.get(visibleId);
  if (!diagnostics || !entry) return;
  const { term } = entry;
  const buffer = term.buffer.active;
  post({
    type: 'diag', id: visibleId, event, buffer: buffer.type, cols: term.cols, rows: term.rows, viewportY: buffer.viewportY,
    scrollback: term.buffer.normal.length - term.rows, mouseTracking: term.modes.mouseTrackingMode,
    dpr: window.devicePixelRatio, renderer: entry.renderer, ...extra
  });
}

if (diagnostics) {
  container.addEventListener('wheel', (event) => {
    if (!terminals.has(visibleId)) return;
    if (!wheel) {
      wheel = { events: 0, deltaY: 0, deltaMode: event.deltaMode, x: event.clientX, y: event.clientY, reports: 0, keys: 0, sample: null };
      setTimeout(() => { const burst = wheel; wheel = null; report('wheel', burst); }, 400);
    }
    wheel.events++;
    wheel.deltaY += event.deltaY;
  }, { capture: true, passive: true });
}

function open(element) {
  const term = new Terminal(options);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(element);
  const entry = { term, fit, renderer: 'dom' };
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { webgl.dispose(); entry.renderer = 'dom'; });
    term.loadAddon(webgl);
    entry.renderer = 'webgl';
  } catch {
    // The DOM renderer draws instead.
  }
  fit.fit();
  return entry;
}

function create(id) {
  if (terminals.has(id)) return;
  const element = document.createElement('div');
  element.className = 'term';
  element.style.visibility = 'hidden';
  container.appendChild(element);
  const entry = open(element);
  const { term } = entry;
  term.onData((data) => {
    if (id !== visibleId) return;
    if (wheel) {
      // SGR wheel reports (buttons 64 and 65) for a program tracking the mouse, cursor keys on a screen without
      // scrollback for one that does not.
      if (/\x1b\[<6[45];/.test(data)) { wheel.reports++; wheel.sample ??= data.replace('\x1b', '\\e'); }
      else if (/^\x1b[\[O][AB]$/.test(data)) wheel.keys++;
    }
    post({ type: 'input', id, data });
  });
  term.onResize(({ cols, rows }) => { if (id === visibleId) post({ type: 'size', id, cols, rows }); });
  // Ctrl+Shift+C / Ctrl+Shift+V copy and paste; plain Ctrl+C and Ctrl+V belong to the program.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey || event.altKey) return true;
    if (event.code === 'KeyC') {
      const selection = term.getSelection();
      if (selection) post({ type: 'copy', id, text: selection });
      return false;
    }
    if (event.code === 'KeyV') {
      post({ type: 'paste', id });
      return false;
    }
    // The window's shortcuts, which WebView2 would otherwise keep from it.
    if (event.code === 'KeyN') {
      post({ type: 'command', name: 'new-session' });
      return false;
    }
    return true;
  });
  terminals.set(id, { ...entry, element });
}

function show(id) {
  visibleId = id;
  for (const [key, entry] of terminals) entry.element.style.visibility = key === id ? 'visible' : 'hidden';
  const entry = terminals.get(id);
  if (!entry) return;
  entry.fit.fit();
  entry.term.focus();
  post({ type: 'shown', id, cols: entry.term.cols, rows: entry.term.rows });
  report('shown');
}

function dispose(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  entry.term.dispose();
  entry.element.remove();
  terminals.delete(id);
  if (visibleId === id) visibleId = null;
}

const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

function handle(item) {
  if (item.type === 'create') return create(item.id);
  if (item.type === 'show') return show(item.id);
  if (item.type === 'dispose') return dispose(item.id);
  const entry = terminals.get(item.id);
  if (!entry) return;
  const { term } = entry;
  switch (item.type) {
    case 'reset':
      // Through the write queue, so it lands after output that arrived first. RIS, then the runtime's serialized
      // screen, then the keyboard flags the runtime reported (as `orc attach` restores them with CSI = flags u).
      term.write('\x1bc');
      term.write(decode(item.data), () => { if (item.id === visibleId) report('snapshot'); });
      if (item.flags !== null && item.flags !== undefined) term.write(`\x1b[=${item.flags}u`);
      break;
    case 'output':
      term.write(decode(item.data));
      break;
    case 'paste':
      term.paste(item.text);
      break;
    case 'ended':
      term.write(`\r\n\x1b[0;2m${item.text}\x1b[0m\r\n`);
      break;
  }
}

host.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'batch') for (const item of message.items) handle(item);
  else handle(message);
});

let fitTimer = 0;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    // A pane collapsed to nothing (the host's page over it, a minimized window) must not shrink a session on the host.
    if (container.clientWidth < 80 || container.clientHeight < 40) return;
    terminals.get(visibleId)?.fit.fit();
  }, 40);
}).observe(container);

// Measure the pane with a throwaway terminal, so the first attach subscribes at this window's size.
const probe = document.createElement('div');
probe.className = 'term';
probe.style.visibility = 'hidden';
container.appendChild(probe);
const measured = open(probe);
post({ type: 'ready', cols: measured.term.cols, rows: measured.term.rows });
measured.term.dispose();
probe.remove();
