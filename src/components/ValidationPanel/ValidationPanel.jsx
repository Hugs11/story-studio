import { StatusDot } from '../common/Badge';
import './ValidationPanel.css';

function parseIssueText(text) {
  const dashIdx = text.indexOf(' — ');
  if (dashIdx === -1) return { path: null, label: text };
  const location = text.slice(0, dashIdx);
  const error = text.slice(dashIdx + 3);
  const parts = location.split(' / ');
  if (parts.length <= 1) return { path: null, label: text };
  const nodeName = parts[parts.length - 1];
  const ancestors = parts.slice(0, -1).join(' / ');
  return { path: ancestors, label: `${nodeName} — ${error}` };
}

export function ValidationPanel({ validationIssues, onSelect }) {
  const visibleIssues = validationIssues?.length > 0
    ? validationIssues
    : [{ id: null, status: 'ok', text: 'Tout est en ordre ✓' }];
  const warnCount = visibleIssues.filter((issue) => issue.status === 'warn').length;
  const errorCount = visibleIssues.filter((issue) => issue.status === 'error').length;

  return (
    <div className="panel-right">
      <div className="panel-right-header">
        <span>Validation</span>
        {errorCount > 0 && <span className="v-badge error">{errorCount}</span>}
        {warnCount > 0 && <span className="v-badge warn">{warnCount}</span>}
      </div>
      <div className="vlist">
        {visibleIssues.map((issue, index) => {
          const { path, label } = parseIssueText(issue.text);
          return (
            <div
              key={`${issue.id ?? 'ok'}:${issue.status}:${issue.text}:${index}`}
              className="vitem"
              onClick={() => issue.id && onSelect(issue.id)}
              style={{ cursor: issue.id ? 'pointer' : 'default' }}
            >
              <StatusDot status={issue.status} />
              <div className="vitem-body">
                {path && <div className="vpath">{path}</div>}
                <span className="vtext">{label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
