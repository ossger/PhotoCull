import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import path from "node:path";

// Renderer root is src/renderer so index.html sits beside main.tsx. The
// electron plugin's main/preload entries and outDirs are absolute so they
// resolve relative to apps/shell, not the renderer root.
const SHELL = __dirname;

export default defineConfig({
  root: path.resolve(SHELL, "src/renderer"),
  publicDir: path.resolve(SHELL, "public"),
  build: {
    outDir: path.resolve(SHELL, "dist"),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      "@shared": path.resolve(SHELL, "src/shared"),
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        entry: path.resolve(SHELL, "src/main/main.ts"),
        vite: {
          build: {
            outDir: path.resolve(SHELL, "dist-electron"),
            rollupOptions: { external: ["electron"] },
          },
          resolve: {
            alias: { "@shared": path.resolve(SHELL, "src/shared") },
          },
        },
      },
      preload: {
        input: path.resolve(SHELL, "src/preload/preload.ts"),
        vite: {
          build: {
            outDir: path.resolve(SHELL, "dist-electron"),
            rollupOptions: { external: ["electron"] },
          },
        },
      },
      renderer: {},
    }),
  ],
});
