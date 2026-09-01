import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for Ubuntu / nginx / pm2 deployment.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
