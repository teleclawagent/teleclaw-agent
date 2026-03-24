/**
 * Cross-platform .env loader for ~/.teleclaw/.env
 *
 * Reads the file, parses `export KEY=VALUE` lines,
 * and sets them on process.env. Auto-generates missing
 * secrets (TELECLAW_ENCRYPT_SECRET, TELECLAW_SIGNING_KEY).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { homedir } from "os";
import { join, dirname } from "path";

const ENV_FILE = join(homedir(), ".teleclaw", ".env");

/**
 * Parse a .env file with `export KEY=VALUE` format.
 * Strips quotes and handles both `export K=V` and `K=V`.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Strip optional `export ` prefix
    const assign = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eqIdx = assign.indexOf("=");
    if (eqIdx === -1) continue;
    const key = assign.slice(0, eqIdx).trim();
    let value = assign.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Ensure ~/.teleclaw/.env exists with required secrets.
 * Creates the file if missing, adds missing keys if partial.
 * Loads all values into process.env.
 */
export function ensureAndLoadEnv(): void {
  const dir = dirname(ENV_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content = "";
  let needsWrite = false;

  if (existsSync(ENV_FILE)) {
    content = readFileSync(ENV_FILE, "utf-8");
  } else {
    // Brand new — create with required secrets
    const secret = randomBytes(32).toString("hex");
    const signingKey = randomBytes(32).toString("hex");
    content =
      "# Teleclaw secrets — do not share or commit\n" +
      `# Created: ${new Date().toISOString()}\n` +
      `export TELECLAW_ENCRYPT_SECRET=${secret}\n` +
      `export TELECLAW_SIGNING_KEY=${signingKey}\n`;
    needsWrite = true;
  }

  // Ensure required keys exist
  if (!content.includes("TELECLAW_ENCRYPT_SECRET")) {
    content += `export TELECLAW_ENCRYPT_SECRET=${randomBytes(32).toString("hex")}\n`;
    needsWrite = true;
  }
  if (!content.includes("TELECLAW_SIGNING_KEY")) {
    content += `export TELECLAW_SIGNING_KEY=${randomBytes(32).toString("hex")}\n`;
    needsWrite = true;
  }

  if (needsWrite) {
    writeFileSync(ENV_FILE, content, { encoding: "utf-8", mode: 0o600 });
  }

  // Load into process.env
  const parsed = parseEnvFile(content);
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
