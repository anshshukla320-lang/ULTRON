import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Quiets the dev-mode HMR cross-origin warning when accessed via 127.0.0.1
  // (Spotify's OAuth redirect) or the Cloudflare tunnel hostname.
  allowedDevOrigins: ["127.0.0.1", "*.trycloudflare.com"],
};

export default nextConfig;
