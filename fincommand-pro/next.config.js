const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Default '.next'. NEXT_DIST_DIR lets a second local server (e.g. one
  // pointed at the Neon test branch) run without overwriting the build
  // another server on :4000 is serving from.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: path.join(__dirname),
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;

