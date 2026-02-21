/**
 * svg renderer component.
 * displays the generated svg visualization.
 * handles loading states, errors, and safely renders svg content.
 */

import { SVGRendererProps } from '../types';

// styles for the component - your team can replace with proper styling
const styles = {
  container: {
    width: '100%',
    maxWidth: '600px',
    aspectRatio: '4/3',
    backgroundColor: '#ffffff',
    borderRadius: '0.5rem',
    border: '1px solid #e5e7eb',
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
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '1rem',
    color: '#9ca3af',
  },
  placeholderIcon: {
    width: '48px',
    height: '48px',
    opacity: 0.5,
  },
  placeholderText: {
    fontSize: '0.875rem',
    textAlign: 'center' as const,
  },
  loading: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '1rem',
    color: '#6b7280',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '3px solid #e5e7eb',
    borderTopColor: '#3b82f6',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  error: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: '0.5rem',
    padding: '1rem',
    color: '#dc2626',
    textAlign: 'center' as const,
  },
  errorIcon: {
    fontSize: '2rem',
  },
  errorText: {
    fontSize: '0.875rem',
  },
};

// inject css animation for spinner
const injectStyles = () => {
  if (typeof document !== 'undefined') {
    const styleId = 'svg-renderer-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `;
      document.head.appendChild(style);
    }
  }
};

// placeholder svg shown when no content is available
const PlaceholderIcon = () => (
  <svg
    style={styles.placeholderIcon}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);

export function SVGRenderer({ svgCode, isLoading, error }: SVGRendererProps) {
  // inject animation styles on first render
  injectStyles();

  // show loading state
  if (isLoading) {
    return (
      <div style={styles.container}>
        <div style={styles.loading}>
          <div style={styles.spinner} />
          <span>generating visualization...</span>
        </div>
      </div>
    );
  }

  // show error state
  if (error) {
    return (
      <div style={styles.container}>
        <div style={styles.error}>
          <span style={styles.errorIcon}>!</span>
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
          <PlaceholderIcon />
          <span style={styles.placeholderText}>
            your visualization will appear here after you speak
          </span>
        </div>
      </div>
    );
  }

  // render the svg
  // using dangerouslySetInnerHTML because the svg is sanitized on the backend
  return (
    <div style={styles.container}>
      <div
        style={styles.svgWrapper}
        dangerouslySetInnerHTML={{ __html: svgCode }}
      />
    </div>
  );
}
