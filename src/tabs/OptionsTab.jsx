import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Toggle } from '../components/common/Toggle';
import { KeyboardShortcutsModal } from '../components/StorySettingsModal/KeyboardShortcutsModal';
import { pickComfyWorkflowApiJson, pickComfyWorkflowConfigJson } from '../hooks/useFileDialog';
import { THEME_OPTIONS } from '../store/themePreference';
import { isTauriRuntime } from '../utils/tauriRuntime';
import './OptionsTab.css';

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

const LANGUAGE_OPTIONS = [
  { value: 'fr', label: 'Francais' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Espanol' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Portugues' },
];

const OPTION_GROUPS = [
  {
    label: 'Général',
    items: [
      { id: 'save', label: 'Sauvegarde' },
      { id: 'interface', label: 'Interface' },
      { id: 'projects-media', label: 'Projets et médias' },
    ],
  },
  {
    label: 'Intelligence artificielle',
    items: [
      { id: 'xtts', label: 'Voix locale' },
      { id: 'comfyui', label: 'Images IA' },
    ],
  },
  {
    label: 'Avancé',
    items: [
      { id: 'diagnostic', label: 'Diagnostic' },
    ],
  },
];

const OPTION_SECTION_IDS = OPTION_GROUPS.flatMap((group) => group.items.map((item) => item.id));

export function OptionsTab({
  copyFilesEnabled,
  onCopyFilesChange,
  workspaceDir,
  onPickWorkspaceDir,
  onConsolidateProject,
  autoSaveEnabled,
  onAutoSaveChange,
  autoSaveBackupLimit,
  onAutoSaveBackupLimitChange,
  themePreference,
  onThemePreferenceChange,
  xttsSettings,
  onUpdateXttsSettings,
  sdSettings,
  onUpdateSdSettings,
  keyboardShortcuts,
  onUpdateKeyboardShortcuts,
  onBackToHome,
  showCentralDiagram,
  onShowCentralDiagramChange,
  verboseLogging = false,
  onVerboseLoggingChange = null,
  onCopyLogPath = null,
  onResolveLogPath = null,
  project = null,
  savePath = null,
  asModal = false,
  onClose = null,
}) {
  const [xttsProbe, setXttsProbe] = useState({ state: 'idle', message: '' });
  const [sdProbe, setSdProbe] = useState({ state: 'idle', message: '' });
  const [sdWorkflows, setSdWorkflows] = useState([]);
  const [importApiPath, setImportApiPath] = useState(null);
  const [importConfigPath, setImportConfigPath] = useState(null);
  const [importing, setImporting] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [consolidationResult, setConsolidationResult] = useState(null);
  const [xttsVoices, setXttsVoices] = useState([]);
  const [xttsVoicesLoaded, setXttsVoicesLoaded] = useState(false);
  const [xttsLogs, setXttsLogs] = useState([]);
  const [copiedLogPath, setCopiedLogPath] = useState(null);
  const [resolvedLogPath, setResolvedLogPath] = useState('');
  const [activeSectionId, setActiveSectionId] = useState(OPTION_SECTION_IDS[0]);
  const screenRef = useRef(null);
  const sectionRefs = useRef({});
  const favoriteVoices = Array.isArray(xttsSettings.favoriteVoices) ? xttsSettings.favoriteVoices : [];

  useEffect(() => {
    let cancelled = false;
    if (!onResolveLogPath) return undefined;
    onResolveLogPath().then((path) => {
      if (!cancelled && path) setResolvedLogPath(path);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [onResolveLogPath]);

  async function handleCopyLogPathClick() {
    if (!onCopyLogPath) return;
    const file = await onCopyLogPath();
    if (file) {
      setCopiedLogPath(file);
      setTimeout(() => setCopiedLogPath(null), 2200);
    }
  }

  useEffect(() => {
    if (!isTauriRuntime()) return;

    invoke('comfyui_list_workflows')
      .then(setSdWorkflows)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;

    let cancelled = false;
    let unlisten = null;
    listen('xtts-log', (event) => {
      if (cancelled) return;
      setXttsLogs((prev) => [...prev, String(event.payload)].slice(-60));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }).catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  async function handleTestSd() {
    const launching = sdSettings?.autoStart && sdSettings?.batPath;
    setSdProbe({
      state: 'loading',
      message: launching ? 'Démarrage de ComfyUI en cours… (peut prendre jusqu\'à 60s)' : 'Connexion à ComfyUI en cours…',
    });
    try {
      await invoke('comfyui_check', { settings: sdSettings });
      setSdProbe({ state: 'ok', message: 'ComfyUI accessible et prêt.' });
    } catch (e) {
      setSdProbe({ state: 'error', message: String(e) });
    }
  }

  async function handlePickApiJson() {
    const result = await pickComfyWorkflowApiJson();
    if (result) setImportApiPath(result);
  }

  async function handlePickConfigJson() {
    const result = await pickComfyWorkflowConfigJson();
    if (result) setImportConfigPath(result);
  }

  async function handleImportWorkflow() {
    if (!importApiPath || !importConfigPath) return;
    setImporting(true);
    try {
      const wf = await invoke('comfyui_import_workflow', {
        apiJsonPath: importApiPath,
        configJsonPath: importConfigPath,
      });
      setSdWorkflows(prev => [...prev.filter(w => w.id !== wf.id), wf]);
      setImportApiPath(null);
      setImportConfigPath(null);
    } catch (e) {
      setSdProbe({ state: 'error', message: `Import échoué : ${e}` });
    } finally {
      setImporting(false);
    }
  }

  async function handleDeleteWorkflow(workflowId) {
    try {
      await invoke('comfyui_delete_workflow', { workflowId });
      setSdWorkflows(prev => prev.filter(w => w.id !== workflowId));
    } catch (e) {
      setSdProbe({ state: 'error', message: `Suppression échouée : ${e}` });
    }
  }

  function handleCopyFilesToggle(v) {
    onCopyFilesChange?.(v);
  }

  async function handleConsolidate() {
    setConsolidating(true);
    setConsolidationResult(null);
    try {
      const result = await onConsolidateProject?.();
      if (result) setConsolidationResult(result);
    } finally {
      setConsolidating(false);
    }
  }

  async function handleRefreshXttsVoices() {
    setXttsProbe({ state: 'loading', message: 'Connexion a XTTS en cours…' });
    setXttsLogs([`Test XTTS depuis ${xttsSettings.serverUrl}`]);
    try {
      const status = await invoke('xtts_get_status', { settings: xttsSettings });
      const voices = status.voices || [];
      setXttsVoices(voices);
      setXttsVoicesLoaded(true);
      const voicesLabel = voices.length === 0
        ? 'aucune voix detectee'
        : `${voices.length} voix detectee(s)`;
      const deviceLabel = status.device === 'cuda' ? 'GPU CUDA' : status.device === 'cpu' ? 'CPU' : 'device inconnu';
      setXttsProbe({ state: 'ok', message: `Serveur pret sur ${deviceLabel} • ${voicesLabel}` });
    } catch (e) {
      setXttsProbe({ state: 'error', message: String(e) });
    }
  }

  function handleTestXtts() {
    handleRefreshXttsVoices();
  }

  function handleToggleXttsFavorite(voiceName) {
    const nextFavorites = favoriteVoices.includes(voiceName)
      ? favoriteVoices.filter((voice) => voice !== voiceName)
      : [...favoriteVoices, voiceName];
    onUpdateXttsSettings({ favoriteVoices: nextFavorites });
  }

  function handleClearXttsFavorites() {
    onUpdateXttsSettings({ favoriteVoices: [] });
  }

  useEffect(() => {
    const root = screenRef.current;
    const sections = OPTION_SECTION_IDS
      .map((id) => sectionRefs.current[id])
      .filter(Boolean);
    if (!root || sections.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver((entries) => {
      const visibleEntries = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      const nextId = visibleEntries[0]?.target?.id;
      if (nextId) setActiveSectionId(nextId);
    }, {
      root,
      rootMargin: '-12% 0px -70% 0px',
      threshold: [0, 0.1, 0.35, 0.6],
    });

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [asModal]);

  function scrollToSection(sectionId) {
    sectionRefs.current[sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSectionId(sectionId);
  }

  function renderSectionNav() {
    return (
      <nav className="opts-nav" aria-label="Sections des préférences">
        {OPTION_GROUPS.map((group) => (
          <div className="opts-nav-group" key={group.label}>
            <div className="opts-nav-group-title">{group.label}</div>
            <div className="opts-nav-items">
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`opts-nav-item${activeSectionId === item.id ? ' is-active' : ''}`}
                  onClick={() => scrollToSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
    );
  }

  const content = (
    <div className={`opts-screen${asModal ? ' is-modal' : ''}`} ref={screenRef}>
        {onBackToHome && (
          <div className="opts-back-row">
            <button className="btn" onClick={onBackToHome}>
              Retour à l'accueil
            </button>
          </div>
        )}
        <div className="opts-layout">
          {renderSectionNav()}
          <div className="opts-content">
        <section
          id="save"
          className="opts-card"
          ref={(node) => { sectionRefs.current.save = node; }}
        >
          <div className="opts-card-title">Sauvegarde</div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Sauvegarde automatique</div>
              <div className="opts-row-sub">Sauvegarde automatiquement toutes les 5 minutes si des modifications sont en attente (uniquement si déjà enregistré sur disque)</div>
            </div>
            <Toggle on={autoSaveEnabled} onChange={onAutoSaveChange} />
          </div>
          {autoSaveEnabled && (
            <div className="opts-row">
              <div className="opts-row-info">
                <div className="opts-row-label">Versions de sécurité</div>
                <div className="opts-row-sub">Nombre de copies `.mbah` conservées avant chaque sauvegarde automatique.</div>
              </div>
              <input
                className="xtts-input opts-number"
                type="number"
                min="0"
                max="50"
                value={autoSaveBackupLimit}
                onChange={(event) => onAutoSaveBackupLimitChange?.(Math.max(0, Math.min(50, Number(event.target.value) || 0)))}
              />
            </div>
          )}
          <div className="opts-help">
            Raccourcis : <strong>Ctrl+S</strong> pour sauvegarder, <strong>Ctrl+Maj+S</strong> pour sauvegarder sous
          </div>
        </section>

        <section
          id="interface"
          className="opts-card"
          ref={(node) => { sectionRefs.current.interface = node; }}
        >
          <div className="opts-card-title">Interface</div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Thème</div>
              <div className="opts-row-sub">Système suit l'apparence configurée dans Windows/macOS</div>
            </div>
            <select
              className="xtts-input opts-select"
              value={themePreference}
              onChange={(event) => onThemePreferenceChange?.(event.target.value)}
            >
              {THEME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Raccourcis clavier</div>
              <div className="opts-row-sub">Voir et modifier les raccourcis de l'application</div>
            </div>
            <button className="btn" type="button" onClick={() => setShortcutsOpen(true)}>
              Modifier
            </button>
          </div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Diagramme condensé dans le panneau central</div>
              <div className="opts-row-sub">Affiche la structure du pack sous le formulaire d'édition (désactivé par défaut)</div>
            </div>
            <Toggle on={!!showCentralDiagram} onChange={onShowCentralDiagramChange} />
          </div>
        </section>

        <section
          id="projects-media"
          className="opts-card"
          ref={(node) => { sectionRefs.current['projects-media'] = node; }}
        >
          <div className="opts-card-title">Gestion des projets et médias</div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Emplacement de travail</div>
              <div className="opts-row-sub">
                Les médias importés, enregistrés ou générés sont regroupés ici par défaut.
              </div>
              <div className="opts-path-value" title={workspaceDir || ''}>
                {workspaceDir || 'Initialisation...'}
              </div>
            </div>
            <button className="btn" type="button" onClick={onPickWorkspaceDir}>
              Choisir
            </button>
          </div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Copier les fichiers importés dans l’emplacement de travail</div>
              <div className="opts-row-sub">
                Copie chaque fichier importé (ZIP, 7z, audio, image) dans <strong>Workspace/fichiers-importes/</strong>.
              </div>
            </div>
            <Toggle on={copyFilesEnabled} onChange={handleCopyFilesToggle} />
          </div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Consolider le projet</div>
              <div className="opts-row-sub">
                Copie le `.mbah` et tous les médias référencés dans un dossier cible, sans supprimer les originaux.
              </div>
            </div>
            <button className="btn" type="button" onClick={handleConsolidate} disabled={consolidating || !project}>
              {consolidating ? 'Consolidation...' : 'Consolider'}
            </button>
          </div>
          {consolidationResult && (
            <div className={`info-box info-box--spaced ${consolidationResult.errors?.length ? 'warn' : ''}`}>
              Projet consolidé : {consolidationResult.copiedCount} média(s) copié(s)
              {consolidationResult.errors?.length ? `, ${consolidationResult.errors.length} fichier(s) manquant(s).` : '.'}
            </div>
          )}
        </section>

        <section
          id="xtts"
          className="opts-card"
          ref={(node) => { sectionRefs.current.xtts = node; }}
        >
          <div className="opts-card-title">Generation de voix locale — XTTS</div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Activer la generation de voix</div>
              <div className="opts-row-sub">
                Ajoute un bouton texte → audio dans tous les champs audio de Story Studio.
              </div>
            </div>
            <Toggle on={xttsSettings.enabled} onChange={(v) => onUpdateXttsSettings({ enabled: v })} />
          </div>

          {xttsSettings.enabled && (
            <div className="xtts-settings">
              <div className="xtts-grid">
                <label className="xtts-label">
                  URL du serveur XTTS
                  <input
                    className="xtts-input"
                    value={xttsSettings.serverUrl}
                    onChange={(e) => onUpdateXttsSettings({ serverUrl: e.target.value })}
                    placeholder="http://127.0.0.1:8020"
                  />
                </label>

                <label className="xtts-label">
                  Dossier XTTS
                  <input
                    className="xtts-input"
                    value={xttsSettings.xttsDir}
                    onChange={(e) => onUpdateXttsSettings({ xttsDir: e.target.value })}
                    placeholder="C:\\chemin\\vers\\XTTS"
                  />
                </label>

                <label className="xtts-label">
                  Langue par defaut
                  <select
                    className="xtts-input"
                    value={xttsSettings.language}
                    onChange={(e) => onUpdateXttsSettings({ language: e.target.value })}
                  >
                    {LANGUAGE_OPTIONS.map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="opts-row opts-row--pt">
                <div className="opts-row-info">
                  <div className="opts-row-label">Demarrer XTTS automatiquement si le serveur est arrete</div>
                  <div className="opts-row-sub">
                    Story Studio lancera `server.py` depuis ton dossier XTTS si besoin.
                  </div>
                </div>
                <Toggle on={xttsSettings.autoStart} onChange={(v) => onUpdateXttsSettings({ autoStart: v })} />
              </div>

              <div className="opts-row opts-row--pt">
                <div className="opts-row-info">
                  <div className="opts-row-label">Forcer le CPU (compatible ComfyUI simultané)</div>
                  <div className="opts-row-sub">
                    XTTS s'exécute sur CPU — plus lent (~3×) mais libère le GPU pour ComfyUI.
                  </div>
                </div>
                <Toggle on={xttsSettings.forceCpu} onChange={(v) => onUpdateXttsSettings({ forceCpu: v })} />
              </div>

              <div className="xtts-actions">
                <button className="btn" onClick={handleTestXtts} disabled={xttsProbe.state === 'loading'}>
                  {xttsProbe.state === 'loading' ? 'Test en cours…' : 'Tester et actualiser les voix'}
                </button>
                <span className="opts-row-sub">
                  {favoriteVoices.length > 0
                    ? `${favoriteVoices.length} voix favorite(s) affichee(s) dans le modal.`
                    : 'Aucune favorite : toutes les voix XTTS detectees seront proposees.'}
                </span>
              </div>

              {xttsProbe.state !== 'idle' && (
                <div className={`info-box ${xttsProbe.state === 'error' ? 'warn' : ''}`}>
                  {xttsProbe.message}
                </div>
              )}

              {xttsLogs.length > 0 && (
                <div className="xtts-log-panel" aria-label="Journal XTTS">
                  {xttsLogs.map((line, index) => (
                    <div key={`${index}-${line}`} className="xtts-log-line">{line}</div>
                  ))}
                </div>
              )}

              <div className="xtts-voices-panel">
                <div className="xtts-voices-header">
                  <div>
                    <div className="opts-row-label">Voix favorites</div>
                    <div className="opts-row-sub">
                      Coche uniquement les voix que tu veux voir dans le modal de generation.
                    </div>
                  </div>
                  <button className="btn" onClick={handleClearXttsFavorites} disabled={favoriteVoices.length === 0}>
                    Tout afficher
                  </button>
                </div>

                {!xttsVoicesLoaded ? (
                  <div className="xtts-voices-empty">
                    Actualise les voix XTTS pour choisir tes favorites.
                  </div>
                ) : xttsVoices.length === 0 ? (
                  <div className="xtts-voices-empty">
                    Aucune voix retournee par XTTS.
                  </div>
                ) : (
                  <div className="xtts-voice-list">
                    {xttsVoices.map((voiceName) => (
                      <label key={voiceName} className="xtts-voice-item">
                        <input
                          type="checkbox"
                          checked={favoriteVoices.includes(voiceName)}
                          onChange={() => handleToggleXttsFavorite(voiceName)}
                        />
                        <span>{voiceName}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        <section
          id="comfyui"
          className="opts-card"
          ref={(node) => { sectionRefs.current.comfyui = node; }}
        >
          <div className="opts-card-title">Génération d'images IA — ComfyUI</div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Activer la génération d'images IA</div>
              <div className="opts-row-sub">
                Ajoute un bouton ✨ Générer IA sous chaque image dans l'éditeur.
              </div>
            </div>
            <Toggle on={sdSettings?.aiImageGen} onChange={(v) => onUpdateSdSettings?.({ aiImageGen: v })} />
          </div>

          {sdSettings?.aiImageGen && (
            <div className="xtts-settings">
              <div className="xtts-grid">
                <label className="xtts-label">
                  URL du serveur ComfyUI
                  <input
                    className="xtts-input"
                    value={sdSettings?.serverUrl ?? ''}
                    onChange={(e) => onUpdateSdSettings?.({ serverUrl: e.target.value })}
                    placeholder="http://127.0.0.1:8188"
                  />
                </label>
                <label className="xtts-label">
                  Fichier de démarrage (.bat)
                  <input
                    className="xtts-input"
                    value={sdSettings?.batPath ?? ''}
                    onChange={(e) => onUpdateSdSettings?.({ batPath: e.target.value })}
                    placeholder="C:\chemin\vers\start_comfyui.bat"
                  />
                </label>
              </div>

              <div className="opts-row opts-row--pt">
                <div className="opts-row-info">
                  <div className="opts-row-label">Démarrer ComfyUI automatiquement</div>
                  <div className="opts-row-sub">
                    Lance le fichier .bat si ComfyUI ne répond pas au moment de générer.
                  </div>
                </div>
                <Toggle on={sdSettings?.autoStart} onChange={(v) => onUpdateSdSettings?.({ autoStart: v })} />
              </div>

              <div className="xtts-actions">
                <button className="btn" onClick={handleTestSd} disabled={sdProbe.state === 'loading'}>
                  {sdProbe.state === 'loading'
                    ? (sdSettings?.autoStart && sdSettings?.batPath ? 'Démarrage…' : 'Test en cours…')
                    : 'Tester ComfyUI'}
                </button>
              </div>

              {sdProbe.state !== 'idle' && (
                <div className={`info-box ${sdProbe.state === 'error' ? 'warn' : ''}`}>
                  {sdProbe.message}
                </div>
              )}

              {/* Gestion des workflows */}
              <div className="sd-workflows-section">
                <div className="opts-row-label" style={{ marginBottom: 8 }}>Workflows disponibles</div>
                {sdWorkflows.length === 0 ? (
                  <div className="opts-row-sub">Aucun workflow chargé.</div>
                ) : (
                  <div className="sd-workflow-list">
                    {sdWorkflows.map(wf => (
                      <div key={wf.id} className="sd-workflow-item">
                        <div>
                          <span className="sd-workflow-item-name">{wf.name}</span>
                          {!wf.isCustom && <span className="sd-workflow-item-tag">intégré</span>}
                        </div>
                        {wf.isCustom && (
                          <button
                            className="btn-xs"
                            onClick={() => handleDeleteWorkflow(wf.id)}
                          >
                            Supprimer
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                <div className="sd-import-section">
                  <div className="opts-row-label" style={{ marginBottom: 6 }}>Importer un workflow custom</div>
                  <div className="sd-import-row">
                    <button className="btn btn-xs" onClick={handlePickApiJson}>
                      {importApiPath ? '✓ API JSON' : 'Choisir *-api.json…'}
                    </button>
                    <button className="btn btn-xs" onClick={handlePickConfigJson}>
                      {importConfigPath ? '✓ Config JSON' : 'Choisir *.config.json…'}
                    </button>
                    <button
                      className="btn btn-xs btn-primary"
                      onClick={handleImportWorkflow}
                      disabled={!importApiPath || !importConfigPath || importing}
                    >
                      {importing ? 'Import…' : 'Importer'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <section
          id="diagnostic"
          className="opts-card"
          ref={(node) => { sectionRefs.current.diagnostic = node; }}
        >
          <div className="opts-card-title">Diagnostic</div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Journalisation détaillée</div>
              <div className="opts-row-sub">
                Enregistre les événements normaux (chargements, sauvegardes, générations) dans le fichier de log,
                en plus des erreurs. Utile pour partager le contexte d'un bug dans une issue GitHub.
                Désactivé : seuls les avertissements et erreurs sont enregistrés.
              </div>
            </div>
            <Toggle on={!!verboseLogging} onChange={onVerboseLoggingChange} />
          </div>
          <div className="opts-row">
            <div className="opts-row-info">
              <div className="opts-row-label">Dossier des logs</div>
              <div className="opts-row-sub">
                {resolvedLogPath ? (
                  <><code>{resolvedLogPath}</code> — fichier courant : <code>story-studio.log</code></>
                ) : (
                  <>Sous <code>%LOCALAPPDATA%\com.hugs11.story-studio\logs\</code>. Fichier courant : <code>story-studio.log</code>.</>
                )}
                {copiedLogPath ? (
                  <span style={{ color: 'var(--color-accent)', marginLeft: 6 }}>(copié)</span>
                ) : null}
              </div>
            </div>
            <button className="btn" type="button" onClick={handleCopyLogPathClick} disabled={!onCopyLogPath} style={{ flexShrink: 0 }}>
              Copier le chemin
            </button>
          </div>
          <div className="opts-help">
            Le fichier peut contenir des chemins locaux (noms de fichiers, dossier utilisateur). Vérifie son contenu avant de le partager publiquement.
          </div>
        </section>

          </div>
        </div>
      </div>
  );

  if (asModal) {
    return (
      <>
        <div className="modal-overlay" onClick={onClose}>
          <div className="modal-box opts-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>Préférences</span>
              <button className="btn btn-icon modal-close" type="button" onClick={onClose}>×</button>
            </div>
            {content}
          </div>
        </div>
        {shortcutsOpen && (
          <KeyboardShortcutsModal
            shortcuts={keyboardShortcuts}
            onChange={onUpdateKeyboardShortcuts}
            onClose={() => setShortcutsOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="screen visible">
      {content}
      {shortcutsOpen && (
        <KeyboardShortcutsModal
          shortcuts={keyboardShortcuts}
          onChange={onUpdateKeyboardShortcuts}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
    </div>
  );
}
