import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";

const host = "127.0.0.1";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    // Genere dist/bundle-stats.html en mode `npm run build:stats`.
    process.env.BUNDLE_STATS && visualizer({
      filename: "dist/bundle-stats.html",
      template: "treemap",
      gzipSize: true,
      brotliSize: true,
    }),
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
