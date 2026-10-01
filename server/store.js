import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ID_RE = /^[a-f0-9-]{8,64}$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Campos que el cliente puede escribir; el resto (id, fechas, fondo) lo controla el servidor.
const EDITABLE = ['name', 'scale', 'size', 'environment', 'settings', 'aps', 'walls', 'measurements', 'thumbnail'];

function pick(src) {
  const out = {};
  for (const key of EDITABLE) if (src[key] !== undefined) out[key] = src[key];
  return out;
}

export class ProjectStore {
  constructor(dir) {
    this.dir = dir;
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
  }

  #file(id, ext = '.json') {
    if (!ID_RE.test(id)) throw new HttpError(400, 'Identificador inválido');
    return path.join(this.dir, id + ext);
  }

  async #write(file, data) {
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async list() {
    const files = (await readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const projects = await Promise.all(
      files.map(async (f) => {
        try {
          const p = JSON.parse(await readFile(path.join(this.dir, f), 'utf8'));
          return {
            id: p.id,
            name: p.name,
            hasMap: Boolean(p.background),
            size: p.size,
            scale: p.scale,
            apCount: p.aps?.length ?? 0,
            wallCount: p.walls?.length ?? 0,
            measurementCount: p.measurements?.length ?? 0,
            thumbnail: p.thumbnail ?? null,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          };
        } catch {
          return null;
        }
      }),
    );
    return projects.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.#file(id), 'utf8'));
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(404, 'Proyecto no encontrado');
    }
  }

  async create(body) {
    const now = new Date().toISOString();
    const project = {
      id: randomUUID(),
      name: 'Proyecto sin título',
      scale: 20,
      size: { width: 800, height: 500 },
      environment: {},
      settings: {},
      aps: [],
      walls: [],
      measurements: [],
      thumbnail: null,
      ...pick(body),
      background: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.#write(this.#file(project.id), JSON.stringify(project));
    return project;
  }

  async update(id, body) {
    const current = await this.get(id);
    const project = { ...current, ...pick(body), id, updatedAt: new Date().toISOString() };
    await this.#write(this.#file(id), JSON.stringify(project));
    return { id, updatedAt: project.updatedAt };
  }

  async remove(id) {
    await this.get(id);
    await unlink(this.#file(id));
    await unlink(this.#file(id, '.bg')).catch(() => {});
  }

  async readBackground(id) {
    const project = await this.get(id);
    if (!project.background) throw new HttpError(404, 'El proyecto no tiene plano');
    return { data: await readFile(this.#file(id, '.bg')), mime: project.background.mime };
  }

  async writeBackground(id, data, mime) {
    if (!IMAGE_TYPES.has(mime)) throw new HttpError(415, 'Formato de imagen no soportado (usa PNG, JPEG o WebP)');
    if (!data.length) throw new HttpError(400, 'Imagen vacía');
    const project = await this.get(id);
    await this.#write(this.#file(id, '.bg'), data);
    project.background = { mime, version: Date.now() };
    project.updatedAt = new Date().toISOString();
    await this.#write(this.#file(id), JSON.stringify(project));
    return project.background;
  }

  async deleteBackground(id) {
    const project = await this.get(id);
    project.background = null;
    project.updatedAt = new Date().toISOString();
    await this.#write(this.#file(id), JSON.stringify(project));
    await unlink(this.#file(id, '.bg')).catch(() => {});
    return { ok: true };
  }
}
