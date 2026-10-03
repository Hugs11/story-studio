import { useEffect, useMemo, useRef, useState } from 'react';
import { exists } from '@tauri-apps/plugin-fs';
import { invoke } from '@tauri-apps/api/core';
import { CircleCheck, Image, Package, RotateCcw, TriangleAlert } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { Button } from '../common/Button';
import { ImageField } from '../editors/ImageField';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useLocalFile } from '../../hooks/useLocalFile';
import { generateConventionName } from '../../utils/packConvention';
import {
  ARCHIVE_NAMING_CONVENTION,
  ARCHIVE_NAMING_FREE,
  advancedArchiveBaseName,
  archiveNamingFields,
} from '../../store/advancedExport/archiveName';
import { generateUuid } from '../../utils/uuid';
import { shouldPromptRegenerateImportedUuid } from '../../store/projectHelpers';
import { packIdentityRefusal } from '../../store/packIdentityCheck';
import './PackNameModal.css';

// La fiche du pack, **commune aux deux éditeurs**.
//
// Elle écrit à deux endroits, et c'est la seule chose qu'il faut savoir en la
// lisant :
//
// - **le document** porte le titre, la version et la description. Côté graphe,
//   l'identité livrée est dans le contexte du document ; la vue de lecture les
//   expose et un **geste d'auteur** annulable les écrit. Côté Libre, ces valeurs
//   vivent dans l'enveloppe du projet.
// - **l'enveloppe du projet** porte l'âge minimum, l'auteur, le producteur, le
//   bonus et le mode de nommage. Ces cinq-là ne composent que le **nom du
//   fichier exporté** : ils n'entrent dans aucun pack, d'aucun côté. Les tenir
//   dans l'enveloppe ne crée donc aucune seconde vérité — il n'existe aucune
//   valeur du document qu'ils pourraient contredire.
//
// Côté graphe aussi, l'auteur peut nommer son pack par convention et y faire
// apparaître sa version, **sans y être contraint** : le défaut reste le nom
// libre, qui retombe sur le titre, pour ne poser sur son fichier aucun « 3+ »
// qu'il n'a pas saisi.
//
// Le choix du chemin d'écriture est fait par l'appelant ; la fiche ne connaît
// que `onSave`. Ce qu'elle ne comble toujours pas d'un repli : les compteurs
// d'un projet sans arbre, qui donneraient un zéro calculé là où rien n'est connu.

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
    uuid: '',
    originalUuid: '',
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
    uuid: String(draft.uuid || '').trim(),
    originalUuid: String(draft.originalUuid || '').trim(),
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
  // La vignette catalogue, éditable ici quand l'hôte la fournit : l'image
  // propre du catalogue (`null` si elle reprend l'image racine) et l'image
  // racine qu'elle reprend alors. Absentes, la couverture reste en lecture
  // seule — c'est le cas du funnel « Agréger des packs », qui a son étape image.
  catalogImage,
  fallbackImage = null,
  exportFolder = null,
  generateDisabled = false,
  embedded = false,
  promptRegenerateUuid = false,
  // Présent seulement pour un projet graphe : le brouillon lu dans le document,
  // la gouvernance de chaque champ et les compteurs de la structure.
  advanced = null,
  onSave,
  onSaveAndGenerate,
  onClose,
}) {
  const isAdvanced = !!advanced;
  // Côté graphe, l'UUID présenté est l'identité réellement utilisée à l'export.
  const governance = advanced?.governance ?? {};
  // Côté graphe, la fiche compose sa source des deux endroits : l'enveloppe du
  // projet pour le nommage, le document pour ce qu'il porte réellement. L'ordre
  // compte — le document est l'autorité sur le titre et la version, et une
  // valeur d'enveloppe ne doit jamais le recouvrir.
  const source = useMemo(
    () => (advanced ? { ...(packMetadata ?? {}), ...advanced.draft } : packMetadata),
    [advanced, packMetadata],
  );
  const [draft, setDraft] = useState(() => defaultDraft(source));
  // Vrai dès que l'auteur a choisi lui-même un mode de nommage.
  //
  // Sans ce témoin, toucher un champ de la convention bascule la fiche en mode
  // convention — un raccourci qui écraserait un choix explicite. Le
  // comportement du Libre est donc conservé **exactement** pour qui ne touche
  // pas au réglage du mode.
  const [namingChosen, setNamingChosen] = useState(false);
  const [saving, setSaving] = useState(null);
  const [notice, setNotice] = useState(null);
  const [collision, setCollision] = useState('unknown');
  // La vignette part avec le brouillon : elle n'est écrite qu'à « Appliquer ».
  const catalogEditable = catalogImage !== undefined;
  const [catalogDraft, setCatalogDraft] = useState(catalogImage ?? null);
  const shownCover = catalogEditable ? (catalogDraft || fallbackImage) : coverImage;
  const coverUrl = useLocalFile(catalogEditable ? null : shownCover);
  useEscapeKey(open && !embedded, onClose);

  // Le brouillon se resynchronise sur la **valeur** de sa source, pas sur son
  // identité. L'hôte reconstruit ces objets à chaque rendu, et un export en
  // cours fait battre l'hôte : se fier à l'identité effaçait la saisie en cours
  // à chaque progression. La signature ne change que si le document change
  // réellement — auquel cas reprendre ses valeurs est la bonne réponse.
  const sourceSignature = JSON.stringify(source ?? {});
  const syncedSignatureRef = useRef(null);
  useEffect(() => {
    if (!open) {
      syncedSignatureRef.current = null;
      return;
    }
    if (syncedSignatureRef.current === sourceSignature) return;
    syncedSignatureRef.current = sourceSignature;
    setDraft(defaultDraft(JSON.parse(sourceSignature)));
    setCatalogDraft(catalogImage ?? null);
    setNamingChosen(false);
    setSaving(null);
    setNotice(null);
    // La vignette n'est relue qu'avec la source : la reprendre à chaque rendu
    // effacerait le choix en cours, comme pour le reste du brouillon.
  }, [open, sourceSignature]);

  const normalizedDraft = useMemo(() => normalizeDraft(draft), [draft]);
  const namingMode = normalizedDraft.namingMode;
  const showImportedUuidHint = promptRegenerateUuid
    && shouldPromptRegenerateImportedUuid(normalizedDraft);
  const exportName = useMemo(() => {
    // Côté graphe, l'aperçu passe par **le composeur que la production
    // appelle**. En tenir un second ici le ferait diverger, et la fiche
    // annoncerait un nom que le fichier ne porterait pas.
    if (isAdvanced) {
      return advancedArchiveBaseName({
        packMetadata: normalizedDraft,
        title: normalizedDraft.title,
        version: normalizedDraft.version,
      });
    }
    return normalizedDraft.namingMode === ARCHIVE_NAMING_FREE
      ? (normalizedDraft.legacyExportName || normalizedDraft.title)
      : generateConventionName(normalizedDraft);
  }, [isAdvanced, normalizedDraft]);
  const tokens = useMemo(() => filenameTokens(exportName), [exportName]);
  const stats = useMemo(() => countStats(project), [project]);
  const hasExportName = namingMode === ARCHIVE_NAMING_FREE
    ? !!(normalizedDraft.legacyExportName || normalizedDraft.title)
    : !!normalizedDraft.title;
  const currentAge = String(draft.minAge || '3').replace(/\D/g, '') || '3';
  const customAgeValue = AGE_CHIPS.includes(currentAge) ? '' : currentAge;

  useEffect(() => {
    // Les deux éditeurs composent un nom exporté : la recherche de
    // collision vaut donc des deux côtés. Elle reste **approximative** — le
    // moteur assainit encore ce nom, et suffixera de toute façon `-2` plutôt
    // que d'écraser un fichier.
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

  // Les champs dont la saisie ne bascule pas la fiche en mode convention.
  // `uuid` y était déjà ; les deux autres s'y ajoutent parce que ce sont
  // précisément ceux du **nom libre** — les taper pour se voir renvoyer au mode
  // convention serait absurde. La liste reste sinon celle du Libre, sans
  // retrait : son comportement ne change pas.
  const NAMING_NEUTRAL_FIELDS = ['uuid', 'namingMode', 'legacyExportName'];

  function updateField(field, value) {
    setDraft((current) => ({
      ...current,
      // Côté graphe, un champ vidé reste vide : il repartira en « absent ».
      // Le replier sur 1 en ferait une valeur d'auteur que personne n'a posée.
      [field]: field === 'version' && !isAdvanced ? normalizeVersion(value) : value,
      namingMode: namingChosen || NAMING_NEUTRAL_FIELDS.includes(field)
        ? current.namingMode
        : ARCHIVE_NAMING_CONVENTION,
    }));
  }

  function chooseNamingMode(mode) {
    setNamingChosen(true);
    setDraft((current) => ({ ...current, namingMode: mode }));
  }

  function regenerateUuid() {
    updateField('uuid', generateUuid());
  }

  function updateAge(value) {
    updateField('minAge', String(value || '').replace(/\D/g, ''));
  }

  async function submit(kind) {
    // La proposition de régénération d'UUID (nouvelle révision d'un pack importé)
    // est gérée en amont de la génération dans App.jsx (handleSavePackMetadata),
    // via un dialogue in-app awaitable — pour qu'elle soit résolue AVANT l'ouverture
    // du sélecteur de dossier de sortie (dialogue natif OS qui passerait devant).
    // Côté graphe, le brouillon part **tel quel** : c'est `packMetadataModel`
    // qui compare au document et n'envoie que les champs réellement changés.
    // Le passer par le normaliseur Libre y poserait un âge et une version que
    // le document ne porte pas.
    const payload = isAdvanced
      ? {
          // Ce que porte le document, et que seul un geste d'auteur écrit.
          title: draft.title,
          description: draft.description,
          version: draft.version,
          uuid: draft.uuid,
          // Ce qui ne compose que le nom du fichier, et vit dans l'enveloppe du
          // projet. Séparé du reste parce que l'appelant l'écrit autrement :
          // aucun geste, aucune entrée dans le pack.
          naming: archiveNamingFields(normalizeDraft(draft)),
        }
      : normalizeDraft(draft);
    // La vignette ne part que si elle a changé : un enregistrement sans rapport
    // ne réécrit pas l'image du catalogue.
    if (catalogEditable && catalogDraft !== (catalogImage ?? null)) payload.catalogImage = catalogDraft;
    setSaving(kind);
    setNotice(null);
    // Une graphie que les passerelles ne liraient pas est refusée ici, avec sa
    // raison, plutôt qu'à l'export. La fiche reste ouverte avec sa saisie.
    const identityRefusal = await packIdentityRefusal(draft.uuid, invoke);
    if (identityRefusal) {
      setNotice(identityRefusal);
      setSaving(null);
      return;
    }
    try {
      if (kind === 'generate') {
        await onSaveAndGenerate?.(payload);
        return;
      }
      const decision = await onSave?.(payload);
      // Côté graphe, `onSave` rend sa décision : la fiche reste ouverte avec sa
      // saisie quand la demande n'a pas abouti, et dit pourquoi. Côté Libre,
      // rien n'est rendu et le comportement ne change pas.
      if (decision?.result === 'kept') setNotice(decision.notice);
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
        : isAdvanced
          // Côté graphe, ce qui bloque est demandé au départ de la production,
          // sur le document courant : la fiche ne peut pas le promettre ici
          // sans tenir un second verdict.
          ? 'Appliquer les métadonnées, vérifier ce qui bloque, puis générer le pack.'
          : 'Appliquer les métadonnées et générer le pack.';

  const modalContent = (
    <div className={`pack-meta-modal${embedded ? ' pack-meta-modal--embedded' : ''}`} onClick={(event) => event.stopPropagation()}>
      <header className="pack-meta-header">
        <span className="pack-meta-header-icon"><Package className="chrome-icon" strokeWidth={2} absoluteStrokeWidth /></span>
        <div className="pack-meta-heading">
          <span className="pack-meta-eyebrow">Métadonnées du pack</span>
          <h2 title={(isAdvanced ? draft.title : exportName) || undefined}>
            {(isAdvanced ? draft.title : exportName) || 'Métadonnées du pack'}
          </h2>
        </div>
        <Button variant="icon" className="modal-close pack-meta-close" onClick={onClose} aria-label="Fermer">×</Button>
      </header>

      <div className="pack-meta-body">
        {catalogEditable ? (
          <aside className="pack-meta-cover-panel pack-meta-cover-panel--editable">
            <span className="pack-meta-cover-label">Vignette catalogue</span>
            <ImageField
              compact
              align="start"
              fieldId="root:thumbnailImage"
              file={shownCover}
              badge="Catalogue · taille libre"
              formatHint="Taille libre : utilisée par STUdio, LuniiQt et les bibliothèques"
              onPick={setCatalogDraft}
              // Retirer revient à l'image racine : il n'y a rien à retirer
              // tant que la vignette la reprend déjà.
              onClear={catalogDraft ? () => setCatalogDraft(null) : undefined}
            />
            <div className="pack-meta-cover-copy">
              <span>
                {catalogDraft
                  ? 'Image propre au catalogue'
                  : fallbackImage
                    ? (isAdvanced ? "Reprend l'image de l'Écran racine" : "Reprend l'image du menu racine")
                    : 'Aucune image : choisis-en une, ou définis l’image racine'}
              </span>
            </div>
          </aside>
        ) : (
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
        )}

        <section className="pack-meta-form">
          <div className="pack-meta-field-row">
            <label>Titre du pack</label>
            <input className="pack-meta-input" value={draft.title || ''} onChange={(event) => updateField('title', event.target.value)} placeholder="Titre de mon pack" />
          </div>

          {/* Le mode de nommage, offert des deux côtés. C'est lui
              qui rend les quatre combinaisons atteignables : nommer par
              convention ou librement, croisé avec versionner ou non. */}
          <div className="pack-meta-field-row">
            <label>Nom du fichier</label>
            <div className="pack-meta-naming-modes" role="group" aria-label="Mode de nommage du fichier exporté">
              <button
                type="button"
                className={`pack-meta-age-chip ${namingMode === ARCHIVE_NAMING_CONVENTION ? 'is-active' : ''}`}
                onClick={() => chooseNamingMode(ARCHIVE_NAMING_CONVENTION)}
              >
                Convention
              </button>
              <button
                type="button"
                className={`pack-meta-age-chip ${namingMode === ARCHIVE_NAMING_FREE ? 'is-active' : ''}`}
                onClick={() => chooseNamingMode(ARCHIVE_NAMING_FREE)}
              >
                Nom libre
              </button>
            </div>
          </div>

          {namingMode === ARCHIVE_NAMING_FREE ? (
            <div className="pack-meta-field-row">
              <label>Nom libre</label>
              <input
                className="pack-meta-input"
                value={draft.legacyExportName || ''}
                onChange={(event) => updateField('legacyExportName', event.target.value)}
                placeholder={draft.title ? `${draft.title} (par défaut)` : 'Laisse vide pour utiliser le titre'}
              />
            </div>
          ) : (
            <>
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
            <label>Producteur <span>facultatif</span></label>
            <input className="pack-meta-input" value={draft.producer || ''} onChange={(event) => updateField('producer', event.target.value)} placeholder="Ex. producteur..." />
          </div>

          <div className="pack-meta-field-row">
            <label>Bonus <span>facultatif</span></label>
            <input className="pack-meta-input" value={draft.bonus || ''} onChange={(event) => updateField('bonus', event.target.value)} placeholder="ex. 8 chapitres" />
          </div>
            </>
          )}

          {/* La version entre dans le pack — c'est le document qui la porte —
              **et** dans le nom de convention. Elle n'appartient donc pas au
              bloc du mode de nommage : elle reste visible quel que soit le
              mode. */}
          <div className="pack-meta-field-row">
            <label>Version</label>
            {isAdvanced ? (
              <div className="pack-meta-uuid-control">
                <input
                  className="pack-meta-input pack-meta-version-input"
                  type="number"
                  min="1"
                  value={draft.version ?? ''}
                  readOnly={!governance.version.editable}
                  disabled={!governance.version.editable}
                  placeholder="Non renseignée"
                  onChange={(event) => updateField('version', event.target.value)}
                />
                {governance.version.reason ? (
                  <span className="pack-meta-uuid-hint">{governance.version.reason}</span>
                ) : null}
              </div>
            ) : (
              <input className="pack-meta-input pack-meta-version-input" type="number" min="1" value={draft.version || 1} onChange={(event) => updateField('version', event.target.value)} />
            )}
          </div>

          <div className="pack-meta-field-row is-textarea">
            <label>Description <span>changelog</span></label>
            <textarea className="pack-meta-input pack-meta-textarea" value={draft.description || ''} onChange={(event) => updateField('description', event.target.value)} rows={3} placeholder="Public visé, contenu, changements depuis la version précédente..." />
          </div>

          <div className="pack-meta-field-row">
            <label>UUID du pack</label>
            <div className="pack-meta-uuid-control">
              <input
                className="pack-meta-input pack-meta-uuid-input"
                value={draft.uuid || ''}
                onChange={(event) => updateField('uuid', event.target.value)}
                readOnly={isAdvanced && !governance.uuid.editable}
                disabled={isAdvanced && !governance.uuid.editable}
                placeholder="UUID du pack"
              />
              {/* La même action est offerte dans les deux éditeurs. */}
              {isAdvanced && !governance.uuid.editable ? null : (
                <Tooltip text="Générer un nouvel UUID de pack" wrap>
                  <Button variant="icon" className="pack-meta-uuid-button" onClick={regenerateUuid} aria-label="Générer un nouvel UUID de pack">
                    <RotateCcw className="chrome-icon" strokeWidth={2} absoluteStrokeWidth />
                  </Button>
                </Tooltip>
              )}
            </div>
          </div>
          <div className="pack-meta-field-row">
            <span />
            <p className="pack-meta-uuid-hint">Un nouvel UUID permet de conserver ce pack et l'ancien comme deux packs distincts.</p>
          </div>
          {isAdvanced && governance.uuid.reason ? (
            <div className="pack-meta-field-row">
              <span />
              <p className="pack-meta-uuid-hint">{governance.uuid.reason}</p>
            </div>
          ) : null}
          {showImportedUuidHint ? (
            <div className="pack-meta-field-row">
              <span />
              <p className="pack-meta-uuid-hint">UUID importé du pack. Tu peux le régénérer si tu le souhaites.</p>
            </div>
          ) : null}
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
        {/* Le nom reste un aperçu : le moteur l'assainit et peut ajouter -2. */}
        <div className="pack-meta-filename" title={exportName ? `${exportName}.zip` : ''}>
          {tokens.map((token, index) => (
            <span key={`${token.kind}-${index}-${token.text}`} className={`pack-meta-token is-${token.kind}`}>{token.text}</span>
          ))}
        </div>
      </div>

      <footer className="pack-meta-footer">
        {/* Les compteurs comptent ce que **cette** structure porte. Un projet
            graphe n'a pas d'arbre : y compter des histoires afficherait zéro
            pour la mauvaise raison. */}
        {isAdvanced ? (
          <div className="pack-meta-summary">
            {advanced.counters ? (
              <>
                <strong>{advanced.counters.stages}</strong> Écran{advanced.counters.stages > 1 ? 's' : ''}
                <span>
                  {advanced.counters.actions} liste{advanced.counters.actions > 1 ? 's' : ''} de choix
                  {' · '}
                  {advanced.counters.options} option{advanced.counters.options > 1 ? 's' : ''}
                  {' · '}
                  {advanced.counters.media} média{advanced.counters.media > 1 ? 's' : ''} lié{advanced.counters.media > 1 ? 's' : ''}
                </span>
              </>
            ) : (
              <span>Structure en cours de lecture</span>
            )}
          </div>
        ) : (
          <div className="pack-meta-summary">
            <strong>{stats.stories}</strong> histoire{stats.stories > 1 ? 's' : ''}
            <span>{stats.media} média{stats.media > 1 ? 's' : ''} lié{stats.media > 1 ? 's' : ''}</span>
          </div>
        )}
        {notice ? (
          <p className="pack-meta-notice" role="status" aria-live="polite">{notice}</p>
        ) : null}
        <div className="pack-meta-actions">
          <Button onClick={onClose} disabled={saving}>Annuler</Button>
          <Button
            onClick={() => submit('save')}
            disabled={saving}
          >
            {saving === 'save' ? 'Application...' : 'Appliquer'}
          </Button>
          {/* Ce bouton est là **des deux côtés** : la fiche est la première
              étape du parcours de fabrication. Ce qui bloque est
              demandé juste après, au départ de la production. */}
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
  );

  if (embedded) return modalContent;

  return (
    <div className="modal-overlay pack-meta-overlay" onClick={onClose}>
      {modalContent}
    </div>
  );
}
