
import { type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type Mem0Config, type Mem0Provider, type AddOptions, type AddResult, type SearchOptions, type MemoryItem, type ListOptions } from "./types.js";
import { TransformersJsEmbedder } from "./embedder.js";
import { JsonCleaningLLM } from "./utils.js";
import * as fs from "node:fs";
import * as path from "node:path";

// Helper to archive memories before deletion
function archiveMemories(memories: MemoryItem[], baseDir: string, logger: any) {
  if (!memories.length) return;
  
  const archivePath = path.join(baseDir, "mem0-archive.jsonl");
  const archiveData = memories.map(m => JSON.stringify(m)).join("\n") + "\n";
  
  try {
    fs.appendFileSync(archivePath, archiveData, "utf-8");
    logger.info(`[mem0] Archived ${memories.length} memories to ${archivePath}`);
  } catch (err) {
    logger.error(`[mem0] Failed to archive memories: ${err}`);
    // If archive fails, DO NOT proceed to delete? 
    // Let's assume we shouldn't block pruning, but logging error is crucial.
  }
}

// ============================================================================
// Platform Provider
// ============================================================================
export class PlatformProvider implements Mem0Provider {
  private client: any;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly orgId: string | undefined,
    private readonly projectId: string | undefined,
    private readonly logger: OpenClawPluginApi["logger"],
    private readonly baseDir: string,
  ) { }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const module = await import("mem0ai");
    const MemoryClient = (module.default || module.MemoryClient) as any;
    
    const opts: Record<string, string> = { apiKey: this.apiKey };
    if (this.orgId) opts.org_id = this.orgId;
    if (this.projectId) opts.project_id = this.projectId;
    this.client = new MemoryClient(opts);
  }

  async add(messages: Array<{ role: string; content: string }>, options: AddOptions): Promise<AddResult> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.custom_instructions) opts.custom_instructions = options.custom_instructions;
    if (options.custom_categories) opts.custom_categories = options.custom_categories;
    if (options.enable_graph) opts.enable_graph = options.enable_graph;
    if (options.output_format) opts.output_format = options.output_format;

    const result = await this.client.add(messages, opts);
    return this.normalizeAddResult(result);
  }

  async search(query: string, options: SearchOptions): Promise<MemoryItem[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.top_k != null) opts.top_k = options.top_k;
    if (options.threshold != null) opts.threshold = options.threshold;
    
    const results = await this.client.search(query, opts);
    return this.normalizeSearchResults(results);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    await this.ensureClient();
    const result = await this.client.get(memoryId);
    return this.normalizeMemoryItem(result);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.page_size != null) opts.page_size = options.page_size;

    const results = await this.client.getAll(opts);
    if (Array.isArray(results)) return results.map(this.normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results)) return results.results.map(this.normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureClient();
    await this.client.delete(memoryId);
  }

  async prune(userId: string, maxCount: number): Promise<number> {
    await this.ensureClient();
    const memories = await this.getAll({ user_id: userId });
    if (memories.length <= maxCount) return 0;

    // Sort by created_at ascending (oldest first)
    memories.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
    
    // Identify items to prune
    const toDelete = memories.slice(0, memories.length - maxCount);

    // Archive first (Safe Pruning)
    archiveMemories(toDelete, this.baseDir, this.logger);

    let deleted = 0;
    // Sequential delete to be safe
    for (const mem of toDelete) {
      try {
        await this.delete(mem.id);
        deleted++;
      } catch { /* ignore */ }
    }
    return deleted;
  }

  private normalizeMemoryItem(raw: any): MemoryItem {
    return {
      id: raw.id ?? raw.memory_id ?? "",
      memory: raw.memory ?? raw.text ?? raw.content ?? "",
      user_id: raw.user_id ?? raw.userId,
      score: raw.score,
      categories: raw.categories,
      metadata: raw.metadata,
      created_at: raw.created_at ?? raw.createdAt,
      updated_at: raw.updated_at ?? raw.updatedAt,
    };
  }

  private normalizeSearchResults(raw: any): MemoryItem[] {
    if (Array.isArray(raw)) return raw.map(this.normalizeMemoryItem);
    if (raw?.results && Array.isArray(raw.results)) return raw.results.map(this.normalizeMemoryItem);
    return [];
  }

  private normalizeAddResult(raw: any): AddResult {
    if (raw?.results && Array.isArray(raw.results)) {
      return {
        results: raw.results.map((r: any) => ({
          id: r.id ?? r.memory_id ?? "",
          memory: r.memory ?? r.text ?? "",
          event: r.event ?? r.metadata?.event ?? "ADD",
        })),
      };
    }
    if (Array.isArray(raw)) {
      return {
        results: raw.map((r: any) => ({
          id: r.id ?? r.memory_id ?? "",
          memory: r.memory ?? r.text ?? "",
          event: r.event ?? r.metadata?.event ?? "ADD",
        })),
      };
    }
    return { results: [] };
  }
}

// ============================================================================
// OSS Provider
// ============================================================================
export class OSSProvider implements Mem0Provider {
  private memory: any;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly ossConfig: Mem0Config["oss"],
    private readonly customPrompt: string | undefined,
    private readonly resolvePath: (p: string) => string,
    private readonly logger: OpenClawPluginApi["logger"],
    private readonly baseDir: string,
  ) { }

  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    process.env.MEM0_TELEMETRY = "false";

    const mem0Oss = await import("mem0ai/oss");
    const { Memory, EmbedderFactory, LLMFactory } = mem0Oss;

    // Patch Embedder
    const originalEmbedderCreate = EmbedderFactory.create.bind(EmbedderFactory);
    EmbedderFactory.create = (provider: string, config: any) => {
      if (provider.toLowerCase() === "transformersjs") {
        return new TransformersJsEmbedder(config);
      }
      return originalEmbedderCreate(provider, config);
    };

    // Patch LLM
    const originalLLMCreate = LLMFactory.create.bind(LLMFactory);
    const self = this;
    LLMFactory.create = (provider: string, config: any) => {
      self.logger?.info(`[mem0] LLM Init: ${provider} (${config?.model})`);
      const llm = originalLLMCreate(provider, config);

      // Fix OpenRouter headers
      if (provider === "openai" && (llm as any).openai) {
        const oa = (llm as any).openai;
        oa.defaultHeaders = { 
          ...(oa.defaultHeaders || {}),
          "HTTP-Referer": "https://github.com/1960697431/openclaw-mem0",
          "X-Title": "OpenClaw Mem0"
        };
      }
      return new JsonCleaningLLM(llm, self.logger);
    };

    const config: Record<string, unknown> = { version: "v1.1" };
    
    // Ensure baseDir exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    
    // Auto-configure dims for Qwen3
    const isTransformer = this.ossConfig?.embedder?.provider?.toLowerCase() === "transformersjs";
    const embedderDims = this.ossConfig?.embedder?.config?.embeddingDims ?? (isTransformer ? 1024 : undefined);

    if (this.ossConfig?.embedder) config.embedder = this.ossConfig.embedder;

    // Vector Store config - use "memory" provider (which still uses SQLite internally)
    // Valid providers: memory, qdrant, redis, supabase, vectorize, azure-ai-search
    if (this.ossConfig?.vectorStore) {
      const vectorStore = JSON.parse(JSON.stringify(this.ossConfig.vectorStore));
      const validProviders = ['memory', 'qdrant', 'redis', 'supabase', 'vectorize', 'azure-ai-search'];
      if (!validProviders.includes((vectorStore.provider || '').toLowerCase())) {
        this.logger?.warn(`[mem0] Invalid vectorStore provider '${vectorStore.provider}', using 'memory'`);
        vectorStore.provider = 'memory';
      }
      if (!vectorStore.config?.dimension && embedderDims) {
        vectorStore.config = vectorStore.config || {};
        vectorStore.config.dimension = embedderDims;
      }
      config.vectorStore = vectorStore;
    } else {
      config.vectorStore = {
        provider: "memory",
        config: { dimension: embedderDims || 1024 },
      };
    }

    if (this.ossConfig?.llm) config.llm = this.ossConfig.llm;

    // Disable history to avoid extra SQLite databases
    config.disableHistory = true;

    if (this.customPrompt) config.customPrompt = this.customPrompt;

    // CRITICAL: mem0ai/oss MemoryVectorStore uses process.cwd() for SQLite path
    // We must change CWD to our data directory before creating Memory
    const originalCwd = process.cwd();
    const vectorDbPath = path.join(this.baseDir, "vector_store.db");
    
    // Pre-create the SQLite db file
    try {
      fs.closeSync(fs.openSync(vectorDbPath, 'a'));
    } catch {}
    
    try {
      process.chdir(this.baseDir);
      this.memory = new Memory(config);
    } catch (err: any) {
      this.logger?.error(`[mem0] Memory init failed: ${err.message}`);
      throw err;
    } finally {
      // Restore original CWD
      try { process.chdir(originalCwd); } catch {}
    }
  }

  // Adapter methods mapping unified interface to OSS SDK (camelCase)
  async add(messages: Array<{ role: string; content: string }>, options: AddOptions): Promise<AddResult> {
    await this.ensureMemory();
    const opts: any = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    const result = await this.memory.add(messages, opts);
    return this.normalizeAddResult(result);
  }

  async search(query: string, options: SearchOptions): Promise<MemoryItem[]> {
    await this.ensureMemory();
    const opts: any = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    if (options.limit != null) opts.limit = options.limit;
    else if (options.top_k != null) opts.limit = options.top_k;
    
    const results = await this.memory.search(query, opts);
    return this.normalizeSearchResults(results);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    await this.ensureMemory();
    const result = await this.memory.get(memoryId);
    return this.normalizeMemoryItem(result);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    await this.ensureMemory();
    const opts: any = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    const results = await this.memory.getAll(opts);
    
    // Handle SDK quirks where it might return array or object
    if (Array.isArray(results)) return results.map(this.normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results)) return results.results.map(this.normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureMemory();
    await this.memory.delete(memoryId);
  }

  async prune(userId: string, maxCount: number): Promise<number> {
    await this.ensureMemory();
    const memories = await this.getAll({ user_id: userId });
    if (memories.length <= maxCount) return 0;

    memories.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
    const toDelete = memories.slice(0, memories.length - maxCount);

    // Archive first (Safe Pruning)
    // Use the consistent baseDir (plugin directory)
    archiveMemories(toDelete, this.baseDir, this.logger);

    let deleted = 0;
    for (const mem of toDelete) {
      try {
        await this.delete(mem.id);
        deleted++;
      } catch { /* ignore */ }
    }
    return deleted;
  }

  // Normalization Helpers (Duplicate logic but keeps classes decoupled)
  private normalizeMemoryItem(raw: any): MemoryItem {
    return {
      id: raw.id ?? raw.memory_id ?? "",
      memory: raw.memory ?? raw.text ?? raw.content ?? "",
      user_id: raw.user_id ?? raw.userId,
      score: raw.score,
      categories: raw.categories,
      metadata: raw.metadata,
      created_at: raw.created_at ?? raw.createdAt,
      updated_at: raw.updated_at ?? raw.updatedAt,
    };
  }

  private normalizeSearchResults(raw: any): MemoryItem[] {
    if (Array.isArray(raw)) return raw.map(this.normalizeMemoryItem);
    if (raw?.results && Array.isArray(raw.results)) return raw.results.map(this.normalizeMemoryItem);
    return [];
  }

  private normalizeAddResult(raw: any): AddResult {
    // OSS SDK usually returns { results: [...] }
    if (raw?.results && Array.isArray(raw.results)) {
      return {
        results: raw.results.map((r: any) => ({
          id: r.id ?? r.memory_id ?? "",
          memory: r.memory ?? r.text ?? "",
          event: r.event ?? r.metadata?.event ?? "ADD",
        })),
      };
    }
    return { results: [] };
  }
}

export function createProvider(cfg: Mem0Config, api: OpenClawPluginApi, dataDir: string): Mem0Provider {
  if (cfg.mode === "open-source") {
    // Inject dataDir into default OSS config if paths are not absolute
    if (cfg.oss && cfg.oss.vectorStore && cfg.oss.vectorStore.config && !cfg.oss.vectorStore.config.dbPath) {
       // If user didn't specify dbPath, SDK defaults to current dir. We want dataDir.
       // Note: mem0ai/oss might default to ./lancedb or similar.
       // We can try to force it by modifying the config passed to OSSProvider
       // But OSSProvider logic uses resolvePath.
    }
    
    return new OSSProvider(
      cfg.oss,
      cfg.customPrompt,
      (p) => {
        // If path is relative, resolve it against dataDir instead of pluginDir
        if (path.isAbsolute(p)) return p;
        return path.join(dataDir, p);
      },
      api.logger,
      dataDir
    );
  }
  return new PlatformProvider(cfg.apiKey!, cfg.orgId, cfg.projectId, api.logger, dataDir);
}
