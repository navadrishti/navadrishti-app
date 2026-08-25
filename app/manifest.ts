import type { MetadataRoute } from "next";
import { FIELD_APP_NAME, PRODUCT_NAME } from "@/lib/env";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: FIELD_APP_NAME,
    short_name: PRODUCT_NAME,
    description: `${PRODUCT_NAME} App — powered by Navadrishti`,
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: "#0067b9",
    orientation: "portrait",
    icons: [
      {
        src: "/Gram.svg",
        sizes: "192x192",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/Gram.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
