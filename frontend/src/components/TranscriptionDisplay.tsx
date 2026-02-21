/**
 * transcription display component.
 * shows the real-time transcription text as the user speaks.
 * provides visual feedback during the speech-to-text process.
 */

import { TranscriptionDisplayProps } from '../types';

// styles for the component - your team can replace with proper styling
const styles = {
  container: {
    width: '100%',
    maxWidth: '600px',
    padding: '1.5rem',
    backgroundColor: '#f9fafb',
    borderRadius: '0.5rem',
    border: '1px solid #e5e7eb',
    minHeight: '100px',
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: 'bold' as const,
    color: '#6b7280',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginBottom: '0.5rem',
  },
  text: {
    fontSize: '1.125rem',
    lineHeight: '1.75',
    color: '#1f2937',
    margin: 0,
  },
  partialText: {
    fontSize: '1.125rem',
    lineHeight: '1.75',
    color: '#6b7280',
    fontStyle: 'italic' as const,
    margin: 0,
  },
  placeholder: {
    fontSize: '1rem',
    color: '#9ca3af',
    fontStyle: 'italic' as const,
    margin: 0,
  },
  cursor: {
    display: 'inline-block',
    width: '2px',
    height: '1.25rem',
    backgroundColor: '#3b82f6',
    marginLeft: '2px',
    animation: 'blink 1s infinite',
  },
};

// inject css animation for cursor blink
const injectStyles = () => {
  if (typeof document !== 'undefined') {
    const styleId = 'transcription-display-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }
  }
};

export function TranscriptionDisplay({
  text,
  isPartial = false,
}: TranscriptionDisplayProps) {
  // inject animation styles on first render
  injectStyles();

  const hasText = text && text.trim().length > 0;

  return (
    <div style={styles.container}>
      <div style={styles.label}>transcription</div>

      {hasText ? (
        <p style={isPartial ? styles.partialText : styles.text}>
          {text}
          {isPartial && <span style={styles.cursor} />}
        </p>
      ) : (
        <p style={styles.placeholder}>
          your speech will appear here as you speak...
        </p>
      )}
    </div>
  );
}
