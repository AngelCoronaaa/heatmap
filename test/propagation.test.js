import test from 'node:test';
import assert from 'node:assert/strict';
import {
  channelsOverlap,
  computeGrid,
  dataRate,
  fspl1m,
  prepareAps,
  prepareWalls,
  rssiAt,
} from '../public/js/propagation.js';

const SCALE = 20; // px por metro
const ap = (over = {}) => ({ id: 'a', x: 0, y: 0, band: '5', channel: 36, width: 20, txPower: 17, gain: 4, ...over });

test('FSPL a 1 m coincide con la fórmula de espacio libre', () => {
  assert.ok(Math.abs(fspl1m(2437) - 40.2) < 0.1);
  assert.ok(Math.abs(fspl1m(5180) - 46.7) < 0.1);
});

test('la señal decae con la distancia según el exponente', () => {
  const [p] = prepareAps([ap()]);
  const walls = prepareWalls([]);
  const at10 = rssiAt(p, 10 * SCALE, 0, walls, 2, SCALE);
  const at100 = rssiAt(p, 100 * SCALE, 0, walls, 2, SCALE);
  assert.ok(Math.abs(at10 - at100 - 20) < 1e-9, 'n=2 → 20 dB por década');
  assert.ok(Math.abs(at10 - (21 - fspl1m(5180) - 20)) < 1e-9);
});

test('los muros atenúan solo cuando el trayecto los cruza', () => {
  const [p] = prepareAps([ap()]);
  const walls = prepareWalls([{ x1: 5 * SCALE, y1: -100, x2: 5 * SCALE, y2: 100, material: 'concrete' }]);
  const free = rssiAt(p, 10 * SCALE, 0, prepareWalls([]), 2.5, SCALE);
  const blocked = rssiAt(p, 10 * SCALE, 0, walls, 2.5, SCALE);
  const beside = rssiAt(p, 0, 10 * SCALE, walls, 2.5, SCALE);
  assert.equal(Math.round(free - blocked), 17);
  assert.equal(beside, rssiAt(p, 0, 10 * SCALE, prepareWalls([]), 2.5, SCALE));
});

test('solapamiento de canales', () => {
  const c = (band, channel, width = 20) => ({ band, channel, width });
  assert.equal(channelsOverlap(c('2.4', 1), c('2.4', 6)), false);
  assert.equal(channelsOverlap(c('2.4', 1), c('2.4', 4)), true);
  assert.equal(channelsOverlap(c('5', 36), c('5', 40)), false);
  assert.equal(channelsOverlap(c('5', 36, 40), c('5', 40)), true);
  assert.equal(channelsOverlap(c('5', 36, 80), c('5', 48)), true);
  assert.equal(channelsOverlap(c('5', 36, 80), c('5', 52)), false);
  assert.equal(channelsOverlap(c('5', 36), c('2.4', 6)), false);
});

test('la tasa crece con el SNR y el ancho de canal', () => {
  assert.equal(dataRate(0), 0);
  assert.ok(dataRate(40, 20) > dataRate(20, 20));
  assert.ok(dataRate(40, 80) > dataRate(40, 20));
});

test('computeGrid devuelve rejillas coherentes', () => {
  const aps = prepareAps([ap({ id: 'a', x: 50, y: 50 }), ap({ id: 'b', x: 350, y: 50 }), ap({ id: 'c', x: 200, y: 50, enabled: false })]);
  assert.equal(aps.length, 2, 'los APs desactivados no se incluyen');
  const r = computeGrid({
    gridW: 40, gridH: 10, cell: 10, scale: SCALE, aps, walls: prepareWalls([]), n: 2.6, noise: -95,
    required: -67, measurements: [{ x: 100, y: 50, rssi: -60 }], idwRadius: 5,
  });
  assert.equal(r.best.length, 400);
  assert.equal(r.bestIdx[5 * 40 + 2], 0);
  assert.equal(r.bestIdx[5 * 40 + 37], 1);
  assert.ok(r.interf[5 * 40 + 20] >= 1, 'mismo canal → interferencia');
  assert.ok(r.best[5 * 40 + 5] > r.best[5 * 40 + 18]);
  assert.ok(Math.abs(r.measured[5 * 40 + 10] - -60) < 1e-6);
  assert.ok(Number.isNaN(r.measured[5 * 40 + 39]), 'fuera del radio IDW queda vacío');
});
