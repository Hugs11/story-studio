import { useEffect, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Tooltip } from '../components/common/Tooltip';
import { ProjectSimulator } from './EmulatorTab/ProjectSimulator';
import { ZipSimulator } from './EmulatorTab/ZipSimulator';
import { revokeUrlCache } from './EmulatorTab/useUrlCache';
import { basename } from '../utils/fileUtils';
import './EmulatorTab.css';

const TRANSFER_TOOLS = [
  { name: 'STUdio', url: 'https://github.com/DantSu/studio' },
  { name: 'LuniiQt', url: 'https://github.com/o-daneel/Lunii.QT' },
];

// ── EmulatorTab ───────────────────────────────────────────────────────────────

export function EmulatorTab({ project, initialZipPath, onConsumeZipPath }) {
  const [mode, setMode] = useState(initialZipPath ? 'zip' : 'project');
  const [zipPath, setZipPath] = useState(initialZipPath ?? null);
  const [zipFromProject, setZipFromProject] = useState(false);

  // Notifier le parent que initialZipPath a été consommé, pour que le prochain
  // montage de l'onglet revienne en mode projet par défaut.
  // reason: signal one-shot au montage, ne doit pas reagir aux changements ulterieurs
  // de initialZipPath / onConsumeZipPath.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (initialZipPath) onConsumeZipPath?.();
  }, []);

  // Révoquer toutes les blob URLs quand l'onglet est démonté
  useEffect(() => () => revokeUrlCache(), []);

  function handleOpenZip(path) {
    setZipPath(path);
    setZipFromProject(true);
    setMode('zip');
  }

  return (
    <div className="screen visible emu-screen">

      {/* Barre de navigation : en mode ZIP, afficher le nom + bouton retour projet */}
      {mode === 'zip' && (
        <div className="emu-mode-bar">
          <Tooltip text="Retour au simulateur projet">
            <button
              className="emu-mode-btn"
              onClick={() => setMode('project')}
            >
              ← Projet
            </button>
          </Tooltip>
          {zipPath && (
            <span className="emu-zip-label">{basename(zipPath)}</span>
          )}
        </div>
      )}

      {/* Simulateur */}
      {mode === 'project'
        ? <ProjectSimulator project={project} onOpenZip={handleOpenZip} />
        : zipPath
          ? <ZipSimulator key={zipPath} zipPath={zipPath} fromProject={zipFromProject} onExit={() => setMode('project')} />
          : null
      }

      <div className="lunii-hint">
        Roue : gauche/droite = naviguer · OK = valider · ⌂ = accueil
      </div>

      <div className="lunii-transfer-card">
        <span className="lunii-transfer-label">Pour transférer sur votre Boîte à Histoires :</span>
        <div className="lunii-transfer-links">
          {TRANSFER_TOOLS.map(t => (
            <button key={t.name} className="lunii-transfer-link" onClick={() => openUrl(t.url)}>
              {t.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
