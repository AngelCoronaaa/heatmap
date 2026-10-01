import { api } from './api.js';
import { Editor, isTyping } from './editor.js';
import {
  BANDS,
  MATERIALS,
  ENV_PRESETS,
  CLEAN_CHANNELS,
  prepareAps,
  prepareWalls,
  samplePoint,
  rssiAt,
  channelsOverlap,
} from './propagation.js';
import { VIEWS, ZONE_COLORS, colorize, gradientCss } from './colors.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => crypto.randomUUID();
const fmt = (n, d = 1) => Number(n).toLocaleString('es', { minimumFractionDigits: d, maximumFractionDigits: d });

const DEFAULT_SETTINGS = {
  view: 'signal',
  opacity: 0.7,
  minSignal: -85,
  required: -67,
  dimMap: 0,
  showLabels: true,
  showWalls: true,
  showMeasurements: true,
  showGrid: true,
  autoRead: false,
  idwRadius: 8,
  needsCalibration: false,
};
const DEFAULT_ENV = { preset: 'office', n: ENV_PRESETS.office.n, noise: -95 };
const BLANK_SCALE = 20; // px por metro en proyectos sin mapa
const MAX_IMAGE_SIDE = 6000;

const TOOL_HINTS = {
  select: 'Clic para seleccionar · arrastra para mover · arrastra el fondo para desplazar',
  ap: 'Clic para colocar un punto de acceso',
  wall: 'Clic para iniciar, clic para encadenar · doble clic o Esc para terminar · Shift = 45°',
  measure: 'Clic en tu posición actual para registrar la señal',
  scale: 'Marca dos puntos separados por una distancia conocida',
  erase: 'Clic sobre un AP, muro o medición para borrarlo',
};
const TOOL_KEYS = { v: 'select', a: 'ap', w: 'wall', m: 'measure', s: 'scale', e: 'erase' };

const state = {
  project: null,
  bg: null,
  tool: 'select',
  material: 'drywall',
  selection: null,
  settings: { ...DEFAULT_SETTINGS },
  grid: null,
  heatCanvas: null,
  prepared: { aps: [], walls: new Float64Array() },
  preparedIds: [],
  history: [],
  future: [],
  dirty: false,
  calibrationDismissed: false,
};

// ======================================================================
// Utilidades de interfaz
// ======================================================================

let toastTimer = 0;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function confirmDialog(title, text, okLabel = 'Eliminar') {
  const dlg = $('#dlg-confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function slug(s) {
  return String(s || 'proyecto').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'proyecto';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
    img.src = src;
  });
}

/** Prepara una imagen de plano para subirla: rasteriza SVG/GIF/BMP y limita el tamaño. */
async function prepareImageFile(file) {
  if (!file.type.startsWith('image/')) throw new Error('El archivo no es una imagen');
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    let w = img.naturalWidth || 2000;
    let h = img.naturalHeight || 1400;
    const isSvg = file.type === 'image/svg+xml';
    let k = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
    if (isSvg) k = Math.min(MAX_IMAGE_SIDE, 3000) / Math.max(w, h);
    const passthrough = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) && k === 1;
    if (passthrough) return { blob: file, width: w, height: h };
    const c = document.createElement('canvas');
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return { blob, width: c.width, height: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ======================================================================
// Inicio
// ======================================================================

const dateFmt = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });

async function showHome() {
  $('#editor').hidden = true;
  $('#home').hidden = false;
  document.title = 'Heatmap Wi‑Fi';
  state.project = null;
  const grid = $('#project-grid');
  let list = [];
  try {
    list = await api.listProjects();
  } catch (err) {
    toast(`No se pudieron cargar los proyectos: ${err.message}`, true);
  }
  grid.innerHTML =
    `<button class="card new" id="card-new"><svg><use href="#i-plus"/></svg><span>Nuevo proyecto</span></button>` +
    list
      .map(
        (p) => `
      <article class="card" data-id="${esc(p.id)}" tabindex="0">
        <div class="card-thumb">${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="">` : `<svg><use href="#i-${p.hasMap ? 'map' : 'grid'}"/></svg>`}</div>
        <div class="card-body">
          <div class="card-title">${esc(p.name)}</div>
          <div class="card-meta">
            <span class="badge ${p.hasMap ? '' : 'alt'}">${p.hasMap ? 'Con mapa' : 'Sin mapa'}</span>
            <span>${p.apCount} AP${p.apCount === 1 ? '' : 's'}</span>
            ${p.measurementCount ? `<span>${p.measurementCount} medici${p.measurementCount === 1 ? 'ón' : 'ones'}</span>` : ''}
          </div>
          <div class="card-meta"><span>${p.updatedAt ? esc(dateFmt.format(new Date(p.updatedAt))) : ''}</span></div>
        </div>
        <button class="icon-btn card-menu" data-delete="${esc(p.id)}" title="Eliminar proyecto"><svg><use href="#i-erase"/></svg></button>
      </article>`,
      )
      .join('');
}

$('#project-grid').addEventListener('click', async (e) => {
  if (e.target.closest('#card-new')) return openNewDialog();
  const del = e.target.closest('[data-delete]');
  if (del) {
    e.stopPropagation();
    const name = del.closest('.card').querySelector('.card-title').textContent;
    if (await confirmDialog('Eliminar proyecto', `"${name}" se eliminará permanentemente.`)) {
      try {
        await api.deleteProject(del.dataset.delete);
        toast('Proyecto eliminado');
        showHome();
      } catch (err) {
        toast(err.message, true);
      }
    }
    return;
  }
  const card = e.target.closest('.card[data-id]');
  if (card) location.hash = `#/p/${card.dataset.id}`;
});

$('#project-grid').addEventListener('keydown', (e) => {
  const card = e.target.closest('.card[data-id]');
  if (card && e.key === 'Enter') location.hash = `#/p/${card.dataset.id}`;
});

$('#btn-new').addEventListener('click', () => openNewDialog());

// ---------- Nuevo proyecto ----------

const formNew = $('#form-new');
let newImageFile = null;

for (const sel of [formNew.elements.env, $('#env-preset')]) {
  sel.innerHTML = Object.entries(ENV_PRESETS)
    .map(([k, v]) => `<option value="${k}">${v.label} (n = ${v.n})</option>`)
    .join('');
}
$('#env-preset').insertAdjacentHTML('beforeend', '<option value="custom">Personalizado</option>');

function openNewDialog() {
  formNew.reset();
  formNew.elements.env.value = 'office';
  newImageFile = null;
  $('#drop-preview').hidden = true;
  $('#new-error').textContent = '';
  syncNewMode();
  $('#dlg-new').showModal();
}

function syncNewMode() {
  const mode = formNew.elements.mode.value;
  $$('[data-mode]', formNew).forEach((el) => (el.hidden = el.dataset.mode !== mode));
}

formNew.addEventListener('change', (e) => {
  if (e.target.name === 'mode') syncNewMode();
  if (e.target.name === 'image') setNewImage(e.target.files[0]);
});

function setNewImage(file) {
  if (!file) return;
  newImageFile = file;
  const prev = $('#drop-preview');
  prev.src = URL.createObjectURL(file);
  prev.hidden = false;
  $('#new-error').textContent = '';
}

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  setNewImage(e.dataTransfer.files[0]);
});

formNew.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (e.submitter?.value === 'cancel') return $('#dlg-new').close();
  const f = formNew.elements;
  const mode = f.mode.value;
  const env = { ...DEFAULT_ENV, preset: f.env.value, n: ENV_PRESETS[f.env.value].n };
  const btn = $('#btn-create');
  try {
    btn.disabled = true;
    let project;
    if (mode === 'map') {
      if (!newImageFile) throw new Error('Selecciona una imagen del plano');
      const widthM = Number(f.mapWidth.value);
      if (!(widthM > 0)) throw new Error('Indica el ancho real del plano');
      const img = await prepareImageFile(newImageFile);
      project = await api.createProject({
        name: f.name.value.trim() || 'Nuevo proyecto',
        scale: img.width / widthM,
        size: { width: img.width, height: img.height },
        environment: env,
        settings: { ...DEFAULT_SETTINGS, showGrid: false, needsCalibration: true },
      });
      await api.uploadBackground(project.id, img.blob);
    } else {
      const w = Number(f.width.value);
      const h = Number(f.height.value);
      if (!(w > 0 && h > 0)) throw new Error('Indica las dimensiones del área');
      project = await api.createProject({
        name: f.name.value.trim() || 'Nuevo proyecto',
        scale: BLANK_SCALE,
        size: { width: w * BLANK_SCALE, height: h * BLANK_SCALE },
        environment: env,
        settings: { ...DEFAULT_SETTINGS },
      });
    }
    $('#dlg-new').close();
    location.hash = `#/p/${project.id}`;
  } catch (err) {
    $('#new-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Importar / exportar ----------

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'heatmap-wifi' || !data.project) throw new Error('El archivo no es un proyecto de Heatmap');
    const project = await api.createProject(data.project);
    if (data.background) {
      const blob = await (await fetch(data.background)).blob();
      await api.uploadBackground(project.id, blob);
    }
    toast('Proyecto importado');
    location.hash = `#/p/${project.id}`;
  } catch (err) {
    toast(`No se pudo importar: ${err.message}`, true);
  }
});

async function exportJson() {
  const p = state.project;
  await save();
  let background = null;
  if (p.background) {
    const blob = await (await fetch(api.backgroundUrl(p))).blob();
    background = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.readAsDataURL(blob);
    });
  }
  const { name, scale, size, environment, settings, aps, walls, measurements } = p;
  const data = {
    format: 'heatmap-wifi',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: { name, scale, size, environment, settings, aps, walls, measurements },
    background,
  };
  download(`${slug(p.name)}.heatmap.json`, new Blob([JSON.stringify(data)], { type: 'application/json' }));
}

function exportPng() {
  const p = state.project;
  const longest = Math.max(p.size.width, p.size.height);
  const k = Math.min(4096 / longest, 2);
  const ui = Math.max(1, (longest * k) / 1400);
  const plan = editor.renderToCanvas(4096, ui);
  const pad = Math.round(24 * ui);
  const footer = Math.round(84 * ui);
  const out = document.createElement('canvas');
  out.width = plan.width + pad * 2;
  out.height = plan.height + pad * 2 + footer;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#060a18';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(plan, pad, pad);

  const view = state.settings.view;
  const def = VIEWS[view];
  const y0 = pad * 2 + plan.height;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#e3e9ff';
  ctx.font = `600 ${16 * ui}px Inter, system-ui, sans-serif`;
  ctx.fillText(p.name, pad, y0);
  ctx.fillStyle = '#8a98c7';
  ctx.font = `500 ${12 * ui}px Inter, system-ui, sans-serif`;
  ctx.fillText(
    `${def.title} · ${fmt(p.size.width / p.scale)} × ${fmt(p.size.height / p.scale)} m · ${p.aps.length} APs · ${dateFmt.format(new Date())}`,
    pad,
    y0 + 24 * ui,
  );

  const lw = Math.min(360 * ui, out.width / 2 - pad);
  const lx = out.width - pad - lw;
  if (def.kind === 'gradient') {
    const stops = VIEWS[view].stops;
    const min = stops[0][0];
    const max = stops[stops.length - 1][0];
    const g = ctx.createLinearGradient(lx, 0, lx + lw, 0);
    for (const [v, c] of stops) g.addColorStop((v - min) / (max - min), c);
    ctx.fillStyle = g;
    ctx.fillRect(lx, y0 + 4 * ui, lw, 10 * ui);
    ctx.fillStyle = '#a9b5de';
    ctx.font = `500 ${11 * ui}px ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center';
    for (const t of def.ticks) ctx.fillText(String(t), lx + ((t - min) / (max - min)) * lw, y0 + 20 * ui);
    ctx.textAlign = 'right';
    ctx.fillText(def.unit, lx + lw, y0 + 38 * ui);
    ctx.textAlign = 'left';
  } else {
    const items =
      def.kind === 'zones'
        ? state.preparedIds.map((id, i) => ({ label: p.aps.find((a) => a.id === id)?.name ?? '', color: ZONE_COLORS[i % ZONE_COLORS.length] })).slice(0, 8)
        : def.classes;
    let x = lx;
    ctx.font = `500 ${11 * ui}px Inter, system-ui, sans-serif`;
    for (const it of items) {
      ctx.fillStyle = it.color;
      ctx.fillRect(x, y0 + 4 * ui, 12 * ui, 12 * ui);
      ctx.fillStyle = '#a9b5de';
      ctx.fillText(it.label, x + 18 * ui, y0 + 4 * ui);
      x += 18 * ui + ctx.measureText(it.label).width + 16 * ui;
    }
  }
  out.toBlob((blob) => download(`${slug(p.name)}-${view}.png`, blob), 'image/png');
}

$('#btn-export-png').addEventListener('click', exportPng);
$('#btn-export-json').addEventListener('click', () => exportJson().catch((err) => toast(err.message, true)));

// ======================================================================
// Editor
// ======================================================================

const editor = new Editor($('#canvas'), state, {
  beforeChange: () => pushHistory(),
  changed: (opts) => changed(opts),
  select: (sel) => select(sel),
  hover: (info) => onHover(info),
  measure: (p) => addMeasurement(p),
  calibrate: (a, b) => openScaleDialog(a, b),
  status: (info) => updateStatus(info),
  setTool: (t) => setTool(t),
  createAp: (x, y) => createAp(x, y),
});

function normalizeProject(p) {
  p.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
  if (!VIEWS[p.settings.view]) p.settings.view = 'signal';
  p.environment = { ...DEFAULT_ENV, ...(p.environment || {}) };
  p.aps ??= [];
  p.walls ??= [];
  p.measurements ??= [];
  p.scale = Number(p.scale) > 0 ? Number(p.scale) : BLANK_SCALE;
  p.size ??= { width: 800, height: 500 };
  return p;
}

async function openProject(id) {
  let project;
  try {
    project = normalizeProject(await api.getProject(id));
  } catch (err) {
    toast(err.message, true);
    location.hash = '';
    return;
  }
  Object.assign(state, {
    project,
    settings: project.settings,
    bg: null,
    selection: null,
    grid: null,
    heatCanvas: null,
    history: [],
    future: [],
    dirty: false,
    calibrationDismissed: false,
  });
  if (project.background) {
    try {
      state.bg = await loadImage(api.backgroundUrl(project));
    } catch {
      toast('No se pudo cargar el plano', true);
    }
  }
  $('#home').hidden = true;
  $('#editor').hidden = false;
  document.title = `${project.name} — Heatmap Wi‑Fi`;
  $('#project-name').value = project.name;
  setSaveStatus('Guardado');
  setTool('select');
  syncSettingsUi();
  renderViewSwitch();
  renderLegend();
  renderSelection();
  renderApList();
  renderPlanPanel();
  updateCounts();
  updateUndo();
  setWifiStatus(null);
  requestAnimationFrame(() => {
    editor.resize();
    editor.fit();
    scheduleCompute(false, true);
  });
}

function setTool(tool) {
  editor.setTool(tool);
  $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $('#tool-hint').textContent = TOOL_HINTS[tool] ?? '';
  const bar = $('#material-bar');
  bar.hidden = tool !== 'wall';
  if (tool === 'wall') renderMaterialBar();
  updateBanner();
}

$('#toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

function renderMaterialBar() {
  $('#material-bar').innerHTML = Object.entries(MATERIALS)
    .map(
      ([k, m]) =>
        `<button data-material="${k}" class="${k === state.material ? 'active' : ''}" title="${m.loss['2.4']} / ${m.loss['5']} / ${m.loss['6']} dB (2.4 / 5 / 6 GHz)"><i class="swatch" style="background:${m.color}"></i>${m.label}</button>`,
    )
    .join('');
}

$('#material-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-material]');
  if (!b) return;
  state.material = b.dataset.material;
  renderMaterialBar();
});

function select(sel) {
  state.selection = sel;
  renderSelection();
  renderApList();
  editor.requestRender();
}

function changed({ draft = false, fromPanel = false } = {}) {
  markDirty();
  scheduleCompute(draft);
  renderApList();
  updateCounts();
  if (!fromPanel && !draft) renderSelection();
  editor.requestRender();
}

// ---------- Historial ----------

let pendingSnapshot = null;
const snapshot = () => {
  const { aps, walls, measurements, scale, size } = state.project;
  return JSON.stringify({ aps, walls, measurements, scale, size });
};

function pushHistory(snap = snapshot()) {
  state.history.push(snap);
  if (state.history.length > 100) state.history.shift();
  state.future = [];
  updateUndo();
}

function restore(snap) {
  Object.assign(state.project, JSON.parse(snap));
  if (state.selection && !editor.findObject(state.selection)) state.selection = null;
  changed();
  renderPlanPanel();
  updateUndo();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  restore(state.history.pop());
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  restore(state.future.pop());
}

function updateUndo() {
  $('#btn-undo').disabled = !state.history.length;
  $('#btn-redo').disabled = !state.future.length;
}

$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

// ---------- Guardado ----------

let saveTimer = 0;
let saving = false;
let saveAgain = false;

function setSaveStatus(text, error = false) {
  const el = $('#save-status');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function markDirty() {
  state.dirty = true;
  setSaveStatus('Sin guardar');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

function savePayload(p, withThumb) {
  const { name, scale, size, environment, settings, aps, walls, measurements } = p;
  const body = { name, scale, size, environment, settings, aps, walls, measurements };
  if (withThumb) {
    try {
      body.thumbnail = editor.renderToCanvas(400).toDataURL('image/jpeg', 0.8);
    } catch {}
  }
  return body;
}

async function save() {
  clearTimeout(saveTimer);
  const p = state.project;
  if (!p || !state.dirty) return;
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  state.dirty = false;
  setSaveStatus('Guardando…');
  try {
    await api.updateProject(p.id, savePayload(p, true));
    if (state.project === p && !state.dirty) setSaveStatus('Guardado');
  } catch (err) {
    state.dirty = true;
    setSaveStatus('Error al guardar', true);
    toast(`Error al guardar: ${err.message}`, true);
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      save();
    }
  }
}

window.addEventListener('beforeunload', (e) => {
  if (!state.project || !state.dirty) return;
  fetch(`/api/projects/${state.project.id}`, {
    method: 'PUT',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(savePayload(state.project, false)),
  });
  e.preventDefault();
});

$('#project-name').addEventListener('input', (e) => {
  state.project.name = e.target.value.trim() || 'Proyecto sin título';
  document.title = `${state.project.name} — Heatmap Wi‑Fi`;
  markDirty();
});
$('#project-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});

$('#btn-back').addEventListener('click', async () => {
  await save();
  location.hash = '';
});

// ======================================================================
// Cálculo del mapa de calor (Web Worker)
// ======================================================================

const worker = new Worker('/js/heatmap-worker.js', { type: 'module' });
let jobSeq = 0;
let lastApplied = 0;
let busy = false;
let queued = null;
let computeTimer = 0;
const jobs = new Map();

worker.onmessage = (e) => {
  const { jobId, result, ms } = e.data;
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  busy = false;
  if (job && state.project?.id === job.projectId && jobId > lastApplied) {
    lastApplied = jobId;
    state.grid = { ...job.meta, result };
    paintHeat();
    updateStats();
    $('#st-compute').textContent = `${job.meta.draft ? 'borrador' : 'rejilla'} ${job.meta.gridW}×${job.meta.gridH} · ${Math.round(ms)} ms`;
  }
  if (queued) {
    const next = queued;
    queued = null;
    runJob(next);
  }
};

worker.onerror = (e) => {
  busy = false;
  console.error(e);
  toast('Error al calcular el mapa de calor', true);
};

function buildJob(draft) {
  const p = state.project;
  const { width: W, height: H } = p.size;
  const target = draft ? 7000 : 70000;
  const cell = Math.max(1, Math.sqrt((W * H) / target));
  const gridW = Math.ceil(W / cell);
  const gridH = Math.ceil(H / cell);
  const aps = prepareAps(p.aps);
  const walls = prepareWalls(p.walls);
  state.prepared = { aps, walls };
  state.preparedIds = aps.map((a) => a.id);
  return {
    id: ++jobSeq,
    projectId: p.id,
    meta: { gridW, gridH, cell, draft },
    params: {
      gridW,
      gridH,
      cell,
      scale: p.scale,
      aps,
      walls,
      n: p.environment.n,
      noise: p.environment.noise,
      required: p.settings.required,
      measurements: p.measurements.map(({ x, y, rssi }) => ({ x, y, rssi })),
      idwRadius: p.settings.idwRadius,
    },
  };
}

function runJob(job) {
  busy = true;
  jobs.set(job.id, job);
  worker.postMessage({ jobId: job.id, params: job.params });
}

function scheduleCompute(draft, immediate = false) {
  if (!state.project) return;
  clearTimeout(computeTimer);
  const go = () => {
    const job = buildJob(draft);
    if (busy) queued = job;
    else runJob(job);
  };
  if (draft || immediate) go();
  else computeTimer = setTimeout(go, 90);
}

function paintHeat() {
  const g = state.grid;
  if (!g) return;
  const img = colorize(g.result, state.settings.view, { gridW: g.gridW, gridH: g.gridH, minSignal: state.settings.minSignal });
  state.heatCanvas ??= document.createElement('canvas');
  const c = state.heatCanvas;
  c.width = g.gridW;
  c.height = g.gridH;
  c.getContext('2d').putImageData(img, 0, 0);
  editor.requestRender();
}

function updateStats() {
  const el = $('#stats');
  const p = state.project;
  const g = state.grid;
  if (!g) return;
  const area = (p.size.width / p.scale) * (p.size.height / p.scale);
  const tile = (value, label, pct) =>
    `<div class="stat"><b>${value}</b><span>${label}</span>${pct !== undefined ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>` : ''}</div>`;

  if (state.settings.view === 'measured' || !p.aps.some((a) => a.enabled !== false)) {
    const ms = p.measurements;
    if (!ms.length) {
      el.innerHTML = `<p class="empty-note" style="grid-column:1/-1">Agrega puntos de acceso (A) para ver la predicción o mediciones (M) para el survey.</p>`;
      return;
    }
    const vals = ms.map((m) => m.rssi);
    const ok = vals.filter((v) => v >= p.settings.required).length;
    el.innerHTML =
      tile(ms.length, 'Mediciones') +
      tile(`${Math.round((ok / vals.length) * 100)}%`, `Puntos ≥ ${p.settings.required} dBm`, (ok / vals.length) * 100) +
      tile(`${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)} dBm`, 'RSSI promedio') +
      tile(`${Math.round(Math.min(...vals))} dBm`, 'Peor punto');
    return;
  }

  const { best, cover, interf, snr } = g.result;
  const total = best.length;
  let ok = 0;
  let redundant = 0;
  let cci = 0;
  let covered = 0;
  let snrSum = 0;
  for (let i = 0; i < total; i++) {
    if (best[i] >= p.settings.required) ok++;
    if (cover[i] >= 2) redundant++;
    if (best[i] >= p.settings.minSignal) {
      covered++;
      snrSum += snr[i];
      if (interf[i] > 0) cci++;
    }
  }
  const pct = (n, d = total) => (d ? (n / d) * 100 : 0);
  el.innerHTML =
    tile(`${Math.round(pct(ok))}%`, `Área ≥ ${p.settings.required} dBm`, pct(ok)) +
    tile(`${Math.round(pct(redundant))}%`, 'Redundancia (2+ APs)', pct(redundant)) +
    tile(`${Math.round(pct(cci, covered))}%`, 'Con interferencia CCI', pct(cci, covered)) +
    tile(covered ? `${Math.round(snrSum / covered)} dB` : '—', 'SNR promedio') +
    `<div class="stat" style="grid-column:1/-1"><span>Área del plano</span><b>${fmt(area, 0)} m²</b></div>`;
}

// ======================================================================
// Paneles
// ======================================================================

function renderViewSwitch() {
  $('#view-switch').innerHTML = Object.entries(VIEWS)
    .map(
      ([k, v], i) =>
        `<button role="tab" data-view="${k}" class="${k === state.settings.view ? 'active' : ''}" title="${v.title} (${i + 1})">${v.label}</button>`,
    )
    .join('');
}

function setView(view) {
  if (!VIEWS[view]) return;
  state.settings.view = view;
  renderViewSwitch();
  renderLegend();
  paintHeat();
  updateStats();
  markDirty();
}

$('#view-switch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) setView(b.dataset.view);
});

function renderLegend() {
  const view = state.settings.view;
  const def = VIEWS[view];
  const el = $('#legend');
  let html = `<div class="legend-title"><span>${def.title}</span><span>${def.unit}</span></div>`;
  if (def.kind === 'gradient') {
    const stops = def.stops;
    const min = stops[0][0];
    const max = stops[stops.length - 1][0];
    html += `<div class="legend-bar" style="background:${gradientCss(view)}"></div><div class="legend-ticks">${def.ticks
      .map((t) => `<span style="left:${((t - min) / (max - min)) * 100}%">${t}</span>`)
      .join('')}</div>`;
    if (view === 'measured' && !state.project.measurements.length) {
      html += `<p class="note">Sin mediciones aún — usa la herramienta de medición (M).</p>`;
    }
  } else if (def.kind === 'discrete') {
    html += `<div class="legend-classes">${def.classes.map((c) => `<span><i style="background:${c.color}"></i>${c.label}</span>`).join('')}</div>`;
    if (view === 'coverage') html += `<p class="note">Señal requerida: ${state.settings.required} dBm</p>`;
    if (view === 'interference') html += `<p class="note">APs solapados ≥ −82 dBm</p>`;
  } else {
    const aps = state.preparedIds.map((id) => state.project.aps.find((a) => a.id === id)).filter(Boolean);
    html += aps.length
      ? `<div class="legend-classes">${aps
          .slice(0, 12)
          .map((a, i) => `<span><i style="background:${ZONE_COLORS[i % ZONE_COLORS.length]}"></i>${esc(a.name)}</span>`)
          .join('')}</div>`
      : `<p class="note">Sin APs activos.</p>`;
  }
  el.innerHTML = html;
}

function syncSettingsUi() {
  const s = state.settings;
  const env = state.project.environment;
  for (const key of ['opacity', 'minSignal', 'required', 'dimMap', 'idwRadius']) $(`#set-${key}`).value = s[key];
  for (const key of ['showLabels', 'showWalls', 'showMeasurements', 'showGrid', 'autoRead']) $(`#set-${key}`).checked = s[key];
  $('#env-preset').value = ENV_PRESETS[env.preset] && ENV_PRESETS[env.preset].n === env.n ? env.preset : 'custom';
  $('#env-n').value = env.n;
  $('#env-noise').value = env.noise;
  $('#field-dim').hidden = !state.bg;
  updateOutputs();
}

function updateOutputs() {
  const s = state.settings;
  const env = state.project.environment;
  $('#out-opacity').textContent = `${Math.round(s.opacity * 100)}%`;
  $('#out-minSignal').textContent = `${s.minSignal} dBm`;
  $('#out-required').textContent = `${s.required} dBm`;
  $('#out-dimMap').textContent = `${Math.round(s.dimMap * 100)}%`;
  $('#out-idwRadius').textContent = `${s.idwRadius} m`;
  $('#out-n').textContent = Number(env.n).toFixed(2);
  $('#out-noise').textContent = `${env.noise} dBm`;
}

// Ajustes de visualización: algunos solo recolorean, otros recalculan.
const RECOMPUTE_SETTINGS = new Set(['required', 'idwRadius']);
$('#sidebar').addEventListener('input', (e) => {
  const id = e.target.id;
  if (!state.project) return;
  if (id.startsWith('set-')) {
    const key = id.slice(4);
    state.settings[key] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
    updateOutputs();
    if (RECOMPUTE_SETTINGS.has(key)) scheduleCompute(false);
    if (key === 'minSignal') paintHeat();
    if (key === 'required') renderLegend();
    editor.requestRender();
    markDirty();
  } else if (id === 'env-n' || id === 'env-noise') {
    const env = state.project.environment;
    env[id === 'env-n' ? 'n' : 'noise'] = Number(e.target.value);
    if (id === 'env-n') {
      env.preset = 'custom';
      $('#env-preset').value = 'custom';
    }
    updateOutputs();
    scheduleCompute(false);
    markDirty();
  }
});

$('#env-preset').addEventListener('change', (e) => {
  const preset = ENV_PRESETS[e.target.value];
  const env = state.project.environment;
  env.preset = e.target.value;
  if (preset) env.n = preset.n;
  $('#env-n').value = env.n;
  updateOutputs();
  scheduleCompute(false);
  markDirty();
});

function updateCounts() {
  const p = state.project;
  $('#ap-count').textContent = p.aps.length ? `· ${p.aps.length}` : '';
  $('#m-count').textContent = p.measurements.length ? `· ${p.measurements.length}` : '';
  if (state.settings.view === 'zones' || state.settings.view === 'measured') renderLegend();
}

function renderApList() {
  const p = state.project;
  if (!p) return;
  const zoneIndex = new Map(state.preparedIds.map((id, i) => [id, i]));
  $('#ap-list').innerHTML = p.aps.length
    ? p.aps
        .map((ap) => {
          const zi = zoneIndex.get(ap.id);
          const color = ap.enabled === false ? '#3a4570' : zi !== undefined ? ZONE_COLORS[zi % ZONE_COLORS.length] : '#5b8cff';
          const active = state.selection?.type === 'ap' && state.selection.id === ap.id;
          return `<button class="ap-item ${active ? 'active' : ''} ${ap.enabled === false ? 'off' : ''}" data-ap="${ap.id}">
            <i class="dot" style="background:${color}"></i>
            <span class="name">${esc(ap.name)}</span>
            <span class="meta">${BANDS[ap.band]?.label.replace(' GHz', 'G')} · ${ap.channel} · ${(ap.txPower ?? 0) + (ap.gain ?? 0)} dBm</span>
          </button>`;
        })
        .join('')
    : `<p class="empty-note">Sin puntos de acceso. Usa la herramienta AP (A) y haz clic en el plano.</p>`;
}

$('#ap-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ap]');
  if (!b) return;
  const ap = state.project.aps.find((a) => a.id === b.dataset.ap);
  if (!ap) return;
  select({ type: 'ap', id: ap.id });
  editor.centerOn(ap.x, ap.y);
});

$('#btn-add-ap').addEventListener('click', () => {
  const p = state.project;
  const c = editor.toPlan(editor.width / 2, editor.height / 2);
  const x = Math.min(p.size.width, Math.max(0, c.x));
  const y = Math.min(p.size.height, Math.max(0, c.y));
  pushHistory();
  const ap = createAp(x, y);
  p.aps.push(ap);
  select({ type: 'ap', id: ap.id });
  changed();
});

$('#btn-optimize').addEventListener('click', () => {
  const p = state.project;
  if (!p.aps.length) return toast('No hay APs para optimizar');
  pushHistory();
  optimizeChannels();
  changed();
  toast('Canales reasignados');
});

// ---------- APs y canales ----------

function nextApName() {
  const used = new Set(state.project.aps.map((a) => a.name));
  let i = state.project.aps.length + 1;
  while (used.has(`AP-${String(i).padStart(2, '0')}`)) i++;
  return `AP-${String(i).padStart(2, '0')}`;
}

function bestChannel(band, width, x, y, others) {
  const p = state.project;
  const candidates = CLEAN_CHANNELS[band]?.[width] ?? BANDS[band].channels;
  const walls = prepareWalls(p.walls);
  let best = candidates[0];
  let bestScore = Infinity;
  for (const ch of candidates) {
    const probe = { band, channel: ch, width };
    let score = -200;
    for (const o of others) {
      if (channelsOverlap(probe, o)) score = Math.max(score, rssiAt(o, x, y, walls, p.environment.n, p.scale));
    }
    if (score < bestScore - 0.01) {
      bestScore = score;
      best = ch;
    }
  }
  return best;
}

function createAp(x, y) {
  const band = '5';
  const width = 20;
  return {
    id: uid(),
    name: nextApName(),
    x,
    y,
    band,
    width,
    channel: bestChannel(band, width, x, y, prepareAps(state.project.aps)),
    txPower: 17,
    gain: 4,
    enabled: true,
  };
}

// Asignación voraz: cada AP toma el canal menos ocupado por los APs ya asignados.
function optimizeChannels() {
  const aps = state.project.aps.filter((a) => a.enabled !== false);
  const prepared = prepareAps(aps);
  // Primero los APs con más vecinos cercanos
  const order = prepared
    .map((ap, i) => ({ i, load: prepared.reduce((s, o) => s + (o === ap ? 0 : 1 / (1 + Math.hypot(o.x - ap.x, o.y - ap.y))), 0) }))
    .sort((a, b) => b.load - a.load);
  const assigned = [];
  for (const { i } of order) {
    const ap = aps[i];
    const prep = prepared[i];
    ap.channel = bestChannel(ap.band, ap.width ?? 20, ap.x, ap.y, assigned);
    prep.channel = ap.channel;
    assigned.push(prep);
  }
}

// ---------- Panel de selección ----------

function renderSelection() {
  const el = $('#panel-selection');
  const sel = state.selection;
  const obj = sel && editor.findObject(sel);
  if (!obj) {
    el.innerHTML = '';
    return;
  }
  const p = state.project;
  const pos = (x, y) => `${fmt(x / p.scale)} m, ${fmt(y / p.scale)} m`;
  const head = (kind, title) =>
    `<div class="sel-head"><div><div class="kind">${kind}</div><h3>${esc(title)}</h3></div><button class="icon-btn" data-act="close" title="Cerrar (Esc)"><svg><use href="#i-close"/></svg></button></div>`;

  if (sel.type === 'ap') {
    const band = BANDS[obj.band];
    el.innerHTML = `${head('Punto de acceso', obj.name)}
      <label class="field"><span>Nombre</span><input data-f="name" value="${esc(obj.name)}" maxlength="40"></label>
      <div class="row gap">
        <label class="field grow"><span>Banda</span><select data-f="band">${Object.entries(BANDS)
          .map(([k, b]) => `<option value="${k}" ${k === obj.band ? 'selected' : ''}>${b.label}</option>`)
          .join('')}</select></label>
        <label class="field grow"><span>Ancho</span><select data-f="width">${band.widths
          .map((w) => `<option value="${w}" ${w === (obj.width ?? 20) ? 'selected' : ''}>${w} MHz</option>`)
          .join('')}</select></label>
      </div>
      <div class="row gap">
        <label class="field grow"><span>Canal</span><select data-f="channel">${band.channels
          .map((c) => `<option value="${c}" ${c === obj.channel ? 'selected' : ''}>${c}</option>`)
          .join('')}</select></label>
        <div class="field grow"><span>Estado</span><label class="toggle inline"><input type="checkbox" data-f="enabled" ${obj.enabled !== false ? 'checked' : ''}><span>Activo</span></label></div>
      </div>
      <label class="field"><span>Potencia TX <output data-out="txPower">${obj.txPower} dBm</output></span><input type="range" data-f="txPower" min="0" max="30" step="1" value="${obj.txPower}"></label>
      <label class="field"><span>Ganancia de antena <output data-out="gain">${obj.gain} dBi</output></span><input type="range" data-f="gain" min="0" max="12" step="0.5" value="${obj.gain}"></label>
      <dl class="kv"><dt>EIRP</dt><dd data-out="eirp">${obj.txPower + obj.gain} dBm</dd><dt>Posición</dt><dd>${pos(obj.x, obj.y)}</dd></dl>
      <div class="row gap"><button class="btn ghost sm grow" data-act="duplicate">Duplicar</button><button class="btn ghost sm grow danger-text" data-act="delete">Eliminar</button></div>`;
  } else if (sel.type === 'wall') {
    const len = Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) / p.scale;
    const m = MATERIALS[obj.material] ?? MATERIALS.drywall;
    el.innerHTML = `${head('Muro', m.label)}
      <label class="field"><span>Material</span><select data-f="material">${Object.entries(MATERIALS)
        .map(([k, v]) => `<option value="${k}" ${k === obj.material ? 'selected' : ''}>${v.label}</option>`)
        .join('')}</select></label>
      <dl class="kv"><dt>Longitud</dt><dd>${fmt(len, 2)} m</dd><dt>Atenuación</dt><dd>${m.loss['2.4']} / ${m.loss['5']} / ${m.loss['6']} dB</dd><dt></dt><dd style="color:var(--muted);font-size:11px">2.4 / 5 / 6 GHz</dd></dl>
      <button class="btn ghost sm danger-text" data-act="delete">Eliminar muro</button>`;
  } else if (sel.type === 'measurement') {
    el.innerHTML = `${head('Medición', `${Math.round(obj.rssi)} dBm`)}
      <div class="row gap">
        <label class="field grow"><span>RSSI (dBm)</span><input type="number" data-f="rssi" min="-120" max="0" step="1" value="${obj.rssi}"></label>
        <label class="field grow"><span>SSID</span><input data-f="ssid" value="${esc(obj.ssid ?? '')}" maxlength="64"></label>
      </div>
      <dl class="kv">
        <dt>Posición</dt><dd>${pos(obj.x, obj.y)}</dd>
        ${obj.channel ? `<dt>Canal</dt><dd>${obj.channel}${obj.band ? ` (${obj.band} GHz)` : ''}</dd>` : ''}
        ${obj.noise ? `<dt>Ruido</dt><dd>${obj.noise} dBm</dd>` : ''}
        <dt>Origen</dt><dd>${obj.source === 'auto' ? 'Adaptador Wi‑Fi' : 'Manual'}</dd>
        ${obj.ts ? `<dt>Fecha</dt><dd>${esc(dateFmt.format(new Date(obj.ts)))}</dd>` : ''}
      </dl>
      <button class="btn ghost sm danger-text" data-act="delete">Eliminar medición</button>`;
  }
}

const selPanel = $('#panel-selection');
selPanel.addEventListener('focusin', (e) => {
  if (e.target.matches('[data-f]')) pendingSnapshot = snapshot();
});
selPanel.addEventListener('focusout', () => (pendingSnapshot = null));

function onSelectionField(e) {
  const f = e.target.dataset.f;
  if (!f) return;
  const obj = editor.findObject(state.selection);
  if (!obj) return;
  if (pendingSnapshot) {
    pushHistory(pendingSnapshot);
    pendingSnapshot = null;
  }
  const t = e.target;
  let value = t.type === 'checkbox' ? t.checked : t.type === 'range' || t.type === 'number' ? Number(t.value) : t.value;
  if (f === 'channel' || f === 'width') value = Number(value);
  if (f === 'rssi' && !Number.isFinite(value)) return;
  if (f === 'name') value = value.trim() || obj.name;
  obj[f] = value;

  let rerender = false;
  if (f === 'band') {
    const band = BANDS[value];
    if (!band.widths.includes(obj.width)) obj.width = 20;
    const others = prepareAps(state.project.aps.filter((a) => a !== obj));
    obj.channel = bestChannel(value, obj.width, obj.x, obj.y, others);
    rerender = true;
  }
  if (f === 'width') {
    const others = prepareAps(state.project.aps.filter((a) => a !== obj));
    obj.channel = bestChannel(obj.band, obj.width, obj.x, obj.y, others);
    rerender = true;
  }
  if (f === 'material' || f === 'rssi') rerender = e.type === 'change';
  if (f === 'txPower' || f === 'gain') {
    $(`[data-out="${f}"]`, selPanel).textContent = `${value} ${f === 'gain' ? 'dBi' : 'dBm'}`;
    $('[data-out="eirp"]', selPanel).textContent = `${obj.txPower + obj.gain} dBm`;
  }
  if (f === 'name') $('.sel-head h3', selPanel).textContent = obj.name;
  if (e.type === 'change') pendingSnapshot = snapshot();
  changed({ fromPanel: !rerender });
}

selPanel.addEventListener('input', onSelectionField);
selPanel.addEventListener('change', (e) => {
  // Los <select> y checkbox ya disparan "input"; aquí solo cerramos el paso de historial
  if (e.target.tagName === 'SELECT' || e.target.type === 'checkbox') {
    pendingSnapshot = snapshot();
    return;
  }
  onSelectionField(e);
});

selPanel.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'close') select(null);
  if (act === 'delete') editor.deleteSelection();
  if (act === 'duplicate') {
    const obj = editor.findObject(state.selection);
    if (!obj) return;
    pushHistory();
    const copy = { ...obj, id: uid(), name: nextApName(), x: obj.x + 30 / editor.zoom, y: obj.y + 30 / editor.zoom };
    copy.channel = bestChannel(copy.band, copy.width ?? 20, copy.x, copy.y, prepareAps(state.project.aps));
    state.project.aps.push(copy);
    select({ type: 'ap', id: copy.id });
    changed();
  }
});

// ---------- Panel del plano ----------

function renderPlanPanel() {
  const p = state.project;
  const W = p.size.width / p.scale;
  const H = p.size.height / p.scale;
  const el = $('#plan-panel');
  if (state.bg) {
    el.innerHTML = `
      <dl class="kv">
        <dt>Modo</dt><dd><span class="badge">Con mapa</span></dd>
        <dt>Imagen</dt><dd>${p.size.width} × ${p.size.height} px</dd>
        <dt>Dimensiones</dt><dd>${fmt(W)} × ${fmt(H)} m</dd>
        <dt>Escala</dt><dd>1 m = ${fmt(p.scale)} px</dd>
      </dl>
      <div class="row gap">
        <button class="btn primary sm grow" data-plan-act="calibrate">Calibrar escala</button>
        <button class="btn ghost sm grow" data-plan-act="load">Reemplazar</button>
      </div>
      <div class="row gap" style="margin-top:8px"><button class="btn ghost sm grow danger-text" data-plan-act="remove">Quitar plano (pasar a sin mapa)</button></div>`;
  } else {
    el.innerHTML = `
      <dl class="kv"><dt>Modo</dt><dd><span class="badge alt">Sin mapa</span></dd><dt>Área</dt><dd>${fmt(W * H, 0)} m²</dd></dl>
      <div class="row gap">
        <label class="field grow"><span>Ancho (m)</span><input type="number" data-plan="width" min="2" max="1000" step="0.5" value="${+W.toFixed(2)}"></label>
        <label class="field grow"><span>Largo (m)</span><input type="number" data-plan="height" min="2" max="1000" step="0.5" value="${+H.toFixed(2)}"></label>
      </div>
      <button class="btn ghost sm" data-plan-act="load" style="width:100%"><svg class="ico"><use href="#i-upload"/></svg>Cargar plano (pasar a con mapa)</button>`;
  }
  $('#field-dim').hidden = !state.bg;
  updateStatus({ zoom: editor.zoom });
  updateBanner();
}

$('#plan-panel').addEventListener('change', (e) => {
  const key = e.target.dataset.plan;
  if (!key) return;
  const meters = Number(e.target.value);
  if (!(meters >= 2 && meters <= 1000)) return renderPlanPanel();
  pushHistory();
  state.project.size[key] = Math.round(meters * state.project.scale);
  renderPlanPanel();
  changed();
});

$('#plan-panel').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-plan-act]')?.dataset.planAct;
  if (act === 'calibrate') setTool('scale');
  if (act === 'load') $('#plan-file').click();
  if (act === 'remove') {
    if (!(await confirmDialog('Quitar plano', 'El proyecto pasará a modo sin mapa. Los APs, muros y mediciones se conservan.', 'Quitar'))) return;
    try {
      await api.deleteBackground(state.project.id);
      state.project.background = null;
      state.bg = null;
      state.settings.showGrid = true;
      syncSettingsUi();
      renderPlanPanel();
      changed();
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('#plan-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const p = state.project;
  try {
    const img = await prepareImageFile(file);
    const bg = await api.uploadBackground(p.id, img.blob);
    // Conserva el ancho físico actual: reescala coordenadas para que los objetos sigan en su sitio en metros
    const k = img.width / p.size.width;
    pushHistory();
    for (const ap of p.aps) Object.assign(ap, { x: ap.x * k, y: ap.y * k });
    for (const m of p.measurements) Object.assign(m, { x: m.x * k, y: m.y * k });
    for (const w of p.walls) Object.assign(w, { x1: w.x1 * k, y1: w.y1 * k, x2: w.x2 * k, y2: w.y2 * k });
    p.scale *= k;
    p.size = { width: img.width, height: img.height };
    p.background = bg;
    state.bg = await loadImage(api.backgroundUrl(p));
    state.settings.needsCalibration = true;
    state.settings.showGrid = false;
    state.calibrationDismissed = false;
    syncSettingsUi();
    renderPlanPanel();
    changed();
    editor.fit();
    toast('Plano cargado — calibra la escala');
  } catch (err) {
    toast(err.message, true);
  }
});

function updateBanner() {
  const show = Boolean(state.bg && state.settings.needsCalibration && !state.calibrationDismissed && state.tool === 'select');
  $('#calibrate-banner').hidden = !show;
  $('#tool-hint').hidden = show;
}

$('#btn-banner-calibrate').addEventListener('click', () => setTool('scale'));
$('#btn-banner-dismiss').addEventListener('click', () => {
  state.calibrationDismissed = true;
  updateBanner();
});

// ---------- Calibración ----------

let scaleSegment = null;
function openScaleDialog(a, b) {
  const p = state.project;
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  if (px < 2) {
    editor.scalePts = [];
    return;
  }
  scaleSegment = px;
  const form = $('#form-scale');
  $('#scale-info').textContent = `Segmento marcado: ${fmt(px, 0)} px (≈ ${fmt(px / p.scale, 2)} m con la escala actual).`;
  form.elements.meters.value = +(px / p.scale).toFixed(2);
  $('#dlg-scale').showModal();
  form.elements.meters.select();
}

$('#form-scale').addEventListener('submit', (e) => {
  e.preventDefault();
  const dlg = $('#dlg-scale');
  if (e.submitter?.value !== 'cancel') {
    const meters = Number(e.target.elements.meters.value);
    if (!(meters > 0)) return;
    pushHistory();
    state.project.scale = scaleSegment / meters;
    state.settings.needsCalibration = false;
    renderPlanPanel();
    changed();
    toast(`Escala: 1 m = ${fmt(state.project.scale)} px`);
    setTool('select');
  }
  editor.scalePts = [];
  editor.requestRender();
  dlg.close();
});
$('#dlg-scale').addEventListener('close', () => {
  editor.scalePts = [];
  editor.requestRender();
});

// ---------- Survey / mediciones ----------

function setWifiStatus(r, busyText) {
  const el = $('#wifi-status');
  el.classList.remove('ok', 'err', 'busy');
  const text = $('.text', el);
  if (busyText) {
    el.classList.add('busy');
    text.textContent = busyText;
  } else if (!r) {
    text.textContent = 'Adaptador Wi‑Fi sin probar';
  } else if (r.ok) {
    el.classList.add('ok');
    text.textContent = `${r.rssi} dBm · ${r.ssid ?? 'SSID oculto'}${r.channel ? ` · ch ${r.channel}` : ''}`;
  } else {
    el.classList.add('err');
    text.textContent = r.error || 'No disponible';
  }
}

async function readWifi() {
  setWifiStatus(null, 'Leyendo adaptador Wi‑Fi…');
  const r = await api.readWifi().catch((err) => ({ ok: false, error: err.message }));
  setWifiStatus(r);
  return r;
}

$('#btn-wifi-test').addEventListener('click', readWifi);

$('#btn-clear-measurements').addEventListener('click', async () => {
  const p = state.project;
  if (!p.measurements.length) return;
  if (!(await confirmDialog('Borrar mediciones', `Se eliminarán ${p.measurements.length} puntos de medición.`))) return;
  pushHistory();
  p.measurements = [];
  if (state.selection?.type === 'measurement') state.selection = null;
  changed();
  renderLegend();
});

let measureTarget = null;

async function addMeasurement(pt) {
  if (state.settings.autoRead) {
    toast('Leyendo señal…');
    const r = await readWifi();
    if (r.ok) {
      pushMeasurement(pt, { rssi: r.rssi, ssid: r.ssid, noise: r.noise, channel: r.channel, band: r.band, source: 'auto' });
      toast(`Medición: ${r.rssi} dBm`);
      return;
    }
    openMeasureDialog(pt, `Lectura automática no disponible: ${r.error}`);
    return;
  }
  openMeasureDialog(pt);
}

function pushMeasurement(pt, data) {
  pushHistory();
  const m = { id: uid(), x: pt.x, y: pt.y, ts: Date.now(), ...data };
  state.project.measurements.push(m);
  changed();
  renderLegend();
}

function openMeasureDialog(pt, error = '') {
  measureTarget = pt;
  const form = $('#form-measure');
  const last = state.project.measurements.at(-1);
  form.elements.rssi.value = last ? Math.round(last.rssi) : -60;
  form.elements.ssid.value = last?.ssid ?? '';
  $('#measure-error').textContent = error;
  $('#dlg-measure').showModal();
  form.elements.rssi.select();
}

let measureExtra = {};
$('#btn-measure-read').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#measure-error').textContent = '';
  const r = await readWifi();
  btn.disabled = false;
  const form = $('#form-measure');
  if (r.ok) {
    form.elements.rssi.value = r.rssi;
    if (r.ssid) form.elements.ssid.value = r.ssid;
    measureExtra = { noise: r.noise, channel: r.channel, band: r.band, source: 'auto' };
  } else {
    $('#measure-error').textContent = r.error;
  }
});

$('#form-measure').addEventListener('submit', (e) => {
  e.preventDefault();
  const dlg = $('#dlg-measure');
  if (e.submitter?.value !== 'cancel' && measureTarget) {
    const rssi = Number(e.target.elements.rssi.value);
    if (!Number.isFinite(rssi)) return;
    pushMeasurement(measureTarget, { rssi, ssid: e.target.elements.ssid.value.trim() || null, source: 'manual', ...measureExtra });
  }
  measureExtra = {};
  measureTarget = null;
  dlg.close();
});

// ---------- Tooltip y barra de estado ----------

function updateStatus({ zoom, pointer } = {}) {
  const p = state.project;
  if (!p) return;
  if (pointer) $('#st-pos').textContent = `x ${fmt(pointer.x / p.scale)} m · y ${fmt(pointer.y / p.scale)} m`;
  $('#st-size').textContent = `${fmt(p.size.width / p.scale)} × ${fmt(p.size.height / p.scale)} m`;
  $('#st-scale').textContent = `1 m = ${fmt(p.scale)} px`;
  if (zoom) $('#st-zoom').textContent = `${Math.round(zoom * 100)}%`;
}

function onHover(info) {
  const tt = $('#tooltip');
  const p = state.project;
  if (!info || !p || ['wall', 'scale'].includes(state.tool)) {
    tt.hidden = true;
    return;
  }
  const { p: pt, sx, sy } = info;
  if (pt.x < 0 || pt.y < 0 || pt.x > p.size.width || pt.y > p.size.height) {
    tt.hidden = true;
    return;
  }
  const view = state.settings.view;
  let html = '';
  if (view === 'measured') {
    const g = state.grid;
    const gx = g ? Math.floor(pt.x / g.cell) : -1;
    const gy = g ? Math.floor(pt.y / g.cell) : -1;
    const v = g && gx >= 0 && gy >= 0 && gx < g.gridW && gy < g.gridH ? g.result.measured[gy * g.gridW + gx] : NaN;
    if (Number.isNaN(v)) {
      tt.hidden = true;
      return;
    }
    html = `<div class="tt-main">${Math.round(v)} dBm <small>medido (interpolado)</small></div>`;
  } else {
    const { aps, walls } = state.prepared;
    if (!aps.length) {
      tt.hidden = true;
      return;
    }
    const s = samplePoint(pt.x, pt.y, { aps, walls, n: p.environment.n, scale: p.scale, noise: p.environment.noise });
    const name = (id) => p.aps.find((a) => a.id === id)?.name ?? '';
    const best = s.best;
    const dist = Math.hypot(best.ap.x - pt.x, best.ap.y - pt.y) / p.scale;
    const covering = s.list.filter((e) => e.rssi >= state.settings.required).length;
    const others = s.list.slice(1, 4).map((e) => `${esc(name(e.ap.id))} ${Math.round(e.rssi)}`);
    html = `<div class="tt-main">${Math.round(best.rssi)} dBm <small>${esc(name(best.ap.id))}</small></div>
      <div class="tt-grid">
        <span>SNR</span><b>${Math.round(s.snr)} dB</b>
        <span>Velocidad</span><b>${s.rate ? `${Math.round(s.rate)} Mbps` : '—'}</b>
        <span>Interferentes</span><b>${s.interferers}</b>
        <span>APs ≥ ${state.settings.required}</span><b>${covering}</b>
        <span>Distancia</span><b>${fmt(dist)} m</b>
      </div>
      ${others.length ? `<div class="tt-sec">${others.join(' · ')}</div>` : ''}`;
  }
  tt.innerHTML = html;
  tt.hidden = false;
  const stage = $('#stage');
  const w = tt.offsetWidth;
  const h = tt.offsetHeight;
  const x = sx + 18 + w > stage.clientWidth ? sx - w - 14 : sx + 18;
  const y = sy + 18 + h > stage.clientHeight ? sy - h - 14 : sy + 18;
  tt.style.left = `${Math.max(4, x)}px`;
  tt.style.top = `${Math.max(4, y)}px`;
}

$('#zoom-in').addEventListener('click', () => editor.zoomBy(1.25));
$('#zoom-out').addEventListener('click', () => editor.zoomBy(0.8));
$('#zoom-fit').addEventListener('click', () => editor.fit());

// ---------- Teclado ----------

window.addEventListener('keydown', (e) => {
  if (!state.project || $('#editor').hidden || document.querySelector('dialog[open]')) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    state.dirty = true;
    save();
    return;
  }
  if (isTyping(e)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 'd' && state.selection?.type === 'ap') {
    e.preventDefault();
    $('[data-act="duplicate"]', selPanel)?.click();
  } else if (mod) {
    return;
  } else if (TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  } else if (key === 'escape') {
    editor.cancel();
  } else if (key === 'delete' || key === 'backspace') {
    e.preventDefault();
    editor.deleteSelection();
  } else if (key === 'f') {
    editor.fit();
  } else if (key === '+' || key === '=') {
    editor.zoomBy(1.25);
  } else if (key === '-') {
    editor.zoomBy(0.8);
  } else if (/^[1-7]$/.test(key)) {
    setView(Object.keys(VIEWS)[Number(key) - 1]);
  }
});

// ======================================================================
// Rutas
// ======================================================================

async function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)$/);
  if (m) {
    if (state.project?.id !== m[1]) {
      await save();
      openProject(m[1]);
    }
  } else {
    await save();
    showHome();
  }
}

window.addEventListener('hashchange', route);
route();

// Exportado solo para depuración desde la consola
window.__heatmap = { state, editor };
