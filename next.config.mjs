/** @type {import('next').NextConfig} */

// Node.js built-in module names (for externals matching)
const nodeBuiltins = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster',
  'console', 'constants', 'crypto', 'dgram', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector',
  'module', 'net', 'os', 'path', 'perf_hooks', 'process',
  'punycode', 'querystring', 'readline', 'repl', 'stream',
  'string_decoder', 'sys', 'timers', 'tls', 'trace_events',
  'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads',
  'zlib', 'node:sqlite',
]);

function isNodeBuiltin(mod) {
  // Strip the node: prefix — webpack sometimes passes 'node:crypto' etc.
  const bare = mod.startsWith('node:') ? mod.slice(5) : mod;
  if (nodeBuiltins.has(bare)) return true;
  // Match "dns/promises", "fs/promises", "stream/web", etc.
  const [root] = bare.split('/');
  return nodeBuiltins.has(root);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['node-cron'],
  experimental: {
    serverActions: { bodySizeLimit: '8mb' },
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      // Use a function external so every Node.js built-in (including sub-paths
      // like dns/promises) is left for the runtime to resolve.
      config.externals.push(({ request }, callback) => {
        if (isNodeBuiltin(request) || request === 'node-cron') {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      });

      // Prevent webpack's "UnhandledSchemeError" for node: protocol URIs.
      // The externals callback above catches these at build time, but webpack's
      // resolver throws first when it encounters the node: scheme.  Register
      // aliases that map 'node:X' → 'X' so the resolver never sees the scheme.
      config.resolve = config.resolve || {};
      config.resolve.alias = config.resolve.alias || {};
      for (const mod of nodeBuiltins) {
        if (mod === 'node:sqlite') {
          // node:sqlite must keep its full name for the externals match
          continue;
        }
        const alias = config.resolve.alias;
        if (!alias[`node:${mod}`]) {
          alias[`node:${mod}`] = mod;
        }
      }
    }
    return config;
  },
  async headers() {
    return [
      {
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
