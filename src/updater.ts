
import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type OpenClawPluginApi } from "openclaw/plugin-sdk";

const GITHUB_REPO = "1960697431/openclaw-mem0";
// This should match the package.json version
const LOCAL_VERSION = "0.4.7"; 

const FILES_TO_UPDATE = [
  "package.json",
  "README.md",
  "openclaw.plugin.json",
  "src/index.ts",
  "src/types.ts",
  "src/constants.ts",
  "src/utils.ts",
  "src/embedder.ts",
  "src/reflection.ts",
  "src/providers.ts",
  "src/updater.ts"
];

export async function checkForUpdates(api: OpenClawPluginApi, pluginDir: string) {
  const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`;

  try {
    // 1. Check remote version
    const pkgResponse = await fetch(`${RAW_BASE}/package.json`, { signal: AbortSignal.timeout(8000) });
    if (!pkgResponse.ok) return;

    const remotePkgText = await pkgResponse.text();
    const remotePkg = JSON.parse(remotePkgText);
    const remoteVersion = remotePkg.version ?? "0.0.0";

    if (remoteVersion === LOCAL_VERSION) {
      api.logger.debug?.(`[mem0] v${LOCAL_VERSION} is up to date`);
      return;
    }

    // Simple semver check
    const local = LOCAL_VERSION.split(".").map(Number);
    const remote = remoteVersion.split(".").map(Number);
    const isNewer = remote[0] > local[0] || 
                   (remote[0] === local[0] && remote[1] > local[1]) ||
                   (remote[0] === local[0] && remote[1] === local[1] && remote[2] > local[2]);

    if (!isNewer) return;

    api.logger.warn(`[mem0] ⬆️ Found update v${remoteVersion} (current v${LOCAL_VERSION}). Updating...`);

    // 2. Download files
    // Check local dependencies first
    let localDeps = "{}";
    try {
      const localPkg = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf-8"));
      localDeps = JSON.stringify(localPkg.dependencies ?? {});
    } catch {}

    for (const file of FILES_TO_UPDATE) {
      try {
        const res = await fetch(`${RAW_BASE}/${file}`, { signal: AbortSignal.timeout(15000) });
        if (res.ok) {
          const content = await res.text();
          // Ensure directory exists for src/ files
          const targetPath = join(pluginDir, file);
          const targetDir = join(pluginDir, file.includes("/") ? "src" : ""); // Simple logic for now
          
          if (!existsSync(targetDir)) {
             // We assume src exists because we are running from it, but good to be safe
          }
          
          writeFileSync(targetPath, content, "utf-8");
          api.logger.info(`[mem0] Updated ${file}`);
        }
      } catch (e) {
        api.logger.warn(`[mem0] Failed to update ${file}: ${e}`);
      }
    }

    // 3. Check dependencies
    const remoteDeps = JSON.stringify(remotePkg.dependencies ?? {});
    if (localDeps !== remoteDeps) {
      api.logger.info("[mem0] Installing new dependencies...");
      try {
        execSync("npm install --production --no-audit --no-fund", { 
          cwd: pluginDir, 
          timeout: 60_000,
          stdio: "pipe" 
        });
      } catch (e) {
        api.logger.error(`[mem0] npm install failed: ${e}`);
      }
    }

    api.logger.warn(`[mem0] ✅ Update complete. Restarting Gateway...`);
    
    // 4. Restart
    setTimeout(() => {
      try { process.kill(process.pid, "SIGHUP"); } 
      catch { process.exit(1); }
    }, 5000);

  } catch (err) {
    api.logger.debug?.(`[mem0] Update check failed: ${err}`);
  }
}
