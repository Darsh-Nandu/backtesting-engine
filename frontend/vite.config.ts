import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ["echarts"],
          lwc: ["lightweight-charts"],
          editor: ["@uiw/react-codemirror", "@codemirror/lang-python"],
        },
      },
    },
  },
});
