import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  target: "node20",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: false,
  outDir: "dist",
  external: ["better-sqlite3"],
});
