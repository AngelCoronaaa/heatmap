import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let dataDir;

test.before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'heatmap-test-'));
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve) => server.stdout.once('data', resolve));
});

test.after(async () => {
  server.kill();
  await rm(dataDir, { recursive: true, force: true });
});

const json = async (method, url, body) => {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test('sirve la aplicación estática', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Heatmap/);
  const js = await fetch(`${BASE}/js/propagation.js`);
  assert.match(js.headers.get('content-type'), /javascript/);
});

test('bloquea path traversal', async () => {
  const res = await fetch(`${BASE}/..%2fpackage.json`);
  assert.ok([403, 404].includes(res.status));
});

test('ciclo de vida de un proyecto', async () => {
  const created = await json('POST', '/api/projects', { name: 'Oficina', scale: 20, size: { width: 400, height: 300 }, id: 'ignored' });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.notEqual(id, 'ignored');

  const upd = await json('PUT', `/api/projects/${id}`, { aps: [{ id: 'x', x: 1, y: 2 }], background: { mime: 'text/html' } });
  assert.equal(upd.status, 200);

  const got = await json('GET', `/api/projects/${id}`);
  assert.equal(got.data.aps.length, 1);
  assert.equal(got.data.background, null, 'el cliente no puede escribir el fondo por JSON');

  const list = await json('GET', '/api/projects');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].apCount, 1);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const bad = await fetch(`${BASE}/api/projects/${id}/background`, { method: 'PUT', headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' });
  assert.equal(bad.status, 415);
  const up = await fetch(`${BASE}/api/projects/${id}/background`, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png });
  assert.equal(up.status, 200);
  const bg = await fetch(`${BASE}/api/projects/${id}/background`);
  assert.equal(bg.headers.get('content-type'), 'image/png');
  assert.equal(Buffer.from(await bg.arrayBuffer()).length, png.length);

  assert.equal((await json('DELETE', `/api/projects/${id}`)).status, 200);
  assert.equal((await json('GET', `/api/projects/${id}`)).status, 404);
});

test('rechaza identificadores inválidos', async () => {
  assert.equal((await json('GET', '/api/projects/..%2F..%2Fetc')).status, 400);
});
