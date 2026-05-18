import { useState, useEffect } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import '../CentralPanel/RootEditor.css';

function toUnderscored(str) {
  return (str || '').trim().replace(/\s+/g, '_');
}

function extractAgeFromName(name) {
  const m = (name || '').match(/^(\d+)\+\]/);
  return m ? m[1] : '';
}

function parseConventionName(raw) {
  if (!raw) return null;
  const ageMatch = raw.match(/^(\d+)\+\]/);
  if (!ageMatch) return null;
  const age = ageMatch[1];
  let rest = raw.slice(ageMatch[0].length);

  let author = '';
  let version = '1';
  const byIdx = rest.indexOf('[by_');
  if (byIdx !== -1) {
    const byPart = rest.slice(byIdx + 4);
    const vMatch = byPart.match(/[_-][Vv](\d+)$/);
    if (vMatch) {
      version = vMatch[1];
      author = byPart.slice(0, byPart.length - vMatch[0].length).replace(/_/g, ' ').trim();
    } else {
      author = byPart.replace(/_/g, ' ').trim();
    }
    rest = rest.slice(0, byIdx);
  }

  let producer = '';
  let core = rest;
  const prodSep = rest.indexOf('_-_');
  if (prodSep !== -1) {
    producer = rest.slice(0, prodSep).replace(/_/g, ' ').trim();
    core = rest.slice(prodSep + 3);
  } else {
    const singleDash = rest.match(/^([A-Za-z][A-Za-z_À-ž]+)-([A-Za-z].+)$/);
    if (singleDash) {
      producer = singleDash[1].replace(/_/g, ' ').trim();
      core = singleDash[2];
    }
  }

  let bonus = '';
  let title = core;
  const bonusParen = core.match(/_\((.+)\)$/);
  if (bonusParen) {
    bonus = bonusParen[1].replace(/_/g, ' ').trim();
    title = core.slice(0, core.length - bonusParen[0].length);
  } else {
    const lastDash = core.lastIndexOf('-');
    if (lastDash !== -1) {
      const potBonus = core.slice(lastDash + 1).replace(/_/g, ' ').trim();
      if (potBonus && /^\d/.test(potBonus)) {
        bonus = potBonus;
        title = core.slice(0, lastDash);
      }
    }
  }

  return { age, title: title.replace(/_/g, ' ').trim(), bonus, author, version, producer };
}

function generateName({ age, title, bonus, author, version, producer }) {
  const t = toUnderscored(title);
  const b = toUnderscored(bonus);
  const a = toUnderscored(author);
  const v = String(version || '1').replace(/\D/g, '') || '1';
  const p = (producer || '').trim();
  const bonusPart = b ? `_(${b})` : '';
  if (!t) return '';
  const prefix = `${age || '3'}+]`;
  const titlePart = p && a && p !== (author || '').trim()
    ? `${p}-${t}${bonusPart ? bonusPart.replace(/^_/, '') : ''}`
    : `${t}${bonusPart}`;
  if (!a) return `${prefix}${titlePart}`;
  return `${prefix}${titlePart}[by_${a}_V${v}`;
}

const AGES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function PackNameModal({ open, packName, packDescription = '', packVersion = 1, packMinAge = '', packConventionSource = '', onUpdatePackName, onClose }) {
  const [gen, setGen] = useState(() => {
    try {
      const saved = localStorage.getItem('nameGenFields');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { age: '3', title: '', bonus: '', author: '', version: '1', producer: '' };
  });
  const [description, setDescription] = useState(packDescription);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (open) {
      setDescription(packDescription);
      const parsed = parseConventionName(packConventionSource);
      const agePrefill = (parsed?.age) || packMinAge || extractAgeFromName(packName);
      const next = parsed
        ? {
            age: parsed.age,
            title: parsed.title,
            bonus: parsed.bonus,
            author: parsed.author,
            version: parsed.version || String(packVersion),
            producer: parsed.producer,
          }
        : {
            ...gen,
            ...(agePrefill ? { age: agePrefill } : {}),
            ...(packName && !gen.title.trim() ? { title: packName.replace(/^\d+\+\]/, '').trim() } : {}),
            ...(packVersion > 1 ? { version: String(packVersion) } : {}),
          };
      setGen(next);
      localStorage.setItem('nameGenFields', JSON.stringify(next));
    }
  }, [open]);

  if (!open) return null;

  function updateGen(field, value) {
    const next = { ...gen, [field]: value };
    setGen(next);
    localStorage.setItem('nameGenFields', JSON.stringify(next));
    const newName = generateName(next);
    if (newName) onUpdatePackName({ name: newName, packVersion: parseInt(next.version, 10) || 1, packDescription: description, packMinAge: next.age });
    else if (field === 'age') onUpdatePackName({ packMinAge: value });
  }

  function updateDescription(value) {
    setDescription(value);
    onUpdatePackName({ packDescription: value });
  }

  const generatedName = generateName(gen);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Convention de nommage communautaire</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '16px 20px 20px', display: 'grid', gap: 12 }}>
          <div className="name-gen-grid">
            <label>Âge minimum</label>
            <select value={gen.age} onChange={(e) => updateGen('age', e.target.value)} className="field-input">
              {AGES.map((a) => <option key={a} value={a}>{a}+</option>)}
            </select>

            <label>Titre de l'histoire</label>
            <input className="field-input" placeholder="Les aventures de Léa" value={gen.title} onChange={(e) => updateGen('title', e.target.value)} />

            <label>Bonus <span style={{ fontSize: 10, opacity: 0.6 }}>(facultatif)</span></label>
            <input className="field-input" placeholder="8 chapitres" value={gen.bonus} onChange={(e) => updateGen('bonus', e.target.value)} />

            <label>Auteur / Créateur</label>
            <input className="field-input" placeholder="MonPseudo" value={gen.author} onChange={(e) => updateGen('author', e.target.value)} />

            <label>Version</label>
            <input
              type="number"
              min="1"
              className="field-input"
              value={gen.version}
              onChange={(e) => updateGen('version', e.target.value)}
              onBlur={(e) => { if (!e.target.value) updateGen('version', '1'); }}
              style={{ width: 80 }}
            />

            <label>Producteur <span style={{ fontSize: 10, opacity: 0.6 }}>(si différent de l'auteur)</span></label>
            <input className="field-input" placeholder="RTL, France Inter…" value={gen.producer} onChange={(e) => updateGen('producer', e.target.value)} />
          </div>

          {generatedName && (
            <div className="name-gen-preview">
              <span className="name-gen-preview-label">Aperçu :</span>
              <code className="name-gen-preview-value">{generatedName}</code>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>Description / Changelog</label>
            <textarea
              className="field-input"
              value={description}
              onChange={e => updateDescription(e.target.value)}
              placeholder=""
              rows={4}
              style={{ resize: 'vertical', fontFamily: 'inherit', fontSize: 12 }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={onClose}>Valider</button>
          </div>
        </div>
      </div>
    </div>
  );
}
