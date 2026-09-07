import { renderWaveBackground, type WaveBackgroundOptions } from 'asciify-engine';

export interface MountOptions extends WaveBackgroundOptions {
  /**
   * Extra self-composite passes per frame. The engine draws base characters at
   * a maximum of ~8% alpha, so each pass re-draws the frame onto itself,
   * lifting alpha (a -> 2a - a^2) while preserving intensity ordering.
   */
  boost?: number;
  /** CSS opacity of the canvas (default 1). */
  opacity?: number;
}

export function mountWave(target: string | HTMLElement, opts: MountOptions = {}) {
  const { boost = 2, opacity = 1, ...waveOpts } = opts;
  const host = typeof target === 'string' ? document.querySelector<HTMLElement>(target) : target;
  if (!host) throw new Error(`mountWave: target not found: ${String(target)}`);

  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;opacity:${opacity};pointer-events:none;z-index:0`;
  host.prepend(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('mountWave: 2d context unavailable');

  const dpr = window.devicePixelRatio || 1;
  const rawMouse = { x: 0.5, y: 0.5 };
  const mouse = { x: 0.5, y: 0.5 };

  const resize = () => {
    const r = host.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
  };
  resize();

  const onMove = (e: MouseEvent) => {
    const r = host.getBoundingClientRect();
    rawMouse.x = (e.clientX - r.left) / r.width;
    rawMouse.y = (e.clientY - r.top) / r.height;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  window.addEventListener('mousemove', onMove);

  let time = 0;
  let raf = 0;
  const frame = () => {
    mouse.x += 0.07 * (rawMouse.x - mouse.x);
    mouse.y += 0.07 * (rawMouse.y - mouse.y);
    const r = host.getBoundingClientRect();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderWaveBackground(ctx, r.width, r.height, time, mouse, waveOpts);

    if (boost > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (let i = 0; i < boost; i++) ctx.drawImage(canvas, 0, 0);
    }

    time += 0.016;
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('mousemove', onMove);
      canvas.remove();
    },
  };
}
