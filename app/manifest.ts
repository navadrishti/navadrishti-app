import type { MetadataRoute } from "next";
import { FIELD_APP_NAME, PRODUCT_NAME } from "@/lib/env";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: FIELD_APP_NAME,
    short_name: PRODUCT_NAME,
    description: `${PRODUCT_NAME} | Digital OS for Social Impact — field attendance and evidence capture`,
    start_url: "/",
    display: "standalone",
    background_color: "#F6F5F1",
    theme_color: "#2B3E41",
    orientation: "portrait",
    icons: [
      {
        src: "/Gram.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/Gram.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/Gram.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}
