import { useState } from 'react';

export function TechnicalSummary({ lines }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="card-title" style={{ marginBottom: 0 }}>Résumé technique</div>
        <button type="button" className="btn-xs" onClick={() => setOpen((v) => !v)}>
          {open ? 'Masquer' : 'Afficher'}
        </button>
      </div>
      {open && (
        <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
          {lines.map((line) => (
            <div
              key={line}
              style={{
                fontSize: 12,
                color: 'var(--color-text-secondary)',
                padding: '8px 10px',
                borderRadius: 10,
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
