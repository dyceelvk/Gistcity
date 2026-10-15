import './ui/styles.css';
import { Game } from './game/game';
import { loadHumanLibrary } from './game/human';

const host = document.getElementById('view')!;
const loadMsg = document.getElementById('loadMsg');
const say = (t: string) => { if (loadMsg) loadMsg.textContent = t; };

(async () => {
  // Realistic characters (≈5.5 MB once, then cached). If they cannot load we
  // still start with the lightweight procedural avatars.
  say('Loading characters… 0%');
  await loadHumanLibrary((f) => say(`Loading characters… ${Math.round(f * 100)}%`));
  say('Building the city…');
  try {
    new Game(host);
  } catch (err) {
    console.error(err);
    say('Could not start the 3D world. Your browser may not support WebGL.');
  }
})();

// Installable / offline-capable in production builds only (never during dev, to avoid stale caches).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
