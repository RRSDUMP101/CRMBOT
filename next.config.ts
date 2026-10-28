import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = {
  output: 'standalone',
  webpack(config) {
    if(process.env.RRS_WORKERS_BUILD==='true') {
      const stub=path.resolve('cloudflare/local-disabled.ts');
      config.resolve.alias={...config.resolve.alias,'./local-db':stub,'./seed-demo':stub,'./local-files':stub};
    }
    return config;
  },
  poweredByHeader: false,
  async headers() { return [{ source: '/:path*', headers: [
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
    {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'}
  ]}, { source: '/((?!widget$).*)', headers: [
    {key:'Content-Security-Policy',value:`default-src 'self'; script-src 'self' 'unsafe-inline'${process.env.NODE_ENV==='development'?" 'unsafe-eval'":''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`}
  ]}]; }
};
export default config;
