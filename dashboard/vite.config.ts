import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "../src/restork/web",
  },
  test: {
    environment: "jsdom",
  },
});
