type SkeletonProps = {
  className?: string;
  style?: React.CSSProperties;
};

export function Skeleton({ className = "", style }: SkeletonProps) {
  return <span className={`skeleton ${className}`.trim()} style={style} aria-hidden="true" />;
}

function FieldHubHeaderSkeleton() {
  return (
    <>
      <header className="app-header field-hub-header">
        <Skeleton className="skeleton-brand-lockup" />
        <div className="field-hub-actions">
          <Skeleton className="skeleton-btn-outline" />
        </div>
      </header>

      <section className="field-hub-welcome" aria-hidden="true">
        <div className="field-hub-welcome-main">
          <Skeleton className="skeleton-avatar" />
          <div className="skeleton-header-text">
            <Skeleton className="skeleton-line-xs" />
            <Skeleton className="skeleton-line-lg" />
          </div>
        </div>
      </section>
    </>
  );
}

function FieldHubFooterSkeleton() {
  return (
    <footer className="app-footer" aria-hidden="true">
      <div className="app-footer-inner">
        <Skeleton className="skeleton-footer-copy" />
        <Skeleton className="skeleton-footer-brand" />
        <Skeleton className="skeleton-footer-link" />
      </div>
    </footer>
  );
}

export function LoginBootstrapSkeleton() {
  return (
    <main className="login-screen" aria-busy="true" aria-label="Loading sign in">
      <span className="sr-only">Loading sign in</span>
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

export function AttendancePanelSkeleton({ showSkillSection = true }: { showSkillSection?: boolean }) {
  return (
    <div className="attendance-console skeleton-attendance-console" aria-busy="true" aria-label="Loading attendance">
      <span className="sr-only">Loading attendance</span>

      <div className="attendance-subtabs skeleton-attendance-subtabs" aria-hidden="true">
        <Skeleton className="skeleton-attendance-tab" />
        <Skeleton className="skeleton-attendance-tab" />
      </div>

      <section className="field-section skeleton-attendance-section">
        <Skeleton className="skeleton-line-md" />
        <Skeleton className="skeleton-line-sm" />
        <Skeleton className="skeleton-attendance-card" />
      </section>

      {showSkillSection ? (
        <section className="field-section skeleton-attendance-section">
          <Skeleton className="skeleton-line-md" />
          <Skeleton className="skeleton-line-sm" />
          <Skeleton className="skeleton-attendance-card" />
        </section>
      ) : null}
    </div>
  );
}

export function FieldConsoleSkeleton() {
  return (
    <main className="app field-hub" aria-busy="true" aria-label="Loading field console">
      <span className="sr-only">Loading field console</span>
      <FieldHubHeaderSkeleton />

      <nav className="field-hub-tabs skeleton-hub-tabs" aria-hidden="true">
        <Skeleton className="skeleton-hub-tab" />
        <Skeleton className="skeleton-hub-tab" />
      </nav>

      <div className="field-hub-body">
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
          <Skeleton className="skeleton-ledger" />
        </section>
      </div>

      <FieldHubFooterSkeleton />
    </main>
  );
}

export function FieldHubAttendanceSkeleton({ showSkillSection = true }: { showSkillSection?: boolean }) {
  return (
    <main className="app field-hub" aria-busy="true" aria-label="Loading attendance">
      <span className="sr-only">Loading attendance</span>
      <FieldHubHeaderSkeleton />

      <nav className="field-hub-tabs skeleton-hub-tabs" aria-hidden="true">
        <Skeleton className="skeleton-hub-tab is-active" />
        <Skeleton className="skeleton-hub-tab" />
      </nav>

      <div className="field-hub-body">
        <AttendancePanelSkeleton showSkillSection={showSkillSection} />
      </div>

      <FieldHubFooterSkeleton />
    </main>
  );
}

export function CardSectionSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <section className="card-section skeleton-stack" aria-busy="true" aria-label="Loading section">
      <span className="sr-only">Loading section</span>
      <Skeleton className="skeleton-line-xs" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="skeleton-ledger" />
      ))}
    </section>
  );
}
