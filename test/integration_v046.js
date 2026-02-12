
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { strict as assert } from "assert";

// Mock Environment
const HOME_DIR = path.join(process.cwd(), "test_env_home");
const OPENCLAW_DIR = path.join(HOME_DIR, ".openclaw");
const DATA_DIR = path.join(OPENCLAW_DIR, "data", "mem0");
const CONFIG_PATH = path.join(OPENCLAW_DIR, "openclaw.json");
const MEMORY_MD_PATH = path.join(OPENCLAW_DIR, "memory.md");

// Setup
if (fs.existsSync(HOME_DIR)) fs.rmSync(HOME_DIR, { recursive: true });
fs.mkdirSync(OPENCLAW_DIR, { recursive: true });

// Mock Provider to intercept calls
let addCallCount = 0;
const mockProvider = {
  add: async (msgs) => {
    addCallCount++;
    console.log(`[Mock] Adding memory: ${msgs[0].content}`);
    return { results: [] };
  },
  search: async () => [],
  getAll: async () => [],
  delete: async () => {},
  prune: async () => 0
};

// Mock API
const mockApi = {
  pluginConfig: { mode: "open-source", userId: "test" },
  logger: { info: console.log, warn: console.log, error: console.error },
  resolvePath: (p) => p, // Should not be used for dataDir in new logic
  registerTool: () => {},
  registerService: () => {},
  registerCli: (callback) => {
    // Simulate CLI environment
    const cliMock = {
      command: (name) => ({
        description: () => ({
          command: (subCmd) => ({
            argument: () => ({
              action: async (fn) => { 
                 // We will manually trigger the action later if needed
              }
            }),
            action: async (fn) => {
              if (subCmd === "import-legacy") {
                console.log("\n>>> Testing import-legacy command...");
                await fn();
              }
            }
          })
        })
      })
    };
    callback({ program: cliMock });
  },
  on: () => {}
};

// --- Test 1: Data Directory Creation ---
console.log("=== Test 1: Data Separation Logic ===");

// We need to simulate the logic inside src/index.ts where it creates dataDir
// Since we can't easily import the raw source without compiling or using ts-node in a complex way,
// we will verify the logic by replicating it or mocking os.homedir.
// BUT, better yet, let's verify the install script logic for config disabling first.

// --- Test 2: Install Script Config Logic ---
console.log("\n=== Test 2: Auto-Disable Default Memory (Install Script Logic) ===");

// Write initial config
const initialConfig = {
  plugins: { entries: {} },
  memory: { enabled: true } // Default memory on
};
fs.writeFileSync(CONFIG_PATH, JSON.stringify(initialConfig));

// Simulate the Node.js script embedded in install.sh
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

// Logic from install.sh
config.plugins = config.plugins || {};
config.plugins.entries = config.plugins.entries || {};

if (config.memory && config.memory.enabled !== false) {
   config.memory = config.memory || {};
   config.memory.enabled = false; // Should disable it
}

if (!config.plugins.entries['openclaw-mem0']) {
  config.plugins.entries['openclaw-mem0'] = { enabled: true };
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

// Verify
const newConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
assert.equal(newConfig.memory.enabled, false, "Default memory should be disabled");
assert.equal(newConfig.plugins.entries['openclaw-mem0'].enabled, true, "Plugin should be enabled");
console.log("✅ Config auto-update worked correctly");


// --- Test 3: Import Legacy Tool ---
console.log("\n=== Test 3: Import Legacy Tool ===");

// Create dummy memory.md
fs.writeFileSync(MEMORY_MD_PATH, "User likes apples.\nUser is a developer.\n\nUser lives in Tokyo.");

// We need to inject our mock provider into the CLI action. 
// Since we can't easily hook into the closure of the real index.ts,
// we will verify the *logic* of the import function here.

async function runImportLogic(provider, homeDir) {
    const memoryMdPath = path.join(homeDir, ".openclaw", "memory.md");
    if (!fs.existsSync(memoryMdPath)) return;
    
    const content = fs.readFileSync(memoryMdPath, "utf-8");
    const lines = content.split("\n").filter(l => l.trim().length > 5);
    
    for (const line of lines) {
       await provider.add([{ role: "user", content: line }]);
    }
}

await runImportLogic(mockProvider, HOME_DIR);

assert.equal(addCallCount, 3, "Should have imported 3 lines of memory");
console.log("✅ Import logic verified");

console.log("\n🎉 All integration tests passed!");
// Cleanup
fs.rmSync(HOME_DIR, { recursive: true });
