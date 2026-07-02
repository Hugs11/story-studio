import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { runSettingsMigrations } from "./store/persistentSettings";

runSettingsMigrations();

// Désactiver le menu contextuel du navigateur (sauf dans les champs de texte)
document.addEventListener('contextmenu', e => {
  if (!e.target.matches('input, textarea')) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
