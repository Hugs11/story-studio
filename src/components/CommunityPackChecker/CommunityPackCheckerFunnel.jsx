import { useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  FunnelDoneState,
  FunnelDropZone,
  FunnelFooter,
  FunnelGenerationState,
  FunnelSectionHeader,
  FunnelShell,
  FunnelStepper,
  FunnelToolButton,
} from '../funnels';
import { CommunityPackMetadataModal } from './CommunityPackMetadataModal';
import {
  ProcessLog,
  ReportView,
  TechnicalLog,
  titleNeedsCorrection,
} from './CommunityPackChecker';
import { useCommunityPackChecker } from './useCommunityPackChecker';
import { Download, FolderOpen, House, Package, TriangleAlert, Wrench } from '../icons/LucideLocal';
import { getLastExportDir, saveLastExportDir } from '../../hooks/useFileDialog';
import { basename } from '../../utils/fileUtils';
import './CommunityPackChecker.css';
import './CommunityPackCheckerFunnel.css';

const STEPS = [
  { key: 'pack', label: 'Pack' },
  { key: 'report', label: 'Rapport' },
  { key: 'output', label: 'Correction' },
];

function latestLine(lines) {
  return lines?.length ? lines[lines.length - 1] : '';
}

function correctionCount(result) {
  if (!result) return '';
  const parts = [];
  if (result.audioFixed) parts.push(`${result.audioFixed} audio`);
  if (result.imageFixed) parts.push(`${result.imageFixed} image${result.imageFixed > 1 ? 's' : ''}`);
  if (result.metadataFixed) parts.push('métadonnées');
  return parts.length ? parts.join(' · ') : 'Pack corrigé';
}

export function CommunityPackCheckerFunnel({ onClose }) {
  const checker = useCommunityPackChecker();
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState('collect');
  const [outputDir, setOutputDir] = useState(() => getLastExportDir() || '');
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [localError, setLocalError] = useState('');

  const busy = phase === 'analyzing' || phase === 'fixing' || checker.status === 'analyzing' || checker.status === 'fixing';
  const canFix = useMemo(() => (
    (checker.report?.correctionsAvailable > 0 || titleNeedsCorrection(checker.report))
    && !busy
  ), [checker.report, busy]);
  const needsMetadata = titleNeedsCorrection(checker.report);
  const canOpenReport = !!checker.report;
  const canOpenCorrection = canOpenReport && canFix;
  const error = localError || checker.error;

  async function analyzePath(path) {
    const selected = String(path || '').trim();
    if (!selected) return;
    setLocalError('');
    setResult(null);
    setPhase('analyzing');
    const report = await checker.analyzePath(selected);
    setPhase('collect');
    if (report) setStep(1);
  }

  async function pickPack() {
    const selected = await openDialog({
      multiple: false,
      title: 'Pack ZIP à vérifier',
      filters: [{ name: 'Pack Lunii ZIP', extensions: ['zip'] }],
    });
    if (selected) await analyzePath(Array.isArray(selected) ? selected[0] : selected);
  }

  async function pickOutputDir() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: 'Dossier du pack corrigé',
      defaultPath: outputDir || getLastExportDir() || undefined,
    });
    if (selected) {
      setOutputDir(selected);
      saveLastExportDir(selected);
    }
  }

  async function fixPack(metadataPatch = null) {
    if (!outputDir) {
      setLocalError('Choisis un dossier de sortie avant de créer le pack corrigé.');
      return;
    }
    setMetadataOpen(false);
    setLocalError('');
    setPhase('fixing');
    const fixed = await checker.fixPack(metadataPatch, { outputDir });
    setPhase(fixed ? 'done' : 'collect');
    if (fixed) setResult(fixed);
  }

  function handlePrimary() {
    if (step === 0) {
      void (checker.zipPath ? analyzePath(checker.zipPath) : pickPack());
      return;
    }
    if (step === 1) {
      if (!canFix) {
        onClose();
        return;
      }
      setStep(2);
      return;
    }
    if (needsMetadata) setMetadataOpen(true);
    else void fixPack(null);
  }

  function handleStepClick(index) {
    if (index === 0) setStep(0);
    if (index === 1 && canOpenReport) setStep(1);
    if (index === 2 && canOpenCorrection) setStep(2);
  }

  const primaryLabel = step === 0
    ? (checker.zipPath ? 'Analyser' : 'Choisir un ZIP')
    : step === 1
      ? (canFix ? 'Choisir la sortie' : 'Terminer')
      : needsMetadata
        ? 'Renseigner et corriger'
        : 'Créer le pack corrigé';

  return (
    <FunnelShell
      icon={<Wrench />}
      title="Vérifier / corriger un pack"
      subtitle="Analyse un ZIP et crée une version corrigée si besoin."
      onClose={busy ? () => {} : onClose}
      showChrome={phase === 'collect'}
      ariaLabel="Vérifier ou corriger un pack"
      stepper={(
        <FunnelStepper
          steps={STEPS}
          current={step}
          onStepClick={handleStepClick}
        />
      )}
      footer={(
        <FunnelFooter
          onBack={() => setStep(Math.max(0, step - 1))}
          backDisabled={step === 0}
          stepLabel={`Étape ${step + 1} / ${STEPS.length}`}
          onPrimary={handlePrimary}
          primaryLabel={primaryLabel}
          primaryDisabled={busy || (step === 2 && !outputDir)}
        />
      )}
    >
      {phase === 'analyzing' ? (
        <FunnelGenerationState
          title="Analyse du pack…"
          hint={latestLine(checker.liveLog) || 'Lecture du ZIP, des médias et de la structure.'}
        />
      ) : phase === 'fixing' ? (
        <FunnelGenerationState
          title="Correction du pack…"
          hint={latestLine(checker.liveLog) || 'Création du nouveau ZIP corrigé.'}
        />
      ) : phase === 'done' ? (
        <FunnelDoneState
          title="Pack corrigé créé"
          fileName={basename(result?.fixedZipPath) || result?.fixedZipPath}
          meta={correctionCount(result)}
        >
          <button type="button" className="funnel-btn" onClick={() => outputDir && openPath(outputDir)}>
            <FolderOpen />
            Ouvrir le dossier
          </button>
          <button type="button" className="funnel-btn" onClick={() => checker.exportReport('report')}>
            <Download />
            Exporter le rapport
          </button>
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={onClose}>
            <House />
            Terminer
          </button>
        </FunnelDoneState>
      ) : (
        <div className="checker-root pack-checker-funnel">
          {step === 0 ? (
            <div className="funnel-step-content pack-checker-step">
              <FunnelSectionHeader
                icon={<Package />}
                title="Pack à vérifier"
                description="Choisis ou dépose un fichier ZIP. Le fichier source reste intact."
              />
              <FunnelDropZone
                icon={<Package />}
                title="Déposer un pack .zip"
                hint="L'analyse vérifie l'audio, les images, le nom, la structure et le mode nuit."
                disabled={busy}
                onFiles={(paths) => analyzePath(paths?.[0])}
              >
                <button type="button" className="funnel-btn" onClick={pickPack} disabled={busy}>
                  Choisir un ZIP
                </button>
              </FunnelDropZone>
              {checker.zipPath ? (
                <div className="pack-checker-selected" title={checker.zipPath}>
                  <Package />
                  <span>{checker.zipPath}</span>
                </div>
              ) : null}
              <ProcessLog status={checker.status} lines={checker.liveLog} />
              {error ? <div className="funnel-error" role="alert">{error}</div> : null}
            </div>
          ) : step === 1 ? (
            <div className="funnel-step-content pack-checker-step pack-checker-step--report">
              <FunnelSectionHeader
                icon={<TriangleAlert />}
                title="Rapport"
                description="Lis les points conformes, les corrections possibles et les vérifications manuelles."
              />
              {error ? <div className="funnel-error" role="alert">{error}</div> : null}
              <ReportView
                report={checker.report}
                busy={busy}
                canFix={canFix}
                onExportReport={checker.exportReport}
                onFixPack={(metadataPatch) => fixPack(metadataPatch)}
                onStartFix={() => setStep(2)}
              />
              <TechnicalLog
                report={checker.report}
                onCopyLog={checker.copyLog}
                onExportLog={checker.exportReport}
                onExportJson={checker.exportReport}
              />
            </div>
          ) : (
            <div className="funnel-step-content pack-checker-step">
              <FunnelSectionHeader
                icon={<FolderOpen />}
                title="Pack corrigé"
                description="Choisis où créer le nouveau ZIP. Le pack source n'est pas modifié."
              />
              <div className="pack-checker-output">
                <span className="pack-checker-output-icon"><FolderOpen /></span>
                <div className="pack-checker-output-copy">
                  <strong>Dossier de sortie</strong>
                  <span title={outputDir}>{outputDir || 'Aucun dossier sélectionné'}</span>
                </div>
                <button type="button" className="funnel-btn" onClick={pickOutputDir}>
                  Choisir
                </button>
              </div>
              <div className="pack-checker-fix-card">
                <span className="pack-checker-output-icon"><Wrench /></span>
                <div>
                  <strong>{needsMetadata ? 'Métadonnées à confirmer' : 'Corrections automatiques prêtes'}</strong>
                  <p>
                    {needsMetadata
                      ? 'Le nom du pack demande une passe guidée avant de créer le ZIP corrigé.'
                      : "L'audio et les images détectés seront corrigés sans changer les métadonnées."}
                  </p>
                </div>
              </div>
              {checker.exportNotice ? <div className="info-box">{checker.exportNotice}</div> : null}
              {error ? <div className="funnel-error" role="alert">{error}</div> : null}
              <div className="pack-checker-inline-actions">
                <FunnelToolButton icon={<Download />} accent="neutral" onClick={() => checker.exportReport('report')}>
                  Exporter le rapport
                </FunnelToolButton>
                <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={() => outputDir && openPath(outputDir)}>
                  Ouvrir le dossier
                </FunnelToolButton>
              </div>
              {metadataOpen ? (
                <CommunityPackMetadataModal
                  report={checker.report}
                  busy={busy}
                  onCancel={() => setMetadataOpen(false)}
                  onSubmit={(metadataPatch) => fixPack(metadataPatch)}
                />
              ) : null}
            </div>
          )}
        </div>
      )}
    </FunnelShell>
  );
}
