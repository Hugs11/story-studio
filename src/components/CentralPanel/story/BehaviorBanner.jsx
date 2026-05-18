export function BehaviorBanner({ text, tone = 'muted' }) {
  const isAccent = tone === 'accent';
  return (
    <div
      style={{
        fontSize: 12,
        color: isAccent ? 'var(--color-accent)' : 'var(--color-text-secondary)',
        padding: '8px 10px',
        borderRadius: 10,
        background: isAccent ? 'var(--color-accent-light)' : 'rgba(255,255,255,0.04)',
        border: isAccent
          ? '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)'
          : '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {text}
    </div>
  );
}
