import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';

const require = createRequire(join(process.argv[2], 'package.json'));
const WebSocket = require('ws');
const nacl = require('tweetnacl');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = realpathSync(mkdtempSync('/tmp/orc-phone-'));
const config = join(scratch, 'client'), profile = join(config, 'runtime');
const app = join(root, 'dist/Orc.app'), cli = join(app, 'Contents/Resources/orc');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('ORC_') && !key.startsWith('ORCA_') && !key.startsWith('ELECTRON_') && key !== 'NODE_OPTIONS'));
env.ORC_CONFIG_DIR = config;
const report = { schemaVersion: 1, passed: false };
const runtimeIds = new Set(), clients = [], secrets = [];
let handle, incarnation;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(...args) {
  return execFileSync(cli, args, { env, cwd: scratch, encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
}
const json = (...args) => JSON.parse(command(...args, '--json'));
const metadata = () => JSON.parse(readFileSync(join(profile, 'orca-runtime.json')));
function status() { const result = json('status'); runtimeIds.add(result.runtimeId); return result; }
function claims(offer) {
  const value = JSON.parse(Buffer.from(new URL(offer.pairingUrl).searchParams.get('code'), 'base64url'));
  secrets.push(value.deviceToken, offer.pairingUrl);
  assert.ok(value.scope === 'mobile');
  return value;
}
async function local(method, params = {}) {
  const meta = metadata();
  assert.ok(runtimeIds.has(meta.runtimeId), 'Unowned test runtime');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(meta.transports.find(t => t.kind === 'unix').endpoint);
    const id = randomUUID(); let buffer = '';
    socket.setTimeout(15000, () => socket.destroy(new Error('Local RPC timed out')));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ id, authToken: meta.authToken, method, params }) + '\n'));
    socket.on('data', bytes => {
      buffer += bytes;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const reply = JSON.parse(line);
        if (reply._keepalive) continue;
        socket.end();
        if (reply.id !== id || reply._meta?.runtimeId !== meta.runtimeId || !reply.ok) reject(new Error('Local test RPC rejected: ' + method));
        else resolve(reply.result);
      }
    });
  });
}

class Phone {
  constructor(grant) {
    this.grant = grant; this.queue = []; this.waiting = null; this.closed = false;
    const keys = nacl.box.keyPair(); this.publicKey = keys.publicKey;
    this.shared = nacl.box.before(Buffer.from(grant.publicKeyB64, 'base64'), keys.secretKey);
    this.ws = new WebSocket(grant.endpoint);
    this.ws.on('message', data => {
      if (this.waiting) { const callback = this.waiting; this.waiting = null; callback(data); }
      else this.queue.push(data);
    });
    this.ws.on('close', () => { this.closed = true; this.waiting?.(null); this.waiting = null; });
    this.ws.on('error', () => {});
    clients.push(this);
  }
  receive() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(new Error('Phone connection closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting = null; reject(new Error('Phone response timed out')); }, 10000);
      this.waiting = data => { clearTimeout(timer); data === null ? reject(new Error('Phone connection closed')) : resolve(data); };
    });
  }
  send(value) {
    const nonce = nacl.randomBytes(24), box = nacl.box.after(Buffer.from(JSON.stringify(value)), nonce, this.shared);
    this.ws.send(Buffer.concat([nonce, box]).toString('base64'));
  }
  async read() {
    const bytes = Buffer.from((await this.receive()).toString(), 'base64');
    const plain = nacl.box.open.after(bytes.subarray(24), bytes.subarray(0, 24), this.shared);
    assert.ok(plain, 'Phone response must be encrypted');
    return JSON.parse(Buffer.from(plain));
  }
  async connect() {
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', () => reject(new Error('Phone endpoint unreachable'))); });
    this.ws.send(JSON.stringify({ type: 'e2ee_hello', publicKeyB64: Buffer.from(this.publicKey).toString('base64') }));
    assert.ok(JSON.parse(await this.receive()).type === 'e2ee_ready');
    this.send({ type: 'e2ee_auth', deviceToken: this.grant.deviceToken });
    assert.ok((await this.read()).type === 'e2ee_authenticated', 'Phone grant rejected');
  }
  async request(method, params = {}, expectedError) {
    const id = randomUUID(); this.send({ id, method, params, deviceToken: this.grant.deviceToken });
    const reply = await this.read();
    assert.ok(reply.id === id, 'Phone response ID mismatch');
    if (expectedError) assert.ok(reply.ok === false && reply.error.code === expectedError, 'Phone authorization boundary failed');
    else assert.ok(reply.ok, 'Phone RPC rejected: ' + method);
    return reply.result;
  }
  close() { this.ws.terminate(); }
}

async function stopRuntime(allowedHandles) {
  const meta = metadata();
  const listing = await local('terminal.list', { limit: 10000 });
  assert.deepEqual(listing.terminals.map(t => t.handle).sort(), [...allowedHandles].sort(), 'Unowned sessions present');
  const executable = execFileSync('ps', ['-p', String(meta.pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  assert.ok(realpathSync(executable) === realpathSync(join(app, 'Contents/Helpers/Orca.app/Contents/MacOS/Orca')));
  const args = execFileSync('ps', ['-p', String(meta.pid), '-o', 'args='], { encoding: 'utf8' });
  assert.ok(args.replaceAll('/private/tmp/', '/tmp/').includes(profile.replaceAll('/private/tmp/', '/tmp/')));
  process.kill(meta.pid, 'SIGTERM');
  for (let i = 0; i < 150; i++) {
    try { process.kill(meta.pid, 0); } catch { return; }
    await sleep(100);
  }
  throw new Error('Test runtime did not stop');
}

try {
  const initial = status(), initialPID = metadata().pid;
  const saved = readFileSync(join(config, 'connection.json'));
  const project = join(scratch, 'project'); mkdirSync(project);
  json('projects', 'add', project, '--folder', '--default');
  handle = json('new', 'terminal', '--name', 'phone-pairing-test').handle;
  incarnation = json('list').find(t => t.handle === handle).incarnationId;
  const address = json('phones').defaultAddress;
  assert.ok(address, 'A LAN or Tailscale address is required for the phone test');
  const first = json('pair-phone', '--address', address), oldGrant = claims(first);
  const repeated = json('pair-phone', '--address', address);
  assert.ok(repeated.deviceId === first.deviceId && repeated.pairingUrl === first.pairingUrl, 'Pending offer must be reusable');
  execFileSync('python3', ['-c', `
import fcntl, os, pty, select, struct, subprocess, sys, termios, time
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 40, 0, 0))
process = subprocess.Popen([sys.argv[1], 'pair-phone', '--address', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
deadline = time.monotonic() + 30
try:
 while time.monotonic() < deadline:
  if select.select([master], [], [], .1)[0]:
   try: chunk = os.read(master, 65536)
   except OSError: break
   if not chunk: break
   output += chunk
 process.wait(timeout=5)
 assert process.returncode == 0 and b'The QR code needs' in output and b'orca://pair?code=' in output
 assert b'\\x1b[30;47m' not in output, 'Narrow terminals must not wrap an unreadable QR'
finally:
 if process.poll() is None: process.kill(); process.wait()
 os.close(master)
`, cli, address], { env, encoding: 'utf8', timeout: 40000, stdio: ['ignore', 'pipe', 'pipe'] });
  report.narrowTerminalOffersPasteLink = true;
  const rotated = json('pair-phone', '--address', address, '--rotate'), grant = claims(rotated);
  assert.ok(rotated.deviceId !== first.deviceId, 'Rotation must invalidate the pending grant');
  await assert.rejects(() => new Phone(oldGrant).connect());
  report.pendingGrantReuseAndRotation = true;
  const phone = new Phone(grant); await phone.connect();
  assert.ok((await phone.request('status.get')).deviceScope === 'mobile');
  const listed = (await phone.request('terminal.list', { limit: 10000 })).terminals;
  assert.ok(listed.some(t => t.handle === handle));
  await phone.request('session.tabs.listAll');
  await phone.request('terminal.send', { terminal: handle, text: "printf '%s%s\\n' ORC_PHONE_ OK", enter: true });
  let observed = false;
  for (let i = 0; i < 30 && !observed; i++) {
    observed = JSON.stringify(await phone.request('terminal.read', { terminal: handle, lines: 100 })).includes('ORC_PHONE_OK');
    if (!observed) await sleep(100);
  }
  assert.ok(observed, 'Phone must receive terminal output after sending input');
  await phone.request('orc.phone.create', { address }, 'forbidden');
  const localGrant = JSON.parse(saved), remoteRuntime = new Phone({ ...localGrant, endpoint: grant.endpoint });
  await remoteRuntime.connect();
  await remoteRuntime.request('orc.phone.status', {}, 'method_not_found');
  remoteRuntime.close();
  report.encryptedMobileScopeTerminalInputOutput = true;
  const second = json('pair-phone', '--address', address), secondGrant = claims(second);
  assert.ok(second.deviceId !== rotated.deviceId);
  assert.ok((await phone.request('status.get')).runtimeId === initial.runtimeId, 'New pairing must keep live phones connected');
  assert.ok(metadata().pid === initialPID && json('list')[0].incarnationId === incarnation);
  assert.ok(json('phones').devices.some(d => d.deviceId === rotated.deviceId && d.lastSeenAt > 0));
  json('phones', 'revoke', rotated.deviceId);
  for (let i = 0; i < 50 && !phone.closed; i++) await sleep(100);
  assert.ok(phone.closed, 'Revocation must disconnect the active phone');
  await assert.rejects(() => new Phone(grant).connect());
  report.livePairingAndRevocationPreserveSession = true;
  const replacement = new Phone(secondGrant); await replacement.connect(); replacement.close();
  await stopRuntime([handle]);
  assert.ok(status().runtimeId !== initial.runtimeId);
  const restored = json('list').find(t => t.incarnationId === incarnation);
  assert.ok(restored?.connected, 'Terminal must survive controlled runtime restart');
  handle = restored.handle;
  const reconnected = new Phone(secondGrant); await reconnected.connect();
  assert.ok((await reconnected.request('terminal.list', { limit: 10000 })).terminals.some(t => t.handle === handle));
  assert.ok(readFileSync(join(config, 'connection.json')).equals(saved));
  report.phoneAndLocalAccessSurviveRestart = true;
  reconnected.close();
  await local('terminal.close', { terminal: handle }); handle = undefined;
  json('phones', 'revoke', second.deviceId);
  const nestedCLI = join(app, 'Contents/Helpers/Orca.app/Contents/Resources/bin/orca');
  const help = execFileSync(nestedCLI, ['--help'], { env, encoding: 'utf8', timeout: 15000 });
  assert.ok(help.includes('orca serve'), 'Nested runtime CLI must resolve its own app');
  report.nestedCLIResolvesInnerBundle = true;
  for (const directory of readdirSync(join(config, 'runtimes'))) {
    const log = readFileSync(join(config, 'runtimes', directory, 'backend.log'), 'utf8');
    assert.ok(!secrets.some(secret => log.includes(secret)), 'Pairing credentials must not appear in backend logs');
  }
  report.noPairingCredentialsInLogs = true;
  report.passed = true;
} catch (error) {
  console.error('Phone integration check failed:', error.message);
  process.exitCode = 1;
} finally {
  clients.forEach(client => client.close());
  try {
    if (handle) {
      const terminals = (await local('terminal.list', { limit: 10000 })).terminals;
      const owned = terminals.find(t => t.handle === handle || (incarnation && t.incarnationId === incarnation));
      if (owned) await local('terminal.close', { terminal: owned.handle });
    }
    await stopRuntime([]);
  } catch {
    report.cleanupIncomplete = true; report.passed = false; process.exitCode = 1;
  }
  const output = join(root, '.build/phone-e2e-report.json');
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (report.passed) rmSync(scratch, { recursive: true });
  else console.error('Private test diagnostics retained at', scratch);
  console.log('Phone pairing report:', output);
}
