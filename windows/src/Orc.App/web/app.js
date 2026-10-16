// The terminal surface: xterm.js 6.1 (the build the runtime's @xterm/headless matches) with the kitty keyboard
// protocol on. The host (MainWindow) owns the Orc protocol; this page only draws bytes and reports keys and size.
'use strict';

const host = window.chrome.webview;
const post = (message) => host.postMessage(message);

// GitHub Dark, the Mac app's default without a Ghostty config.
const theme = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#2f81f7', cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341',
  brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff'
};

const term = new Terminal({
  allowProposedApi: true,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  fontSize: 14,
  scrollback: 10000,
  cursorBlink: true,
  theme,
  // Shift+Enter and friends: programs that push kitty flags get CSI-u key reports.
  vtExtensions: { kittyKeyboard: true }
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon.Unicode11Addon());
term.unicode.activeVersion = '11';
term.open(document.getElementById('terminal'));
try { term.loadAddon(new WebglAddon.WebglAddon()); } catch (error) { console.warn('WebGL renderer unavailable; using the DOM renderer', error); }

const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

function handle(item) {
  switch (item.type) {
    case 'reset':
      // Through the write queue, so it lands after output that arrived first. RIS, then the runtime's serialized
      // screen, then the keyboard flags the runtime reported (as `orc attach` restores them with CSI = flags u).
      term.write('\x1bc');
      term.write(decode(item.data));
      if (item.flags !== null && item.flags !== undefined) term.write(`\x1b[=${item.flags}u`);
      break;
    case 'output':
      term.write(decode(item.data));
      break;
    case 'clear':
      term.write('\x1bc');
      break;
    case 'paste':
      term.paste(item.text);
      break;
    case 'focus':
      term.focus();
      break;
  }
}

host.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'batch') for (const item of message.items) handle(item);
  else handle(message);
});

term.onData((data) => post({ type: 'input', data }));

// Ctrl+Shift+C / Ctrl+Shift+V copy and paste; plain Ctrl+C and Ctrl+V belong to the program.
term.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown' || !event.ctrlKey || !event.shiftKey || event.altKey) return true;
  if (event.code === 'KeyC') {
    const selection = term.getSelection();
    if (selection) post({ type: 'copy', text: selection });
    return false;
  }
  if (event.code === 'KeyV') {
    post({ type: 'paste' });
    return false;
  }
  return true;
});

let fitTimer = 0;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => fit.fit(), 40);
}).observe(document.getElementById('terminal'));
term.onResize(({ cols, rows }) => post({ type: 'size', cols, rows }));

fit.fit();
post({ type: 'ready', cols: term.cols, rows: term.rows });
