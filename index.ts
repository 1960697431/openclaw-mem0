
/**
 * BRIDGE FILE FOR BACKWARD COMPATIBILITY
 * 
 * This file serves two purposes:
 * 1. Entry point for the plugin (OpenClaw loads this).
 * 2. MIGRATION MANAGER: If an old user (v0.3.x) auto-updates, they will only get this file
 *    and package.json, but miss the 'src/' folder. This file detects that state and
 *    downloads the missing 'src/' files before booting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

// Get current directory
const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define the source files structure for v0.4.0+
const SRC_FILES = [
  "src/index.ts",
  "src/types.ts",
  "src/constants.ts",
  "src/utils.ts",
  "src/embedder.ts",
  "src/reflection.ts",
  "src/providers.ts",
  "src/updater.ts",
  "src/archive.ts"
];

const GITHUB_BASE = "https://raw.githubusercontent.com/1960697431/openclaw-mem0/main";

async function ensureSourceFiles() {
  const srcDir = path.join(__dirname, "src");
  
  // Quick check: if src/index.ts exists, we are likely good
  if (fs.existsSync(path.join(srcDir, "index.ts"))) {
    return;
  }

  console.log("[mem0] ⚠️ Detected partial update (missing src folder). Starting self-repair migration...");

  if (!fs.existsSync(srcDir)) {
    fs.mkdirSync(srcDir, { recursive: true });
  }

  for (const file of SRC_FILES) {
    const targetPath = path.join(__dirname, file); // e.g. /.../src/utils.ts
    // Skip if already exists
    if (fs.existsSync(targetPath)) continue;

    console.log(`[mem0] ⬇️ Downloading missing file: ${file}...`);
    try {
      const res = await fetch(`${GITHUB_BASE}/${file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const content = await res.text();
      fs.writeFileSync(targetPath, content, "utf-8");
    } catch (err) {
      console.error(`[mem0] ❌ Failed to download ${file}: ${err}. Plugin may fail to load.`);
    }
  }
  console.log("[mem0] ✅ Migration complete. Booting plugin...");
}

// Bootstrapper
const boot = async () => {
  try {
    // 1. Ensure new file structure exists
    await ensureSourceFiles();

    // 2. Dynamic import the real plugin logic from src/index.ts
    // Note: We use the full path to ensure node resolves it correctly
    const realPluginPath = path.join(__dirname, "src", "index.ts");
    
    // In ESM, we need file:// URL for dynamic imports of absolute paths on Windows/some setups
    const importUrl = url.pathToFileURL(realPluginPath).href;
    
    const module = await import(importUrl);
    return module.default;
  } catch (err) {
    console.error("[mem0] CRITICAL BOOT ERROR:", err);
    // Return a dummy plugin to prevent Gateway crash
    return {
      id: "openclaw-mem0",
      name: "Memory (Broken)",
      register: (api: any) => {
        api.logger.error(`[mem0] Failed to load plugin: ${err}`);
      }
    };
  }
};

// Export the boot promise result (OpenClaw supports Promise<Plugin>)
// OR we export a proxy object that delegates to the real one.
// Since OpenClaw expects a synchronous object export usually, let's try to do this cleanly.
// However, top-level await is supported in recent Node.js.

// Proxy Plugin Object
const proxyPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description: "Mem0 memory backend",
  
  // Forward configSchema if needed (simple pass-through)
  configSchema: {
    parse: (cfg: any) => cfg // Validation will happen in real plugin
  },

  register: async (api: any) => {
    const realPlugin = await boot();
    if (realPlugin && realPlugin.register) {
      realPlugin.register(api);
    }
  }
};

export default proxyPlugin;
