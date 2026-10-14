import './ui/styles.css';
import { Game } from './game/game';

const host = document.getElementById('view')!;
try {
  new Game(host);
} catch (err) {
  console.error(err);
  const msg = document.getElementById('loadMsg');
  if (msg) msg.textContent = 'Could not start the 3D world. Your browser may not support WebGL.';
}

// Installable / offline-capable in production builds only (never during dev, to avoid stale caches).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
