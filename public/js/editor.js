import { MATERIALS, BANDS } from './propagation.js';
import { colorAt, ZONE_COLORS } from './colors.js';

const HIT_AP = 14;
const HIT_POINT = 9;
const HIT_WALL = 7;
const HIT_HANDLE = 9;
const SNAP = 10;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 40;

const uid = () => crypto.randomUUID();

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * Lienzo interactivo: pan/zoom, herramientas de edición y dibujo de todas las capas.
 * `hooks`: beforeChange(), changed({ draft }), select(sel), hover(info), measure(pt), calibrate(p1, p2), status(info)
 */
export class Editor {
  constructor(canvas, state, hooks) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.state = state;
    this.hooks = hooks;
    this.zoom = 1;
    this.ox = 0;
    this.oy = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.pointer = null;
    this.screenPointer = null;
    this.drag = null;
    this.wallStart = null;
    this.scalePts = [];
    this.spaceDown = false;
    this.frame = 0;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    canvas.addEventListener('pointerleave', () => {
      this.screenPointer = null;
      this.hooks.hover(null);
      this.requestRender();
    });
    canvas.addEventListener('dblclick', () => this.finishWall());
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !isTyping(e)) {
        this.spaceDown = true;
        this.updateCursor();
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.spaceDown = false;
        this.updateCursor();
      }
    });
  }

  get project() {
    return this.state.project;
  }

  // ---------- Coordenadas ----------

  toPlan(sx, sy) {
    return { x: (sx - this.ox) / this.zoom, y: (sy - this.oy) / this.zoom };
  }

  eventPoint(e) {
    const r = this.canvas.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (!w || !h) return;
    const first = !this.width;
    this.dpr = window.devicePixelRatio || 1;
    this.width = w;
    this.height = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    if (first && this.project) this.fit();
    this.requestRender();
  }

  fit() {
    if (!this.project || !this.width) return;
    const { width, height } = this.project.size;
    const pad = 48;
    this.zoom = Math.min((this.width - pad * 2) / width, (this.height - pad * 2) / height);
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom));
    this.ox = (this.width - width * this.zoom) / 2;
    this.oy = (this.height - height * this.zoom) / 2;
    this.emitStatus();
    this.requestRender();
  }

  zoomBy(factor, sx = this.width / 2, sy = this.height / 2) {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.zoom * factor));
    const p = this.toPlan(sx, sy);
    this.zoom = z;
    this.ox = sx - p.x * z;
    this.oy = sy - p.y * z;
    this.emitStatus();
    this.requestRender();
  }

  centerOn(x, y) {
    this.ox = this.width / 2 - x * this.zoom;
    this.oy = this.height / 2 - y * this.zoom;
    this.requestRender();
  }

  emitStatus() {
    this.hooks.status({ zoom: this.zoom, pointer: this.pointer });
  }

  // ---------- Herramientas ----------

  setTool(tool) {
    this.wallStart = null;
    this.scalePts = [];
    this.state.tool = tool;
    this.updateCursor();
    this.requestRender();
  }

  updateCursor() {
    const c = this.canvas;
    if (this.drag?.kind === 'pan') c.style.cursor = 'grabbing';
    else if (this.spaceDown) c.style.cursor = 'grab';
    else if (this.state.tool === 'select') c.style.cursor = this.hoverHit ? 'move' : 'default';
    else if (this.state.tool === 'erase') c.style.cursor = this.hoverHit ? 'pointer' : 'not-allowed';
    else c.style.cursor = 'crosshair';
  }

  cancel() {
    if (this.wallStart || this.scalePts.length) {
      this.wallStart = null;
      this.scalePts = [];
    } else if (this.state.selection) {
      this.hooks.select(null);
    } else if (this.state.tool !== 'select') {
      this.hooks.setTool('select');
    }
    this.requestRender();
  }

  finishWall() {
    if (this.state.tool === 'wall' && this.wallStart) {
      this.wallStart = null;
      this.requestRender();
    }
  }

  hitTest(p) {
    const proj = this.project;
    const z = this.zoom;
    const s = this.state;
    for (let i = proj.aps.length - 1; i >= 0; i--) {
      const ap = proj.aps[i];
      if (Math.hypot(ap.x - p.x, ap.y - p.y) * z <= HIT_AP) return { type: 'ap', id: ap.id };
    }
    if (s.settings.showMeasurements) {
      for (let i = proj.measurements.length - 1; i >= 0; i--) {
        const m = proj.measurements[i];
        if (Math.hypot(m.x - p.x, m.y - p.y) * z <= HIT_POINT) return { type: 'measurement', id: m.id };
      }
    }
    if (s.selection?.type === 'wall') {
      const w = proj.walls.find((w) => w.id === s.selection.id);
      if (w) {
        if (Math.hypot(w.x1 - p.x, w.y1 - p.y) * z <= HIT_HANDLE) return { type: 'wall', id: w.id, handle: 1 };
        if (Math.hypot(w.x2 - p.x, w.y2 - p.y) * z <= HIT_HANDLE) return { type: 'wall', id: w.id, handle: 2 };
      }
    }
    if (s.settings.showWalls) {
      let bestD = Infinity;
      let hit = null;
      for (const w of proj.walls) {
        const d = distToSegment(p.x, p.y, w.x1, w.y1, w.x2, w.y2) * z;
        if (d <= HIT_WALL && d < bestD) {
          bestD = d;
          hit = { type: 'wall', id: w.id };
        }
      }
      if (hit) return hit;
    }
    return null;
  }

  findObject(sel) {
    if (!sel) return null;
    const list = { ap: this.project.aps, wall: this.project.walls, measurement: this.project.measurements }[sel.type];
    return list?.find((o) => o.id === sel.id) ?? null;
  }

  // Ajuste a extremos de muros existentes y a ángulos de 45° con Shift.
  snapPoint(p, from, shift) {
    let best = null;
    let bestD = SNAP / this.zoom;
    for (const w of this.project.walls) {
      for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < bestD) {
          bestD = d;
          best = { x, y, snapped: true };
        }
      }
    }
    if (best) return best;
    if (from && shift) {
      const dx = p.x - from.x;
      const dy = p.y - from.y;
      const len = Math.hypot(dx, dy);
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      return { x: from.x + Math.cos(ang) * len, y: from.y + Math.sin(ang) * len };
    }
    return { x: p.x, y: p.y };
  }

  // ---------- Eventos ----------

  onPointerDown(e) {
    if (!this.project) return;
    this.canvas.setPointerCapture(e.pointerId);
    const { sx, sy } = this.eventPoint(e);
    const p = this.toPlan(sx, sy);
    const tool = this.state.tool;
    this.hooks.hover(null);

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      this.startPan(sx, sy);
      return;
    }
    if (e.button === 2) {
      if (tool === 'wall') this.finishWall();
      else if (tool === 'scale') this.scalePts = [];
      this.requestRender();
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'select') {
      const hit = this.hitTest(p);
      if (!hit) {
        this.hooks.select(null);
        this.startPan(sx, sy);
        return;
      }
      this.hooks.select({ type: hit.type, id: hit.id });
      const obj = this.findObject(hit);
      this.drag = {
        kind: 'move',
        hit,
        start: p,
        orig: { ...obj },
        moved: false,
      };
      return;
    }

    if (tool === 'erase') {
      const hit = this.hitTest(p);
      if (hit) this.removeObject(hit);
      return;
    }

    if (tool === 'ap') {
      this.hooks.beforeChange();
      const ap = this.hooks.createAp(p.x, p.y);
      this.project.aps.push(ap);
      this.hooks.select({ type: 'ap', id: ap.id });
      this.hooks.changed({});
      return;
    }

    if (tool === 'wall') {
      const pt = this.snapPoint(p, this.wallStart, e.shiftKey);
      if (!this.wallStart) {
        this.wallStart = pt;
      } else if (Math.hypot(pt.x - this.wallStart.x, pt.y - this.wallStart.y) * this.zoom > 3) {
        this.hooks.beforeChange();
        this.project.walls.push({
          id: uid(),
          x1: this.wallStart.x,
          y1: this.wallStart.y,
          x2: pt.x,
          y2: pt.y,
          material: this.state.material,
        });
        this.wallStart = pt;
        this.hooks.changed({});
      }
      this.requestRender();
      return;
    }

    if (tool === 'measure') {
      if (p.x < 0 || p.y < 0 || p.x > this.project.size.width || p.y > this.project.size.height) return;
      this.hooks.measure(p);
      return;
    }

    if (tool === 'scale') {
      this.scalePts.push(this.snapPoint(p, this.scalePts[0], e.shiftKey));
      if (this.scalePts.length === 2) {
        const [a, b] = this.scalePts;
        this.hooks.calibrate(a, b);
      }
      this.requestRender();
    }
  }

  startPan(sx, sy) {
    this.drag = { kind: 'pan', sx, sy, ox: this.ox, oy: this.oy };
    this.updateCursor();
  }

  onPointerMove(e) {
    if (!this.project) return;
    const { sx, sy } = this.eventPoint(e);
    const p = this.toPlan(sx, sy);
    this.pointer = p;
    this.screenPointer = { sx, sy };
    this.shiftKey = e.shiftKey;

    const d = this.drag;
    if (d?.kind === 'pan') {
      this.ox = d.ox + (sx - d.sx);
      this.oy = d.oy + (sy - d.sy);
      this.requestRender();
      this.emitStatus();
      return;
    }

    if (d?.kind === 'move') {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      if (!d.moved && Math.hypot(dx, dy) * this.zoom < 3) return;
      if (!d.moved) {
        this.hooks.beforeChange();
        d.moved = true;
      }
      const obj = this.findObject(d.hit);
      if (!obj) return;
      if (d.hit.type === 'wall') {
        if (d.hit.handle) {
          const fixed = d.hit.handle === 1 ? { x: obj.x2, y: obj.y2 } : { x: obj.x1, y: obj.y1 };
          const pt = this.snapPointExcluding(p, fixed, e.shiftKey, obj.id);
          obj[`x${d.hit.handle}`] = pt.x;
          obj[`y${d.hit.handle}`] = pt.y;
        } else {
          obj.x1 = d.orig.x1 + dx;
          obj.y1 = d.orig.y1 + dy;
          obj.x2 = d.orig.x2 + dx;
          obj.y2 = d.orig.y2 + dy;
        }
      } else {
        obj.x = d.orig.x + dx;
        obj.y = d.orig.y + dy;
      }
      this.hooks.changed({ draft: true });
      this.requestRender();
      return;
    }

    const hit = this.state.tool === 'select' || this.state.tool === 'erase' ? this.hitTest(p) : null;
    if (Boolean(hit) !== Boolean(this.hoverHit) || hit?.id !== this.hoverHit?.id) {
      this.hoverHit = hit;
      this.updateCursor();
    }
    this.hooks.hover({ p, sx, sy });
    this.emitStatus();
    if (this.state.tool === 'wall' || this.state.tool === 'scale' || this.state.tool === 'erase') this.requestRender();
  }

  snapPointExcluding(p, from, shift, excludeId) {
    const walls = this.project.walls;
    this.project.walls = walls.filter((w) => w.id !== excludeId);
    try {
      return this.snapPoint(p, from, shift);
    } finally {
      this.project.walls = walls;
    }
  }

  onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (d?.kind === 'move' && d.moved) this.hooks.changed({});
    this.updateCursor();
  }

  onWheel(e) {
    if (!this.project) return;
    e.preventDefault();
    const { sx, sy } = this.eventPoint(e);
    const unit = e.deltaMode === 1 ? 16 : 1;
    const speed = e.ctrlKey ? 0.01 : 0.0015;
    this.zoomBy(Math.exp(-e.deltaY * unit * speed), sx, sy);
  }

  removeObject(sel) {
    const key = { ap: 'aps', wall: 'walls', measurement: 'measurements' }[sel.type];
    if (!key) return;
    this.hooks.beforeChange();
    this.project[key] = this.project[key].filter((o) => o.id !== sel.id);
    if (this.state.selection?.id === sel.id) this.hooks.select(null);
    this.hoverHit = null;
    this.hooks.changed({});
    this.requestRender();
  }

  deleteSelection() {
    if (this.state.selection) this.removeObject(this.state.selection);
  }

  // ---------- Dibujo ----------

  requestRender() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.project) return;
    ctx.setTransform(this.dpr * this.zoom, 0, 0, this.dpr * this.zoom, this.dpr * this.ox, this.dpr * this.oy);
    this.drawScene(ctx, this.zoom, true);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawScaleBar(ctx);
  }

  /** Dibuja la escena en coordenadas del plano. `z` = píxeles de pantalla por píxel de plano. */
  drawScene(ctx, z, interactive) {
    const s = this.state;
    const proj = this.project;
    const { width: W, height: H } = proj.size;
    const set = s.settings;

    // Plano
    ctx.save();
    if (interactive) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 30;
    }
    ctx.fillStyle = s.bg ? '#ffffff' : '#0c1431';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (s.bg) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(s.bg, 0, 0, W, H);
      if (set.dimMap > 0) {
        ctx.fillStyle = `rgba(6, 10, 24, ${set.dimMap})`;
        ctx.fillRect(0, 0, W, H);
      }
    }
    if (set.showGrid) this.drawGrid(ctx, z, W, H);

    if (s.heatCanvas && s.grid) {
      ctx.globalAlpha = set.opacity;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(s.heatCanvas, 0, 0, s.grid.gridW * s.grid.cell, s.grid.gridH * s.grid.cell);
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    if (!s.bg) {
      ctx.strokeStyle = 'rgba(122, 162, 255, 0.35)';
      ctx.lineWidth = 1 / z;
      ctx.strokeRect(0, 0, W, H);
    }

    if (set.showWalls) this.drawWalls(ctx, z, interactive);
    if (set.showMeasurements) this.drawMeasurements(ctx, z);
    this.drawAps(ctx, z);
    if (interactive) this.drawOverlays(ctx, z);
  }

  drawGrid(ctx, z, W, H) {
    const scale = this.project.scale;
    const pxPerM = scale * z;
    let step = 1;
    while (pxPerM * step < 14) step *= step === 1 ? 5 : 2;
    const major = step * 5;
    ctx.lineWidth = 1 / z;
    for (const [every, color] of [[step, this.state.bg ? 'rgba(20, 40, 90, 0.10)' : 'rgba(122, 162, 255, 0.07)'], [major, this.state.bg ? 'rgba(20, 40, 90, 0.22)' : 'rgba(122, 162, 255, 0.16)']]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let m = every; m * scale < W; m += every) {
        ctx.moveTo(m * scale, 0);
        ctx.lineTo(m * scale, H);
      }
      for (let m = every; m * scale < H; m += every) {
        ctx.moveTo(0, m * scale);
        ctx.lineTo(W, m * scale);
      }
      ctx.stroke();
    }
  }

  drawWalls(ctx, z, interactive) {
    const sel = this.state.selection;
    const hover = interactive && this.state.tool === 'erase' ? this.hoverHit : null;
    ctx.lineCap = 'round';
    for (const w of this.project.walls) {
      const mat = MATERIALS[w.material] ?? MATERIALS.drywall;
      const selected = sel?.type === 'wall' && sel.id === w.id;
      ctx.beginPath();
      ctx.moveTo(w.x1, w.y1);
      ctx.lineTo(w.x2, w.y2);
      ctx.strokeStyle = 'rgba(5, 8, 20, 0.75)';
      ctx.lineWidth = (selected ? 8 : 6) / z;
      ctx.stroke();
      ctx.strokeStyle = hover?.id === w.id ? '#ff6b81' : mat.color;
      ctx.lineWidth = (selected ? 4.5 : 3) / z;
      ctx.stroke();
      if (selected && interactive) {
        for (const [x, y] of [[w.x1, w.y1], [w.x2, w.y2]]) {
          ctx.beginPath();
          ctx.arc(x, y, 5 / z, 0, Math.PI * 2);
          ctx.fillStyle = '#0a1024';
          ctx.fill();
          ctx.strokeStyle = '#7aa2ff';
          ctx.lineWidth = 2 / z;
          ctx.stroke();
        }
      }
    }
  }

  drawMeasurements(ctx, z) {
    const sel = this.state.selection;
    const showLabels = this.state.settings.showLabels;
    ctx.font = `600 ${10 / z}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const m of this.project.measurements) {
      const selected = sel?.type === 'measurement' && sel.id === m.id;
      ctx.beginPath();
      ctx.arc(m.x, m.y, (selected ? 6.5 : 5) / z, 0, Math.PI * 2);
      ctx.fillStyle = colorAt('signal', m.rssi);
      ctx.fill();
      ctx.lineWidth = (selected ? 2.5 : 1.5) / z;
      ctx.strokeStyle = selected ? '#ffffff' : 'rgba(5, 8, 20, 0.85)';
      ctx.stroke();
      if (showLabels && z > 0.35) {
        const label = `${Math.round(m.rssi)}`;
        const tx = m.x + 8 / z;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(6, 10, 24, 0.78)';
        roundRect(ctx, tx - 3 / z, m.y - 7 / z, tw + 6 / z, 14 / z, 4 / z);
        ctx.fill();
        ctx.fillStyle = '#e3e9ff';
        ctx.fillText(label, tx, m.y + 0.5 / z);
      }
    }
  }

  drawAps(ctx, z) {
    const s = this.state;
    const sel = s.selection;
    const zoneIndex = new Map((s.preparedIds ?? []).map((id, i) => [id, i]));
    const useZone = s.settings.view === 'zones';
    for (const ap of this.project.aps) {
      const selected = sel?.type === 'ap' && sel.id === ap.id;
      const disabled = ap.enabled === false;
      const r = 10 / z;
      const zi = zoneIndex.get(ap.id);
      const fill = disabled ? '#3a4570' : useZone && zi !== undefined ? ZONE_COLORS[zi % ZONE_COLORS.length] : '#5b8cff';

      if (selected) {
        ctx.beginPath();
        ctx.arc(ap.x, ap.y, r + 6 / z, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(122, 162, 255, 0.25)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(ap.x, ap.y, r, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2 / z;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      // Ícono Wi-Fi
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.4 / z;
      ctx.lineCap = 'round';
      for (const k of [2.5, 5]) {
        ctx.beginPath();
        ctx.arc(ap.x, ap.y + 3 / z, k / z, Math.PI * 1.25, Math.PI * 1.75);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(ap.x, ap.y + 3 / z, 1 / z, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      if (s.settings.showLabels) {
        const band = BANDS[ap.band]?.label.replace(' GHz', 'G') ?? '';
        const lines = [ap.name, `${band} · ch ${ap.channel}`];
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.font = `600 ${11 / z}px Inter, system-ui, sans-serif`;
        const w1 = ctx.measureText(lines[0]).width;
        ctx.font = `500 ${9.5 / z}px Inter, system-ui, sans-serif`;
        const w2 = ctx.measureText(lines[1]).width;
        const bw = Math.max(w1, w2) + 12 / z;
        const by = ap.y + r + 5 / z;
        ctx.fillStyle = 'rgba(6, 10, 24, 0.82)';
        roundRect(ctx, ap.x - bw / 2, by, bw, 30 / z, 6 / z);
        ctx.fill();
        ctx.fillStyle = disabled ? '#6f7cab' : '#e3e9ff';
        ctx.font = `600 ${11 / z}px Inter, system-ui, sans-serif`;
        ctx.fillText(lines[0], ap.x, by + 3.5 / z);
        ctx.fillStyle = '#8a98c7';
        ctx.font = `500 ${9.5 / z}px Inter, system-ui, sans-serif`;
        ctx.fillText(lines[1], ap.x, by + 17 / z);
      }
    }
  }

  drawOverlays(ctx, z) {
    const s = this.state;
    const p = this.pointer;
    if (!p || !this.screenPointer) return;

    if (s.tool === 'wall') {
      const pt = this.snapPoint(p, this.wallStart, this.shiftKey);
      const mat = MATERIALS[s.material];
      if (this.wallStart) {
        ctx.beginPath();
        ctx.moveTo(this.wallStart.x, this.wallStart.y);
        ctx.lineTo(pt.x, pt.y);
        ctx.strokeStyle = mat.color;
        ctx.lineWidth = 3 / z;
        ctx.setLineDash([6 / z, 4 / z]);
        ctx.stroke();
        ctx.setLineDash([]);
        const len = Math.hypot(pt.x - this.wallStart.x, pt.y - this.wallStart.y) / this.project.scale;
        this.drawTag(ctx, z, (pt.x + this.wallStart.x) / 2, (pt.y + this.wallStart.y) / 2, `${len.toFixed(2)} m`);
      }
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, (pt.snapped ? 6 : 4) / z, 0, Math.PI * 2);
      ctx.fillStyle = pt.snapped ? '#7aa2ff' : mat.color;
      ctx.fill();
    }

    if (s.tool === 'scale') {
      const pts = [...this.scalePts];
      if (pts.length === 1) pts.push(this.snapPoint(p, pts[0], this.shiftKey));
      ctx.strokeStyle = '#f5c542';
      ctx.fillStyle = '#f5c542';
      ctx.lineWidth = 2 / z;
      if (pts.length === 2) {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.stroke();
        const px = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        this.drawTag(ctx, z, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2, `${(px / this.project.scale).toFixed(2)} m`);
      }
      for (const q of pts) {
        ctx.beginPath();
        ctx.arc(q.x, q.y, 4 / z, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (s.tool === 'ap' || s.tool === 'measure') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, (s.tool === 'ap' ? 10 : 5) / z, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(122, 162, 255, 0.8)';
      ctx.lineWidth = 1.5 / z;
      ctx.setLineDash([3 / z, 3 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  drawTag(ctx, z, x, y, text) {
    ctx.font = `600 ${11 / z}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 12 / z;
    ctx.fillStyle = 'rgba(6, 10, 24, 0.9)';
    roundRect(ctx, x - w / 2, y - 18 / z, w, 18 / z, 5 / z);
    ctx.fill();
    ctx.fillStyle = '#e3e9ff';
    ctx.fillText(text, x, y - 9 / z);
  }

  drawScaleBar(ctx) {
    const pxPerM = this.project.scale * this.zoom;
    const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
    const meters = nice.find((m) => m * pxPerM >= 70) ?? 500;
    const len = meters * pxPerM;
    const x = 16;
    const y = 22;
    ctx.strokeStyle = 'rgba(227, 233, 255, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.lineTo(x + len, y - 4);
    ctx.stroke();
    ctx.font = '500 11px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(227, 233, 255, 0.85)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${meters} m`, x + len + 8, y - 9);
  }

  /** Renderiza el plano completo en un canvas nuevo (exportación y miniaturas). */
  renderToCanvas(maxSide, uiScale = 1) {
    const { width: W, height: H } = this.project.size;
    const k = Math.min(maxSide / Math.max(W, H), 2);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(W * k));
    canvas.height = Math.max(1, Math.round(H * k));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // Trazos y textos se expresan en px de salida; uiScale los agranda en exportaciones grandes
    this.drawScene(ctx, k / uiScale, false);
    return canvas;
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function isTyping(e) {
  const t = e.target;
  return t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName));
}
