/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app talks to SQLite through node:sqlite and performs real HTTP audits;
  // both must run in Node, not the edge.
  serverExternalPackages: ['node-cron'],
  experimental: {
    serverActions: { bodySizeLimit: '8mb' },
  },
  async headers() {
    return [
      {
        // Public concept previews and client portal are shareable; nothing else is embedded.
        source: '/mockup/:path*',
        headers: [{ key: 'X-Frame-Options', value: 'ALLOWALL' }],
      },
      {
        source: '/((?!mockup|site|portal).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
