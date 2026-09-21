import { defineConfig, type PluginOption } from 'vite';
import { createApiServer } from './src/server/app.js';

const apiPlugin = (): PluginOption => ({
  name: 'ctd-api',
  configureServer(server) {
    server.middlewares.use(createApiServer());
  }
});

export default defineConfig({
  root: 'src/web',
  publicDir: false,
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  plugins: [apiPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5565
  }
});
