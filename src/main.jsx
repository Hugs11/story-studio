import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { runSettingsMigrations } from "./store/persistentSettings";

// Banc d'essai des moteurs de graphe, monté à la place de
// l'application sous `VITE_BENCH=graph npm run tauri:dev`.
//
// `import.meta.env.DEV` et une variable d'environnement absente du build font
// disparaître entièrement cette branche de l'application livrée : aucun moteur
// d'affichage n'entre dans le bundle tant que le verdict du banc n'est pas
// rendu et l'éditeur avancé intégré.
if (import.meta.env.DEV && import.meta.env.VITE_BENCH === "graph") {
  import("../bench/graphEngines/mount.js").then(({ mount }) => mount());
} else if (import.meta.env.DEV && (import.meta.env.VITE_BENCH === "surface"
  || import.meta.env.VITE_BENCH === "recette")) {
  // La **vraie** surface avancée, montée sur une fixture, pour la voir et la
  // capturer. Elle passe par les commandes Tauri de production. En mode
  // `recette`, la même surface est mesurée par un parcours de
  // recette — mêmes composants, mêmes commandes, relevé en plus.
  import("../bench/graphEngines/surfaceMount.jsx").then(({ mountSurface }) => mountSurface());
} else if (import.meta.env.DEV && import.meta.env.VITE_BENCH === "atelier") {
  // Le **vrai** espace de travail avancé, monté sur une fixture,
  // avec son store, sa session d'édition et ses commandes de production.
  import("../bench/graphEngines/workspaceMount.jsx").then(({ mountWorkspace }) => mountWorkspace());
} else if (import.meta.env.DEV && import.meta.env.VITE_BENCH === "export") {
  // Le banc d'export : pack importé, édité, enregistré, rouvert,
  // exporté et relu — sur de vrais fichiers, par les commandes de production.
  import("../bench/graphEngines/exportMount.jsx").then(({ mountExportBench }) => mountExportBench());
} else {

runSettingsMigrations();

// Chromium peut faire passer l'élément encore focus après un clic en
// `:focus-visible` dès la première touche pressée. Le contour apparaît alors
// sur l'ancien clic, sans suivre la sélection applicative. On réserve les
// anneaux de focus au parcours clavier réellement commencé avec Tab.
document.addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    document.documentElement.setAttribute('data-keyboard-navigation', 'true');
  }
}, true);

document.addEventListener('pointerdown', () => {
  document.documentElement.removeAttribute('data-keyboard-navigation');
}, true);

// WebView2 doit autoriser le signal Ctrl+wheel pour exposer le pincement du
// trackpad au diagramme. On neutralise ici son action native afin qu'il ne
// zoome jamais l'interface entière ; le viewport du diagramme le consomme.
window.addEventListener('wheel', event => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false, capture: true });

// Désactiver le menu contextuel du navigateur (sauf dans les champs de texte)
document.addEventListener('contextmenu', e => {
  if (!e.target.matches('input, textarea')) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

}
