import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { escapeHtml } from '../public/render-utils.js';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const adminPassword = 'test-password-with-enough-entropy';
let serverProcess;
let dataDir;
let baseUrl;
let cookie;
let csrfToken;

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (!String(chunk).includes('Pickleball League app running')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited before startup with code ${code}`));
    });
  });
}

before(async () => {
  const port = await reservePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickleball-league-test-'));
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: projectDir,
    env: {
      ...process.env,
      ADMIN_PASSWORD: adminPassword,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await waitForServer(serverProcess);

  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  cookie = response.headers.get('set-cookie').split(';', 1)[0];
  csrfToken = result.csrfToken;
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit');
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('mutations require authentication and a CSRF token', async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/players/clear`, { method: 'POST' });
  assert.equal(unauthenticated.status, 401);

  const missingCsrf = await fetch(`${baseUrl}/api/players/clear`, {
    method: 'POST',
    headers: { Cookie: cookie }
  });
  assert.equal(missingCsrf.status, 403);
});

test('untrusted text is escaped before HTML rendering', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});

test('static responses include a restrictive content security policy', async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('overlapping slow mutations do not lose updates', async () => {
  const count = 10;
  const requests = await Promise.all(Array.from({ length: count }, (_, index) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ name: `Race ${index}` });
    const socket = net.createConnection(new URL(baseUrl).port, '127.0.0.1', () => {
      socket.write([
        'POST /api/players HTTP/1.1',
        `Host: ${new URL(baseUrl).host}`,
        `Cookie: ${cookie}`,
        `X-CSRF-Token: ${csrfToken}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n'));
      resolve({ body, socket });
    });
    socket.on('error', reject);
  })));

  await new Promise(resolve => setTimeout(resolve, 50));
  await Promise.all(requests.map(({ body, socket }) => new Promise((resolve, reject) => {
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => {
      assert.match(response, /^HTTP\/1\.1 201/m);
      resolve();
    });
    socket.on('error', reject);
    socket.write(body);
  })));

  const playersResponse = await fetch(`${baseUrl}/api/players`);
  const players = await playersResponse.json();
  assert.equal(players.length, count);
  assert.deepEqual(
    players.map(player => player.name).sort(),
    Array.from({ length: count }, (_, index) => `Race ${index}`).sort()
  );

  const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'data.json'), 'utf8'));
  assert.equal(persisted.players.length, count);
  assert.deepEqual(fs.readdirSync(dataDir).filter(name => name.endsWith('.tmp')), []);
});
