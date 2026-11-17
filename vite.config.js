import { defineConfig } from 'vite';

// In development the intake service runs next to vite (npm run server) and stands in for nginx:
// it serves /catalog/ and the api. In production nginx does that.
const api = process.env.API_URL || 'http://localhost:3000';

// nginx serves these pretty addresses; vite needs to be told.
const pretty = { '/submit': '/submit.html', '/admin': '/admin/index.html', '/admin/': '/admin/index.html' };

export default defineConfig({
  // Keep the browser's Host header: the api checks it against the request's Origin.
  server: { proxy: { '/api': { target: api, changeOrigin: false }, '/catalog': { target: api, changeOrigin: false } } },
  plugins: [
    {
      name: 'pretty-urls',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          const path = req.url.split('?')[0];
          if (pretty[path]) req.url = pretty[path] + req.url.slice(path.length);
          next();
        });
      },
    },
  ],
});
