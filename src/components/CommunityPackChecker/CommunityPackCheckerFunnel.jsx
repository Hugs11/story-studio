import { checkerOutputDirectory } from '../../store/catalogue/duplicateModel.js';
import { TechnicalDetail } from '../common/UserMessage.jsx';
import { useCheckerTranslation } from '../../i18n/useCheckerTranslation.js';
import { translateChecker } from '../../i18n/checkerPresentation.js';
import { useEffect, useRef, useMemo, useState } from 'react';
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
} from '../funnels/index.js';
import { CommunityPackMetadataModal } from './CommunityPackMetadataModal';
import {
  FixableCorrectionsList,
  ProcessLog,
  ReportView,
  TechnicalLog,
  titleNeedsCorrection,
} from './CommunityPackChecker';
import { useCommunityPackChecker } from './useCommunityPackChecker';
import { Download, FolderOpen, House, Package, TriangleAlert, Wrench } from '../icons/LucideLocal';
import { getLastExportDir, saveLastExportDir } from '../../hooks/useFileDialog';
import { basename } from '../../utils/fileUtils';
import {
  optionalSilenceSelectionKey,
  packCorrectionCounts,
  serializeOptionalSilenceSelection,
} from './packCheckerIssueClassification';
import './CommunityPackChecker.css';
import './CommunityPackCheckerFunnel.css';

const STEPS = [
  { key: 'pack', labelKey: 'checker:funnel.step.pack' },
  { key: 'report', labelKey: 'checker:funnel.step.report' },
  { key: 'output', labelKey: 'checker:funnel.step.correction' },
];

function latestLine(lines) {
  return lines?.length ? lines[lines.length - 1] : '';
}

// Comptes indépendants, chacun accordé à son nombre ; résolus au rendu.
function correctionCount(result) {
  if (!result) return '';
  const parts = [];
  if (result.audioFixed) parts.push(translateChecker('checker:done.audio.count', { count: result.audioFixed }));
  if (result.imageFixed) parts.push(translateChecker('checker:done.image.count', { count: result.imageFixed }));
  if (result.metadataFixed) parts.push(translateChecker('checker:done.metadata.label'));
  return parts.length ? parts.join(' · ') : translateChecker('checker:done.pack.fixed');
}

export function CommunityPackCheckerFunnel({ onClose, initialEntry = null, preparationLifetime = null }) {
  const { t } = useCheckerTranslation();
  const checker = useCommunityPackChecker(initialEntry, preparationLifetime);
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState('collect');
  const [outputDir, setOutputDir] = useState(() => initialEntry ? checkerOutputDirectory(initialEntry) : getLastExportDir() || '');
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [result, setResult] = useState(null);
  const [localError, setLocalError] = useState('');
  const [selectedOptionalSilences, setSelectedOptionalSilences] = useState(() => new Set());

  const busy = phase === 'analyzing' || phase === 'fixing' || checker.status === 'analyzing' || checker.status === 'fixing';
  const correctionCounts = useMemo(() => packCorrectionCounts(checker.report), [checker.report]);
  const canCreateFixedPack = useMemo(() => (
    (correctionCounts.automatic > 0 || titleNeedsCorrection(checker.report) || selectedOptionalSilences.size > 0)
    && !busy
  ), [checker.report, correctionCounts.automatic, selectedOptionalSilences, busy]);
  const canOpenReport = !!checker.report;
  const canOpenCorrection = canOpenReport && (canCreateFixedPack || correctionCounts.optional > 0);
  const error = localError || checker.error;

  async function analyzePath(path) {
    const selected = String(path || '').trim();
    if (!selected) return;
    setLocalError('');
    setResult(null);
    setSelectedOptionalSilences(new Set());
    setPhase('analyzing');
    const report = await checker.analyzePath(selected);
    setPhase('collect');
    if (report) setStep(1);
  }

  const initialStarted = useRef(false);
  useEffect(() => {
    if (!initialEntry || initialStarted.current) return;
    initialStarted.current = true;
    void analyzePath(initialEntry.zipPath);
  });

  async function pickPack() {
    const selected = await openDialog({
      multiple: false,
      title: t('native:checker.pack.title'),
      filters: [{ name: t('native:file.pack.filterLabel'), extensions: ['zip', '7z'] }],
    });
    if (selected) await analyzePath(Array.isArray(selected) ? selected[0] : selected);
  }

  async function chooseOutputDir() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('native:checker.output.title'),
      defaultPath: outputDir || getLastExportDir() || undefined,
    });
    const nextOutputDir = Array.isArray(selected) ? selected[0] : selected;
    if (!nextOutputDir) return null;
    setOutputDir(nextOutputDir);
    saveLastExportDir(nextOutputDir);
    return nextOutputDir;
  }

  async function fixPack(metadataPatch = null) {
    setMetadataOpen(false);
    setLocalError('');
    const selectedOutputDir = await chooseOutputDir();
    if (!selectedOutputDir) {
      return;
    }
    setPhase('fixing');
    const fixed = await checker.fixPack(metadataPatch, {
      outputDir: selectedOutputDir,
      correctionSelection: {
        optionalAudioSilences: serializeOptionalSilenceSelection(
          checker.report,
          selectedOptionalSilences,
        ),
      },
    });
    setPhase(fixed ? 'done' : 'collect');
    if (fixed) setResult(fixed);
  }

  function handlePrimary() {
    if (step === 0) {
      // CTA actif seulement quand un pack est déjà choisi (zone de dépôt ou
      // bouton « Choisir un pack ») : le footer ne duplique plus le picker.
      if (checker.zipPath) void analyzePath(checker.sourceFolder || checker.zipPath);
      return;
    }
    if (step === 1) {
      if (!canOpenCorrection) {
        onClose();
        return;
      }
      setStep(2);
      return;
    }
    // La fenêtre des métadonnées s'ouvre toujours avant de créer le ZIP
    // corrigé : l'identité du pack s'y garde ou s'y renouvelle, comme au Libre.
    setMetadataOpen(true);
  }

  function handleStepClick(index) {
    if (index === 0) setStep(0);
    if (index === 1 && canOpenReport) setStep(1);
    if (index === 2 && canOpenCorrection) setStep(2);
  }

  const primaryLabel = step === 0
    ? t('checker:funnel.primary.analyze')
    : step === 1
      ? (canCreateFixedPack ? t('checker:fix.start.action') : (correctionCounts.optional > 0 ? t('checker:funnel.primary.suggestions') : t('checker:funnel.primary.finish')))
      : t('checker:funnel.primary.create');

  function toggleOptionalSilence(issue) {
    const key = optionalSilenceSelectionKey(issue);
    if (!key) return;
    setSelectedOptionalSilences((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <FunnelShell
      icon={<Wrench />}
      title={t('checker:funnel.shell.title')}
      subtitle={t('checker:funnel.shell.subtitle')}
      size="wide"
      onClose={busy ? () => {} : onClose}
      closeDisabled={Boolean(initialEntry) && busy}
      showChrome={phase === 'collect'}
      ariaLabel={t('checker:funnel.shell.aria')}
      stepper={(
        <FunnelStepper
          steps={STEPS.map((entry) => ({ key: entry.key, label: t(entry.labelKey) }))}
          current={step}
          onStepClick={handleStepClick}
        />
      )}
      footer={(
        <FunnelFooter
          onBack={() => setStep(Math.max(0, step - 1))}
          backDisabled={step === 0}
          stepLabel={t('home:funnel.footer.stepCount', { step: step + 1, total: STEPS.length })}
          onPrimary={handlePrimary}
          primaryLabel={primaryLabel}
          primaryDisabled={busy || (step === 0 && !checker.zipPath) || (step === 2 && !canCreateFixedPack)}
        />
      )}
    >
      {initialEntry && <p className="catalogue-path">{initialEntry.source.path}</p>}
      {phase === 'analyzing' ? (
        <FunnelGenerationState
          title={t('checker:funnel.analyzing.title')}
          hint={latestLine(checker.liveLog) || t('checker:funnel.analyzing.hint')}
        />
      ) : phase === 'fixing' ? (
        <FunnelGenerationState
          title={t('checker:funnel.fixing.title')}
          hint={latestLine(checker.liveLog) || t('checker:funnel.fixing.hint')}
        />
      ) : phase === 'done' ? (
        <FunnelDoneState
          title={t('checker:funnel.done.title')}
          fileName={basename(result?.fixedZipPath) || result?.fixedZipPath}
          meta={correctionCount(result)}
        >
          <button type="button" className="funnel-btn" onClick={() => outputDir && openPath(outputDir)}>
            <FolderOpen />
            {t('checker:funnel.done.openFolder')}
          </button>
          <button type="button" className="funnel-btn" onClick={() => checker.exportReport('report')}>
            <Download />
            {t('checker:report.export.action')}
          </button>
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={onClose}>
            <House />
            {t('checker:funnel.primary.finish')}
          </button>
        </FunnelDoneState>
      ) : (
        <div className="checker-root pack-checker-funnel">
          {step === 0 ? (
            <div className="funnel-step-content pack-checker-step">
              <FunnelSectionHeader
                icon={<Package />}
                title={t('checker:funnel.pack.title')}
                description={t('checker:funnel.pack.description')}
              />
              <FunnelDropZone
                icon={<Package />}
                title={t('checker:funnel.drop.title')}
                hint={t('checker:funnel.drop.hint')}
                disabled={busy}
                onFiles={(paths) => analyzePath(paths?.[0])}
              >
                <button type="button" className="funnel-btn" onClick={pickPack} disabled={busy}>
                  {t('checker:funnel.pack.choose')}
                </button>
                <button type="button" className="funnel-btn" onClick={() => { void checker.pickFolderPack(); }} disabled={busy}>
                  {t('checker:funnel.folder.choose')}
                </button>
              </FunnelDropZone>
              {checker.zipPath ? (
                <div className="pack-checker-selected" title={checker.sourceFolder || checker.zipPath}>
                  <Package />
                  <span>{checker.sourceFolder || checker.zipPath}</span>
                </div>
              ) : null}
              <ProcessLog status={checker.status} lines={checker.liveLog} />
              {error ? <div className="funnel-error" role="alert">{error}<TechnicalDetail value={localError ? null : checker.technicalDetail} /></div> : null}
            </div>
          ) : step === 1 ? (
            <div className="funnel-step-content pack-checker-step pack-checker-step--report">
              <FunnelSectionHeader
                icon={<TriangleAlert />}
                title={t('checker:funnel.report.title')}
                description={t('checker:funnel.report.description')}
              />
              {error ? <div className="funnel-error" role="alert">{error}<TechnicalDetail value={localError ? null : checker.technicalDetail} /></div> : null}
              <ReportView
                report={checker.report}
                busy={busy}
                canFix={canCreateFixedPack}
                onExportReport={checker.exportReport}
                onFixPack={(metadataPatch) => fixPack(metadataPatch)}
                onStartFix={() => setStep(2)}
                showFixButton={false}
                selectedOptionalSilences={selectedOptionalSilences}
                onToggleOptionalSilence={toggleOptionalSilence}
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
                icon={<Wrench />}
                title={t('checker:funnel.correction.title')}
                description={t('checker:funnel.correction.description')}
              />
              <FixableCorrectionsList
                report={checker.report}
                selectedOptionalSilences={selectedOptionalSilences}
                onToggleOptionalSilence={toggleOptionalSilence}
              />
              {checker.exportNotice ? <div className="info-box">{checker.exportNotice}</div> : null}
              {error ? <div className="funnel-error" role="alert">{error}<TechnicalDetail value={localError ? null : checker.technicalDetail} /></div> : null}
              <div className="pack-checker-inline-actions">
                <FunnelToolButton icon={<Download />} accent="neutral" onClick={() => checker.exportReport('report')}>
                  {t('checker:report.export.action')}
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
