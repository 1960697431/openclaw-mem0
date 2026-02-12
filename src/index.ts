
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type Mem0Config, type Mem0Mode, type MemoryItem, type SearchOptions, type AddOptions, type ListOptions, type PendingAction } from "./types.js";
import { DEFAULT_CUSTOM_INSTRUCTIONS, DEFAULT_CUSTOM_CATEGORIES } from "./constants.js";
import { resolveEnvVars, resolveEnvVarsDeep, fixLlmConfig, cleanJsonResponse } from "./utils.js";
import { createProvider } from "./providers.js";
import { ReflectionEngine } from "./reflection.js";
import { checkForUpdates } from "./updater.js";
import { ArchiveManager } from "./archive.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// Helper to load main OpenClaw config
function loadMainConfig(): Record<string, any> | null {
  try {
    const home = os.homedir();
    const configPath = path.join(home, ".openclaw", "openclaw.json");
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      return JSON.parse(content);
    }
  } catch (e) {
    // Ignore errors, fallback to manual config
  }
  return null;
}

// ============================================================================
// Config Parser
// ============================================================================
const ALLOWED_KEYS = [
  "mode", "apiKey", "userId", "orgId", "projectId", "autoCapture", "autoRecall",
  "customInstructions", "customCategories", "customPrompt", "enableGraph",
  "searchThreshold", "topK", "oss", "proactiveChannel", "proactiveTarget", "gatewayPort",
  "maxMemoryCount",
  // Flat Config (Easy Mode) keys
  "provider", "model", "baseUrl", "baseURL", "url"
];

function parseConfig(value: unknown): Mem0Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("openclaw-mem0 config required");
  }
  const cfg = value as Record<string, unknown>;
  
  // Warn unknown keys
  const unknown = Object.keys(cfg).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unknown.length > 0) {
    console.warn(`[openclaw-mem0] Ignoring unknown keys: ${unknown.join(", ")}`);
  }

  // 1. Detect Mode
  // Default to "open-source" if not specified, unless it's platform specific keys
  let mode: Mem0Mode = (cfg.mode === "oss" || cfg.mode === "open-source") ? "open-source" : "platform";
  if (!cfg.mode) {
     // Heuristic: if 'provider' (llm) is set, assume open-source. If 'orgId' is set, assume platform.
     if (cfg.provider || cfg.oss) mode = "open-source";
     else if (cfg.orgId || (cfg.apiKey && !cfg.provider)) mode = "platform"; // Platform uses apiKey at root without provider
     else mode = "open-source"; // Fallback default
  }

  // 2. Handle Flat Config (Easy Mode) for Open Source
  let ossConfig = cfg.oss as Record<string, unknown> | undefined;
  
  if (mode === "open-source") {
    ossConfig = ossConfig || {};

    // Default Embedder (if not set)
    if (!ossConfig.embedder) {
      ossConfig.embedder = { 
        provider: "transformersjs",
        config: { model: "onnx-community/Qwen3-Embedding-0.6B-ONNX" }
      };
    }

    // Map LLM
    // Scenario A: User provided explicit config in plugin
    if (cfg.provider || cfg.apiKey) {
      if (!ossConfig.llm) {
        const llmConfig: Record<string, any> = {};
        if (cfg.apiKey) llmConfig.apiKey = cfg.apiKey;
        if (cfg.model) llmConfig.model = cfg.model;
        if (cfg.baseUrl) llmConfig.baseURL = cfg.baseUrl;
        if (cfg.url) llmConfig.url = cfg.url;

        ossConfig.llm = {
          provider: (cfg.provider as string) || "openai",
          config: llmConfig
        };
      }
    } 
    // Scenario B: No config provided -> Inherit from Main Config
    else if (!ossConfig.llm) {
      const mainConfig = loadMainConfig();
      if (mainConfig && mainConfig.llm) {
        console.log("[mem0] 🔗 No plugin config found. Inheriting LLM config from OpenClaw main config.");
        // We need to adapt OpenClaw's main LLM config format to Mem0's format
        // Usually OpenClaw main config looks like: { llm: { provider: "openai", config: { ... } } }
        // Or sometimes: { llm: { type: "openai", ... } }
        // We assume it matches roughly or we map it.
        const mainLlm = mainConfig.llm;
        
        // Map "type" to "provider" if needed
        const provider = mainLlm.provider || mainLlm.type || "openai";
        const config = mainLlm.config || mainLlm; // Fallback if it's flat

        // Special handling: remove internal keys if any
        const cleanConfig = { ...config };
        
        ossConfig.llm = {
          provider,
          config: cleanConfig
        };
      } else {
        // Fallback warning handled downstream or it will fail gracefully
        console.warn("[mem0] ⚠️ No LLM configured in plugin OR main config. Memory extraction will fail.");
      }
    }
  }

  if (mode === "platform" && (!cfg.apiKey || typeof cfg.apiKey !== "string")) {
    throw new Error("apiKey is required for platform mode");
  }

  // Auto-fix LLM config using our utility
  if (ossConfig?.llm) {
    const fixed = fixLlmConfig(ossConfig.llm.provider, ossConfig.llm.config);
    ossConfig.llm.provider = fixed.provider;
    ossConfig.llm.config = fixed.config;
  }

  // Resolve env vars
  if (ossConfig) {
    ossConfig = resolveEnvVarsDeep(ossConfig);
  }

  return {
    mode,
    apiKey: typeof cfg.apiKey === "string" ? resolveEnvVars(cfg.apiKey) : undefined,
    userId: typeof cfg.userId === "string" && cfg.userId ? cfg.userId : "default",
    orgId: typeof cfg.orgId === "string" ? cfg.orgId : undefined,
    projectId: typeof cfg.projectId === "string" ? cfg.projectId : undefined,
    autoCapture: cfg.autoCapture !== false,
    autoRecall: cfg.autoRecall !== false,
    customInstructions: typeof cfg.customInstructions === "string" ? cfg.customInstructions : DEFAULT_CUSTOM_INSTRUCTIONS,
    customCategories: (cfg.customCategories && typeof cfg.customCategories === "object") ? cfg.customCategories as Record<string, string> : DEFAULT_CUSTOM_CATEGORIES,
    customPrompt: typeof cfg.customPrompt === "string" ? cfg.customPrompt : undefined,
    enableGraph: cfg.enableGraph === true,
    searchThreshold: typeof cfg.searchThreshold === "number" ? cfg.searchThreshold : 0.5,
    topK: typeof cfg.topK === "number" ? cfg.topK : 5,
    oss: ossConfig,
    proactiveChannel: typeof cfg.proactiveChannel === "string" ? cfg.proactiveChannel : undefined,
    proactiveTarget: typeof cfg.proactiveTarget === "string" ? cfg.proactiveTarget : undefined,
    gatewayPort: typeof cfg.gatewayPort === "number" ? cfg.gatewayPort : undefined,
    maxMemoryCount: typeof cfg.maxMemoryCount === "number" ? cfg.maxMemoryCount : 2000,
  };
}

// ============================================================================
// Main Plugin
// ============================================================================
const memoryPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description: "Mem0 memory backend — Platform or Open-Source",
  kind: "memory" as const,
  configSchema: {
    parse: parseConfig
  },

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    
    // Ensure Data Directory (~/.openclaw/data/mem0)
    const home = os.homedir();
    const dataDir = path.join(home, ".openclaw", "data", "mem0");
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const provider = createProvider(cfg, api, dataDir);
    let currentSessionId: string | undefined;

    api.logger.info(`openclaw-mem0: registered (mode=${cfg.mode}, user=${cfg.userId})`);

    // Helper builders
    const buildAddOptions = (userIdOverride?: string, runId?: string): AddOptions => {
      const opts: AddOptions = { user_id: userIdOverride || cfg.userId };
      if (runId) opts.run_id = runId;
      if (cfg.mode === "platform") {
        opts.custom_instructions = cfg.customInstructions;
        opts.custom_categories = Object.entries(cfg.customCategories).map(([k, v]) => ({ [k]: v }));
        opts.enable_graph = cfg.enableGraph;
        opts.output_format = "v1.1";
      }
      return opts;
    };

    const buildSearchOptions = (userIdOverride?: string, limit?: number, runId?: string): SearchOptions => {
      const opts: SearchOptions = {
        user_id: userIdOverride || cfg.userId,
        top_k: limit ?? cfg.topK,
        limit: limit ?? cfg.topK,
        threshold: cfg.searchThreshold,
        keyword_search: true,
        reranking: true,
      };
      if (runId) opts.run_id = runId;
      return opts;
    };

    // ── Tool: Search ────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search long-term memories. Use to get context on user preferences or past topics. If initial search yields nothing for a historical query, try again with deep=true to search the archive.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Number()),
        userId: Type.Optional(Type.String()),
        scope: Type.Optional(Type.Union([
          Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")
        ])),
        deep: Type.Optional(Type.Boolean({ description: "Search cold archive (slower but deeper). Use only if standard search fails for old info." })),
      }),
      async execute(_id, params: any) {
        const { query, limit, userId, scope = "all", deep } = params;
        try {
          let results: MemoryItem[] = [];
          
          // 1. Standard Vector Search (Hot)
          if (scope === "long-term" || scope === "all") {
            const res = await provider.search(query, buildSearchOptions(userId, limit));
            results.push(...res);
          }
          if ((scope === "session" || scope === "all") && currentSessionId) {
            const res = await provider.search(query, buildSearchOptions(userId, limit, currentSessionId));
            if (scope === "all") {
              const ids = new Set(results.map(r => r.id));
              results.push(...res.filter(r => !ids.has(r.id)));
            } else {
              results = res;
            }
          }

          // 2. Deep Search (Cold Archive)
          if (deep && (scope === "long-term" || scope === "all")) {
             // Search archive and append
             const archiveResults = await archiveManager.search(query, limit);
             results.push(...archiveResults);
          }

          if (results.length === 0) return { content: [{ type: "text", text: "No relevant memories found." }] };

          const text = results.map((r, i) => {
             const score = r.score ? ` (score: ${(r.score * 100).toFixed(0)}%)` : "";
             const source = (r as any)._source === "archive" ? " [ARCHIVE]" : "";
             return `${i + 1}. ${r.memory}${score}${source}`;
          }).join("\n");

          return {
            content: [{ type: "text", text: `Found ${results.length} memories:\n${text}` }],
            details: { count: results.length, memories: results }
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_search" });

    // ── Tool: Store ─────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_store",
      label: "Memory Store",
      description: "Save important information in long-term memory.",
      parameters: Type.Object({
        text: Type.String(),
        userId: Type.Optional(Type.String()),
        longTerm: Type.Optional(Type.Boolean({ default: true })),
      }),
      async execute(_id, params: any) {
        const { text, userId, longTerm = true } = params;
        try {
          const runId = !longTerm && currentSessionId ? currentSessionId : undefined;
          const res = await provider.add([{ role: "user", content: text }], buildAddOptions(userId, runId));
          return {
            content: [{ type: "text", text: `Stored ${res.results.length} memories.` }],
            details: res
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_store" });

    // ── Tool: Get ───────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_get",
      label: "Memory Get",
      description: "Retrieve a specific memory by ID.",
      parameters: Type.Object({ memoryId: Type.String() }),
      async execute(_id, params: any) {
        try {
          const mem = await provider.get(params.memoryId);
          return {
            content: [{ type: "text", text: `Memory: ${mem.memory}` }],
            details: mem
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_get" });

    // ── Tool: List ──────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_list",
      label: "Memory List",
      description: "List all stored memories.",
      parameters: Type.Object({
        userId: Type.Optional(Type.String()),
        scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")])),
      }),
      async execute(_id, params: any) {
        const { userId, scope = "all" } = params;
        const uid = userId || cfg.userId;
        try {
          let memories: MemoryItem[] = [];
          if (scope === "long-term" || scope === "all") {
            const res = await provider.getAll({ user_id: uid });
            memories.push(...res);
          }
          if ((scope === "session" || scope === "all") && currentSessionId) {
            const res = await provider.getAll({ user_id: uid, run_id: currentSessionId });
            if (scope === "all") {
              const ids = new Set(memories.map(r => r.id));
              memories.push(...res.filter(r => !ids.has(r.id)));
            } else {
              memories = res;
            }
          }
          return {
            content: [{ type: "text", text: `${memories.length} memories found.` }],
            details: { count: memories.length, memories }
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_list" });

    // ── Tool: Forget ────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_forget",
      label: "Memory Forget",
      description: "Delete memories by ID or query.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        memoryId: Type.Optional(Type.String()),
      }),
      async execute(_id, params: any) {
        try {
          if (params.memoryId) {
            await provider.delete(params.memoryId);
            return { content: [{ type: "text", text: "Memory deleted." }] };
          }
          if (params.query) {
            const results = await provider.search(params.query, buildSearchOptions(undefined, 5));
            if (results.length === 1 || (results[0]?.score ?? 0) > 0.9) {
              await provider.delete(results[0].id);
              return { content: [{ type: "text", text: `Deleted: ${results[0].memory}` }] };
            }
            return {
              content: [{ type: "text", text: `Found ${results.length} candidates. Please specify ID.` }],
              details: results
            };
          }
          return { content: [{ type: "text", text: "Provide query or memoryId." }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_forget" });

    // ── CLI ─────────────────────────────────────────────────────────────────
    api.registerCli(({ program }) => {
      const mem0 = program.command("mem0").description("Mem0 memory plugin commands");
      
      mem0.command("list").action(async () => {
        try {
           const res = await provider.getAll({ user_id: cfg.userId });
           console.log(JSON.stringify(res, null, 2));
        } catch(e) { console.error(e); }
      });
      
      mem0.command("search").argument("<query>").action(async (q) => {
        try {
           const res = await provider.search(q, buildSearchOptions());
           console.log(JSON.stringify(res, null, 2));
        } catch(e) { console.error(e); }
      });

      mem0.command("import-legacy").action(async () => {
        const memoryMdPath = path.join(home, ".openclaw", "memory.md");
        if (!fs.existsSync(memoryMdPath)) {
          console.log("No legacy memory.md found.");
          return;
        }
        console.log(`Found legacy memory at ${memoryMdPath}. Importing...`);
        const content = fs.readFileSync(memoryMdPath, "utf-8");
        // Split by newlines or paragraphs
        const lines = content.split("\n").filter(l => l.trim().length > 5);
        if (lines.length === 0) return;

        console.log(`Found ${lines.length} items. Processing...`);
        // Batch add
        for (const line of lines) {
           await provider.add([{ role: "user", content: line }], buildAddOptions());
           process.stdout.write(".");
        }
        console.log("\n✅ Import complete. You can now disable the default memory.");
      });

      mem0.command("stats").action(async () => {
        console.log({ mode: cfg.mode, user: cfg.userId, autoRecall: cfg.autoRecall });
      });
    });

    // ── Lifecycle ───────────────────────────────────────────────────────────
    const pluginDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const reflectionEngine = new ReflectionEngine(cfg.oss?.llm, api.logger, dataDir);
    const archiveManager = new ArchiveManager(dataDir, api.logger);

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;
        const sessionId = (ctx as any)?.sessionKey;
        if (sessionId) currentSessionId = sessionId;

        const memories = await provider.search(event.prompt, buildSearchOptions());
        const action = reflectionEngine.checkPendingActions();
        
        let context = "";
        if (memories.length) {
          context += `<relevant-memories>\n${memories.map(m => `- ${m.memory}`).join("\n")}\n</relevant-memories>`;
        }
        if (action) {
          context += `\n<proactive-insight>\nSYSTEM NOTICE: ${action.message}\n</proactive-insight>`;
          api.logger.info(`[mem0] Injected proactive action: ${action.message}`);
        }
        if (context) return { systemContext: context };
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages?.length) return;
        const sessionId = (ctx as any)?.sessionKey;
        if (sessionId) currentSessionId = sessionId;

        const validMsgs = event.messages.filter((m: any) => 
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
        ).slice(-10);

        if (!validMsgs.length) return;

        try {
          const res = await provider.add(validMsgs as any, buildAddOptions(undefined, currentSessionId));
          if (res.results.length > 0) {
            api.logger.info(`[mem0] Captured ${res.results.length} memories`);
            const memories = await provider.search(validMsgs.map((m: any) => m.content).join(" "), buildSearchOptions());
            reflectionEngine.reflect(validMsgs as any, memories);
          }
        } catch (err) {
          api.logger.warn(`[mem0] Capture failed: ${err}`);
        }
      });
    }

    // Heartbeat for Active Brain
    let heartbeat: NodeJS.Timeout;
    api.registerService({
      id: "openclaw-mem0",
      start: () => {
        // Auto-update check on startup
        checkForUpdates(api, pluginDir);

        // Prune old memories if needed
        provider.prune(cfg.userId, cfg.maxMemoryCount || 2000)
          .then((deleted) => {
            if (deleted > 0) api.logger.info(`[mem0] Pruned ${deleted} old memories (limit: ${cfg.maxMemoryCount})`);
          })
          .catch((err) => api.logger.warn(`[mem0] Prune failed: ${err}`));

        heartbeat = setInterval(() => {
          // Just check/fire to update state. 
          // Real proactive push would happen here. 
          // For now, relies on next-turn injection.
          reflectionEngine.checkPendingActions(); 
        }, 60000);
      },
      stop: () => clearInterval(heartbeat)
    });
  }
};

export default memoryPlugin;
