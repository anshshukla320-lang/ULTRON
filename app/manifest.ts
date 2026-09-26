import type { MetadataRoute } from "next";

// Makes ULTRON installable on a phone ("Add to Home screen") so it opens
// full-screen like an app. The phone talks to the ULTRON server on the PC —
// see README "Phone app" for reaching it securely from outside the house.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "U.L.T.R.O.N.",
    short_name: "ULTRON",
    description: "Your personal voice assistant, running on your PC.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
