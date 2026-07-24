import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const clientRoot = fileURLToPath(new URL("./src/client", import.meta.url));
const outputDirectory = fileURLToPath(new URL("./dist-client", import.meta.url));

export default defineConfig({
  root: clientRoot,
  base: "./",
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022"
  }
});
