/**
 * svg renderer component.
 * displays the generated svg visualization.
 * handles loading states, errors, and safely renders svg content.
 * features a modern design with smooth animations.
 */

import { SVGRendererProps } from '../types';

// modern styles with dark theme
const styles = {
  container: {
    width: '100%',
    maxWidth: '700px',
    aspectRatio: '16/10',
    backgroundColor: 'var(--color-bg-card)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--color-border)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'var(--shadow-md)',
  },
  // when used inside an svg item (no container border/shadow)
  inline: {
    width: '100%',
    aspectRatio: '16/10',
    backgroundColor: 'var(--color-bg-card)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  svgWrapper: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 'var(--spacing-md)',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--spacing-lg)',
    color: 'var(--color-text-muted)',
    padding: 'var(--spacing-xl)',
  },
  placeholderIconWrapper: {
    width: '80px',
    height: '80px',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'var(--color-bg-elevated)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderIcon: {
    width: '40px',
    height: '40px',
    opacity: 0.5,
  },
  placeholderText: {
    fontSize: '0.9rem',
    textAlign: 'center' as const,
    maxWidth: '280px',
    lineHeight: '1.6',
  },
  loading: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-lg)',
    color: 'var(--color-text-secondary)',
    padding: 'var(--spacing-xl)',
  },
  spinnerWrapper: {
    position: 'relative' as const,
    width: '60px',
    height: '60px',
  },
  spinner: {
    width: '60px',
    height: '60px',
    border: '3px solid var(--color-bg-elevated)',
    borderTopColor: 'var(--color-primary)',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  spinnerInner: {
    position: 'absolute' as const,
    top: '10px',
    left: '10px',
    width: '40px',
    height: '40px',
    border: '3px solid var(--color-bg-elevated)',
    borderBottomColor: 'var(--color-secondary)',
    borderRadius: '50%',
    animation: 'spin 1.5s linear infinite reverse',
  },
  loadingText: {
    fontSize: '0.875rem',
    fontWeight: '500' as const,
  },
  error: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 'var(--spacing-md)',
    padding: 'var(--spacing-xl)',
    textAlign: 'center' as const,
  },
  errorIconWrapper: {
    width: '60px',
    height: '60px',
    borderRadius: '50%',
    backgroundColor: 'var(--color-error-bg)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorIcon: {
    width: '28px',
    height: '28px',
    color: 'var(--color-error)',
  },
  errorText: {
    fontSize: '0.875rem',
    color: 'var(--color-error)',
    maxWidth: '300px',
  },
};

// placeholder svg icon
const PlaceholderIcon = () => (
  <svg
    style={styles.placeholderIcon}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);

// error icon
const ErrorIcon = () => (
  <svg
    style={styles.errorIcon}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

export function SVGRenderer({ svgCode, isLoading, error }: SVGRendererProps) {
  // show loading state
  if (isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>
          <div style={styles.spinnerWrapper}>
            <div style={styles.spinner} />
            <div style={styles.spinnerInner} />
          </div>
          <span style={styles.loadingText}>generating visualization...</span>
        </div>
      </div>
    );
  }

  // show error state
  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.error}>
          <div style={styles.errorIconWrapper}>
            <ErrorIcon />
          </div>
          <span style={styles.errorText}>{error}</span>
        </div>
      </div>
    );
  }

  // show placeholder when no svg
  if (!svgCode) {
    return (
      <div style={styles.container}>
        <div style={styles.placeholder}>
          <div style={styles.placeholderIconWrapper}>
            <PlaceholderIcon />
          </div>
          <span style={styles.placeholderText}>
            your visualization will appear here after you start recording and say the trigger word
          </span>
        </div>
      </div>
    );
  }

  // render the svg inline (used inside svg list items)
  return (
    <div style={styles.inline}>
      <div
        style={styles.svgWrapper}
        dangerouslySetInnerHTML={{ __html: svgCode }}
      />
    </div>
  );
}
