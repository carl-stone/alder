import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "node20",
    minify: false,
    rollupOptions: {
      external: ["electron"],
      output: {
        format: "cjs",
        entryFileNames: "main.cjs",
        chunkFileNames: "main-[hash].cjs",
      },
    },
  },
});
