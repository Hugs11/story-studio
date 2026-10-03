import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import { benchGraphEnginesPlugin } from "./bench/graphEngines/vitePlugin.js";

const host = "127.0.0.1";

// Campagne e2e : sous `vite serve` et `VITE_E2E=1` seulement, les boîtes de
// dialogue natives sont remplacées par un shim scriptable (`e2e/shim/dialog.js`).
// Aucun build n'est concerné.
function e2eDialogAliases(command) {
  if (command !== "serve" || process.env.VITE_E2E !== "1") return [];
  const fromRoot = relative => fileURLToPath(new URL(relative, import.meta.url));
  return [
    { find: /^@tauri-apps\/plugin-dialog$/, replacement: fromRoot("./e2e/shim/dialog.js") },
    {
      find: /^e2e-real-plugin-dialog$/,
      replacement: fromRoot("./node_modules/@tauri-apps/plugin-dialog/dist-js/index.js"),
    },
  ];
}

// https://vite.dev/config/
export default defineConfig(async ({ command }) => ({
  resolve: {
    alias: e2eDialogAliases(command),
  },
  plugins: [
    react(),
    // Genere dist/bundle-stats.html en mode `npm run build:stats`.
    process.env.BUNDLE_STATS && visualizer({
      filename: "dist/bundle-stats.html",
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
    }),
    // Bancs d'essai avancés. Le greffon ne s'active que
    // sous `VITE_BENCH=graph|surface|atelier|export|recette` et n'existe dans aucun build.
    benchGraphEnginesPlugin(),
  ].filter(Boolean),

  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/]react(?:-dom)?[\\/]/,
            },
          ],
        },
      },
    },
  },

  // Options Vite propres au développement Tauri, appliquées seulement en `tauri dev` ou `tauri build`.
  //
  // 1. Empêcher Vite de masquer les erreurs Rust.
  clearScreen: false,
  // 2. Tauri attend un port fixe : échouer si ce port est indisponible.
  server: {
    port: 1420,
    strictPort: true,
    host,
    hmr: {
      protocol: "ws",
      host,
      port: 1421,
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
