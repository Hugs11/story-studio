import { useEffect, useMemo, useState } from 'react';
import { exists } from '@tauri-apps/plugin-fs';
import { CircleCheck, Image, Package, TriangleAlert } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useLocalFile } from '../../hooks/useLocalFile';
import { generateConventionName, getExportPackName } from '../../utils/packConvention';
import './PackNameModal.css';

const AGE_CHIPS = ['2', '3', '6', '9', '12'];

function normalizeVersion(value) {
  const parsed = Number.parseInt(String(value || '').replace(/\D/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function defaultDraft(packMetadata = {}) {
  return {
    title: '',
    author: '',
    version: 1,
    minAge: '3',
    producer: '',
    bonus: '',
    description: '',
    namingMode: 'convention',
    legacyExportName: '',
    legacyName: '',
    ...packMetadata,
  };
}

function normalizeDraft(draft) {
  const namingMode = draft.namingMode === 'legacy' ? 'legacy' : 'convention';
  return {
    ...draft,
    title: String(draft.title || '').trim(),
    author: String(draft.author || '').trim(),
    producer: String(draft.producer || '').trim(),
    bonus: String(draft.bonus || '').trim(),
    description: String(draft.description || '').trim(),
    minAge: String(draft.minAge || '3').replace(/\D/g, '') || '3',
    version: normalizeVersion(draft.version),
    namingMode,
  };
}

function countStats(project) {
  let stories = 0;
  let media = 0;

  function countMedia(...values) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) media += 1;
    }
  }

  countMedia(project?.rootAudio, project?.rootImage, project?.thumbnailImage, project?.nightModeAudio);
  function walk(entries = []) {
    for (const entry of entries) {
      if (entry.type === 'story' || entry.type === 'zip') stories += 1;
      countMedia(entry.audio, entry.image, entry.itemAudio, entry.itemImage, entry.zipPath, entry.coverAudio, entry.coverImage);
      if (entry.type === 'menu') walk(entry.children || []);
    }
  }
  walk(project?.rootEntries || []);
  return { stories, media };
}

function filenameTokens(exportName) {
  if (!exportName) return [{ kind: 'empty', text: 'Titre requis pour générer le nom exporté', insert: '' }];
  const tokens = [];
  let rest = String(exportName || '');
  const ageMatch = rest.match(/^(\d+\+\])/);
  if (ageMatch) {
    const value = ageMatch[1];
    tokens.push({ kind: 'age', text: value, insert: value.replace(/\]$/, '') });
    rest = rest.slice(value.length);
  }

  const authorIndex = rest.indexOf('[by_');
  const body = authorIndex === -1 ? rest : rest.slice(0, authorIndex);
  const byPart = authorIndex === -1 ? '' : rest.slice(authorIndex);
  if (body) tokens.push({ kind: 'title', text: body, insert: body.replace(/_/g, ' ') });

  if (byPart) {
    const versionMatch = byPart.match(/([_-]V\d+)$/i);
    const author = versionMatch ? byPart.slice(0, byPart.length - versionMatch[1].length) : byPart;
    if (author) tokens.push({ kind: 'author', text: author, insert: author.replace(/^\[by_/, '').replace(/_/g, ' ') });
    if (versionMatch) tokens.push({ kind: 'version', text: versionMatch[1], insert: versionMatch[1].replace(/[^\d]/g, '') });
  }

  tokens.push({ kind: 'ext', text: '.zip', insert: '' });
  return tokens;
}

export function PackNameModal({
  open,
  packMetadata = {},
  project = null,
  coverImage = null,
  exportFolder = null,
  generateDisabled = false,
  onSave,
  onSaveAndGenerate,
  onClose,
}) {
  const [draft, setDraft] = useState(() => defaultDraft(packMetadata));
  const [saving, setSaving] = useState(null);
  const [collision, setCollision] = useState('unknown');
  const coverUrl = useLocalFile(coverImage);
  useEscapeKey(open, onClose);

  useEffect(() => {
    if (open) {
      setDraft(defaultDraft(packMetadata));
      setSaving(null);
    }
  }, [open, packMetadata]);

  const normalizedDraft = useMemo(() => normalizeDraft(draft), [draft]);
  const exportName = useMemo(() => {
    if (normalizedDraft.namingMode === 'legacy' && normalizedDraft.legacyExportName) {
      return getExportPackName(normalizedDraft);
    }
    return generateConventionName(normalizedDraft);
  }, [normalizedDraft]);
  const tokens = useMemo(() => filenameTokens(exportName), [exportName]);
  const stats = useMemo(() => countStats(project), [project]);
  const hasExportName = normalizedDraft.namingMode === 'legacy'
    ? !!normalizedDraft.legacyExportName
    : !!normalizedDraft.title;
  const currentAge = String(draft.minAge || '3').replace(/\D/g, '') || '3';
  const customAgeValue = AGE_CHIPS.includes(currentAge) ? '' : currentAge;

  useEffect(() => {
    if (!open || !exportFolder || !exportName) {
      setCollision('unknown');
      return undefined;
    }
    let cancelled = false;
    const fullPath = `${exportFolder.replace(/[\\/]+$/, '')}/${exportName}.zip`;
    exists(fullPath)
      .then((found) => {
        if (!cancelled) setCollision(found ? 'collision' : 'free');
      })
      .catch(() => {
        if (!cancelled) setCollision('unknown');
      });
    return () => {
      cancelled = true;
    };
  }, [open, exportFolder, exportName]);

  if (!open) return null;

  function updateField(field, value) {
    setDraft((current) => ({
      ...current,
      [field]: field === 'version' ? normalizeVersion(value) : value,
      namingMode: 'convention',
    }));
  }

  function updateAge(value) {
    updateField('minAge', String(value || '').replace(/\D/g, ''));
  }

  async function submit(kind) {
    const payload = normalizeDraft(draft);
    setSaving(kind);
    try {
      if (kind === 'generate') await onSaveAndGenerate?.(payload);
      else await onSave?.(payload);
    } finally {
      setSaving(null);
    }
  }

  const collisionText = collision === 'collision'
    ? 'Un ZIP du même nom existe déjà dans le dossier d’export'
    : collision === 'free'
      ? 'Nom disponible dans le dossier d’export'
      : exportFolder
        ? 'Statut du nom en cours de vérification'
        : "Aucun dossier d'export disponible";
  const generateButtonDisabled = !!saving || !hasExportName || generateDisabled;
  const generateButtonTooltip = saving
    ? 'Une action est déjà en cours.'
    : !hasExportName
      ? 'Renseigne le titre du pack avant de générer.'
      : generateDisabled
        ? 'Passe par « à corriger » avant de pouvoir générer le pack.'
        : 'Appliquer les métadonnées et générer le pack.';

  return (
    <div className="modal-overlay pack-meta-overlay" onClick={onClose}>
      <div className="pack-meta-modal" onClick={(event) => event.stopPropagation()}>
        <header className="pack-meta-header">
          <span className="pack-meta-header-icon"><Package className="chrome-icon" strokeWidth={2} absoluteStrokeWidth /></span>
          <div className="pack-meta-heading">
            <span className="pack-meta-eyebrow">Métadonnées du pack</span>
            <h2 title={exportName || undefined}>{exportName || 'Métadonnées du pack'}</h2>
            <p>Ces informations s'affichent dans la liseuse et constituent le nom du fichier exporté.</p>
          </div>
          <Button variant="icon" className="modal-close pack-meta-close" onClick={onClose} aria-label="Fermer">×</Button>
        </header>

        <div className="pack-meta-body">
          <aside className="pack-meta-cover-panel">
            <span className="pack-meta-cover-label">Couverture</span>
            <div className="pack-meta-cover">
              {coverUrl ? <img src={coverUrl} alt="" /> : <Image className="pack-meta-cover-empty" strokeWidth={1.7} absoluteStrokeWidth />}
            </div>
            <div className="pack-meta-cover-copy">
              <span>{coverUrl ? 'Définie dans la bibliothèque' : 'Aucune image racine définie'}</span>
              <small>non éditable ici</small>
            </div>
          </aside>

          <section className="pack-meta-form">
            <div className="pack-meta-field-row">
              <label>Titre du pack</label>
              <input className="pack-meta-input" value={draft.title || ''} onChange={(event) => updateField('title', event.target.value)} placeholder="Titre de mon pack" />
            </div>

            <div className="pack-meta-field-row">
              <label>Âge minimum</label>
              <div className="pack-meta-age-control">
                <div className="pack-meta-age-chips" role="group" aria-label="Âges minimum prédéfinis">
                  {AGE_CHIPS.map((age) => (
                    <button
                      key={age}
                      type="button"
                      className={`pack-meta-age-chip ${currentAge === age ? 'is-active' : ''}`}
                      onClick={() => updateAge(age)}
                    >
                      {age}+
                    </button>
                  ))}
                </div>
                <div className={`pack-meta-age-custom ${customAgeValue ? 'is-active' : ''}`}>
                  <span>Autre :</span>
                  <div className="pack-meta-age-custom-value">
                    <input
                      className="pack-meta-input pack-meta-age-other"
                      value={customAgeValue}
                      onChange={(event) => updateAge(event.target.value)}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      aria-label="Âge minimum personnalisé"
                      placeholder="5"
                    />
                    <span aria-hidden="true">+</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="pack-meta-field-row">
              <label>Auteur</label>
              <input className="pack-meta-input" value={draft.author || ''} onChange={(event) => updateField('author', event.target.value)} placeholder="Nom de l’auteur" />
            </div>

            <div className="pack-meta-field-row">
              <label>Version</label>
              <div className="pack-meta-version-grid">
                <input className="pack-meta-input pack-meta-version-input" type="number" min="1" value={draft.version || 1} onChange={(event) => updateField('version', event.target.value)} />
                <div className="pack-meta-inline-field">
                  <span>Producteur</span>
                  <input className="pack-meta-input" value={draft.producer || ''} onChange={(event) => updateField('producer', event.target.value)} placeholder="RTL, France Inter... (facultatif)" />
                </div>
              </div>
            </div>

            <div className="pack-meta-field-row">
              <label>Bonus <span>facultatif</span></label>
              <input className="pack-meta-input" value={draft.bonus || ''} onChange={(event) => updateField('bonus', event.target.value)} placeholder="ex. 8 chapitres" />
            </div>

            <div className="pack-meta-field-row is-textarea">
              <label>Description <span>changelog</span></label>
              <textarea className="pack-meta-input pack-meta-textarea" value={draft.description || ''} onChange={(event) => updateField('description', event.target.value)} rows={3} placeholder="Public visé, contenu, changements depuis la version précédente..." />
            </div>
          </section>
        </div>

        <div className="pack-meta-preview">
          <div className="pack-meta-preview-head">
            <span className="pack-meta-preview-label">Nom exporté</span>
            <div className={`pack-meta-status is-${collision}`}>
              {collision === 'collision' ? <TriangleAlert className="chrome-icon" strokeWidth={2} absoluteStrokeWidth /> : <CircleCheck className="chrome-icon" strokeWidth={2} absoluteStrokeWidth />}
              <span>{collisionText}</span>
            </div>
          </div>
          <div className="pack-meta-filename" title={exportName ? `${exportName}.zip` : ''}>
            {tokens.map((token, index) => (
              <span key={`${token.kind}-${index}-${token.text}`} className={`pack-meta-token is-${token.kind}`}>{token.text}</span>
            ))}
          </div>
        </div>

        <footer className="pack-meta-footer">
          <div className="pack-meta-summary">
            <strong>{stats.stories}</strong> histoire{stats.stories > 1 ? 's' : ''}
            <span>{stats.media} média{stats.media > 1 ? 's' : ''} lié{stats.media > 1 ? 's' : ''}</span>
          </div>
          <div className="pack-meta-actions">
            <Button onClick={onClose} disabled={saving}>Annuler</Button>
            <Button onClick={() => submit('save')} disabled={saving}>{saving === 'save' ? 'Application...' : 'Appliquer'}</Button>
            <Tooltip text={generateButtonTooltip} wrap>
              <Button
                variant="primary"
                onClick={() => submit('generate')}
                disabled={generateButtonDisabled}
                aria-label={generateButtonTooltip}
              >
                {saving === 'generate' ? 'Préparation...' : 'Appliquer & générer'}
              </Button>
            </Tooltip>
          </div>
        </footer>
      </div>
    </div>
  );
}
