// Modelo de propagación predictiva (log-distance + atenuación por muros).
// Coordenadas en píxeles del plano; `scale` = píxeles por metro.

export const BANDS = {
  '2.4': {
    label: '2.4 GHz',
    channels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    widths: [20],
    freq: (ch) => 2407 + 5 * ch,
  },
  '5': {
    label: '5 GHz',
    channels: [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
    widths: [20, 40, 80, 160],
    freq: (ch) => 5000 + 5 * ch,
  },
  '6': {
    label: '6 GHz',
    channels: Array.from({ length: 59 }, (_, i) => 1 + i * 4),
    widths: [20, 40, 80, 160],
    freq: (ch) => 5950 + 5 * ch,
  },
};

// Pérdida por muro en dB para cada banda.
export const MATERIALS = {
  drywall: { label: 'Tablaroca', color: '#8fb3ff', loss: { '2.4': 3, '5': 4, '6': 5 } },
  glass: { label: 'Vidrio', color: '#6fe3f0', loss: { '2.4': 3, '5': 4, '6': 6 } },
  wood: { label: 'Madera / puerta', color: '#d9a66b', loss: { '2.4': 4, '5': 6, '6': 7 } },
  brick: { label: 'Ladrillo', color: '#f08b6c', loss: { '2.4': 8, '5': 11, '6': 13 } },
  concrete: { label: 'Concreto', color: '#c3c9dc', loss: { '2.4': 12, '5': 17, '6': 20 } },
  metal: { label: 'Metal / elevador', color: '#ffffff', loss: { '2.4': 25, '5': 30, '6': 32 } },
};

export const ENV_PRESETS = {
  open: { label: 'Espacio abierto', n: 2.0 },
  office: { label: 'Oficina', n: 2.6 },
  dense: { label: 'Denso / industrial', n: 3.1 },
};

// Canales que no se solapan, usados por el optimizador automático.
export const CLEAN_CHANNELS = {
  '2.4': { 20: [1, 6, 11] },
  '5': {
    20: [36, 40, 44, 48, 149, 153, 157, 161, 52, 56, 60, 64, 100, 104, 108, 112],
    40: [36, 44, 149, 157, 52, 60, 100, 108],
    80: [36, 149, 52, 100],
    160: [36, 100],
  },
  '6': {
    20: [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229],
    40: [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229],
    80: [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213],
    160: [5, 37, 69, 101, 133, 165, 197],
  },
};

const BAND_INDEX = { '2.4': 0, '5': 1, '6': 2 };
const MIN_DIST_M = 0.5;
export const CCA_THRESHOLD = -82;

// SNR mínimo (dB, canal de 20 MHz) y tasa PHY 802.11ax 1SS GI 0.8 µs para MCS 0–11.
const MCS_SNR = [2, 5, 9, 11, 15, 18, 20, 25, 29, 31, 34, 37];
const MCS_RATE_20 = [8.6, 17.2, 25.8, 34.4, 51.6, 68.8, 77.4, 86, 103.2, 114.7, 129, 143.4];
const WIDTH_FACTOR = { 20: 1, 40: 2, 80: 4.19, 160: 8.37 };

export function fspl1m(freqMHz) {
  return 20 * Math.log10(freqMHz) - 27.55;
}

export function noiseFloor(base, width = 20) {
  return base + 10 * Math.log10(width / 20);
}

export function dataRate(snr, width = 20, streams = 2) {
  let mcs = -1;
  for (let i = 0; i < MCS_SNR.length; i++) if (snr >= MCS_SNR[i]) mcs = i;
  if (mcs < 0) return 0;
  return MCS_RATE_20[mcs] * (WIDTH_FACTOR[width] ?? 1) * streams;
}

// Rango de frecuencias ocupado por un canal (para detectar solapamiento).
export function channelRange(band, ch, width = 20) {
  if (band === '2.4') {
    const f = BANDS['2.4'].freq(ch);
    return [f - 11, f + 11];
  }
  const base = band === '5' ? (ch >= 149 ? 149 : 36) : 1;
  const span = Math.max(1, width / 20);
  const idx = Math.round((ch - base) / 4);
  const first = base + (idx - (idx % span)) * 4;
  const lo = BANDS[band].freq(first) - 10;
  return [lo, lo + 20 * span];
}

export function channelsOverlap(a, b) {
  if (a.band !== b.band) return false;
  const ra = channelRange(a.band, a.channel, a.width);
  const rb = channelRange(b.band, b.channel, b.width);
  return ra[0] < rb[1] && rb[0] < ra[1];
}

export function prepareAps(aps) {
  return aps
    .filter((ap) => ap.enabled !== false)
    .map((ap) => ({
      id: ap.id,
      x: ap.x,
      y: ap.y,
      band: ap.band,
      bandIdx: BAND_INDEX[ap.band] ?? 1,
      channel: ap.channel,
      width: ap.width ?? 20,
      eirp: (ap.txPower ?? 17) + (ap.gain ?? 4),
      pl0: fspl1m(BANDS[ap.band]?.freq(ap.channel) ?? 5500),
    }));
}

// Muros como arreglo plano: x1, y1, x2, y2, pérdida 2.4, pérdida 5, pérdida 6
export function prepareWalls(walls) {
  const out = new Float64Array(walls.length * 7);
  walls.forEach((w, i) => {
    const m = MATERIALS[w.material] ?? MATERIALS.drywall;
    out.set([w.x1, w.y1, w.x2, w.y2, m.loss['2.4'], m.loss['5'], m.loss['6']], i * 7);
  });
  return out;
}

function wallLoss(ax, ay, bx, by, walls, bandIdx) {
  let loss = 0;
  const rx = bx - ax;
  const ry = by - ay;
  for (let i = 0; i < walls.length; i += 7) {
    const cx = walls[i];
    const cy = walls[i + 1];
    const sx = walls[i + 2] - cx;
    const sy = walls[i + 3] - cy;
    const denom = rx * sy - ry * sx;
    if (denom === 0) continue;
    const qx = cx - ax;
    const qy = cy - ay;
    const t = (qx * sy - qy * sx) / denom;
    if (t <= 0 || t >= 1) continue;
    const u = (qx * ry - qy * rx) / denom;
    if (u < 0 || u > 1) continue;
    loss += walls[i + 4 + bandIdx];
  }
  return loss;
}

export function rssiAt(ap, x, y, walls, n, scale) {
  const d = Math.max(Math.hypot(x - ap.x, y - ap.y) / scale, MIN_DIST_M);
  return ap.eirp - ap.pl0 - 10 * n * Math.log10(d) - wallLoss(ap.x, ap.y, x, y, walls, ap.bandIdx);
}

// Valores en un punto concreto (para el tooltip del cursor).
export function samplePoint(x, y, { aps, walls, n, scale, noise }) {
  const list = aps
    .map((ap) => ({ ap, rssi: rssiAt(ap, x, y, walls, n, scale) }))
    .sort((a, b) => b.rssi - a.rssi);
  const best = list[0];
  if (!best) return { list };
  const snr = best.rssi - noiseFloor(noise, best.ap.width);
  const interferers = list.filter((e) => e !== best && e.rssi >= CCA_THRESHOLD && channelsOverlap(e.ap, best.ap)).length;
  return { list, best, snr, rate: dataRate(snr, best.ap.width), interferers };
}

/**
 * Calcula la rejilla del mapa de calor.
 * @returns buffers por celda: mejor RSSI, AP dominante, nº de APs ≥ señal requerida,
 *          interferentes co-canal, SNR, tasa estimada y RSSI medido interpolado (IDW) con su opacidad.
 */
export function computeGrid({ gridW, gridH, cell, scale, aps, walls, n, noise, required, measurements, idwRadius }) {
  const total = gridW * gridH;
  const best = new Float32Array(total).fill(-200);
  const bestIdx = new Int16Array(total).fill(-1);
  const cover = new Uint8Array(total);
  const interf = new Uint8Array(total);
  const snr = new Float32Array(total).fill(-100);
  const rate = new Float32Array(total);
  const measured = new Float32Array(total).fill(NaN);
  const measuredAlpha = new Uint8Array(total);
  const values = new Float32Array(aps.length);
  const N = aps.length;
  const overlap = new Uint8Array(N * N);
  for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) overlap[a * N + b] = a !== b && channelsOverlap(aps[a], aps[b]) ? 1 : 0;

  for (let gy = 0; gy < gridH; gy++) {
    const y = (gy + 0.5) * cell;
    for (let gx = 0; gx < gridW; gx++) {
      const x = (gx + 0.5) * cell;
      const i = gy * gridW + gx;
      let b = -200;
      let bi = -1;
      let c = 0;
      for (let a = 0; a < aps.length; a++) {
        const r = rssiAt(aps[a], x, y, walls, n, scale);
        values[a] = r;
        if (r > b) {
          b = r;
          bi = a;
        }
        if (r >= required) c++;
      }
      best[i] = b;
      bestIdx[i] = bi;
      cover[i] = c;
      if (bi >= 0) {
        const serving = aps[bi];
        let k = 0;
        for (let a = 0; a < N; a++) {
          if (overlap[bi * N + a] && values[a] >= CCA_THRESHOLD) k++;
        }
        interf[i] = k;
        const s = b - noiseFloor(noise, serving.width);
        snr[i] = s;
        rate[i] = dataRate(s, serving.width);
      }
    }
  }

  if (measurements.length) {
    const radiusPx = idwRadius * scale;
    const r2 = radiusPx * radiusPx;
    for (let gy = 0; gy < gridH; gy++) {
      const y = (gy + 0.5) * cell;
      for (let gx = 0; gx < gridW; gx++) {
        const x = (gx + 0.5) * cell;
        let wsum = 0;
        let vsum = 0;
        let exact = NaN;
        let reach = 0;
        for (const m of measurements) {
          const d2 = (m.x - x) ** 2 + (m.y - y) ** 2;
          if (d2 > r2) continue;
          reach = Math.max(reach, 1 - Math.sqrt(d2) / radiusPx);
          if (d2 < 1) {
            exact = m.rssi;
            break;
          }
          // Peso IDW con caída suave hacia el borde del radio
          const w = (1 / d2) * (1 - d2 / r2);
          wsum += w;
          vsum += w * m.rssi;
        }
        const i = gy * gridW + gx;
        measured[i] = Number.isNaN(exact) ? (wsum > 0 ? vsum / wsum : NaN) : exact;
        // Opacidad que se desvanece hacia el borde del radio de interpolación
        measuredAlpha[i] = Number.isNaN(exact) ? Math.round(Math.min(1, reach * 3) * 255) : 255;
      }
    }
  }

  return { best, bestIdx, cover, interf, snr, rate, measured, measuredAlpha };
}
