import { mountWave } from './wave';

mountWave('#hero', {
  speed: 2.1,
  accentColor: '#9fb0ff',
  fontSize: 20,
  mouseInfluence: 0.4,
  accentThreshold: 0.35,
  // keep in sync with suped.dev (src/layouts/Base.astro): same wave, same feel; src/wave*.ts are copies of suped.dev/src/scripts/wave*.ts
  boost: 1,
  opacity: 0.5,
  lightMode: false,
  // phones: a tenth of the cells, so spend it on brightness
  touch: { opacity: 0.75, boost: 2 },
});

const cmd = document.querySelector<HTMLButtonElement>('#cmd');
const text = cmd?.querySelector<HTMLElement>('.text')?.textContent?.trim() ?? '';

cmd?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(text);
    cmd.classList.add('copied');
    setTimeout(() => cmd.classList.remove('copied'), 900);
  } catch {
    // Clipboard unavailable (insecure context / permission). Fail silently.
  }
});
