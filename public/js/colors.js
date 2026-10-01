// Escalas de color y vistas del mapa de calor.

const RAMP = ['#6d3fc0', '#e0475b', '#f08a3e', '#f5c542', '#b7e04a', '#4fd27a', '#20b9a6', '#2b9be0'];

export const VIEWS = {
  signal: {
    label: 'Señal',
    title: 'Intensidad de señal (RSSI)',
    unit: 'dBm',
    kind: 'gradient',
    stops: [[-90, RAMP[0]], [-82, RAMP[1]], [-75, RAMP[2]], [-70, RAMP[3]], [-67, RAMP[4]], [-60, RAMP[5]], [-45, RAMP[6]], [-30, RAMP[7]]],
    ticks: [-90, -80, -70, -60, -50, -40, -30],
  },
  snr: {
    label: 'SNR',
    title: 'Relación señal / ruido',
    unit: 'dB',
    kind: 'gradient',
    stops: [[0, RAMP[0]], [10, RAMP[1]], [15, RAMP[2]], [20, RAMP[3]], [25, RAMP[4]], [30, RAMP[5]], [38, RAMP[6]], [45, RAMP[7]]],
    ticks: [0, 10, 20, 25, 30, 40],
  },
  rate: {
    label: 'Velocidad',
    title: 'Tasa PHY estimada (802.11ax, 2SS)',
    unit: 'Mbps',
    kind: 'gradient',
    stops: [[0, RAMP[0]], [50, RAMP[1]], [120, RAMP[2]], [250, RAMP[3]], [400, RAMP[4]], [600, RAMP[5]], [900, RAMP[6]], [1200, RAMP[7]]],
    ticks: [0, 300, 600, 900, 1200],
  },
  interference: {
    label: 'Interferencia',
    title: 'APs interferentes en el mismo canal',
    unit: '',
    kind: 'discrete',
    classes: [
      { label: '0', color: RAMP[5] },
      { label: '1', color: RAMP[3] },
      { label: '2', color: RAMP[2] },
      { label: '3+', color: RAMP[1] },
    ],
  },
  coverage: {
    label: 'Cobertura',
    title: 'APs con señal ≥ requerida',
    unit: '',
    kind: 'discrete',
    classes: [
      { label: '0', color: RAMP[1] },
      { label: '1', color: RAMP[3] },
      { label: '2', color: RAMP[5] },
      { label: '3+', color: RAMP[7] },
    ],
  },
  zones: {
    label: 'Zonas AP',
    title: 'AP dominante por zona',
    unit: '',
    kind: 'zones',
  },
  measured: {
    label: 'Medido',
    title: 'Señal medida (survey, interpolada)',
    unit: 'dBm',
    kind: 'gradient',
    stops: null, // usa los de "signal"
    ticks: [-90, -80, -70, -60, -50, -40, -30],
  },
};
VIEWS.measured.stops = VIEWS.signal.stops;

export const ZONE_COLORS = ['#5b8cff', '#4fd27a', '#f5c542', '#e0475b', '#20b9a6', '#c27bff', '#f08a3e', '#7fd4ff', '#ff7fb3', '#b7e04a', '#8f9bff', '#ffd27f'];

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function buildLut(stops, size = 512) {
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const lut = new Uint8ClampedArray(size * 3);
  const rgb = stops.map(([v, c]) => [v, hexToRgb(c)]);
  for (let i = 0; i < size; i++) {
    const v = min + ((max - min) * i) / (size - 1);
    let k = 0;
    while (k < rgb.length - 2 && v > rgb[k + 1][0]) k++;
    const [v0, c0] = rgb[k];
    const [v1, c1] = rgb[k + 1];
    const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
    for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * t;
  }
  return { lut, min, max, size };
}

const lutCache = new Map();
function lutFor(view) {
  if (!lutCache.has(view)) lutCache.set(view, buildLut(VIEWS[view].stops));
  return lutCache.get(view);
}

export function colorAt(view, value) {
  const { lut, min, max, size } = lutFor(view);
  const k = Math.round(((Math.min(max, Math.max(min, value)) - min) / (max - min)) * (size - 1)) * 3;
  return `rgb(${lut[k]}, ${lut[k + 1]}, ${lut[k + 2]})`;
}

/**
 * Convierte el resultado de la rejilla en píxeles RGBA según la vista activa.
 * Las celdas con señal por debajo de `minSignal` quedan transparentes.
 */
export function colorize(result, view, { gridW, gridH, minSignal }) {
  const img = new ImageData(gridW, gridH);
  const px = img.data;
  const { best, bestIdx, cover, interf, snr, rate, measured, measuredAlpha } = result;
  const total = gridW * gridH;
  const def = VIEWS[view];

  const put = (i, r, g, b, a = 255) => {
    const o = i * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = a;
  };

  if (def.kind === 'gradient') {
    const { lut, min, max, size } = lutFor(view);
    const src = view === 'signal' ? best : view === 'snr' ? snr : view === 'rate' ? rate : measured;
    for (let i = 0; i < total; i++) {
      if (view === 'measured') {
        if (Number.isNaN(src[i]) || src[i] < minSignal) continue;
      } else if (best[i] < minSignal) continue;
      const v = Math.min(max, Math.max(min, src[i]));
      const k = Math.round(((v - min) / (max - min)) * (size - 1)) * 3;
      put(i, lut[k], lut[k + 1], lut[k + 2], view === 'measured' ? measuredAlpha[i] : 255);
    }
  } else if (def.kind === 'discrete') {
    const colors = def.classes.map((c) => hexToRgb(c.color));
    const src = view === 'coverage' ? cover : interf;
    for (let i = 0; i < total; i++) {
      if (best[i] < minSignal) continue;
      const c = colors[Math.min(colors.length - 1, src[i])];
      put(i, c[0], c[1], c[2]);
    }
  } else {
    const colors = ZONE_COLORS.map(hexToRgb);
    for (let i = 0; i < total; i++) {
      if (best[i] < minSignal || bestIdx[i] < 0) continue;
      const c = colors[bestIdx[i] % colors.length];
      put(i, c[0], c[1], c[2]);
    }
  }
  return img;
}

export function gradientCss(view) {
  const { stops } = VIEWS[view];
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  return `linear-gradient(90deg, ${stops.map(([v, c]) => `${c} ${(((v - min) / (max - min)) * 100).toFixed(1)}%`).join(', ')})`;
}
