import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @leo/shared ships TypeScript source; compile it with the app.
  transpilePackages: ["@leo/shared"],
};

export default nextConfig;
