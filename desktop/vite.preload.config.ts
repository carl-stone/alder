import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "chrome132",
    minify: false,
    rollupOptions: {
      external: ["electron"],
      output: {
        format: "cjs",
        entryFileNames: "preload.cjs",
        chunkFileNames: "preload-[hash].cjs",
      },
    },
  },
});
