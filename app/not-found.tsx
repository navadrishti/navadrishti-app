import Link from "next/link";
import { AppFooter, ProductBrand } from "@/components/product-brand";

export default function NotFound() {
  return (
    <main className="login-screen">
      <section className="login-card">
        <div className="login-brand">
          <ProductBrand
            href="/"
            size="sm"
            nameClassName="brand-name-on-light"
            poweredClassName="brand-powered-on-light"
          />
          <p className="login-subtitle" style={{ marginTop: 24 }}>
            404
          </p>
          <h1>Page not found</h1>
          <p className="login-status">
            The page you are looking for does not exist.
          </p>
          <Link href="/" className="btn-primary" style={{ marginTop: 16 }}>
            Go to Home
          </Link>
        </div>
      </section>
      <AppFooter />
    </main>
  );
}
