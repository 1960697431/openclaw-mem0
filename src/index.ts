
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type Mem0Config, type Mem0Mode, type MemoryItem, type SearchOptions, type AddOptions, type ListOptions, type PendingAction, type Mem0Stats } from "./types.js";
import { DEFAULT_CUSTOM_INSTRUCTIONS, DEFAULT_CUSTOM_CATEGORIES } from "./constants.js";
import { resolveEnvVars, resolveEnvVarsDeep, fixLlmConfig, cleanJsonResponse } from "./utils.js";
import { createProvider } from "./providers.js";
import { ReflectionEngine } from "./reflection.js";
import { checkForUpdates } from "./updater.js";
import { ArchiveManager } from "./archive.js";
import { buildMemoryContext, estimateTokens, type SmartInjectionConfig } from "./contextManager.js";
import { MemoryIngestor } from "./ingestor.js";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

function readPluginVersion(): string {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const pluginDir = path.dirname(path.dirname(currentFile));
    const packagePath = path.join(pluginDir, "package.json");
    if (!fs.existsSync(packagePath)) return "unknown";
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

const PLUGIN_VERSION = readPluginVersion();

// Helper to load main OpenClaw config and extract default LLM settings
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

function inferProviderFromMainConfig(name: string, providerConfig: Record<string, any>): string {
  const key = (name || "").toLowerCase();
  const api = String(providerConfig?.api || "").toLowerCase();

  if (api.includes("anthropic") || key.includes("anthropic") || key.includes("claude")) return "anthropic";
  if (api.includes("gemini") || api.includes("google") || api.includes("generativelanguage") || key.includes("gemini")) return "gemini";
  if (api.includes("ollama") || key.includes("ollama")) return "ollama";
  if (api.includes("minimax") || key.includes("minimax")) return "minimax";
  if (key.includes("deepseek")) return "deepseek";
  if (key.includes("zhipu") || key.includes("glm")) return "zhipu";

  return "openai";
}

// Extract default LLM config from OpenClaw main config
function extractDefaultLlmConfig(mainConfig: Record<string, any>): { provider: string; config: Record<string, any> } | null {
  // Try models.providers first (newer structure)
  if (mainConfig.models?.providers) {
    const providers = mainConfig.models.providers;
    // Prefer certain providers in order
    const preferredOrder = ['zhipu', 'deepseek', 'moonshot', 'qwen', 'gemini', 'minimax', 'openai', 'anthropic', 'ollama'];
    
    for (const preferred of preferredOrder) {
      if (providers[preferred]) {
        const p = providers[preferred];
        const provider = inferProviderFromMainConfig(preferred, p);
        const baseURL = p.baseURL ?? p.baseUrl ?? p.url;
        const config: Record<string, any> = {
          apiKey: p.apiKey,
          model: p.models?.[0]?.id || 'default',
        };
        if (provider === "ollama") config.url = baseURL;
        else if (baseURL) config.baseURL = baseURL;

        return {
          provider,
          config,
        };
      }
    }
    
    // Fallback to first available provider
    const firstProvider = Object.entries(providers)[0];
    if (firstProvider) {
      const [name, p] = firstProvider as [string, any];
      const provider = inferProviderFromMainConfig(name, p);
      const baseURL = p.baseURL ?? p.baseUrl ?? p.url;
      const config: Record<string, any> = {
        apiKey: p.apiKey,
        model: p.models?.[0]?.id || 'default',
      };
      if (provider === "ollama") config.url = baseURL;
      else if (baseURL) config.baseURL = baseURL;
      return {
        provider,
        config,
      };
    }
  }
  
  // Try legacy llm structure
  if (mainConfig.llm) {
    const mainLlm = mainConfig.llm;
    const provider = mainLlm.provider || mainLlm.type || "openai";
    const config = mainLlm.config || mainLlm;
    return { provider, config };
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
  // Handle empty/undefined config - use defaults
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.log("[mem0] No config provided, using zero-config mode with inherited LLM settings");
    value = {};
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
        const baseURL = (cfg.baseURL || cfg.baseUrl) as string | undefined;
        if (baseURL) llmConfig.baseURL = baseURL;
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
      if (mainConfig) {
        const defaultLlm = extractDefaultLlmConfig(mainConfig);
        if (defaultLlm) {
          console.log("[mem0] 🔗 No plugin config found. Inheriting LLM config from OpenClaw main config.");
          ossConfig.llm = defaultLlm;
        } else {
          console.warn("[mem0] ⚠️ Could not extract LLM config from main config. Using fallback.");
        }
      }
      
      // Final fallback - still no LLM
      if (!ossConfig.llm) {
        console.warn("[mem0] ⚠️ No LLM configured. Memory extraction may fail. Please configure provider in openclaw.json.");
      }
    }
  }

  if (mode === "platform" && (!cfg.apiKey || typeof cfg.apiKey !== "string")) {
    throw new Error("apiKey is required for platform mode");
  }

  // Auto-fix LLM config using our utility
  const ossAny = ossConfig as Record<string, any> | undefined;
  const llmCfg = ossAny?.llm as { provider?: string; config?: Record<string, unknown> } | undefined;
  if (llmCfg?.provider && llmCfg.config && typeof llmCfg.config === "object") {
    const fixed = fixLlmConfig(llmCfg.provider, llmCfg.config);
    llmCfg.provider = fixed.provider;
    llmCfg.config = fixed.config;
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
    const SEARCH_CACHE_TTL_MS = Math.max(5_000, Number(process.env.MEM0_SEARCH_CACHE_TTL_MS ?? 45_000) || 45_000);
    const SEARCH_CACHE_MAX_ENTRIES = Math.max(16, Number(process.env.MEM0_SEARCH_CACHE_MAX ?? 128) || 128);
    const searchCache = new Map<string, { expiresAt: number; results: MemoryItem[] }>();

    api.logger.info(`openclaw-mem0: registered (mode=${cfg.mode}, user=${cfg.userId})`);

    const cloneMemories = (items: MemoryItem[]): MemoryItem[] => items.map((item) => ({ ...item }));
    const clearSearchCache = () => {
      if (searchCache.size > 0) searchCache.clear();
    };
    const makeSearchCacheKey = (
      query: string,
      limit: number,
      userId: string,
      scope: "session" | "long-term" | "all",
      deep: boolean,
      sessionId: string | undefined
    ) => `${query.trim().toLowerCase()}|${limit}|${userId}|${scope}|${deep ? "1" : "0"}|${sessionId || "-"}`;
    const getSearchCache = (key: string): MemoryItem[] | null => {
      const now = Date.now();
      const cached = searchCache.get(key);
      if (!cached) return null;
      if (cached.expiresAt <= now) {
        searchCache.delete(key);
        return null;
      }
      return cloneMemories(cached.results);
    };
    const setSearchCache = (key: string, results: MemoryItem[]) => {
      if (!results.length) return;
      const now = Date.now();
      searchCache.set(key, {
        expiresAt: now + SEARCH_CACHE_TTL_MS,
        results: cloneMemories(results),
      });
      if (searchCache.size > SEARCH_CACHE_MAX_ENTRIES) {
        const oldestKey = searchCache.keys().next().value;
        if (oldestKey) searchCache.delete(oldestKey);
      }
    };
    const previewMemoryText = (text: string, maxLen = 160): string => {
      const normalized = (text || "").replace(/\s+/g, " ").trim();
      if (!normalized) return "(empty)";
      return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 1)}…` : normalized;
    };
    const formatSearchResult = (results: MemoryItem[]) => {
      const text = results.map((r, i) => {
        const score = r.score ? ` (score: ${(r.score * 100).toFixed(0)}%)` : "";
        const source = (r as any)._source === "archive" ? " [ARCHIVE]" : "";
        return `${i + 1}. [id:${r.id}] ${previewMemoryText(r.memory)}${score}${source}`;
      }).join("\n");
      return {
        content: [{ type: "text", text: `Found ${results.length} memories:\n${text}` }],
        details: { count: results.length, memories: results }
      };
    };

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
          const effectiveLimit = limit ?? cfg.topK;
          const effectiveUserId = userId || cfg.userId;
          const cacheKey = makeSearchCacheKey(query, effectiveLimit, effectiveUserId, scope, Boolean(deep), currentSessionId);
          const cachedResults = getSearchCache(cacheKey);
          if (cachedResults) {
            api.logger.debug?.(`[mem0] 🔍 搜索命中缓存: "${query}" (${cachedResults.length} 条)`);
            return formatSearchResult(cachedResults);
          }

          let results: MemoryItem[] = [];
          const needLongTerm = scope === "long-term" || scope === "all";
          const needSession = (scope === "session" || scope === "all") && Boolean(currentSessionId);
          const needArchive = Boolean(deep) && needLongTerm;

          const [longTermResults, sessionResults, archiveResults] = await Promise.all([
            needLongTerm ? provider.search(query, buildSearchOptions(userId, limit)) : Promise.resolve([] as MemoryItem[]),
            needSession ? provider.search(query, buildSearchOptions(userId, limit, currentSessionId)) : Promise.resolve([] as MemoryItem[]),
            needArchive ? archiveManager.search(query, effectiveLimit) : Promise.resolve([] as MemoryItem[]),
          ]);

          const dedup = new Set<string>();
          const pushUnique = (items: MemoryItem[]) => {
            for (const item of items) {
              if (!item || !item.id || dedup.has(item.id)) continue;
              dedup.add(item.id);
              results.push(item);
            }
          };

          if (scope === "session") {
            pushUnique(sessionResults);
          } else if (scope === "long-term") {
            pushUnique(longTermResults);
            pushUnique(archiveResults);
          } else {
            pushUnique(longTermResults);
            pushUnique(sessionResults);
            pushUnique(archiveResults);
          }

          if (results.length === 0) {
            api.logger.debug?.(`[mem0] 🔍 搜索 "${query}" 未找到相关记忆`);
            return { content: [{ type: "text", text: "No relevant memories found." }] };
          }

          api.logger.info(`[mem0] 🔍 搜索 "${query}" 找到 ${results.length} 条记忆`);
          setSearchCache(cacheKey, results);
          return formatSearchResult(results);
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
          if (res.results.length > 0) clearSearchCache();
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
          if (!mem || typeof mem.memory !== "string" || mem.memory.trim().length === 0) {
            return { content: [{ type: "text", text: "Memory not found." }] };
          }
          return {
            content: [{ type: "text", text: `Memory: ${mem.memory}` }],
            details: mem
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_get" });

    // ── Tool: Stats ─────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_stats",
      label: "Memory Stats",
      description: "Get memory system statistics (count, storage size, health).",
      parameters: Type.Object({}),
      async execute() {
        try {
          const stats = await provider.getStats();
          const formatSize = (bytes: number) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          };
          
          const summary = [
            `📊 Memory Statistics`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `Total Memories: ${stats.totalMemories}`,
            `Hot Storage: ${formatSize(stats.dbSize)}`,
            `Archive Size: ${formatSize(stats.archiveSize)}`,
            `Write Queue: ${stats.writeQueueStats.currentQueue} pending (${stats.writeQueueStats.totalWrites} total)`,
            `Last Updated: ${stats.lastUpdated}`,
          ].join("\n");
          
          return {
            content: [{ type: "text", text: summary }],
            details: stats
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err}` }] };
        }
      }
    }, { name: "memory_stats" });

    // ── Tool: List ──────────────────────────────────────────────────────────
    api.registerTool({
      name: "memory_list",
      label: "Memory List",
      description: "List all stored memories.",
      parameters: Type.Object({
        userId: Type.Optional(Type.String()),
        scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")])),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id, params: any) {
        const { userId, scope = "all", limit = 30 } = params;
        const uid = userId || cfg.userId;
        const displayLimit = Math.max(1, Math.min(100, Number(limit) || 30));
        try {
          let memories: MemoryItem[] = [];
          const needLongTerm = scope === "long-term" || scope === "all";
          const needSession = (scope === "session" || scope === "all") && Boolean(currentSessionId);

          const [longTermMemories, sessionMemories] = await Promise.all([
            needLongTerm ? provider.getAll({ user_id: uid }) : Promise.resolve([] as MemoryItem[]),
            needSession ? provider.getAll({ user_id: uid, run_id: currentSessionId }) : Promise.resolve([] as MemoryItem[]),
          ]);

          const dedup = new Set<string>();
          const pushUnique = (items: MemoryItem[]) => {
            for (const item of items) {
              if (!item || !item.id || dedup.has(item.id)) continue;
              dedup.add(item.id);
              memories.push(item);
            }
          };

          if (scope === "session") {
            pushUnique(sessionMemories);
          } else if (scope === "long-term") {
            pushUnique(longTermMemories);
          } else {
            pushUnique(longTermMemories);
            pushUnique(sessionMemories);
          }

          if (memories.length === 0) {
            return {
              content: [{ type: "text", text: "No memories found." }],
              details: { count: 0, memories: [] }
            };
          }

          const sortedMemories = memories.slice().sort((a, b) => {
            const ta = new Date(a.updated_at || a.created_at || 0).getTime();
            const tb = new Date(b.updated_at || b.created_at || 0).getTime();
            return tb - ta;
          });
          const shown = sortedMemories.slice(0, displayLimit);
          const lines = shown.map((m, i) => `${i + 1}. [id:${m.id}] ${previewMemoryText(m.memory)}`);
          const suffix = sortedMemories.length > shown.length
            ? `\n... and ${sortedMemories.length - shown.length} more.`
            : "";

          return {
            content: [{
              type: "text",
              text: `${sortedMemories.length} memories found (scope=${scope}).\n${lines.join("\n")}${suffix}`
            }],
            details: { count: sortedMemories.length, memories: sortedMemories }
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
        userId: Type.Optional(Type.String()),
        scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("long-term"), Type.Literal("all")])),
        limit: Type.Optional(Type.Number()),
        deleteAll: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params: any) {
        try {
          const effectiveUserId = params.userId || cfg.userId;
          const scope = params.scope || "all";
          const effectiveLimit = Math.max(1, Math.min(50, Number(params.limit) || 8));

          if (params.memoryId) {
            await provider.delete(params.memoryId);
            clearSearchCache();
            return { content: [{ type: "text", text: "Memory deleted." }] };
          }
          if (params.query) {
            const needLongTerm = scope === "long-term" || scope === "all";
            const needSession = (scope === "session" || scope === "all") && Boolean(currentSessionId);
            const [longTermResults, sessionResults] = await Promise.all([
              needLongTerm ? provider.search(params.query, buildSearchOptions(effectiveUserId, effectiveLimit)) : Promise.resolve([] as MemoryItem[]),
              needSession ? provider.search(params.query, buildSearchOptions(effectiveUserId, effectiveLimit, currentSessionId)) : Promise.resolve([] as MemoryItem[]),
            ]);

            const dedup = new Set<string>();
            const results: MemoryItem[] = [];
            for (const item of [...longTermResults, ...sessionResults]) {
              if (!item || !item.id || dedup.has(item.id)) continue;
              dedup.add(item.id);
              results.push(item);
            }

            if (results.length === 0) {
              return { content: [{ type: "text", text: "No matching memories found." }] };
            }

            const normalizedQuery = String(params.query).trim().toLowerCase();
            const exactMatches = results.filter((item) => String(item.memory || "").trim().toLowerCase() === normalizedQuery);
            const candidates = exactMatches.length > 0 ? exactMatches : results;

            if (params.deleteAll === true) {
              const failed: string[] = [];
              let deleted = 0;
              for (const item of candidates) {
                try {
                  await provider.delete(item.id);
                  deleted++;
                } catch {
                  failed.push(item.id);
                }
              }
              if (deleted > 0) clearSearchCache();
              const failedText = failed.length ? ` Failed IDs: ${failed.join(", ")}` : "";
              return {
                content: [{
                  type: "text",
                  text: `Deleted ${deleted}/${candidates.length} memories by query "${params.query}".${failedText}`
                }],
                details: { deleted, attempted: candidates.length, failedIds: failed, candidates }
              };
            }

            if (candidates.length === 1) {
              await provider.delete(candidates[0].id);
              clearSearchCache();
              return { content: [{ type: "text", text: `Deleted [id:${candidates[0].id}]: ${previewMemoryText(candidates[0].memory)}` }] };
            }

            const lines = candidates.slice(0, effectiveLimit).map((r, i) => {
              const score = r.score != null ? ` score=${(r.score * 100).toFixed(0)}%` : "";
              return `${i + 1}. [id:${r.id}] ${previewMemoryText(r.memory)}${score}`;
            });

            return {
              content: [{
                type: "text",
                text: `Found ${candidates.length} candidates for "${params.query}" (scope=${scope}).\n${lines.join("\n")}\nUse memory_forget with memoryId, or set deleteAll=true to remove all listed candidates.`
              }],
              details: { count: candidates.length, candidates }
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
        clearSearchCache();
        console.log("\n✅ Import complete. You can now disable the default memory.");
      });

      mem0.command("stats").action(async () => {
        try {
          const stats = await provider.getStats();
          const formatSize = (bytes: number) => {
            if (bytes < 1024) return `${bytes} B`;
            if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
          };
          
          console.log("\n📊 OpenClaw Mem0 Statistics");
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
          console.log(`Mode:           ${cfg.mode}`);
          console.log(`User ID:        ${cfg.userId}`);
          console.log(`Auto Recall:    ${cfg.autoRecall ? "✅" : "❌"}`);
          console.log(`Auto Capture:   ${cfg.autoCapture ? "✅" : "❌"}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`Total Memories: ${stats.totalMemories}`);
          console.log(`Hot Storage:    ${formatSize(stats.dbSize)}`);
          console.log(`Archive Size:   ${formatSize(stats.archiveSize)}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`Write Queue:`);
          console.log(`  - Pending:    ${stats.writeQueueStats.currentQueue}`);
          console.log(`  - Total:      ${stats.writeQueueStats.totalWrites}`);
          console.log(`  - Max Peak:   ${stats.writeQueueStats.queueMax}`);
          console.log("");
        } catch(e) { 
          console.error("Failed to get stats:", e); 
        }
      });

      mem0.command("dashboard").action(async () => {
        try {
          const stats = await provider.getStats();
          const memories = await provider.getAll({ user_id: cfg.userId });
          
          console.log("\n╔════════════════════════════════════════════════════════════╗");
          console.log("║               🧠 MEM0 MEMORY DASHBOARD                     ║");
          console.log("╠════════════════════════════════════════════════════════════╣");
          console.log(`║ Mode: ${cfg.mode.padEnd(20)} User: ${cfg.userId.padEnd(20)} ║`);
          console.log("╠════════════════════════════════════════════════════════════╣");
          console.log(`║ 📊 Total Memories: ${(stats.totalMemories.toString()).padEnd(38)} ║`);
          console.log(`║ 💾 Hot Storage:    ${(stats.dbSize + " bytes").padEnd(38)} ║`);
          console.log(`║ 📦 Archive Size:   ${(stats.archiveSize + " bytes").padEnd(38)} ║`);
          console.log("╠════════════════════════════════════════════════════════════╣");
          
          if (memories.length > 0) {
            console.log("║ 📝 Recent Memories:                                        ║");
            const recent = memories.slice(-5).reverse();
            for (const m of recent) {
              const preview = m.memory.substring(0, 45) + (m.memory.length > 45 ? "..." : "");
              console.log(`║   • ${preview.padEnd(53)} ║`);
            }
          }
          console.log("╚════════════════════════════════════════════════════════════╝");
        } catch(e) {
          console.error("Failed to load dashboard:", e);
        }
      });
    });

    // ── Lifecycle ───────────────────────────────────────────────────────────
    const pluginDir = path.dirname(path.dirname(new URL(import.meta.url).pathname));
    const workspaceDir = path.join(home, ".openclaw", "workspace");
    
    const reflectionEngine = new ReflectionEngine(cfg.oss?.llm, api.logger, dataDir);
    const archiveManager = new ArchiveManager(dataDir, api.logger);
    const memoryIngestor = new MemoryIngestor(workspaceDir, provider, api.logger, cfg.userId);
    const captureBatchWindowMs = Math.max(200, Number(process.env.MEM0_CAPTURE_BATCH_WINDOW_MS ?? 1200) || 1200);
    const captureBatchMaxMessages = Math.max(10, Number(process.env.MEM0_CAPTURE_BATCH_MAX_MSGS ?? 30) || 30);
    const captureBuffers = new Map<string, { sessionId?: string; messages: Array<{ role: "user" | "assistant"; content: string }> }>();
    const captureTimers = new Map<string, NodeJS.Timeout>();

    const getCaptureBufferKey = (sessionId?: string) => sessionId || "__global__";
    const flushCaptureBuffer = async (bufferKey: string) => {
      const timer = captureTimers.get(bufferKey);
      if (timer) {
        clearTimeout(timer);
        captureTimers.delete(bufferKey);
      }

      const batch = captureBuffers.get(bufferKey);
      if (!batch || !batch.messages.length) return;
      captureBuffers.delete(bufferKey);

      const compactMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
      for (const message of batch.messages) {
        const text = typeof message.content === "string" ? message.content.trim() : "";
        if (!text) continue;
        const previous = compactMessages[compactMessages.length - 1];
        if (previous && previous.role === message.role && previous.content === text) continue;
        compactMessages.push({ role: message.role, content: text });
      }
      const payload = compactMessages.slice(-captureBatchMaxMessages);
      if (!payload.length) return;

      try {
        const res = await provider.add(payload as any, buildAddOptions(undefined, batch.sessionId));
        if (res.results.length > 0) {
          clearSearchCache();
          api.logger.info(`[mem0] ✨ 批量捕获 ${payload.length} 条消息，提取 ${res.results.length} 条新记忆`);
          const mergedQuery = payload.map((m) => m.content).join(" ").slice(0, 2000);
          if (mergedQuery.trim()) {
            const memories = await provider.search(mergedQuery, buildSearchOptions(undefined, cfg.topK));
            reflectionEngine.reflect(payload as any, memories);
          }
        } else {
          api.logger.debug?.(`[mem0] 批量捕获完成，但未提取到新记忆`);
        }
      } catch (err) {
        api.logger.warn(`[mem0] 批量记忆捕获失败: ${err}`);
      }
    };
    const scheduleCaptureBatch = (sessionId: string | undefined, messages: Array<{ role: "user" | "assistant"; content: string }>) => {
      const bufferKey = getCaptureBufferKey(sessionId);
      const current = captureBuffers.get(bufferKey) || { sessionId, messages: [] as Array<{ role: "user" | "assistant"; content: string }> };
      current.sessionId = sessionId || current.sessionId;
      current.messages.push(...messages);
      if (current.messages.length > captureBatchMaxMessages) {
        current.messages = current.messages.slice(-captureBatchMaxMessages);
      }
      captureBuffers.set(bufferKey, current);

      if (captureTimers.has(bufferKey)) {
        clearTimeout(captureTimers.get(bufferKey)!);
      }
      const timer = setTimeout(() => {
        void flushCaptureBuffer(bufferKey);
      }, captureBatchWindowMs);
      captureTimers.set(bufferKey, timer);
    };

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;
        const sessionId = (ctx as any)?.sessionKey;
        if (sessionId) currentSessionId = sessionId;

        try {
          const memories = await provider.search(event.prompt, buildSearchOptions());
          
          if (memories.length > 0) {
            api.logger.info(`[mem0] 🧠 自动回忆: 找到 ${memories.length} 条相关记忆 (注入上下文)`);
          } else {
            api.logger.debug?.(`[mem0] 自动回忆: 未找到相关记忆`);
          }

          const action = reflectionEngine.checkPendingActions();
          
          // Smart context injection with token budget management
          const modelId = (ctx as any)?.modelId || (event as any).model || "default";
          const injectionConfig: SmartInjectionConfig = {
            modelId,
            maxMemories: cfg.topK,
          };
          
          const injection = buildMemoryContext(memories, injectionConfig);
          
          if (injection.truncated) {
            api.logger.debug?.(`[mem0] 上下文已截断: ${injection.injectedCount}/${injection.totalMemories} 条记忆, 约 ${injection.estimatedTokens} tokens`);
          }
          
          let context = injection.context;
          
          if (action) {
            context += `\n<proactive-insight>\n系统提示: ${action.message}\n</proactive-insight>`;
            api.logger.info(`[mem0] 已注入主动提醒: ${action.message}`);
          }
          
          if (context) return { systemContext: context };
        } catch (err) {
          api.logger.warn(`[mem0] 自动回忆失败: ${err}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        api.logger.debug?.(`[mem0] 收到对话结束事件 (success=${event.success}, msgs=${event.messages?.length})`);
        
        if (!event.success || !event.messages?.length) return;
        const sessionId = (ctx as any)?.sessionKey;
        if (sessionId) currentSessionId = sessionId;

        // Helper to extract text from message content (string or array)
        const extractText = (content: any): string => {
          if (typeof content === "string") return content;
          if (Array.isArray(content)) {
            return content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text || "")
              .join("\n");
          }
          return "";
        };

        const validMsgs = event.messages.filter((m: any) => {
          if (m.role !== "user" && m.role !== "assistant") return false;
          const text = extractText(m.content);
          return text.trim().length > 0;
        }).map((m: any) => ({
          role: m.role,
          content: extractText(m.content)
        })).slice(-10);

        if (!validMsgs.length) {
          api.logger.debug?.(`[mem0] 没有有效的文本消息，跳过捕获`);
          return;
        }
        scheduleCaptureBatch(
          currentSessionId,
          validMsgs.map((m: any) => ({ role: m.role as "user" | "assistant", content: m.content }))
        );
      });
    }

    // Heartbeat for Active Brain and Status Updates
    let heartbeat: NodeJS.Timeout;
    
    const updateStatusFile = async () => {
      try {
        const stats = await provider.getStats();
        const statusPath = path.join(dataDir, "mem0-status.json");
        
        const status = {
          ...stats,
          config: {
            mode: cfg.mode,
            userId: cfg.userId,
            autoCapture: cfg.autoCapture,
            autoRecall: cfg.autoRecall,
            maxMemoryCount: cfg.maxMemoryCount,
          },
          version: PLUGIN_VERSION,
        };
        
        fs.writeFileSync(statusPath, JSON.stringify(status, null, 2));
      } catch (err) {
        // Silent fail - not critical
      }
    };
    
    api.registerService({
      id: "openclaw-mem0",
      start: () => {
        // Start memory file watcher
        memoryIngestor.start();

        // Auto-update check on startup
        checkForUpdates(api, pluginDir);

        // Prune old memories if needed
        provider.prune(cfg.userId, cfg.maxMemoryCount || 2000)
          .then((deleted) => {
            if (deleted > 0) {
              clearSearchCache();
              api.logger.info(`[mem0] 🧹 已清理 ${deleted} 条旧记忆 (限制: ${cfg.maxMemoryCount})`);
            }
          })
          .catch((err) => api.logger.warn(`[mem0] 清理失败: ${err}`));

        // Initial status update
        updateStatusFile();

        heartbeat = setInterval(() => {
          reflectionEngine.checkPendingActions();
          // Update status file every minute
          updateStatusFile().catch(() => {});
        }, 60000);
      },
      stop: () => {
        memoryIngestor.stop();
        clearInterval(heartbeat);
        const pendingCaptureKeys = Array.from(captureTimers.keys());
        pendingCaptureKeys.forEach((key) => {
          void flushCaptureBuffer(key);
        });
        const remainingKeys = Array.from(captureBuffers.keys());
        remainingKeys.forEach((key) => {
          void flushCaptureBuffer(key);
        });
        // Final status update on shutdown
        updateStatusFile().catch(() => {});
      }
    });
  }
};

export default memoryPlugin;
