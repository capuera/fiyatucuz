/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@fiyatucuz/types', '@fiyatucuz/validation'],
};

export default nextConfig;
