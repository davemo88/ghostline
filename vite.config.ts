import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [
    {
      // Dev aid for headless screenshots: /delay stalls the page's load event
      // so `firefox --screenshot url/?snap` captures a running game frame.
      name: 'snap-delay',
      configureServer(server) {
        server.middlewares.use('/delay', (req, res) => {
          const ms = Number(new URL(req.url ?? '', 'http://x').searchParams.get('ms') ?? 4500);
          setTimeout(() => res.end('ok'), Math.min(ms, 30000));
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        debug: resolve(__dirname, 'debug.html'),
      },
    },
  },
});
