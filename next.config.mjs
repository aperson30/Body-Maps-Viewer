/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // NiiVue is browser-only; prevent bundling Node modules
    //tests
    config.resolve.fallback = { fs: false, path: false };
    return config;
  },
};

export default nextConfig;
