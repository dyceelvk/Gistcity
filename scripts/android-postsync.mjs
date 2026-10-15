// Runs after `npx cap sync android` in CI: brands the generated Android project
// (launcher icons, adaptive icon background, manifest flags). Idempotent.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const app = 'android/app/src/main';
if (!existsSync(app)) { console.error('android project not found — run npx cap add android first'); process.exit(1); }

// icons
for (const d of readdirSync('android-res').filter((n) => n.startsWith('mipmap-'))) {
  mkdirSync(join(app, 'res', d), { recursive: true });
  for (const f of readdirSync(join('android-res', d))) copyFileSync(join('android-res', d, f), join(app, 'res', d, f));
}
// adaptive icon background colour (Capacitor's template references @color/ic_launcher_background)
const valuesDir = join(app, 'res', 'values'); mkdirSync(valuesDir, { recursive: true });
writeFileSync(join(valuesDir, 'ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#0B0E0C</color></resources>\n`);
for (const anydpi of ['mipmap-anydpi-v26']) {
  const dir = join(app, 'res', anydpi); mkdirSync(dir, { recursive: true });
  const xml = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@color/ic_launcher_background"/>\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n</adaptive-icon>\n`;
  writeFileSync(join(dir, 'ic_launcher.xml'), xml); writeFileSync(join(dir, 'ic_launcher_round.xml'), xml);
}
// strings
const strings = join(valuesDir, 'strings.xml');
if (existsSync(strings)) writeFileSync(strings, readFileSync(strings, 'utf8').replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">GistCity</string>').replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">GistCity</string>'));
// manifest: keep the WebView alive across rotation, no cleartext, game-friendly flags
const manifest = join(app, 'AndroidManifest.xml');
let m = readFileSync(manifest, 'utf8');
if (!m.includes('usesCleartextTraffic')) m = m.replace('<application', '<application\n        android:usesCleartextTraffic="false"');
if (!m.includes('android:screenOrientation')) m = m.replace('<activity', '<activity\n            android:screenOrientation="fullUser"');
writeFileSync(manifest, m);
console.log('android project branded');
