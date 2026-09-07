import { mountWave } from './background';

mountWave('#hero', {
  speed: 2.1,
  accentColor: '#9fb0ff',
  fontSize: 20,
  mouseInfluence: 0.4,
  accentThreshold: 0.35,
  boost: 2,
  lightMode: false,
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
