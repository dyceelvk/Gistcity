import './ui/styles.css';
import { Game, type Boot } from './game/game';
import { loadHumanLibrary } from './game/human';
import { cloud } from './net/supabase';
import { AuthScreen } from './ui/auth';
import { defaultState, loadLocal, sanitizeState, type PlayerState } from './game/state';

const host = document.getElementById('view')!;
const loadMsg = document.getElementById('loadMsg');
const say = (t: string) => { if (loadMsg) loadMsg.textContent = t; };

/**
 * Boot flow:
 *  1. backend configured → restore session; if nobody is signed in show the
 *     sign-in / create-account screen (no anonymous play in the shared city);
 *  2. load the player's server data (profile, G wallet, inventory, saved state);
 *  3. first sign-in → character creation before entering the city;
 *  4. no backend → offline practice mode on this device.
 */
async function boot(): Promise<Boot> {
  if (!cloud.enabled) {
    const banner = document.createElement('div'); banner.className = 'practice'; banner.textContent = 'PRACTICE MODE · OFFLINE'; banner.title = 'Not connected to GistCity: progress is saved on this device only.';
    const col = document.querySelector('.leftCol'); if (col) col.prepend(banner);
    return { state: loadLocal(), needsCharacter: false, certificates: [] };
  }
  cloud.installBridge();
  await cloud.init();
  const auth = new AuthScreen();
  let recovering = false;
  cloud.onRecovery = () => { recovering = true; };
  if (!cloud.signedIn) {
    // a password-recovery link lands here with a session and the PASSWORD_RECOVERY event
    await auth.show(recovering ? 'recover' : 'signin');
    await cloud.waitForSignIn();
  } else if (recovering || location.hash.includes('type=recovery')) {
    await auth.show('recover');
  }
  document.getElementById('loading')?.classList.remove('done');
  say('Loading your citizen record…');
  let me;
  try { me = await cloud.loadMe(); }
  catch (e: any) {
    // Session exists but the server rejected us (e.g. suspended account or expired token): sign in again.
    await cloud.signOut();
    await auth.show('signin');
    me = await cloud.loadMe();
  }
  const profile = me.profile;
  if (!profile) throw new Error('Your profile could not be created. Please contact support.');
  if (profile.status !== 'active') { await cloud.signOut(); throw new Error('This account is ' + profile.status + '.'); }
  const base: PlayerState = me.state ? sanitizeState(me.state) : defaultState();
  const state: PlayerState = {
    ...base,
    name: profile.display_name || base.name,
    username: profile.username,
    cash: me.balance,            // the server wallet is the truth
    inventory: me.inventory,     // and so is ownership
  };
  return { state, needsCharacter: !profile.character_ready, certificates: me.certificates ?? [], employment: me.employment ?? null, church: me.church ?? null };
}

(async () => {
  try {
    const b = await boot();
    say('Loading characters… 0%');
    await loadHumanLibrary((f) => say(`Loading characters… ${Math.round(f * 100)}%`));
    say('Building the city…');
    new Game(host, b);
  } catch (err: any) {
    console.error(err);
    say(err?.message ? String(err.message) : 'Could not start the 3D world. Your browser may not support WebGL.');
    document.getElementById('loading')?.classList.remove('done');
  }
})();

// Installable / offline-capable in production builds only (never during dev, to avoid stale caches).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}
