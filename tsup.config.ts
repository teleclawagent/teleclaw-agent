import { defineConfig } from "tsup";
import { rmSync, readdirSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pkg from "./package.json" with { type: "json" };

// Bundle everything EXCEPT production dependencies and Node builtins.
// This ensures @ston-fi/* (devDeps with pnpm-only install blocker)
// and all their transitive deps are inlined into dist/.
const external = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
];

// Clean dist/ but preserve dist/web/ (Vite frontend build)
function cleanDistPreserveWeb() {
  try {
    for (const entry of readdirSync("dist")) {
      if (entry === "web") continue;
      rmSync(join("dist", entry), { recursive: true, force: true });
    }
  } catch {
    // dist/ doesn't exist yet — nothing to clean
  }
}

cleanDistPreserveWeb();

/** Copy JSON data files that are loaded at runtime via __dirname */
function copyDataFiles() {
  const pairs = [
    ["src/agent/tools/fragment/gifts-complete-data.json", "dist/gifts-complete-data.json"],
    ["src/agent/tools/fragment/gifts-database.json", "dist/gifts-database.json"],
    ["src/agent/tools/fragment/gifts-cdn-data.json", "dist/gifts-cdn-data.json"],
    ["src/templates/SOUL.md", "dist/templates/SOUL.md"],
  ];
  for (const [src, dest] of pairs) {
    if (existsSync(src)) {
      const destDir = join(dest, "..");
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      cpSync(src, dest);
    }
  }
}

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "cli/index": "src/cli/index.ts",
  },
  format: "esm",
  target: "node20",
  platform: "node",
  splitting: true,
  clean: false,
  dts: false,
  sourcemap: false,
  outDir: "dist",
  external,
  onSuccess: async () => {
    copyDataFiles();
    console.log("📦 Data files copied to dist/");
  },
});
