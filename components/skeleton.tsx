type SkeletonProps = {
  className?: string;
  style?: React.CSSProperties;
};

export function Skeleton({ className = "", style }: SkeletonProps) {
  return <span className={`skeleton ${className}`.trim()} style={style} aria-hidden="true" />;
}

export function LoginBootstrapSkeleton() {
  return (
    <main className="login-screen">
      <div className="login-shell">
        <Skeleton className="skeleton-login-logo" />
        <section className="login-card login-card-skeleton">
          <div className="skeleton-form">
            <Skeleton className="skeleton-field" />
            <Skeleton className="skeleton-field" />
            <Skeleton className="skeleton-button" />
          </div>
        </section>
      </div>
    </main>
  );
}

export function FieldConsoleSkeleton() {
  return (
    <main className="app">
      <header className="app-header">
        <div className="header-left">
          <Skeleton className="skeleton-header-logo" />
          <div className="skeleton-header-text">
            <Skeleton className="skeleton-line-lg" />
            <Skeleton className="skeleton-line-sm" />
          </div>
        </div>
        <Skeleton className="skeleton-btn-outline" />
      </header>

      <section className="card-section">
        <div className="chips-row">
          <Skeleton className="skeleton-chip" />
          <Skeleton className="skeleton-chip" />
          <Skeleton className="skeleton-chip" />
        </div>
      </section>

      <section className="card-section skeleton-stack">
        <Skeleton className="skeleton-line-xs" />
        <Skeleton className="skeleton-line-lg" />
        <Skeleton className="skeleton-line-md" />
        <Skeleton className="skeleton-camera" />
        <Skeleton className="skeleton-field" />
        <Skeleton className="skeleton-field" />
        <Skeleton className="skeleton-button" />
      </section>

      <section className="card-section skeleton-stack">
        <Skeleton className="skeleton-line-xs" />
        <Skeleton className="skeleton-ledger" />
        <Skeleton className="skeleton-ledger" />
      </section>
    </main>
  );
}

export function CardSectionSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <section className="card-section skeleton-stack">
      <Skeleton className="skeleton-line-xs" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="skeleton-ledger" />
      ))}
    </section>
  );
}
