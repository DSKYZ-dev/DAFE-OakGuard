import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.dafecharts.mobile',
  appName: 'DAFE Charts',
  webDir: 'dist',
  backgroundColor: '#0a0a18',
  android: {
    backgroundColor: '#0a0a18',
    allowMixedContent: true,
  },
  server: {
    androidScheme: 'https',
    cleartext: true,
  },
};

export default config;