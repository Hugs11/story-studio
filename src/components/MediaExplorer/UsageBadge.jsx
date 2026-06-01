export function UsageBadge({ count }) {
  return <span className={`media-usage-badge${count === 0 ? ' is-zero' : ''}`}>×{count}</span>;
}
