/**
 * transcription display component.
 * shows the real-time transcription text as the user speaks.
 * features a modern glass-morphism design with animated cursor.
 */

import { TranscriptionDisplayProps } from '../types';

// modern styles with dark theme and glass effect
const styles = {
  container: {
    width: '100%',
    maxWidth: '700px',
    padding: 'var(--spacing-lg)',
    backgroundColor: 'rgba(37, 37, 64, 0.7)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    borderRadius: 'var(--radius-lg)',
    border: '1px solid var(--color-border)',
    minHeight: '120px',
    boxShadow: 'var(--shadow-md)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-sm)',
    marginBottom: 'var(--spacing-md)',
  },
  icon: {
    width: '16px',
    height: '16px',
    color: 'var(--color-primary-light)',
  },
  label: {
    fontSize: '0.75rem',
    fontWeight: '600' as const,
    color: 'var(--color-text-muted)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.08em',
  },
  textContainer: {
    minHeight: '60px',
  },
  text: {
    fontSize: '1.125rem',
    lineHeight: '1.8',
    color: 'var(--color-text)',
    margin: 0,
    fontWeight: '400' as const,
  },
  partialText: {
    fontSize: '1.125rem',
    lineHeight: '1.8',
    color: 'var(--color-text-secondary)',
    fontStyle: 'italic' as const,
    margin: 0,
  },
  placeholder: {
    fontSize: '1rem',
    color: 'var(--color-text-muted)',
    fontStyle: 'italic' as const,
    margin: 0,
    opacity: 0.7,
  },
  cursor: {
    display: 'inline-block',
    width: '2px',
    height: '1.25rem',
    backgroundColor: 'var(--color-primary)',
    marginLeft: '4px',
    verticalAlign: 'text-bottom',
    animation: 'blink 1s infinite',
    borderRadius: '1px',
  },
};

// text icon component
const TextIcon = () => (
  <svg style={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

export function TranscriptionDisplay({
  text,
  isPartial = false,
}: TranscriptionDisplayProps) {
  const hasText = text && text.trim().length > 0;

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <TextIcon />
        <span style={styles.label}>transcription</span>
      </div>

      <div style={styles.textContainer}>
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
    </div>
  );
}
