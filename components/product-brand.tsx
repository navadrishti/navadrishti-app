import {
  FIELD_APP_NAME,
  PRODUCT_BRAND_CLASSNAME,
  PRODUCT_LOGO_ALT,
  PRODUCT_LOGO_SRC,
  PRODUCT_NAME,
  PRODUCT_POWERED_BY,
  getPlatformUrl,
} from '@/lib/env';

type ProductBrandProps = {
  href?: string;
  size?: 'md' | 'sm' | 'xs';
  /** Show "App" after GRAM in the name line */
  showFieldSuffix?: boolean;
  className?: string;
  nameClassName?: string;
  poweredClassName?: string;
};

const sizeStyles = {
  md: {
    icon: 'brand-icon-md',
    name: 'brand-name-md',
    powered: 'brand-powered-md',
  },
  sm: {
    icon: 'brand-icon-sm',
    name: 'brand-name-sm',
    powered: 'brand-powered-sm',
  },
  xs: {
    icon: 'brand-icon-xs',
    name: 'brand-name-xs',
    powered: 'brand-powered-xs',
  },
} as const;

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function ProductBrand({
  href,
  size = 'md',
  showFieldSuffix = false,
  className,
  nameClassName,
  poweredClassName,
}: ProductBrandProps) {
  const styles = sizeStyles[size];
  const name = showFieldSuffix ? FIELD_APP_NAME : PRODUCT_NAME;

  const content = (
    <>
      <img
        src={PRODUCT_LOGO_SRC}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cx('brand-icon', styles.icon)}
      />
      <span className="brand-text">
        <span className={cx('brand-name', styles.name, nameClassName)}>
          {name}
          <span className="sr-only">{PRODUCT_LOGO_ALT}</span>
        </span>
        <span className={cx('brand-powered', styles.powered, poweredClassName)} aria-hidden="true">
          {PRODUCT_POWERED_BY}
        </span>
      </span>
    </>
  );

  const sharedClassName = cx(PRODUCT_BRAND_CLASSNAME, 'product-brand-lockup', className);

  if (href) {
    return (
      <a href={href} className={sharedClassName}>
        {content}
      </a>
    );
  }

  return <div className={sharedClassName}>{content}</div>;
}

export function AppFooter() {
  const platformUrl = getPlatformUrl();

  return (
    <footer className="app-footer">
      <div className="app-footer-inner">
        <span className="app-footer-copy">© {new Date().getFullYear()}</span>
        <ProductBrand size="xs" />
        {platformUrl ? (
          <a className="app-footer-platform" href={platformUrl} target="_blank" rel="noreferrer">
            Open platform
          </a>
        ) : null}
      </div>
    </footer>
  );
}
