import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  assetPrefix: ".",
  trailingSlash: true,
  turbopack: { root: process.cwd() },
};

export default nextConfig;
