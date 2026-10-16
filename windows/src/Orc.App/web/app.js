// The terminal surfaces: one xterm.js 6.1 terminal per attached session (the build the runtime's @xterm/headless
// matches), with the kitty keyboard protocol on. Only the shown terminal reports keys and the size that fits the pane;
// hidden ones keep their screen and scrollback. The host (MainWindow) owns the Orc protocol.
//
// Each terminal is drawn at its session's PTY size, so the host's output lays out as it was written. While this window
// owns the session that is the size that fits the pane. While another screen does, the terminal sits in the pane at
// that screen's size, its font made smaller when the size does not fit.
'use strict';

const host = window.chrome.webview;
const post = (message) => host.postMessage(message);
const container = document.getElementById('terminals');

const BASE_FONT = 14;
const MIN_FONT = 7;
// xterm.js reserves this much for its scrollbar at the right of the pane.
const SCROLLBAR = 14;

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
  fontSize: BASE_FONT,
  scrollback: 10000,
  cursorBlink: true,
  theme,
  // Shift+Enter and friends: programs that push kitty flags get CSI-u key reports.
  vtExtensions: { kittyKeyboard: true }
};

const terminals = new Map();
let visibleId = null;
// A cell at the base font, in CSS pixels, and the size that fits the pane at it: what this window asks sessions for.
let baseCell = null;
let fitted = null;
let attentionAt = 0;

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
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.open(element);
  const entry = { term, element, renderer: 'dom', pty: null, queue: [], writing: 0, waiting: false };
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => { webgl.dispose(); entry.renderer = 'dom'; });
    term.loadAddon(webgl);
    entry.renderer = 'webgl';
  } catch {
    // The DOM renderer draws instead.
  }
  measure(term);
  layout(entry);
  return entry;
}

const cellOf = (term) => {
  const cell = term.dimensions?.css.cell;
  return cell && cell.width > 0 && cell.height > 0 ? cell : null;
};

// Remembers the cell size of a terminal drawn at the base font, and with it the size that fits the pane.
function measure(term) {
  const cell = term?.options.fontSize === BASE_FONT ? cellOf(term) : null;
  if (cell) baseCell = { width: cell.width, height: cell.height };
  if (!baseCell) return;
  fitted = {
    cols: Math.max(2, Math.floor((container.clientWidth - SCROLLBAR) / baseCell.width)),
    rows: Math.max(1, Math.floor(container.clientHeight / baseCell.height))
  };
}

// Draws the terminal at its PTY's size (the size that fits, until the host says), at the base font if that fits the
// pane and smaller if not.
function layout(entry) {
  const size = entry.pty ?? fitted;
  if (!size || !baseCell) return;
  const { term } = entry;
  const width = container.clientWidth - SCROLLBAR;
  const height = container.clientHeight;
  const ratio = Math.min(1, width / (size.cols * baseCell.width), height / (size.rows * baseCell.height));
  let font = ratio >= 1 ? BASE_FONT : Math.max(MIN_FONT, Math.floor(BASE_FONT * ratio * 2) / 2);
  if (term.options.fontSize !== font) term.options.fontSize = font;
  if (term.cols !== size.cols || term.rows !== size.rows) term.resize(size.cols, size.rows);
  // Cells round to device pixels, so a smaller font is not always proportionally smaller: step down until it fits.
  for (let cell = cellOf(term); cell && font > MIN_FONT && (size.cols * cell.width > width + 0.5 || size.rows * cell.height > height + 0.5); cell = cellOf(term)) {
    term.options.fontSize = font = Math.max(MIN_FONT, font - 0.5);
  }
  measure(term);
  // Outline a terminal sized for another screen, so its edge shows where the session's lines end.
  entry.element.classList.toggle('foreign', Boolean(fitted && (size.cols !== fitted.cols || size.rows !== fitted.rows)));
}

// Clicking or scrolling in the shown terminal is the person using this window: it takes the session's size.
function attention(id) {
  const now = performance.now();
  if (id !== visibleId || now - attentionAt < 250) return;
  attentionAt = now;
  post({ type: 'attention', id });
}

function create(id) {
  if (terminals.has(id)) return;
  const element = document.createElement('div');
  element.className = 'term';
  element.style.visibility = 'hidden';
  container.appendChild(element);
  const entry = open(element);
  const { term } = entry;
  element.addEventListener('pointerdown', () => attention(id), { capture: true });
  element.addEventListener('wheel', () => attention(id), { capture: true, passive: true });
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

  // Windows' clipboard keys, as Windows Terminal binds them: Ctrl+C copies a selection and otherwise stays ^C for the
  // program; Ctrl+V pastes this PC's clipboard (the host's ^V would read the host's); Ctrl+Shift+C/V and
  // Ctrl+Insert/Shift+Insert too. Shift+drag selects even while a program tracks the mouse.
  const copySelection = () => {
    if (!term.hasSelection()) return false;
    post({ type: 'copy', id, text: term.getSelection() });
    term.clearSelection();
    return true;
  };
  const consume = (event) => { event.preventDefault(); event.stopPropagation(); return false; };
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || event.altKey || event.metaKey) return true;
    const ctrl = event.ctrlKey;
    if (ctrl && event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) {
      copySelection();
      return consume(event);
    }
    if (ctrl && !event.shiftKey && event.code === 'Insert' && term.hasSelection()) {
      copySelection();
      return consume(event);
    }
    if ((ctrl && event.code === 'KeyV') || (event.shiftKey && !ctrl && event.code === 'Insert')) {
      post({ type: 'paste', id });
      return consume(event);
    }
    // The window's shortcuts, which WebView2 would otherwise keep from it.
    if (ctrl && event.shiftKey && event.code === 'KeyN') {
      post({ type: 'command', name: 'new-session' });
      return consume(event);
    }
    return true;
  });

  // Programs copy with OSC 52 (Claude Code's selections, tmux, Neovim). Copies go to the Windows clipboard; reading it
  // ("?") is refused, so a program on the host cannot read this PC's clipboard behind your back.
  term.parser.registerOscHandler(52, (data) => {
    const payload = data.slice(data.indexOf(';') + 1);
    if (id !== visibleId || payload === '?' || payload.length === 0 || payload.length > 1 << 20) return true;
    try {
      const text = new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)));
      if (text) post({ type: 'copy', id, text });
    } catch {
      // Not base64: nothing to copy.
    }
    return true;
  });

  // Right-click opens Copy / Paste / Select All, unless the program tracks the mouse (then the click is its, and
  // Shift+right-click opens the menu).
  element.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (term.modes.mouseTrackingMode !== 'none' && !event.shiftKey) return;
    post({ type: 'menu', id, x: event.clientX, y: event.clientY, selection: term.getSelection() });
  });
  terminals.set(id, entry);
}

function show(id) {
  visibleId = id;
  for (const [key, entry] of terminals) entry.element.style.visibility = key === id ? 'visible' : 'hidden';
  const entry = terminals.get(id);
  if (!entry) return;
  layout(entry);
  entry.term.focus();
  if (fitted) post({ type: 'shown', id, cols: fitted.cols, rows: fitted.rows });
  report('shown');
}

// A terminal's output and the steps between it, in order. xterm.js parses writes later, so a step waits until the
// writes before it are parsed and holds the ones after it. It runs outside xterm.js's write callbacks: resizing inside
// one makes xterm.js parse that write again and drop the ones after it.
function enqueue(entry, op) {
  entry.queue.push(op);
  pump(entry);
}

function pump(entry) {
  while (entry.queue.length > 0 && !entry.waiting) {
    const op = entry.queue[0];
    if (typeof op === 'function') {
      if (entry.writing > 0) {
        entry.waiting = true;
        return;
      }
      entry.queue.shift();
      op();
      continue;
    }
    entry.queue.shift();
    if (op.length === 0) continue;
    entry.writing++;
    entry.term.write(op, () => {
      if (--entry.writing === 0 && entry.waiting) {
        entry.waiting = false;
        setTimeout(() => pump(entry));
      }
    });
  }
}

// The PTY takes a new size from here on in the terminal's output: output before it is laid out at the size it was
// written for, and output after it at this one.
function resizeTo(entry, cols, rows) {
  enqueue(entry, () => {
    entry.pty = { cols, rows };
    layout(entry);
  });
}

function dispose(id) {
  const entry = terminals.get(id);
  if (!entry) return;
  entry.queue.length = 0;
  entry.waiting = true;
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
      // In order with the output that arrived first. RIS, the size the screen was serialized at, then the runtime's
      // serialized screen, then the keyboard flags the runtime reported (as `orc attach` restores them with CSI = flags u).
      enqueue(entry, '\x1bc');
      if (item.cols > 0 && item.rows > 0) resizeTo(entry, item.cols, item.rows);
      enqueue(entry, decode(item.data));
      enqueue(entry, () => { if (item.id === visibleId) report('snapshot'); });
      if (item.flags !== null && item.flags !== undefined) enqueue(entry, `\x1b[=${item.flags}u`);
      break;
    case 'output':
      enqueue(entry, decode(item.data));
      break;
    case 'pty':
      resizeTo(entry, item.cols, item.rows);
      break;
    case 'paste':
      term.paste(item.text);
      term.focus();
      break;
    case 'select-all':
      term.selectAll();
      term.focus();
      break;
    case 'ended':
      enqueue(entry, `\r\n\x1b[0;2m${item.text}\x1b[0m\r\n`);
      break;
  }
}

host.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'batch') for (const item of message.items) handle(item);
  else handle(message);
});

// Files dropped on the shown terminal go to the host, which saves them and gets their paths pasted, as Orc.app does
// with files dropped on its terminals. Nothing dropped ever navigates the page away from the terminals.
const MAX_ATTACHMENT = 12 * 1024 * 1024;
const readBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  event.dataTransfer.dropEffect = terminals.has(visibleId) && event.dataTransfer.types.includes('Files') ? 'copy' : 'none';
});
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  const id = visibleId;
  const dropped = [...(event.dataTransfer?.files ?? [])];
  if (!terminals.has(id) || dropped.length === 0) return;
  attention(id);
  const files = [];
  const folders = [];
  const tooLarge = [];
  for (const file of dropped) {
    if (file.size > MAX_ATTACHMENT) { tooLarge.push(file.name); continue; }
    // A folder cannot be read as a file.
    try { files.push({ name: file.name, data: await readBase64(file) }); } catch { folders.push(file.name); }
  }
  post({ type: 'drop', id, files, folders, tooLarge });
});

let fitTimer = 0;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    // A pane collapsed to nothing (the host's page over it, a minimized window) must not shrink a session on the host.
    if (container.clientWidth < 80 || container.clientHeight < 40) return;
    const before = fitted;
    const entry = terminals.get(visibleId);
    measure(entry?.term);
    if (entry) layout(entry);
    if (entry && fitted && (fitted.cols !== before?.cols || fitted.rows !== before?.rows)) {
      post({ type: 'size', id: visibleId, cols: fitted.cols, rows: fitted.rows });
    }
  }, 40);
}).observe(container);

// Measure the pane with a throwaway terminal, so the first attach subscribes at this window's size.
const probe = document.createElement('div');
probe.className = 'term';
probe.style.visibility = 'hidden';
container.appendChild(probe);
const measured = open(probe);
post({ type: 'ready', cols: fitted?.cols ?? measured.term.cols, rows: fitted?.rows ?? measured.term.rows });
measured.term.dispose();
probe.remove();
