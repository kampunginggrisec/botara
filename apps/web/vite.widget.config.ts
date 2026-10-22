import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Standalone build for the embeddable webchat widget: a single IIFE file
 * (dist/widget.js) that any website can include with one script tag.
 * Built after the main SPA build (see package.json "build").
 */
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("./src/widget.ts", import.meta.url)),
      name: "BotaraWebchat",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
    outDir: "dist",
    emptyOutDir: false,
    minify: true,
  },
});
