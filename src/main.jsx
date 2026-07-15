import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { runSettingsMigrations } from "./store/persistentSettings";

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
