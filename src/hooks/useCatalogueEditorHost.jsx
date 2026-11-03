import { consumeGenerationRequest } from '../store/catalogue/generationLanding.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { lazy, Suspense } from 'react';
import { useErrorDialog } from '../components/common/Dialog';
import { editWarningDialog } from '../components/Catalogue/open/EditWarningDialog.jsx';
const EditPackFunnel = lazy(() => import('../components/EditPack/EditPackFunnel.jsx').then(module => ({ default: module.EditPackFunnel })));
import { CatalogueSimulator } from '../components/Catalogue/open/CatalogueSimulator.jsx';
import { useCatalogueConsultation } from './useCatalogueConsultation.js';
import { catalogueOpenApi } from '../store/catalogue/catalogueOpenApi.js';

/** Owns the preselected funnel above the browser. An editor landing closes the catalogue. */
export function useCatalogueEditorHost({ active, editorReady, onGenerate, onRecoverSession, openProjectFromPath, onLand, onLandAdvanced, onBeforeReplace, onCloseCatalogue, onNotice, onError }) {
  const { showChoiceDialog } = useErrorDialog();
  const [pendingGeneration, setPendingGeneration] = useState(null);
  const consumedGeneration = useRef(null);
  useEffect(() => {
    const handoff = consumeGenerationRequest(pendingGeneration, { consumed: consumedGeneration.current, catalogueActive: active, editorReady });
    if (!handoff.generate) return;
    consumedGeneration.current = handoff.consumed;
    setPendingGeneration(null);
    void Promise.resolve().then(onGenerate).catch(onError);
  }, [pendingGeneration, active, editorReady, onGenerate, onError]);
  const [pending, setPending] = useState(null);
  const consultation = useCatalogueConsultation({ api: catalogueOpenApi(), active, onCleanupFailed: onError });
  useEffect(() => { if (!active) setPending(null); }, [active]);
  const open = useCallback(async (intention) => {
    if (intention.kind === 'openProject') {
      if (await openProjectFromPath(intention.path)) {
        if (intention.purpose === 'editAndGenerate') setPendingGeneration({});
        onCloseCatalogue();
      }
    } else setPending(intention);
  }, [openProjectFromPath, onCloseCatalogue]);
  async function land(handler, input) {
    await handler(input);
    setPending(null);
    onCloseCatalogue();
  }
  const recover = async recovery => {
    if (await onRecoverSession(recovery)) onCloseCatalogue();
  };
  return { open, recover, warning: warning => showChoiceDialog(editWarningDialog(warning)), surface: <Suspense fallback={null}>
    {pending && <EditPackFunnel initialSource={pending.source} onClose={() => setPending(null)}
      onLand={input => land(onLand,input)} onLandAdvanced={input => land(onLandAdvanced,input)}
      onBeforeReplace={onBeforeReplace} onNotice={onNotice}
      onSimulate={async () => {
        const target = pending.target;
        setPending(null);
        await consultation.launch(target, {});
      }} />}
    <CatalogueSimulator consultation={consultation} onChooseAgain={() => consultation.close()} />
  </Suspense> };
}
