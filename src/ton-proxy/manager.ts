/**
 * TON Proxy manager — downloads, starts, stops the Tonutils-Proxy binary.
 *
 * Binary source: https://github.com/xssnick/Tonutils-Proxy
 * The CLI binary exposes an HTTP proxy on 127.0.0.1:<port> for .ton sites.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import {
  existsSync,
  chmodSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { pipeline } from "stream/promises";
import { createLogger } from "../utils/logger.js";
import { TELECLAW_ROOT } from "../workspace/paths.js";

const log = createLogger("TonProxy");

const GITHUB_REPO = "xssnick/Tonutils-Proxy";
const BINARY_DIR = join(TELECLAW_ROOT, "bin");
const PID_FILE = join(TELECLAW_ROOT, "ton-proxy.pid");
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const HEALTH_CHECK_TIMEOUT_MS = 5_000;
const KILL_GRACE_MS = 5_000;

export interface TonProxyConfig {
  enabled: boolean;
  port: number;
  binary_path?: string;
}

export class TonProxyManager {
  private process: ChildProcess | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private config: TonProxyConfig;
  private restartCount = 0;
  private maxRestarts = 3;

  constructor(config: TonProxyConfig) {
    this.config = config;
  }

  /** Resolve the binary path — user-specified or auto-detected */
  getBinaryPath(): string {
    if (this.config.binary_path) return this.config.binary_path;
    return join(BINARY_DIR, getBinaryName());
  }

  /** Check if the binary exists on disk */
  isInstalled(): boolean {
    return existsSync(this.getBinaryPath());
  }

  /** Whether the proxy process is currently running */
  isRunning(): boolean {
    return this.process !== null && this.process.exitCode === null;
  }

  /**
   * Download the latest CLI binary from GitHub releases.
   * Fetches the latest release tag, then downloads the platform-appropriate binary.
   */
  async install(): Promise<void> {
    const binaryName = getBinaryName();
    log.info(`Downloading TON Proxy binary (${binaryName})...`);

    await mkdir(BINARY_DIR, { recursive: true });

    // Fetch latest release tag
    const releaseUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
    const releaseRes = await fetch(releaseUrl, {
      headers: { Accept: "application/vnd.github.v3+json" },
    });
    if (!releaseRes.ok) {
      throw new Error(`Failed to fetch latest release: ${releaseRes.status}`);
    }
    const release = (await releaseRes.json()) as { tag_name: string };
    const tag = release.tag_name;

    // Download binary
    const downloadUrl = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${binaryName}`;
    log.info(`Downloading ${downloadUrl}`);

    const res = await fetch(downloadUrl);
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`);
    }

    const dest = this.getBinaryPath();
    const fileStream = createWriteStream(dest);
    // Node fetch body is a ReadableStream; pipe through to file
    await pipeline(res.body as unknown as NodeJS.ReadableStream, fileStream);

    // Make executable
    chmodSync(dest, 0o755);

    log.info(`TON Proxy installed: ${dest} (${tag})`);
  }

  /** Kill any orphan proxy process from a previous session */
  private killOrphan(): void {
    // Check PID file first
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
        if (pid && !isNaN(pid)) {
          try {
            process.kill(pid, 0); // check if alive
            log.warn(`Killing orphan TON Proxy (PID ${pid}) from previous session`);
            process.kill(pid, "SIGTERM");
          } catch {
            // Process already dead — clean up stale PID file
          }
        }
        unlinkSync(PID_FILE);
      } catch {
        // PID file read/parse error — ignore
      }
    }

    // Also check if port is in use (belt & suspenders)
    try {
      const out = execSync(`ss -tlnp 2>/dev/null | grep ':${this.config.port} ' || true`, {
        encoding: "utf-8",
        timeout: 3000,
      });
      const pidMatch = out.match(/pid=(\d+)/);
      if (pidMatch) {
        const pid = parseInt(pidMatch[1], 10);
        log.warn(`Port ${this.config.port} occupied by PID ${pid}, killing it`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Already dead
        }
        // Give it a moment to release the port
        execSync("sleep 0.5");
      }
    } catch {
      // ss not available or other error — skip
    }
  }

  /** Write PID to file for orphan detection */
  private writePidFile(pid: number): void {
    try {
      writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
    } catch {
      log.warn("Failed to write TON Proxy PID file");
    }
  }

  /** Remove PID file */
  private removePidFile(): void {
    try {
      if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
    } catch {
      // ignore
    }
  }

  /** Start the proxy process */
  async start(): Promise<void> {
    if (this.isRunning()) {
      log.warn("TON Proxy is already running");
      return;
    }

    // Reset restart counter for fresh start
    this.restartCount = 0;
    this.maxRestarts = 3;

    // Kill any orphan process from a previous session
    this.killOrphan();

    if (!this.isInstalled()) {
      await this.install();
    }

    const binaryPath = this.getBinaryPath();
    const port = String(this.config.port);

    log.info(`Starting TON Proxy on 127.0.0.1:${port}`);

    this.process = spawn(binaryPath, ["-addr", `127.0.0.1:${port}`], {
      cwd: BINARY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    this.process.stdout?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.debug(`[proxy] ${line}`);
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.warn(`[proxy:err] ${line}`);
    });

    this.process.on("exit", (code, signal) => {
      log.info(`TON Proxy exited (code=${code}, signal=${signal})`);
      this.process = null;
      this.removePidFile();

      // Auto-restart on unexpected exit (up to maxRestarts)
      if (code !== 0 && code !== null && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        log.warn(`Auto-restarting TON Proxy (attempt ${this.restartCount}/${this.maxRestarts})`);
        // Fire-and-forget restart
        this.start().catch((err) => log.error({ err }, "Failed to auto-restart TON Proxy"));
      }
    });

    this.process.on("error", (err) => {
      log.error({ err }, "TON Proxy process error");
      this.process = null;
    });

    // Start health check loop
    this.startHealthCheck();

    // Wait briefly for process to crash or start
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.isRunning()) {
          resolve();
        } else {
          reject(new Error("TON Proxy process exited immediately"));
        }
      }, 1000);

      this.process?.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("TON Proxy process exited during startup"));
      });
    });

    if (this.process?.pid) this.writePidFile(this.process.pid);
    log.info(`TON Proxy running on 127.0.0.1:${port} (PID ${this.process?.pid})`);
  }

  /** Stop the proxy process gracefully */
  async stop(): Promise<void> {
    this.stopHealthCheck();

    if (!this.process) return;

    // Prevent auto-restart during intentional stop
    this.maxRestarts = 0;

    log.info("Stopping TON Proxy...");

    return new Promise<void>((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      const forceKill = setTimeout(() => {
        if (this.process) {
          log.warn("TON Proxy did not exit gracefully, sending SIGKILL");
          this.process.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);

      this.process.on("exit", () => {
        clearTimeout(forceKill);
        this.process = null;
        this.removePidFile();
        resolve();
      });

      this.process.kill("SIGTERM");
    });
  }

  /** Remove the downloaded binary from disk */
  async uninstall(): Promise<void> {
    if (this.isRunning()) {
      await this.stop();
    }
    const binaryPath = this.getBinaryPath();
    if (existsSync(binaryPath)) {
      const { unlink } = await import("fs/promises");
      await unlink(binaryPath);
      log.info(`TON Proxy binary removed: ${binaryPath}`);
    }
  }

  /** Get proxy status for WebUI / tools */
  getStatus(): { running: boolean; port: number; installed: boolean; pid?: number } {
    return {
      running: this.isRunning(),
      port: this.config.port,
      installed: this.isInstalled(),
      pid: this.process?.pid,
    };
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthInterval = setInterval(() => {
      void this.checkHealth();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  private async checkHealth(): Promise<void> {
    if (!this.isRunning()) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      // Tonutils-Proxy responds to regular HTTP requests when used as proxy
      // A simple connect to the port verifies it's alive
      const res = await fetch(`http://127.0.0.1:${this.config.port}/`, {
        signal: controller.signal,
      }).catch(() => null);
      clearTimeout(timeout);

      if (!res) {
        log.warn("TON Proxy health check failed (no response)");
      }
    } catch {
      // Connection refused is normal for proxy (no upstream) — process liveness is the real check
    }
  }
}

/** Get the platform-specific binary name */
function getBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  let os: string;
  switch (platform) {
    case "linux":
      os = "linux";
      break;
    case "darwin":
      os = "darwin";
      break;
    case "win32":
      os = "windows";
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  let cpuArch: string;
  switch (arch) {
    case "x64":
      cpuArch = "amd64";
      break;
    case "arm64":
      cpuArch = "arm64";
      break;
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }

  const ext = platform === "win32" ? ".exe" : "";
  return `tonutils-proxy-cli-${os}-${cpuArch}${ext}`;
}
