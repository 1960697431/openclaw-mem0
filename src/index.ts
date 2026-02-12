
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type Mem0Config, type Mem0Mode, type MemoryItem, type SearchOptions, type AddOptions, type ListOptions, type PendingAction } from "./types.js";
import { DEFAULT_CUSTOM_INSTRUCTIONS, DEFAULT_CUSTOM_CATEGORIES } from "./constants.js";
import { resolveEnvVars, resolveEnvVarsDeep } from "./utils.js";
import { createProvider } from "./providers.js";
import { ReflectionEngine } from "./reflection.js";
import { checkForUpdates } from "./updater.js";
import * as path from "node:path";
import * as fs from "node:fs";

// ============================================================================
// Config Parser
// ============================================================================
const ALLOWED_KEYS = [
  "mode", "apiKey", "userId", "orgId", "projectId", "autoCapture", "autoRecall",
  "customInstructions", "customCategories", "customPrompt", "enableGraph",
  "searchThreshold", "topK", "oss", "proactiveChannel", "proactiveTarget", "gatewayPort"
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

  const mode: Mem0Mode = (cfg.mode === "oss" || cfg.mode === "open-source") ? "open-source" : "platform";

  if (mode === "platform" && (!cfg.apiKey || typeof cfg.apiKey !== "string")) {
    throw new Error("apiKey is required for platform mode");
  }

  let ossConfig;
  if (cfg.oss && typeof cfg.oss === "object") {
    ossConfig = resolveEnvVarsDeep(cfg.oss as Record<string, unknown>);
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
    const provider = createProvider(cfg, api);
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
      description: "Search long-term memories. Use to get context on user preferences or past topics.",
      parameters: Type.Object({
        query: Type.String(),
        limit: Type.Optional(Type.Number()),
        userId: Type.Optional(Type.String()),
        scope: Type.Optional(Type.Union([
          Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")
        ])),
      }),
      async execute(_id, params: any) {
        const { query, limit, userId, scope = "all" } = params;
        try {
          let results: MemoryItem[] = [];
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

          if (results.length === 0) return { content: [{ type: "text", text: "No relevant memories found." }] };

          const text = results.map((r, i) => `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%)`).join("\n");
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

      mem0.command("stats").action(async () => {
        console.log({ mode: cfg.mode, user: cfg.userId, autoRecall: cfg.autoRecall });
      });
    });

    // ── Lifecycle ───────────────────────────────────────────────────────────
    const pluginDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const reflectionEngine = new ReflectionEngine(cfg.oss?.llm, api.logger, pluginDir);

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
