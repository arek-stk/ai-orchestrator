import type { NextConfig } from 'next';

const serverUrl = (process.env.ORCH_SERVER_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The API is proxied same-origin so session cookies and the CSRF origin check just work.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${serverUrl}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
