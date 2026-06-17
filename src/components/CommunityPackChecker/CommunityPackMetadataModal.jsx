import { useMemo, useState } from 'react';
import { Button } from '../common/Button';
import { CircleCheck, FilePen, Package, TriangleAlert, X } from '../icons/LucideLocal';
import { generateConventionName, parseConventionName } from '../../utils/packConvention';
import './CommunityPackMetadataModal.css';

const AGE_CHIPS = ['2', '3', '6', '9', '12'];

function normalizeVersion(value) {
  const parsed = Number.parseInt(String(value || '').replace(/\D/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeDraft(draft) {
  const parsedTitle = parseConventionName(draft.title || '');
  return {
    title: parsedTitle?.title || String(draft.title || '').trim(),
    author: parsedTitle?.author || String(draft.author || '').trim(),
    producer: parsedTitle?.producer || String(draft.producer || '').trim(),
    bonus: parsedTitle?.bonus || String(draft.bonus || '').trim(),
    description: String(draft.description || '').trim(),
    minAge: parsedTitle?.minAge || String(draft.minAge || '3').replace(/\D/g, '') || '3',
    version: Math.max(normalizeVersion(parsedTitle?.version), normalizeVersion(draft.version)),
    namingMode: 'convention',
  };
}

function defaultDraft(report) {
  const parsed = parseConventionName(report?.packTitle || '')
    || parseConventionName(report?.packName || '')
    || {};
  const currentVersion = Math.max(
    normalizeVersion(parsed.version),
    normalizeVersion(report?.packVersion),
  );
  return {
    title: parsed.title || report?.packTitle || report?.packName || '',
    author: parsed.author || '',
    producer: parsed.producer || '',
    bonus: parsed.bonus || '',
    description: report?.packDescription || parsed.description || '',
    minAge: parsed.minAge || '3',
    version: currentVersion + 1,
    namingMode: 'convention',
  };
}

function filenameTokens(exportName) {
  if (!exportName) return [{ kind: 'empty', text: 'Titre requis' }];
  const tokens = [];
  const ageMatch = exportName.match(/^(\d+\+\])/);
  let rest = exportName;
  if (ageMatch) {
    tokens.push({ kind: 'age', text: ageMatch[1] });
    rest = rest.slice(ageMatch[1].length);
  }
  const authorIndex = rest.indexOf('[by_');
  const body = authorIndex === -1 ? rest : rest.slice(0, authorIndex);
  const author = authorIndex === -1 ? '' : rest.slice(authorIndex);
  if (body) tokens.push({ kind: 'title', text: body });
  if (author) tokens.push({ kind: 'author', text: author });
  return tokens;
}

function titleIssues(report) {
  return (report?.issues || []).filter((issue) => (
    issue.category === 'title' && (issue.severity === 'warning' || issue.severity === 'error')
  ));
}

export function CommunityPackMetadataModal({
  report,
  busy = false,
  onCancel,
  onSubmit,
}) {
  const [draft, setDraft] = useState(() => defaultDraft(report));
  const normalized = useMemo(() => normalizeDraft(draft), [draft]);
  const exportName = useMemo(() => generateConventionName(normalized), [normalized]);
  const tokens = useMemo(() => filenameTokens(exportName), [exportName]);
  const issues = useMemo(() => titleIssues(report), [report]);
  const currentAge = String(draft.minAge || '3').replace(/\D/g, '') || '3';
  const customAge = AGE_CHIPS.includes(currentAge) ? '' : currentAge;
  const canSubmit = normalized.title.length > 0 && !busy;

  function updateField(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: field === 'version' ? normalizeVersion(value) : value,
    }));
  }

  function updateAge(value) {
    updateField('minAge', String(value || '').replace(/\D/g, ''));
  }

  function submit() {
    if (!canSubmit) return;
    onSubmit?.(normalized);
  }

  return (
    <div className="checker-meta-overlay" onMouseDown={onCancel}>
      <div className="checker-meta-modal" onMouseDown={(event) => event.stopPropagation()}>
        <header className="checker-meta-header">
          <span className="checker-meta-header-icon"><FilePen className="checker-icon" aria-hidden="true" /></span>
          <div className="checker-meta-heading">
            <span>Correction des métadonnées</span>
            <h2 title={exportName || undefined}>{exportName || 'Nom du pack'}</h2>
            <p>Chaque correction crée une nouvelle révision : la version est proposée à +1.</p>
          </div>
          <button type="button" className="checker-meta-close" onClick={onCancel} aria-label="Fermer">
            <X className="checker-icon" aria-hidden="true" />
          </button>
        </header>

        <div className="checker-meta-body">
          <aside className="checker-meta-side">
            <div className="checker-meta-pack-icon">
              <Package className="checker-icon" aria-hidden="true" />
            </div>
            <div>
              <strong>{report?.packName || 'Pack communautaire'}</strong>
              <span title={report?.zipPath}>{report?.zipPath}</span>
            </div>
            {issues.length > 0 ? (
              <div className="checker-meta-issues">
                {issues.map((issue, index) => (
                  <div key={`${issue.message}-${index}`}>
                    <TriangleAlert className="checker-icon" aria-hidden="true" />
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="checker-meta-ok">
                <CircleCheck className="checker-icon" aria-hidden="true" />
                <span>Le nom semble déjà valide.</span>
              </div>
            )}
          </aside>

          <section className="checker-meta-form">
            <label>
              <span>Titre du pack</span>
              <input value={draft.title || ''} onChange={(event) => updateField('title', event.target.value)} placeholder="Titre du pack" />
            </label>

            <label>
              <span>Âge minimum</span>
              <div className="checker-meta-age">
                {AGE_CHIPS.map((age) => (
                  <button
                    key={age}
                    type="button"
                    className={currentAge === age ? 'is-active' : ''}
                    onClick={() => updateAge(age)}
                  >
                    {age}+
                  </button>
                ))}
                <input
                  value={customAge}
                  onChange={(event) => updateAge(event.target.value)}
                  inputMode="numeric"
                  placeholder="Autre"
                />
              </div>
            </label>

            <div className="checker-meta-grid">
              <label>
                <span>Auteur</span>
                <input value={draft.author || ''} onChange={(event) => updateField('author', event.target.value)} placeholder="Nom de l'auteur" />
              </label>
              <label>
                <span>Version</span>
                <input type="number" min="1" value={draft.version || 1} onChange={(event) => updateField('version', event.target.value)} />
              </label>
            </div>

            <div className="checker-meta-grid">
              <label>
                <span>Producteur</span>
                <input value={draft.producer || ''} onChange={(event) => updateField('producer', event.target.value)} placeholder="Radio France, RTL..." />
              </label>
              <label>
                <span>Bonus</span>
                <input value={draft.bonus || ''} onChange={(event) => updateField('bonus', event.target.value)} placeholder="facultatif" />
              </label>
            </div>

            <label>
              <span>Description</span>
              <textarea value={draft.description || ''} onChange={(event) => updateField('description', event.target.value)} rows={3} placeholder="Description ou changelog..." />
            </label>
          </section>
        </div>

        <div className="checker-meta-preview">
          <span>Aperçu convention communautaire</span>
          <div title={exportName ? `${exportName}.zip` : undefined}>
            {tokens.map((token, index) => (
              <em key={`${token.kind}-${index}-${token.text}`} className={`is-${token.kind}`}>{token.text}</em>
            ))}
            <em className="is-ext">.zip</em>
          </div>
        </div>

        <footer className="checker-meta-footer">
          <Button onClick={onCancel} disabled={busy}>Annuler</Button>
          <button type="button" className="chrome-toolbar-cta chrome-toolbar-cta--violet checker-correction-cta" onClick={submit} disabled={!canSubmit}>
            {busy ? 'Correction...' : 'Corriger le pack'}
          </button>
        </footer>
      </div>
    </div>
  );
}
