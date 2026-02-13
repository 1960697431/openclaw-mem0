
import { type OpenClawPluginApi } from "openclaw/plugin-sdk";
import { type Mem0Config, type Mem0Provider, type AddOptions, type AddResult, type SearchOptions, type MemoryItem, type ListOptions, type Mem0Stats } from "./types.js";
import { TransformersJsEmbedder, RemoteEmbedder, isRemoteEmbedderProvider, normalizeRemoteEmbedderConfig } from "./embedder.js";
import { cleanJsonResponse } from "./utils.js";
import { UnifiedLLM, createLLM } from "./llm.js";
import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// Write Queue - Protects SQLite from concurrent writes (SQLITE_BUSY)
// ============================================================================
class WriteQueue {
  private queue: Array<() => Promise<any>> = [];
  private processing = false;
  private stats = { totalWrites: 0, queueMax: 0 };
  private readonly writeDelayMs = Math.max(0, Number(process.env.MEM0_WRITE_DELAY_MS ?? 0) || 0);

  async enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      this.stats.queueMax = Math.max(this.stats.queueMax, this.queue.length);
      this.process();
    });
  }

  private async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task();
        this.stats.totalWrites++;
      } catch {
        // Error already handled in the task wrapper
      }
      if (this.writeDelayMs > 0) {
        // Optional delay for conservative environments. Default is 0 for throughput.
        await new Promise(r => setTimeout(r, this.writeDelayMs));
      }
    }
    
    this.processing = false;
  }

  getStats() {
    return { ...this.stats, currentQueue: this.queue.length };
  }
}

// Shared write queue for all OSS operations
const writeQueue = new WriteQueue();

// Serialize temporary process.cwd() switches during Memory initialization.
let cwdSwitchChain: Promise<void> = Promise.resolve();

async function withCwdSwitchLock<T>(fn: () => Promise<T>): Promise<T> {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = cwdSwitchChain;
  cwdSwitchChain = previous.then(() => gate);

  await previous;
  try {
    return await fn();
  } finally {
    release?.();
  }
}

function countLinesFast(filePath: string): number {
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.alloc(64 * 1024);
  let bytesRead = 0;
  let lineCount = 0;
  let lastByte = -1;

  try {
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 10) lineCount++; // '\n'
      }
      if (bytesRead > 0) {
        lastByte = buffer[bytesRead - 1];
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  // Handle non-empty file without trailing newline.
  if (lastByte !== -1 && lastByte !== 10) {
    lineCount += 1;
  }
  return lineCount;
}

// ============================================================================
// UnifiedLLM Adapter - Wraps UnifiedLLM to match mem0ai/oss LLM interface
// ============================================================================
class UnifiedLLMAdapter {
  private unifiedLLM: UnifiedLLM;
  private logger: OpenClawPluginApi["logger"];
  private config: any;

  constructor(unifiedLLM: UnifiedLLM, logger: OpenClawPluginApi["logger"], config: any) {
    this.unifiedLLM = unifiedLLM;
    this.logger = logger;
    this.config = config;
  }

  private normalizeMessages(messages: Array<{ role: string; content: string }>): Array<{ role: "system" | "user" | "assistant"; content: string }> {
    return messages.map((message) => {
      const role = message.role === "system" || message.role === "assistant" || message.role === "user"
        ? message.role
        : "user";
      const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
      return { role, content };
    });
  }

  private ensureJsonObjectResponse(raw: string): string {
    const cleaned = cleanJsonResponse(raw || "").trim();
    if (!cleaned) {
      this.logger.debug?.("[mem0] LLM returned empty JSON-mode response, falling back to {}");
      return "{}";
    }
    try {
      JSON.parse(cleaned);
      return cleaned;
    } catch {
      this.logger.debug?.(`[mem0] LLM returned invalid JSON-mode response, fallback to {}. preview=${cleaned.slice(0, 120)}`);
      return "{}";
    }
  }

  private isJsonModeRequest(options: any): boolean {
    // mem0ai/oss uses { type: "json_object" } directly.
    if (options?.type === "json_object") return true;
    // Some wrappers pass { responseFormat: { type: "json_object" } }.
    if (options?.responseFormat?.type === "json_object") return true;
    return false;
  }

  async generate(
    messages: Array<{ role: string; content: string }>,
    options?: { responseFormat?: { type: string }; temperature?: number }
  ): Promise<string> {
    try {
      const jsonMode = this.isJsonModeRequest(options);
      const result = await this.unifiedLLM.generate(this.normalizeMessages(messages), {
        jsonMode,
        temperature: options?.temperature,
      });
      return jsonMode ? this.ensureJsonObjectResponse(result) : result;
    } catch (error: any) {
      this.logger.error(`[mem0] UnifiedLLM generation failed: ${error.message}`);
      throw error;
    }
  }

  // Provide backward compatibility with JsonCleaningLLM behavior
  async chat(messages: Array<{ role: string; content: string }>, options?: any): Promise<any> {
    const content = await this.generate(messages, options);
    return {
      choices: [{
        message: {
          role: "assistant",
          content: content,
        },
      }],
    };
  }

  async generateChat(messages: Array<{ role: string; content: string }>): Promise<{ content: string; role: string }> {
    const content = await this.generate(messages);
    return {
      role: "assistant",
      content,
    };
  }

  // mem0ai/oss compatibility - it calls this.llm.generateResponse()
  async generateResponse(messages: Array<{ role: string; content: string }>, options?: any): Promise<string> {
    return this.generate(messages, options);
  }
}

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
    private readonly statsUserId: string,
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

  async getStats(): Promise<Mem0Stats> {
    await this.ensureClient();
    
    let totalMemories = 0;
    try {
      const memories = await this.getAll({ user_id: this.statsUserId });
      totalMemories = memories.length;
    } catch {}

    let archiveSize = 0;
    try {
      const archivePath = path.join(this.baseDir, "mem0-archive.jsonl");
      if (fs.existsSync(archivePath)) {
        archiveSize = fs.statSync(archivePath).size;
      }
    } catch {}

    return {
      totalMemories,
      archiveSize,
      dbSize: 0, // Platform mode uses cloud storage
      writeQueueStats: { totalWrites: 0, queueMax: 0, currentQueue: 0 },
      lastUpdated: new Date().toISOString(),
    };
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
    if (raw && typeof raw === "object" && (raw.id || raw.memory_id || raw.memory || raw.text)) {
      return {
        results: [{
          id: raw.id ?? raw.memory_id ?? "",
          memory: raw.memory ?? raw.text ?? "",
          event: raw.event ?? raw.metadata?.event ?? "ADD",
        }],
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
  private archiveLineCountCache: { mtimeMs: number; size: number; lineCount: number } | null = null;

  constructor(
    private readonly ossConfig: Mem0Config["oss"],
    private readonly customPrompt: string | undefined,
    private readonly resolvePath: (p: string) => string,
    private readonly statsUserId: string,
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
    const self = this;

    // Patch Embedder
    const originalEmbedderCreate = EmbedderFactory.create.bind(EmbedderFactory);
    EmbedderFactory.create = (provider: string, config: any) => {
      const providerLower = (provider || "").toLowerCase();
      if (providerLower === "transformersjs") {
        return new TransformersJsEmbedder(config);
      }
      if (isRemoteEmbedderProvider(providerLower)) {
        const normalized = normalizeRemoteEmbedderConfig(providerLower, config || {});
        self.logger?.info(`[mem0] Embedder Init: ${providerLower} (${normalized.model || "auto"})`);
        return new RemoteEmbedder(normalized);
      }
      return originalEmbedderCreate(provider, config);
    };

    // Patch LLM with UnifiedLLM for multi-format support
    LLMFactory.create = (provider: string, config: any) => {
      self.logger?.info(`[mem0] LLM Init: ${provider} (${config?.model})`);
      
      // Create UnifiedLLM for multi-format API support
      const unifiedLLM = createLLM({ provider, config }, self.logger);
      
      // Return adapter that wraps UnifiedLLM to match mem0ai/oss interface
      return new UnifiedLLMAdapter(unifiedLLM, self.logger, config);
    };

    const config: Record<string, unknown> = { version: "v1.1" };
    
    // Ensure baseDir exists
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
    
    // Auto-configure embedder dimensions and normalize remote embedder config.
    let embedderDims: number | undefined;

    if (this.ossConfig?.embedder) {
      const embedder = JSON.parse(JSON.stringify(this.ossConfig.embedder));
      const embedderProvider = (embedder?.provider || "").toLowerCase();
      if (embedderProvider === "transformersjs") {
        if (!embedder.config?.embeddingDims) {
          embedder.config = embedder.config || {};
          embedder.config.embeddingDims = 1024;
        }
        embedderDims = Number(embedder.config.embeddingDims) || 1024;
      } else if (isRemoteEmbedderProvider(embedderProvider)) {
        embedder.config = embedder.config || {};
        const llmConfig = (this.ossConfig?.llm?.config || {}) as Record<string, any>;
        if (!embedder.config.apiKey && llmConfig.apiKey) {
          embedder.config.apiKey = llmConfig.apiKey;
        }
        if (!embedder.config.headers && llmConfig.headers) {
          embedder.config.headers = llmConfig.headers;
        }
        if (!embedder.config.timeout && llmConfig.timeout) {
          embedder.config.timeout = llmConfig.timeout;
        }
        if (
          !embedder.config.baseURL &&
          !embedder.config.url &&
          llmConfig.baseURL &&
          embedderProvider !== "gemini" &&
          embedderProvider !== "google" &&
          embedderProvider !== "ollama"
        ) {
          embedder.config.baseURL = llmConfig.baseURL;
        }
        const normalizedEmbedderConfig = normalizeRemoteEmbedderConfig(embedderProvider, embedder.config);
        embedder.config = normalizedEmbedderConfig;
        embedderDims = Number(normalizedEmbedderConfig.embeddingDims) || 1024;
      } else {
        embedderDims = Number(embedder.config?.embeddingDims) || undefined;
      }
      config.embedder = embedder;
    }

    // Vector Store config - use "memory" provider (which still uses SQLite internally)
    // Valid providers: memory, qdrant, redis, supabase, vectorize, azure-ai-search
    if (this.ossConfig?.vectorStore) {
      const vectorStore = JSON.parse(JSON.stringify(this.ossConfig.vectorStore));
      const validProviders = ['memory', 'qdrant', 'redis', 'supabase', 'vectorize', 'azure-ai-search'];
      if (!validProviders.includes((vectorStore.provider || '').toLowerCase())) {
        this.logger?.warn(`[mem0] Invalid vectorStore provider '${vectorStore.provider}', using 'memory'`);
        vectorStore.provider = 'memory';
      }
      if (vectorStore.config?.dbPath && typeof vectorStore.config.dbPath === "string") {
        vectorStore.config.dbPath = this.resolvePath(vectorStore.config.dbPath);
      }
      if (vectorStore.config?.path && typeof vectorStore.config.path === "string") {
        vectorStore.config.path = this.resolvePath(vectorStore.config.path);
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
    
    await withCwdSwitchLock(async () => {
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
    });
  }

  // Adapter methods mapping unified interface to OSS SDK (camelCase)
  async add(messages: Array<{ role: string; content: string }>, options: AddOptions): Promise<AddResult> {
    await this.ensureMemory();
    return writeQueue.enqueue(async () => {
      const opts: any = { userId: options.user_id };
      if (options.run_id) opts.runId = options.run_id;
      const result = await this.memory.add(messages, opts);
      return this.normalizeAddResult(result);
    });
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
    
    if (Array.isArray(results)) return results.map(this.normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results)) return results.results.map(this.normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureMemory();
    return writeQueue.enqueue(async () => {
      await this.memory.delete(memoryId);
    });
  }

  async prune(userId: string, maxCount: number): Promise<number> {
    await this.ensureMemory();
    const memories = await this.getAll({ user_id: userId });
    if (memories.length <= maxCount) return 0;

    memories.sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime());
    const toDelete = memories.slice(0, memories.length - maxCount);

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

  async getStats(): Promise<Mem0Stats> {
    await this.ensureMemory();
    
    // Get memory count
    let totalMemories = 0;
    try {
      const memories = await this.getAll({ user_id: this.statsUserId });
      totalMemories = memories.length;
    } catch {}

    // Get file sizes
    let dbSize = 0;
    let archiveSize = 0;
    
    try {
      const dbPath = path.join(this.baseDir, "vector_store.db");
      if (fs.existsSync(dbPath)) {
        dbSize = fs.statSync(dbPath).size;
      }
    } catch {}

    try {
      const archivePath = path.join(this.baseDir, "mem0-archive.jsonl");
      if (fs.existsSync(archivePath)) {
        const stat = fs.statSync(archivePath);
        archiveSize = stat.size;
        let lineCount = 0;
        if (
          this.archiveLineCountCache &&
          this.archiveLineCountCache.mtimeMs === stat.mtimeMs &&
          this.archiveLineCountCache.size === stat.size
        ) {
          lineCount = this.archiveLineCountCache.lineCount;
        } else {
          lineCount = countLinesFast(archivePath);
          this.archiveLineCountCache = {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            lineCount,
          };
        }
        totalMemories += lineCount;
      }
    } catch {}

    return {
      totalMemories,
      archiveSize,
      dbSize,
      writeQueueStats: writeQueue.getStats(),
      lastUpdated: new Date().toISOString(),
    };
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
    if (Array.isArray(raw)) {
      return {
        results: raw.map((r: any) => ({
          id: r.id ?? r.memory_id ?? "",
          memory: r.memory ?? r.text ?? "",
          event: r.event ?? r.metadata?.event ?? "ADD",
        })),
      };
    }
    if (raw && typeof raw === "object" && (raw.id || raw.memory_id || raw.memory || raw.text)) {
      return {
        results: [{
          id: raw.id ?? raw.memory_id ?? "",
          memory: raw.memory ?? raw.text ?? "",
          event: raw.event ?? raw.metadata?.event ?? "ADD",
        }],
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
      cfg.userId,
      api.logger,
      dataDir
    );
  }
  return new PlatformProvider(cfg.apiKey!, cfg.orgId, cfg.projectId, cfg.userId, api.logger, dataDir);
}
