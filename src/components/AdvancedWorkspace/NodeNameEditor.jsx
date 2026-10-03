import { useEffect, useRef, useState } from 'react';

import { advancedGestures, graphNode, presence } from '../../store/projectModel/advancedGestures.js';

// Champ commun aux Écrans et Actions. Il reprend les interactions du renommage
// inline du Libre : Entrée valide, Échap annule, le flou valide, et une valeur
// inchangée n'envoie aucun geste.
export function NodeNameEditor({
  kind,
  node,
  disabled = false,
  focusRequested = false,
  onFocusHandled = null,
  onGesture,
}) {
  const authored = node.name?.presence === 'value' ? String(node.name.value ?? '') : '';
  const [draft, setDraft] = useState(authored);
  const inputRef = useRef(null);
  const cancelledRef = useRef(false);

  useEffect(() => { setDraft(authored); }, [authored, node.path]);
  useEffect(() => {
    if (!focusRequested) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    onFocusHandled?.();
  }, [focusRequested, onFocusHandled]);

  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft === authored) return;
    const target = kind === 'stage' ? graphNode.stage(node.uuid) : graphNode.action(node.id);
    void onGesture(advancedGestures.setNodeName(target, presence.value(draft)));
  };

  return (
    <input
      ref={inputRef}
      className="field-input advanced-field__name-input"
      value={draft}
      aria-label="Nom"
      disabled={disabled || node.uniqueId !== true}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelledRef.current = true;
          setDraft(authored);
          event.currentTarget.blur();
        }
      }}
    />
  );
}
