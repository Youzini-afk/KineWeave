import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const appRoot = fileURLToPath(new URL("./src/renderer", import.meta.url));
const outputDirectory = fileURLToPath(new URL("./dist-renderer", import.meta.url));

export default defineConfig({
  root: appRoot,
  base: "./",
  build: {
    outDir: outputDirectory,
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome142"
  }
});
