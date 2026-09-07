// Draws the wave on an OffscreenCanvas so the page's main thread never waits
// on it. Driven by messages from wave.ts. Identical copy lives in the suped.ai
// repo at site/src/wave.worker.ts.

import { renderWaveBackground, type WaveBackgroundOptions } from 'asciify-engine';

type Init = { type: 'init'; canvas: OffscreenCanvas; opts: WaveBackgroundOptions; boost: number; fps: number; dpr: number; drift: boolean };
type Msg =
  | Init
  | { type: 'resize'; width: number; height: number }
  | { type: 'mouse'; x: number; y: number }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'still' };

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let opts: WaveBackgroundOptions = {};
let boost = 1;
let fps = 20;
let dpr = 1;
let width = 0;
let height = 0;
let time = 0;
let last = 0;
let running = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let drift = false; // no pointer on this device: wander the vortex instead of parking it
let pointerSeen = false;
const rawMouse = { x: 0.5, y: 0.5 };
const mouse = { x: 0.5, y: 0.5 };

function wander(t: number) {
  rawMouse.x = 0.5 + 0.38 * Math.sin(t * 0.21);
  rawMouse.y = 0.5 + 0.3 * Math.sin(t * 0.16 + 1.3);
}

function draw() {
  if (!ctx || !canvas || width === 0 || height === 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // The engine types its context as the DOM one; the 2D API is the same.
  renderWaveBackground(ctx as unknown as CanvasRenderingContext2D, width, height, time, mouse, opts);
  if (boost > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let i = 0; i < boost; i++) ctx.drawImage(canvas, 0, 0);
  }
}

function tick() {
  if (!running) return;
  const now = performance.now();
  const dt = now - last;
  last = now;
  time += Math.min(dt, 100) / 1000;
  if (drift && !pointerSeen) wander(time);
  mouse.x += 0.12 * (rawMouse.x - mouse.x);
  mouse.y += 0.12 * (rawMouse.y - mouse.y);
  draw();
  timer = setTimeout(tick, 1000 / fps);
}

function start() {
  if (running) return;
  running = true;
  last = performance.now();
  tick();
}

function stop() {
  running = false;
  clearTimeout(timer);
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      canvas = m.canvas;
      ctx = canvas.getContext('2d');
      opts = m.opts;
      boost = m.boost;
      fps = m.fps;
      dpr = m.dpr;
      drift = m.drift;
      break;
    case 'resize':
      width = m.width;
      height = m.height;
      if (canvas) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      if (!running) draw();
      break;
    case 'mouse':
      pointerSeen = true;
      rawMouse.x = m.x;
      rawMouse.y = m.y;
      break;
    case 'start':
      start();
      break;
    case 'stop':
      stop();
      break;
    case 'still':
      stop();
      draw();
      break;
  }
};
