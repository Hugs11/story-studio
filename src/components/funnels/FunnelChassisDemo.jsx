import { useEffect, useRef, useState } from 'react';
import {
  FunnelShell,
  FunnelStepper,
  FunnelFooter,
  FunnelSectionHeader,
  FunnelToolButton,
  FunnelGenerationState,
  FunnelDoneState,
  useFunnel,
} from './index.js';
import {
  Package, ListTodo, Mic, Image as ImageIcon, Sparkles, Crop, Scissors,
  FolderOpen, House, Wrench,
} from '../icons/LucideLocal';

/*
 * ⚠️ TEMPORAIRE (plan 03) — banc d'essai du châssis de funnel.
 *
 * Ce composant N'EST PAS un funnel métier (ce n'est PAS « Agréger des packs »).
 * Il sert uniquement à valider visuellement le châssis (sombre + clair) en
 * exerçant toutes ses briques : shell, stepper cliquable, footer, en-têtes de
 * section, boutons-outils (D42), écran Génération et écran Terminé.
 *
 * À retirer une fois qu'un vrai funnel (plan 04) consomme le châssis.
 */

const STEPS = [
  { key: 'collect', label: 'Collecte' },
  { key: 'tools', label: 'Outils' },
  { key: 'meta', label: 'Métadonnées' },
];

const GEN_THRESHOLDS = [0.3, 0.7, 1];
const GEN_LABELS = ['Préparation', 'Traitement', 'Finalisation'];

export function FunnelChassisDemo({ onClose }) {
  const funnel = useFunnel({ stepCount: STEPS.length, family: 'generative' });
  const { phase, stepIndex, isLastStep, showChrome } = funnel;
  const [progress, setProgress] = useState(0);
  const timerRef = useRef(null);

  // Simulation de progression (calquée sur la maquette de référence).
  useEffect(() => {
    if (phase !== 'processing') return undefined;
    setProgress(0);
    timerRef.current = setInterval(() => {
      setProgress((prev) => {
        const next = Math.min(1, prev + 0.04);
        if (next >= 1) {
          clearInterval(timerRef.current);
          setTimeout(() => funnel.complete(), 450);
        }
        return next;
      });
    }, 60);
    return () => clearInterval(timerRef.current);
  }, [phase, funnel]);

  function handlePrimary() {
    if (isLastStep) funnel.startProcessing();
    else funnel.goNext();
  }

  const phases = GEN_LABELS.map((label, index) => {
    const done = progress >= GEN_THRESHOLDS[index];
    const prev = index === 0 ? 0 : GEN_THRESHOLDS[index - 1];
    const active = !done && progress >= prev;
    return { label, status: done ? 'done' : active ? 'active' : 'todo' };
  });

  return (
    <FunnelShell
      icon={<Package />}
      title="Démo du châssis"
      subtitle="Banc d'essai temporaire — pas un funnel réel"
      onClose={onClose}
      showChrome={showChrome}
      ariaLabel="Démo du châssis de funnel"
      stepper={(
        <FunnelStepper steps={STEPS} current={stepIndex} onStepClick={funnel.goToStep} />
      )}
      footer={(
        <FunnelFooter
          onBack={funnel.goBack}
          backDisabled={funnel.isFirstStep}
          stepLabel={funnel.stepLabel}
          onPrimary={handlePrimary}
          primaryLabel={isLastStep ? 'Générer (démo)' : 'Continuer'}
          primaryIcon={isLastStep ? <Package /> : undefined}
        />
      )}
    >
      {phase === 'collect' && stepIndex === 0 && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<ListTodo />}
            title="Collecte"
            description="Étape de saisie générique : ici viendrait le contenu propre au funnel."
          />
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
            Le stepper en haut est cliquable (navigation libre). Le pied gère
            Précédent / « Étape N / M » / CTA orange.
          </p>
        </div>
      )}

      {phase === 'collect' && stepIndex === 1 && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<Mic />}
            title="Outils riches (D42)"
            description="Les boutons-outils ouvrent les modals existantes de l'app (câblage par funnel)."
          />
          <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
            <FunnelToolButton icon={<Mic />} accent="neutral" block onClick={() => {}}>Réenregistrer</FunnelToolButton>
            <FunnelToolButton icon={<Scissors />} accent="neutral" block onClick={() => {}}>Édition audio</FunnelToolButton>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <FunnelToolButton icon={<Sparkles />} accent="violet" variant="solid" onClick={() => {}}>Générer un texte</FunnelToolButton>
            <FunnelToolButton icon={<Crop />} accent="violet" variant="outline" onClick={() => {}}>Retouche image</FunnelToolButton>
            <FunnelToolButton icon={<ImageIcon />} accent="orange" variant="solid" onClick={() => {}}>Action orange</FunnelToolButton>
          </div>
        </div>
      )}

      {phase === 'collect' && stepIndex === 2 && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<Wrench />}
            title="Métadonnées"
            description="Dernière étape de saisie ; le CTA bascule en « Générer »."
            trailing={<span className="funnel-badge">Pré-rempli</span>}
          />
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
            Valide pour lancer l'écran Génération, puis l'écran Terminé.
          </p>
        </div>
      )}

      {phase === 'processing' && (
        <FunnelGenerationState
          title="Génération (démo)…"
          phases={phases}
          progress={progress}
        />
      )}

      {phase === 'done' && (
        <FunnelDoneState
          title="Démo terminée"
          fileName="exemple_demo_v1.zip"
          meta="Châssis validé · sombre & clair"
        >
          <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={() => {}}>Ouvrir le dossier</FunnelToolButton>
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={onClose}>
            <House strokeWidth={2} />
            Terminer
          </button>
        </FunnelDoneState>
      )}
    </FunnelShell>
  );
}
