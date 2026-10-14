import type { CapacitorConfig } from '@capacitor/cli';

// Android wrapper. Install once:  npm i -D @capacitor/cli @capacitor/core @capacitor/android
// then:  npm run build && npx cap add android && npx cap sync android && npx cap open android
const config: CapacitorConfig = {
  appId: 'app.crushly.gist',
  appName: 'GIST',
  webDir: 'dist',
  backgroundColor: '#0b0e0c',
  android: { allowMixedContent: false },
  server: { androidScheme: 'https' },
};

export default config;
