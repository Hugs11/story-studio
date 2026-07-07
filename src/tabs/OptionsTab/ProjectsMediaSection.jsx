import { useState } from 'react';
import { Button } from '../../components/common/Button';
import { Toggle } from '../../components/common/Toggle';

export function ProjectsMediaSection({
  className,
  sectionRef,
  useWorkspaceForNewProjects,
  onUseWorkspaceForNewProjectsChange,
  displayedWorkspaceDir,
  onPickWorkspaceDir,
  copyFilesEnabled,
  onCopyFilesChange,
  onConsolidateProject,
  project,
}) {
  const [consolidating, setConsolidating] = useState(false);
  const [consolidationResult, setConsolidationResult] = useState(null);

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

  return (
    <section id="projects-media" className={className} ref={sectionRef}>
      <div className="opts-card-title">Gestion des projets et médias</div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Utiliser un workspace pour les nouveaux projets</div>
          <div className="opts-row-sub">
            Désactivé par défaut : les nouveaux projets commencent dans une session temporaire, sans emplacement imposé.
          </div>
        </div>
        <Toggle on={!!useWorkspaceForNewProjects} onChange={onUseWorkspaceForNewProjectsChange} />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Emplacement de travail</div>
          <div className="opts-row-sub">
            Emplacement de référence pour les projets enregistrés et les médias gérés.
          </div>
          <div className="opts-path-value" title={displayedWorkspaceDir || ''}>
            {displayedWorkspaceDir || 'Workspace en cours de résolution...'}
          </div>
        </div>
        <Button onClick={onPickWorkspaceDir}>
          Choisir
        </Button>
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Copier les fichiers importés dans l’emplacement de travail</div>
          <div className="opts-row-sub">
            Copie chaque fichier importé (ZIP, 7z, audio, image) dans <strong>Workspace/fichiers-importes/</strong>.
          </div>
        </div>
        <Toggle on={copyFilesEnabled} onChange={(v) => onCopyFilesChange?.(v)} />
      </div>
      <div className="opts-row">
        <div className="opts-row-info">
          <div className="opts-row-label">Consolider le projet</div>
          <div className="opts-row-sub">
            Copie le `.mbah` et tous les médias référencés dans un dossier cible, sans supprimer les originaux.
          </div>
        </div>
        <Button onClick={handleConsolidate} disabled={consolidating || !project}>
          {consolidating ? 'Consolidation...' : 'Consolider'}
        </Button>
      </div>
      {consolidationResult && (
        <div className={`info-box info-box--spaced ${consolidationResult.errors?.length ? 'warn' : ''}`}>
          Projet consolidé : {consolidationResult.copiedCount} média(s) copié(s)
          {consolidationResult.errors?.length ? `, ${consolidationResult.errors.length} fichier(s) manquant(s).` : '.'}
        </div>
      )}
    </section>
  );
}
