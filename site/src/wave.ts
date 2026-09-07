import { renderWaveBackground, type WaveBackgroundOptions } from 'asciify-engine';

// Shared between suped.dev (src/scripts/wave.ts) and suped.ai (site/src/wave.ts).
// Keep the two files identical, along with wave.worker.ts next to each.
//
// Where the work happens: the wave is ~3,700 canvas fillText calls per frame at
// 1440x900, about 35 ms on a laptop. That's too much for the main thread, so
// when OffscreenCanvas is available the drawing runs in a Web Worker and the
// page never waits on it. Frame rate is capped (the wave is slow; 20 fps reads
// the same as 60), the backing store is 1x regardless of screen density, the
// loop stops when the tab is hidden, and prefers-reduced-motion gets a single
// still frame instead of an animation.

export interface MountOptions extends WaveBackgroundOptions {
  /**
   * Extra self-composite passes per frame. The engine draws base characters at
   * a maximum of ~8% alpha, so each pass re-draws the frame onto itself,
   * lifting alpha (a -> 2a - a^2) while preserving intensity ordering.
   */
  boost?: number;
  /** CSS opacity of the canvas (default 1). */
  opacity?: number;
  /** Frame-rate cap (default 20). */
  fps?: number;
  /** Cap on device pixel ratio for the backing store (default 1). */
  maxDpr?: number;
}

interface Backend {
  resize(width: number, height: number): void;
  mouse(x: number, y: number): void;
  start(): void;
  stop(): void;
  still(): void;
  destroy(): void;
}

export function mountWave(target: string | HTMLElement, opts: MountOptions = {}) {
  const { boost = 1, opacity = 1, fps = 20, maxDpr = 1, ...waveOpts } = opts;
  const host = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!host) throw new Error(`mountWave: target not found: ${String(target)}`);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;opacity:${opacity};pointer-events:none;z-index:0`;
  host.prepend(canvas);

  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');

  // No hover pointer (phones, tablets): the vortex would park at the center
  // forever, so let it wander slowly instead. A real pointer takes over on
  // the first mousemove.
  const drift = matchMedia('(hover: none)').matches;

  const backend: Backend =
    createWorkerBackend(canvas, waveOpts, boost, fps, dpr, drift) ?? createMainThreadBackend(canvas, waveOpts, boost, fps, dpr, drift);

  const size = () => {
    const r = host.getBoundingClientRect();
    backend.resize(r.width, r.height);
  };
  const onMove = (e: MouseEvent) => {
    const r = host.getBoundingClientRect();
    backend.mouse((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const onVisibility = () => (document.hidden ? backend.stop() : apply());
  const apply = () => (reduced.matches ? backend.still() : backend.start());

  const ro = new ResizeObserver(size);
  ro.observe(host);
  size();
  window.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', apply);
  apply();

  return {
    destroy() {
      backend.destroy();
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', apply);
      canvas.remove();
    },
  };
}

function createWorkerBackend(canvas: HTMLCanvasElement, opts: WaveBackgroundOptions, boost: number, fps: number, dpr: number, drift: boolean): Backend | null {
  if (typeof Worker === 'undefined' || typeof canvas.transferControlToOffscreen !== 'function') return null;
  let worker: Worker;
  let offscreen: OffscreenCanvas;
  try {
    worker = new Worker(new URL('./wave.worker.ts', import.meta.url), { type: 'module' });
    offscreen = canvas.transferControlToOffscreen();
  } catch {
    return null;
  }
  worker.postMessage({ type: 'init', canvas: offscreen, opts, boost, fps, dpr, drift }, [offscreen]);
  const post = (m: object) => worker.postMessage(m);
  return {
    resize: (width, height) => post({ type: 'resize', width, height }),
    mouse: (x, y) => post({ type: 'mouse', x, y }),
    start: () => post({ type: 'start' }),
    stop: () => post({ type: 'stop' }),
    still: () => post({ type: 'still' }),
    destroy: () => worker.terminate(),
  };
}

function createMainThreadBackend(canvas: HTMLCanvasElement, opts: WaveBackgroundOptions, boost: number, fps: number, dpr: number, drift: boolean): Backend {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('mountWave: 2d context unavailable');
  const rawMouse = { x: 0.5, y: 0.5 };
  const mouse = { x: 0.5, y: 0.5 };
  let pointerSeen = false;
  let width = 0;
  let height = 0;
  let time = 0;
  let last = 0;
  let raf = 0;
  let running = false;
  const minFrameMs = 1000 / fps;

  const draw = () => {
    if (width === 0 || height === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderWaveBackground(ctx, width, height, time, mouse, opts);
    if (boost > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let i = 0; i < boost; i++) ctx.drawImage(canvas, 0, 0);
    }
  };
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = now - last;
    if (dt < minFrameMs) return;
    last = now;
    time += Math.min(dt, 100) / 1000;
    if (drift && !pointerSeen) {
      rawMouse.x = 0.5 + 0.38 * Math.sin(time * 0.21);
      rawMouse.y = 0.5 + 0.3 * Math.sin(time * 0.16 + 1.3);
    }
    mouse.x += 0.12 * (rawMouse.x - mouse.x);
    mouse.y += 0.12 * (rawMouse.y - mouse.y);
    draw();
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };
  return {
    resize(w, h) {
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (!running) draw();
    },
    mouse(x, y) {
      pointerSeen = true;
      rawMouse.x = x;
      rawMouse.y = y;
    },
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    },
    stop,
    still() {
      stop();
      draw();
    },
    destroy: stop,
  };
}
