import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Navadrishti Field App",
    short_name: "Navadrishti",
    description: "Offline-first evidence capture for field teams.",
    start_url: "/",
    display: "standalone",
    background_color: "#f6efe7",
    theme_color: "#f26a2e",
    orientation: "portrait",
    icons: [
      {
        src: "/logo.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any"
      },
      {
        src: "/logo.svg",
        sizes: "512x512",
        type: "image/svg+xml",
        purpose: "any"
      }
    ]
  };
}
