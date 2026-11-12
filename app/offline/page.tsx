"use client";

import React from "react";
import { AppFooter, ProductBrand } from "@/components/product-brand";

export default function OfflinePage() {
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <ProductBrand size="sm" nameClassName="brand-name-on-light" poweredClassName="brand-powered-on-light" />
          <h1>You&apos;re offline</h1>
          <p className="login-status">
            You can still mark attendance and capture evidence. Records stay on this device and upload
            when the app is open and online again.
          </p>
          <button type="button" className="btn-primary" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </section>
      <AppFooter />
    </main>
  );
}
