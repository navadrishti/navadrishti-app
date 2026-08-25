import React from "react";
import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { AppProvider } from "@/components/app-provider";
import { FIELD_APP_NAME, PRODUCT_NAME } from "@/lib/env";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

const siteTitle = `${PRODUCT_NAME} | Digital OS for Social Impact`;

export const metadata: Metadata = {
  title: {
    absolute: siteTitle,
    default: siteTitle,
  },
  applicationName: FIELD_APP_NAME,
  description: `${PRODUCT_NAME} App — field attendance and evidence capture, powered by Navadrishti`,
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/Gram.png", type: "image/png", sizes: "512x512" },
      { url: "/Gram.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/Gram.png", type: "image/png", sizes: "512x512" }],
    shortcut: ["/Gram.png"],
  },
};

export const viewport: Viewport = {
  themeColor: "#0067b9",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
