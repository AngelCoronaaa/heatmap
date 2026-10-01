import { computeGrid } from './propagation.js';

self.onmessage = (e) => {
  const { jobId, params } = e.data;
  const started = performance.now();
  const result = computeGrid(params);
  const buffers = Object.values(result).map((arr) => arr.buffer);
  self.postMessage({ jobId, result, ms: performance.now() - started }, buffers);
};
