import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { ProjectStore, HttpError } from './store.js';
import { readWifi } from './wifi.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data', 'projects');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JSON = 5 * 1024 * 1024;
const MAX_IMAGE = 40 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const store = new ProjectStore(DATA_DIR);

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), { 'Content-Type': MIME['.json'] });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'El contenido es demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, MAX_JSON);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // sin "api"
  const [resource, id, sub] = parts;
  const method = req.method;

  if (resource === 'health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, platform: process.platform, version: process.version });
  }

  if (resource === 'wifi' && method === 'GET') {
    return sendJson(res, 200, await readWifi());
  }

  if (resource !== 'projects') throw new HttpError(404, 'Ruta no encontrada');

  if (!id) {
    if (method === 'GET') return sendJson(res, 200, await store.list());
    if (method === 'POST') return sendJson(res, 201, await store.create(await readJson(req)));
    throw new HttpError(405, 'Método no permitido');
  }

  if (sub === 'background') {
    if (method === 'GET') {
      const { data, mime } = await store.readBackground(id);
      return send(res, 200, data, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    }
    if (method === 'PUT') {
      const mime = (req.headers['content-type'] || '').split(';')[0].trim();
      const data = await readBody(req, MAX_IMAGE);
      return sendJson(res, 200, await store.writeBackground(id, data, mime));
    }
    if (method === 'DELETE') return sendJson(res, 200, await store.deleteBackground(id));
    throw new HttpError(405, 'Método no permitido');
  }

  if (sub) throw new HttpError(404, 'Ruta no encontrada');

  if (method === 'GET') return sendJson(res, 200, await store.get(id));
  if (method === 'PUT') return sendJson(res, 200, await store.update(id, await readJson(req)));
  if (method === 'DELETE') {
    await store.remove(id);
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(405, 'Método no permitido');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método no permitido');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Acceso denegado');

  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, 'No encontrado');
  }
  if (!info.isFile()) throw new HttpError(404, 'No encontrado');

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const body = req.method === 'HEAD' ? undefined : await readFile(filePath);
  send(res, 200, body, { 'Content-Type': type, 'Content-Length': info.size });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url);
    }
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Error interno' });
    else res.end();
  }
});

await store.init();
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Heatmap Wi-Fi listo en http://${shown}:${PORT}`);
  console.log(`Proyectos en ${DATA_DIR}`);
});
