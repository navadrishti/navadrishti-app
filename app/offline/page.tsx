"use client";

import React from "react";
import { AppFooter, ProductBrand } from "@/components/product-brand";

export default function OfflinePage() {
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <ProductBrand size="sm" nameClassName="brand-name-on-light" poweredClassName="brand-powered-on-light" />
          <h1>You&apos;re Offline</h1>
          <p className="login-status">
            You can still capture evidence. It will sync when you&apos;re back online.
          </p>
          <button type="button" className="btn-primary" style={{ marginTop: 16 }} onClick={() => window.location.reload()}>
            Try Again
          </button>
        </div>
      </section>
      <AppFooter />
    </main>
  );
}
