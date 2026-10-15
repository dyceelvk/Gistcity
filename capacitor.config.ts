import type { CapacitorConfig } from '@capacitor/cli';

// GistCity Android app (Capacitor). The web build in `dist` is bundled into the
// APK, so the game assets load from the device; only accounts, the economy and
// multiplayer talk to the backend. CI builds it: .github/workflows/build-android.yml
// Local:  npm run build && npx cap add android && npx cap sync android && node scripts/android-postsync.mjs && npx cap open android
const config: CapacitorConfig = {
  appId: 'com.rielinc.gistcity',
  appName: 'GistCity',
  webDir: 'dist',
  backgroundColor: '#0b0e0c',
  android: { allowMixedContent: false, backgroundColor: '#0b0e0c' },
  server: { androidScheme: 'https' },
};

export default config;
