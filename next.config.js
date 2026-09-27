// PWA via @ducanh2912/next-pwa (the maintained successor to next-pwa, which
// did not support Next 15). Same NetworkFirst/CacheFirst strategy as before;
// the workbox-level options (runtimeCaching, buildExcludes, skipWaiting) now
// live under workboxOptions.
const withPWA = require('@ducanh2912/next-pwa').default({
  dest: 'public',
  register: true,
  // Disabled in dev to avoid aggressive caching during hot-reload.
  disable: process.env.NODE_ENV === 'development',
  workboxOptions: {
    skipWaiting: true,
    // Do not pre-cache API routes: too volatile and auth-dependent.
    exclude: [/middleware-manifest\.json$/, /app-build-manifest\.json$/],
    runtimeCaching: [
      {
        // App pages: NetworkFirst, fall back to cache when offline.
        urlPattern: ({ request, url }) =>
          request.mode === 'navigate' && !url.pathname.startsWith('/api/'),
        handler: 'NetworkFirst',
        options: {
          cacheName: 'pages',
          networkTimeoutSeconds: 4,
          expiration: { maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 },
        },
      },
      {
        // GET API: NetworkFirst (programs, sessions, exercises change over time).
        urlPattern: ({ url, request }) =>
          url.pathname.startsWith('/api/') && request.method === 'GET',
        handler: 'NetworkFirst',
        options: {
          cacheName: 'api-get',
          networkTimeoutSeconds: 4,
          expiration: { maxEntries: 100, maxAgeSeconds: 24 * 60 * 60 },
        },
      },
      {
        // Static assets: CacheFirst (long-lived).
        urlPattern: ({ url }) =>
          url.pathname.startsWith('/_next/static/') ||
          /\.(?:png|svg|webp|ico|woff2?)$/.test(url.pathname),
        handler: 'CacheFirst',
        options: {
          cacheName: 'static-assets',
          expiration: { maxEntries: 200, maxAgeSeconds: 30 * 24 * 60 * 60 },
        },
      },
    ],
  },
});
const withNextIntl = require('next-intl/plugin')('./i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Development and production builds must not share a build directory. They
  // did, and running `npm run build` while `npm run dev` was serving silently
  // replaced the dev server's asset manifest: the browser 404'd every chunk,
  // nothing hydrated, and forms fell back to a native submit. The symptom
  // looked like "the app is broken", not like "a build ran".
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  // Pi's provider packages load their OAuth helpers through a computed
  // `require`, which webpack cannot resolve: bundling them produces a stream of
  // "Cannot find module 'node:fs'" unhandled rejections at request time. Marking
  // the packages external keeps them as real Node requires, which is how they
  // are meant to load on the server.
  serverExternalPackages: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'],
};

module.exports = withPWA(withNextIntl(nextConfig));
