// Le `jsx-runtime` du banc de chrome : React intact, plus un carnet.
//
// Le banc doit répondre à « cette commande atteint-elle un gestionnaire ? ».
// Le HTML rendu ne le dit pas : `onClick` n'y survit pas, et la barre d'outils
// n'ajoute pas `disabled` à un bouton dont le gestionnaire manque — elle le
// peint exactement comme un bouton branché. La question ne se pose donc qu'au
// moment où l'élément est créé, avec ses props.
//
// Ce module est la fabrique d'éléments que le compilateur JSX appelle. Il
// délègue à React sans rien changer et note au passage le couple
// `(type, props)`. Le rendu reste celui de React ; seul le carnet est en plus.
//
// Il n'est jamais importé par son chemin depuis `src/` : le chargeur du banc
// fait pointer la source JSX ici, pour la durée des tests seulement.
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';

let notebook = null;

export function openNotebook() {
  notebook = [];
  return notebook;
}

export function closeNotebook() {
  const written = notebook ?? [];
  notebook = null;
  return written;
}

export function jsx(type, props, key) {
  if (notebook) notebook.push({ type, props });
  return reactJsx(type, props, key);
}

export function jsxs(type, props, key) {
  if (notebook) notebook.push({ type, props });
  return reactJsxs(type, props, key);
}

export { Fragment };
