import { useEffect } from 'react';
import { AggregatePacksFunnel } from '../../AggregatePacks/AggregatePacksFunnel.jsx';
import { AssemblyPreparationDialog } from './AssemblyPreparationDialog.jsx';
export function CatalogueAssembly({ assembly, onLand, onLanded, returnFocus }) {
  const phase = assembly.state.phase;
  useEffect(() => {
    // Preparation uses showModal; the ready funnel uses a portal and needs an
    // explicit initial focus after the preparation dialog's cleanup ran.
    if (phase === 'ready') document.querySelector('.funnel-modal .funnel-icon-btn')?.focus();
    if (phase === 'idle' && returnFocus?.current) {
      const { trigger } = returnFocus.current;
      returnFocus.current = null;
      (trigger?.isConnected ? trigger : document.getElementById('catalogue-search'))?.focus();
    }
  }, [phase, returnFocus]);
  if (assembly.state.phase === 'idle') return null;
  if (assembly.state.phase === 'ready') return <AggregatePacksFunnel onLand={onLand} onLanded={onLanded} preparation={assembly.state.preparation} onReleasePreparation={assembly.close} onClose={assembly.close} />;
  return <AssemblyPreparationDialog state={assembly.state} onClose={assembly.close} />;
}
