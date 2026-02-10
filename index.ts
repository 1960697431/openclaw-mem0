/**
 * OpenClaw Memory (Mem0) Plugin
 *
 * Long-term memory via Mem0 — supports both the Mem0 platform
 * and the open-source self-hosted SDK. Uses the official `mem0ai` package.
 *
 * Features:
 * - 5 tools: memory_search, memory_list, memory_store, memory_get, memory_forget
 *   (with session/long-term scope support via scope and longTerm parameters)
 * - Short-term (session-scoped) and long-term (user-scoped) memory
 * - Auto-recall: injects relevant memories (both scopes) before each agent turn
 * - Auto-capture: stores key facts scoped to the current session after each agent turn
 * - CLI: openclaw mem0 search, openclaw mem0 stats
 * - Dual mode: platform or open-source (self-hosted)
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// TransformersJs Embedder (Local ONNX model via @huggingface/transformers)
// ============================================================================

/**
 * Local embedder using @huggingface/transformers to run ONNX models.
 * Default: Qwen3-Embedding-0.6B-ONNX (600M params, 1024 dims, 100+ languages)
 */
class TransformersJsEmbedder {
  private extractor: any = null;
  private initPromise: Promise<void> | null = null;
  private model: string;
  private embeddingDims: number;

  constructor(config: { model?: string; embeddingDims?: number }) {
    this.model = config.model || "onnx-community/Qwen3-Embedding-0.6B-ONNX";
    this.embeddingDims = config.embeddingDims || 1024;
  }

  private async ensureExtractor(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    console.log(`[mem0] Loading transformers.js model: ${this.model}...`);
    const { pipeline } = await import("@huggingface/transformers");
    this.extractor = await pipeline("feature-extraction", this.model, {
      dtype: "q8", // Quantized version (~700MB vs 2.4GB)
    });
    console.log(`[mem0] Model loaded successfully.`);
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureExtractor();
    const output = await this.extractor([text], {
      pooling: "last_token",
      normalize: true,
    });
    return output.tolist()[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureExtractor();
    const output = await this.extractor(texts, {
      pooling: "last_token",
      normalize: true,
    });
    return output.tolist();
  }
}

// ============================================================================
// JSON Cleaning LLM Wrapper (Strips markdown code blocks from responses)
// ============================================================================

/**
 * Wraps an LLM instance to strip markdown code blocks from JSON responses.
 * Fixes Gemini and other models that return ```json ... ``` instead of raw JSON.
 */
class JsonCleaningLLM {
  constructor(private wrappedLLM: any) { }

  /**
   * Extracts JSON from LLM responses that may contain markdown code blocks,
   * preamble text, or other non-JSON content.
   * Handles verbose models (e.g. Ollama) that add explanations around JSON.
   */
  private cleanJsonResponse(content: string): string {
    if (!content || typeof content !== "string") return content;

    let cleaned = content.trim();

    // Strategy 1: Full-text code block (```json ... ``` or ``` ... ```)
    const fullMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fullMatch) {
      return fullMatch[1].trim();
    }

    // Strategy 2: Extract the LAST code block from verbose response
    // (models often add explanation before the JSON block)
    const codeBlocks = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
    if (codeBlocks.length > 0) {
      // Use the last code block (usually the actual JSON output)
      const lastBlock = codeBlocks[codeBlocks.length - 1][1].trim();
      // Verify it looks like JSON
      if (lastBlock.startsWith("{") || lastBlock.startsWith("[")) {
        return lastBlock;
      }
      // If not JSON-like, still return it (might be the intended output)
      return lastBlock;
    }

    // Strategy 3: Find raw JSON object/array in the response
    // (model returned JSON without code blocks but with surrounding text)
    const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (jsonMatch) {
      // Validate it's parseable JSON
      try {
        JSON.parse(jsonMatch[1]);
        return jsonMatch[1];
      } catch {
        // Not valid JSON, fall through
      }
    }

    // Strategy 4: Return as-is (already clean or unparseable)
    return cleaned;
  }

  async generateResponse(
    messages: Array<{ role: string; content: string }>,
    responseFormat?: any,
    tools?: any
  ): Promise<string | { content: string; role: string; toolCalls?: any[] }> {
    const response = await this.wrappedLLM.generateResponse(
      messages,
      responseFormat,
      tools
    );

    // If response is a string, clean it
    if (typeof response === "string") {
      return this.cleanJsonResponse(response);
    }

    // If response is an object with content, clean the content
    if (response && typeof response === "object" && response.content) {
      return {
        ...response,
        content: this.cleanJsonResponse(response.content),
      };
    }

    return response;
  }

  async generateChat(
    messages: Array<{ role: string; content: string }>
  ): Promise<{ content: string; role: string }> {
    const response = await this.wrappedLLM.generateChat(messages);

    if (response && response.content) {
      return {
        ...response,
        content: this.cleanJsonResponse(response.content),
      };
    }

    return response;
  }
}

// ============================================================================
// Reflection Engine — Active Brain (Intent Detection & Proactive Triggers)
// ============================================================================

/**
 * A pending action discovered by the reflection engine.
 * Stored in memory, checked by the heartbeat timer.
 */
type PendingAction = {
  id: string;
  message: string;
  createdAt: number;
  triggerAt: number; // Unix timestamp (ms) when this action should fire
  fired: boolean;
};

/**
 * The Reflection Engine analyzes newly captured memories to discover
 * user intent, reminders, follow-ups, and patterns. It runs silently
 * after every auto-capture cycle.
 *
 * Inspired by memU's five-step proactive loop:
 *   Record → Organize → Retrieve → Reflect → Trigger/Act
 * This engine handles the "Reflect" and "Trigger" steps.
 */
class ReflectionEngine {
  private pendingActions: PendingAction[] = [];
  private readonly MAX_PENDING = 5;
  private readonly ACTION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Built-in reflection prompt — invisible to users
  private readonly REFLECTION_PROMPT = `You are a silent background memory analyzer for an AI assistant. Your job is to detect if the user has implied any future intent, reminder, follow-up, or recurring pattern.

Analyze the following recent conversation and memories. Look for:
1. Explicit reminders ("remind me", "don't forget", "tomorrow I need to...")
2. Implicit intent ("I should probably...", "I'll deal with that later")
3. Follow-up tasks ("let me know when...", "check back on...")
4. Time-sensitive items (meetings, deadlines, appointments)
5. Behavioral patterns (user always asks about X in the morning)

IMPORTANT:
- Only flag genuinely actionable items. Do NOT flag casual conversation.
- Be conservative. When in doubt, return should_act: false.
- The message should be natural and helpful, like a thoughtful assistant.
- Estimate delay_minutes based on context (e.g., "tomorrow morning" = ~720 min).

Respond with ONLY valid JSON, no markdown:
{"should_act": true, "message": "friendly reminder text", "delay_minutes": 30}
or
{"should_act": false}`;

  constructor(
    private readonly llmConfig?: { provider: string; config: Record<string, unknown> },
    private readonly logger?: { info: (msg: string) => void; debug?: (msg: string) => void; warn: (msg: string) => void },
  ) { }

  /**
   * Called after auto-capture stores new memories.
   * Sends the recent conversation to the LLM for intent analysis.
   */
  async reflect(
    recentMessages: Array<{ role: string; content: string }>,
    recentMemories: Array<{ memory: string }>,
  ): Promise<void> {
    if (!this.llmConfig) return;
    if (recentMessages.length === 0) return;

    // Prune expired/fired actions first
    this.pruneActions();
    if (this.pendingActions.length >= this.MAX_PENDING) return;

    try {
      // Build context for the LLM
      const conversationSummary = recentMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n");

      const memorySummary = recentMemories.length > 0
        ? recentMemories.map((m) => `- ${m.memory}`).join("\n")
        : "(no stored memories yet)";

      const userPrompt = `Recent conversation:\n${conversationSummary}\n\nStored memories:\n${memorySummary}`;

      // Call the LLM directly via OpenAI-compatible API
      const llmCfg = this.llmConfig.config;
      const baseURL = (llmCfg.baseURL as string) || "https://api.openai.com/v1";
      const apiKey = (llmCfg.apiKey as string) || "";
      const model = (llmCfg.model as string) || "gpt-4o";

      const response = await fetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: this.REFLECTION_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
          max_tokens: 200,
        }),
      });

      if (!response.ok) {
        this.logger?.debug?.(`openclaw-mem0: reflection LLM returned ${response.status}`);
        return;
      }

      const data = (await response.json()) as any;
      let content = data?.choices?.[0]?.message?.content ?? "";

      // Strip markdown code blocks if present
      content = content.trim();
      const codeBlockMatch = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      if (codeBlockMatch) content = codeBlockMatch[1].trim();

      const result = JSON.parse(content);

      if (result.should_act && result.message) {
        const delayMs = (result.delay_minutes || 0) * 60 * 1000;
        const now = Date.now();

        const action: PendingAction = {
          id: `action_${now}_${Math.random().toString(36).slice(2, 8)}`,
          message: result.message,
          createdAt: now,
          triggerAt: now + delayMs,
          fired: false,
        };

        this.pendingActions.push(action);
        this.logger?.info(
          `openclaw-mem0: reflection detected intent → "${action.message}" (trigger in ${result.delay_minutes || 0}m)`,
        );
      }
    } catch (err) {
      // Silently fail — reflection is best-effort, must never break the main flow
      this.logger?.debug?.(`openclaw-mem0: reflection error: ${String(err)}`);
    }
  }

  /**
   * Called by heartbeat timer and before_agent_start.
   * Returns the first ripe action (triggerAt <= now) and marks it as fired.
   */
  checkPendingActions(): PendingAction | null {
    this.pruneActions();
    const now = Date.now();

    for (const action of this.pendingActions) {
      if (!action.fired && action.triggerAt <= now) {
        action.fired = true;
        return action;
      }
    }
    return null;
  }

  /** Returns all unfired pending actions (for debugging/stats). */
  getPendingCount(): number {
    return this.pendingActions.filter((a) => !a.fired).length;
  }

  /** Remove expired or fired actions. */
  private pruneActions(): void {
    const now = Date.now();
    this.pendingActions = this.pendingActions.filter(
      (a) => !a.fired && now - a.createdAt < this.ACTION_TTL_MS,
    );
  }
}

// ============================================================================
// Types
// ============================================================================

type Mem0Mode = "platform" | "open-source";

type Mem0Config = {
  mode: Mem0Mode;
  // Platform-specific
  apiKey?: string;
  orgId?: string;
  projectId?: string;
  customInstructions: string;
  customCategories: Record<string, string>;
  enableGraph: boolean;
  // OSS-specific
  customPrompt?: string;
  oss?: {
    embedder?: { provider: string; config: Record<string, unknown> };
    vectorStore?: { provider: string; config: Record<string, unknown> };
    llm?: { provider: string; config: Record<string, unknown> };
    historyDbPath?: string;
  };
  // Shared
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  searchThreshold: number;
  topK: number;
  // Proactive messaging (Active Brain)
  proactiveChannel?: string;  // e.g. "telegram", "imessage", "feishu"
  proactiveTarget?: string;   // e.g. chat_id, phone number, user handle
  gatewayPort?: number;       // e.g. 3000, 18789
};

// Unified types for the provider interface
interface AddOptions {
  user_id: string;
  run_id?: string;
  custom_instructions?: string;
  custom_categories?: Array<Record<string, string>>;
  enable_graph?: boolean;
  output_format?: string;
}

interface SearchOptions {
  user_id: string;
  run_id?: string;
  top_k?: number;
  threshold?: number;
  limit?: number;
  keyword_search?: boolean;
  reranking?: boolean;
}

interface ListOptions {
  user_id: string;
  run_id?: string;
  page_size?: number;
}

interface MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface AddResultItem {
  id: string;
  memory: string;
  event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
}

interface AddResult {
  results: AddResultItem[];
}

// ============================================================================
// Unified Provider Interface
// ============================================================================

interface Mem0Provider {
  add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult>;
  search(query: string, options: SearchOptions): Promise<MemoryItem[]>;
  get(memoryId: string): Promise<MemoryItem>;
  getAll(options: ListOptions): Promise<MemoryItem[]>;
  delete(memoryId: string): Promise<void>;
}

// ============================================================================
// Platform Provider (Mem0 Cloud)
// ============================================================================

class PlatformProvider implements Mem0Provider {
  private client: any; // MemoryClient from mem0ai
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly orgId?: string,
    private readonly projectId?: string,
  ) { }

  private async ensureClient(): Promise<void> {
    if (this.client) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    const { default: MemoryClient } = await import("mem0ai");
    const opts: Record<string, string> = { apiKey: this.apiKey };
    if (this.orgId) opts.org_id = this.orgId;
    if (this.projectId) opts.project_id = this.projectId;
    this.client = new MemoryClient(opts);
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.custom_instructions)
      opts.custom_instructions = options.custom_instructions;
    if (options.custom_categories)
      opts.custom_categories = options.custom_categories;
    if (options.enable_graph) opts.enable_graph = options.enable_graph;
    if (options.output_format) opts.output_format = options.output_format;

    const result = await this.client.add(messages, opts);
    return normalizeAddResult(result);
  }

  async search(query: string, options: SearchOptions): Promise<MemoryItem[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.top_k != null) opts.top_k = options.top_k;
    if (options.threshold != null) opts.threshold = options.threshold;
    if (options.keyword_search != null) opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;

    const results = await this.client.search(query, opts);
    return normalizeSearchResults(results);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    await this.ensureClient();
    const result = await this.client.get(memoryId);
    return normalizeMemoryItem(result);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    await this.ensureClient();
    const opts: Record<string, unknown> = { user_id: options.user_id };
    if (options.run_id) opts.run_id = options.run_id;
    if (options.page_size != null) opts.page_size = options.page_size;

    const results = await this.client.getAll(opts);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    // Some versions return { results: [...] }
    if (results?.results && Array.isArray(results.results))
      return results.results.map(normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureClient();
    await this.client.delete(memoryId);
  }
}

// ============================================================================
// Open-Source Provider (Self-hosted)
// ============================================================================

class OSSProvider implements Mem0Provider {
  private memory: any; // Memory from mem0ai/oss
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly ossConfig?: Mem0Config["oss"],
    private readonly customPrompt?: string,
    private readonly resolvePath?: (p: string) => string,
    private readonly logger?: OpenClawPluginApi["logger"],
  ) { }

  private async ensureMemory(): Promise<void> {
    if (this.memory) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  private async _init(): Promise<void> {
    // Disable mem0ai's built-in PostHog telemetry (us.i.posthog.com)
    // This prevents ETIMEDOUT errors for users behind firewalls or in China
    process.env.MEM0_TELEMETRY = "false";

    const mem0Oss = await import("mem0ai/oss");
    const { Memory, EmbedderFactory, LLMFactory } = mem0Oss;

    // Monkey-patch EmbedderFactory to support 'transformersjs' provider
    const originalEmbedderCreate = EmbedderFactory.create.bind(EmbedderFactory);
    EmbedderFactory.create = (provider: string, config: any) => {
      if (provider.toLowerCase() === "transformersjs") {
        return new TransformersJsEmbedder(config);
      }
      return originalEmbedderCreate(provider, config);
    };

    // Monkey-patch LLMFactory to wrap LLM with JsonCleaningLLM
    // This strips markdown code blocks (```json ... ```) from responses
    const originalLLMCreate = LLMFactory.create.bind(LLMFactory);
    const self = this;
    LLMFactory.create = (provider: string, config: any) => {
      self.logger?.info(`[mem0] Initializing LLM provider: ${provider} with model: ${config?.model}`);
      
      const llm = originalLLMCreate(provider, config);

      // Fix for OpenRouter: Inject required headers to prevent 401/Redirects
      // We access the underlying openai instance (which is loosely typed here)
      if (provider === "openai" && (llm as any).openai) {
        const openaiClient = (llm as any).openai;
        // Ensure defaultHeaders exists
        if (!openaiClient.defaultHeaders) openaiClient.defaultHeaders = {};
        
        Object.assign(openaiClient.defaultHeaders, {
          "HTTP-Referer": "https://github.com/1960697431/openclaw-mem0",
          "X-Title": "OpenClaw Mem0 Plugin",
        });
        
        self.logger?.debug(`[mem0] Injected OpenRouter headers for OpenAI provider`);
      }

      return new JsonCleaningLLM(llm);
    };

    const config: Record<string, unknown> = { version: "v1.1" };

    if (this.ossConfig?.embedder) config.embedder = this.ossConfig.embedder;
    if (this.ossConfig?.vectorStore) {
      // Deep clone vectorStore config and resolve dbPath if present
      const vectorStore = JSON.parse(JSON.stringify(this.ossConfig.vectorStore));
      if (vectorStore.config?.dbPath && this.resolvePath) {
        vectorStore.config.dbPath = this.resolvePath(vectorStore.config.dbPath);
      }
      config.vectorStore = vectorStore;
    }
    if (this.ossConfig?.llm) config.llm = this.ossConfig.llm;

    if (this.ossConfig?.historyDbPath) {
      const dbPath = this.resolvePath
        ? this.resolvePath(this.ossConfig.historyDbPath)
        : this.ossConfig.historyDbPath;
      config.historyDbPath = dbPath;
    }

    if (this.customPrompt) config.customPrompt = this.customPrompt;

    this.memory = new Memory(config);
  }

  async add(
    messages: Array<{ role: string; content: string }>,
    options: AddOptions,
  ): Promise<AddResult> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, not user_id/run_id
    const addOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) addOpts.runId = options.run_id;
    const result = await this.memory.add(messages, addOpts);
    return normalizeAddResult(result);
  }

  async search(query: string, options: SearchOptions): Promise<MemoryItem[]> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, not user_id/run_id
    const opts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) opts.runId = options.run_id;
    if (options.limit != null) opts.limit = options.limit;
    else if (options.top_k != null) opts.limit = options.top_k;
    if (options.keyword_search != null) opts.keyword_search = options.keyword_search;
    if (options.reranking != null) opts.reranking = options.reranking;

    const results = await this.memory.search(query, opts);
    return normalizeSearchResults(results);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    await this.ensureMemory();
    const result = await this.memory.get(memoryId);
    return normalizeMemoryItem(result);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    await this.ensureMemory();
    // OSS SDK uses camelCase: userId/runId, not user_id/run_id
    const getAllOpts: Record<string, unknown> = { userId: options.user_id };
    if (options.run_id) getAllOpts.runId = options.run_id;
    const results = await this.memory.getAll(getAllOpts);
    if (Array.isArray(results)) return results.map(normalizeMemoryItem);
    if (results?.results && Array.isArray(results.results))
      return results.results.map(normalizeMemoryItem);
    return [];
  }

  async delete(memoryId: string): Promise<void> {
    await this.ensureMemory();
    await this.memory.delete(memoryId);
  }
}

// ============================================================================
// Result Normalizers
// ============================================================================

function normalizeMemoryItem(raw: any): MemoryItem {
  return {
    id: raw.id ?? raw.memory_id ?? "",
    memory: raw.memory ?? raw.text ?? raw.content ?? "",
    // Handle both platform (user_id, created_at) and OSS (userId, createdAt) field names
    user_id: raw.user_id ?? raw.userId,
    score: raw.score,
    categories: raw.categories,
    metadata: raw.metadata,
    created_at: raw.created_at ?? raw.createdAt,
    updated_at: raw.updated_at ?? raw.updatedAt,
  };
}

function normalizeSearchResults(raw: any): MemoryItem[] {
  // Platform API returns flat array, OSS returns { results: [...] }
  if (Array.isArray(raw)) return raw.map(normalizeMemoryItem);
  if (raw?.results && Array.isArray(raw.results))
    return raw.results.map(normalizeMemoryItem);
  return [];
}

function normalizeAddResult(raw: any): AddResult {
  // Handle { results: [...] } shape (both platform and OSS)
  if (raw?.results && Array.isArray(raw.results)) {
    return {
      results: raw.results.map((r: any) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        // Platform API may return PENDING status (async processing)
        // OSS stores event in metadata.event
        event: r.event ?? r.metadata?.event ?? (r.status === "PENDING" ? "ADD" : "ADD"),
      })),
    };
  }
  // Platform API without output_format returns flat array
  if (Array.isArray(raw)) {
    return {
      results: raw.map((r: any) => ({
        id: r.id ?? r.memory_id ?? "",
        memory: r.memory ?? r.text ?? "",
        event: r.event ?? r.metadata?.event ?? (r.status === "PENDING" ? "ADD" : "ADD"),
      })),
    };
  }
  return { results: [] };
}

// ============================================================================
// Config Parser
// ============================================================================

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveEnvVarsDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = resolveEnvVars(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = resolveEnvVarsDeep(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ============================================================================
// Default Custom Instructions & Categories
// ============================================================================

const DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract and maintain a structured, evolving profile of the user from their conversations with an AI assistant. Capture information that would help the assistant provide personalized, context-aware responses in future interactions.

Information to Extract:

1. Identity & Demographics:
   - Name, age, location, timezone, language preferences
   - Occupation, employer, job role, industry
   - Education background

2. Preferences & Opinions:
   - Communication style preferences (formal/casual, verbose/concise)
   - Tool and technology preferences (languages, frameworks, editors, OS)
   - Content preferences (topics of interest, learning style)
   - Strong opinions or values they've expressed
   - Likes and dislikes they've explicitly stated

3. Goals & Projects:
   - Current projects they're working on (name, description, status)
   - Short-term and long-term goals
   - Deadlines and milestones mentioned
   - Problems they're actively trying to solve

4. Technical Context:
   - Tech stack and tools they use
   - Skill level in different areas (beginner/intermediate/expert)
   - Development environment and setup details
   - Recurring technical challenges

5. Relationships & People:
   - Names and roles of people they mention (colleagues, family, friends)
   - Team structure and dynamics
   - Key contacts and their relevance

6. Decisions & Lessons:
   - Important decisions made and their reasoning
   - Lessons learned from past experiences
   - Strategies that worked or failed
   - Changed opinions or updated beliefs

7. Routines & Habits:
   - Daily routines and schedules mentioned
   - Work patterns (when they're productive, how they organize work)
   - Health and wellness habits if voluntarily shared

8. Life Events:
   - Significant events (new job, moving, milestones)
   - Upcoming events or plans
   - Changes in circumstances

Guidelines:
- Store memories as clear, self-contained statements (each memory should make sense on its own)
- Use third person: "User prefers..." not "I prefer..."
- Include temporal context when relevant: "As of [date], user is working on..."
- When information updates, UPDATE the existing memory rather than creating duplicates
- Merge related facts into single coherent memories when possible
- Preserve specificity: "User uses Next.js 14 with App Router" is better than "User uses React"
- Capture the WHY behind preferences when stated: "User prefers Vim because of keyboard-driven workflow"

Exclude:
- Passwords, API keys, tokens, or any authentication credentials
- Exact financial amounts (account balances, salaries) unless the user explicitly asks to remember them
- Temporary or ephemeral information (one-time questions, debugging sessions with no lasting insight)
- Generic small talk with no informational content
- The assistant's own responses unless they contain a commitment or promise to the user
- Raw code snippets (capture the intent/decision, not the code itself)
- Information the user explicitly asks not to remember`;

const DEFAULT_CUSTOM_CATEGORIES: Record<string, string> = {
  identity:
    "Personal identity information: name, age, location, timezone, occupation, employer, education, demographics",
  preferences:
    "Explicitly stated likes, dislikes, preferences, opinions, and values across any domain",
  goals:
    "Current and future goals, aspirations, objectives, targets the user is working toward",
  projects:
    "Specific projects, initiatives, or endeavors the user is working on, including status and details",
  technical:
    "Technical skills, tools, tech stack, development environment, programming languages, frameworks",
  decisions:
    "Important decisions made, reasoning behind choices, strategy changes, and their outcomes",
  relationships:
    "People mentioned by the user: colleagues, family, friends, their roles and relevance",
  routines:
    "Daily habits, work patterns, schedules, productivity routines, health and wellness habits",
  life_events:
    "Significant life events, milestones, transitions, upcoming plans and changes",
  lessons:
    "Lessons learned, insights gained, mistakes acknowledged, changed opinions or beliefs",
  work:
    "Work-related context: job responsibilities, workplace dynamics, career progression, professional challenges",
  health:
    "Health-related information voluntarily shared: conditions, medications, fitness, wellness goals",
};

// ============================================================================
// Config Schema
// ============================================================================

const ALLOWED_KEYS = [
  "mode",
  "apiKey",
  "userId",
  "orgId",
  "projectId",
  "autoCapture",
  "autoRecall",
  "customInstructions",
  "customCategories",
  "customPrompt",
  "enableGraph",
  "searchThreshold",
  "topK",
  "oss",
  "proactiveChannel",
  "proactiveTarget",
  "gatewayPort",
];

/**
 * Warn about and strip unknown config keys instead of throwing.
 * This makes the plugin forward-compatible: users can add config
 * fields from a newer README without breaking older plugin versions.
 */
function warnAndStripUnknownKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  // Log warning but don't throw — just strip the unknown keys
  console.warn(`[openclaw-mem0] ${label}: ignoring unknown keys: ${unknown.join(", ")} (update plugin to enable these features)`);
  for (const key of unknown) {
    delete value[key];
  }
}

const mem0ConfigSchema = {
  parse(value: unknown): Mem0Config {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("openclaw-mem0 config required");
    }
    const cfg = value as Record<string, unknown>;
    warnAndStripUnknownKeys(cfg, ALLOWED_KEYS, "openclaw-mem0 config");

    // Accept both "open-source" and legacy "oss" as open-source mode; everything else is platform
    const mode: Mem0Mode =
      cfg.mode === "oss" || cfg.mode === "open-source" ? "open-source" : "platform";

    // Platform mode requires apiKey
    if (mode === "platform") {
      if (typeof cfg.apiKey !== "string" || !cfg.apiKey) {
        throw new Error(
          "apiKey is required for platform mode (set mode: \"open-source\" for self-hosted)",
        );
      }
    }

    // Resolve env vars in oss config
    let ossConfig: Mem0Config["oss"];
    if (cfg.oss && typeof cfg.oss === "object" && !Array.isArray(cfg.oss)) {
      ossConfig = resolveEnvVarsDeep(
        cfg.oss as Record<string, unknown>,
      ) as unknown as Mem0Config["oss"];
    }

    return {
      mode,
      apiKey:
        typeof cfg.apiKey === "string" ? resolveEnvVars(cfg.apiKey) : undefined,
      userId:
        typeof cfg.userId === "string" && cfg.userId ? cfg.userId : "default",
      orgId: typeof cfg.orgId === "string" ? cfg.orgId : undefined,
      projectId: typeof cfg.projectId === "string" ? cfg.projectId : undefined,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      customInstructions:
        typeof cfg.customInstructions === "string"
          ? cfg.customInstructions
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      customCategories:
        cfg.customCategories &&
          typeof cfg.customCategories === "object" &&
          !Array.isArray(cfg.customCategories)
          ? (cfg.customCategories as Record<string, string>)
          : DEFAULT_CUSTOM_CATEGORIES,
      customPrompt:
        typeof cfg.customPrompt === "string"
          ? cfg.customPrompt
          : DEFAULT_CUSTOM_INSTRUCTIONS,
      enableGraph: cfg.enableGraph === true,
      searchThreshold:
        typeof cfg.searchThreshold === "number" ? cfg.searchThreshold : 0.5,
      topK: typeof cfg.topK === "number" ? cfg.topK : 5,
      oss: ossConfig,
      proactiveChannel:
        typeof cfg.proactiveChannel === "string" && cfg.proactiveChannel.trim()
          ? cfg.proactiveChannel.trim()
          : undefined,
      proactiveTarget:
        typeof cfg.proactiveTarget === "string" && cfg.proactiveTarget.trim()
          ? cfg.proactiveTarget.trim()
          : undefined,
      gatewayPort:
        typeof cfg.gatewayPort === "number" ? cfg.gatewayPort : undefined,
    };
  },
};

// ============================================================================
// Provider Factory
// ============================================================================

function createProvider(
  cfg: Mem0Config,
  api: OpenClawPluginApi,
): Mem0Provider {
  if (cfg.mode === "open-source") {
    return new OSSProvider(
      cfg.oss,
      cfg.customPrompt,
      (p) => api.resolvePath(p),
      api.logger,
    );
  }

  return new PlatformProvider(cfg.apiKey!, cfg.orgId, cfg.projectId);
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert Record<string, string> categories to the array format mem0ai expects */
function categoriesToArray(
  cats: Record<string, string>,
): Array<Record<string, string>> {
  return Object.entries(cats).map(([key, value]) => ({ [key]: value }));
}

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0)",
  description:
    "Mem0 memory backend — Mem0 platform or self-hosted open-source",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mem0ConfigSchema.parse(api.pluginConfig);
    const provider = createProvider(cfg, api);

    // Track current session ID for tool-level session scoping
    let currentSessionId: string | undefined;

    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.userId}, graph: ${cfg.enableGraph}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`,
    );

    // Helper: build add options
    function buildAddOptions(userIdOverride?: string, runId?: string): AddOptions {
      const opts: AddOptions = {
        user_id: userIdOverride || cfg.userId,
      };
      if (runId) opts.run_id = runId;
      if (cfg.mode === "platform") {
        opts.custom_instructions = cfg.customInstructions;
        opts.custom_categories = categoriesToArray(cfg.customCategories);
        opts.enable_graph = cfg.enableGraph;
        opts.output_format = "v1.1";
      }
      return opts;
    }

    // Helper: build search options
    function buildSearchOptions(
      userIdOverride?: string,
      limit?: number,
      runId?: string,
    ): SearchOptions {
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
    }

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description:
          "Search through long-term memories stored in Mem0. Use when you need context about user preferences, past decisions, or previously discussed topics.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({
              description: `Max results (default: ${cfg.topK})`,
            }),
          ),
          userId: Type.Optional(
            Type.String({
              description:
                "User ID to scope search (default: configured userId)",
            }),
          ),
          scope: Type.Optional(
            Type.Union([
              Type.Literal("session"),
              Type.Literal("long-term"),
              Type.Literal("all"),
            ], {
              description:
                'Memory scope: "session" (current session only), "long-term" (user-scoped only), or "all" (both). Default: "all"',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, limit, userId, scope = "all" } = params as {
            query: string;
            limit?: number;
            userId?: string;
            scope?: "session" | "long-term" | "all";
          };

          try {
            let results: MemoryItem[] = [];

            if (scope === "session") {
              if (currentSessionId) {
                results = await provider.search(
                  query,
                  buildSearchOptions(userId, limit, currentSessionId),
                );
              }
            } else if (scope === "long-term") {
              results = await provider.search(
                query,
                buildSearchOptions(userId, limit),
              );
            } else {
              // "all" — search both scopes and combine
              const longTermResults = await provider.search(
                query,
                buildSearchOptions(userId, limit),
              );
              let sessionResults: MemoryItem[] = [];
              if (currentSessionId) {
                sessionResults = await provider.search(
                  query,
                  buildSearchOptions(userId, limit, currentSessionId),
                );
              }
              // Deduplicate by ID, preferring long-term
              const seen = new Set(longTermResults.map((r) => r.id));
              results = [
                ...longTermResults,
                ...sessionResults.filter((r) => !seen.has(r.id)),
              ];
            }

            if (!results || results.length === 0) {
              return {
                content: [
                  { type: "text", text: "No relevant memories found." },
                ],
                details: { count: 0 },
              };
            }

            const text = results
              .map(
                (r, i) =>
                  `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%, id: ${r.id})`,
              )
              .join("\n");

            const sanitized = results.map((r) => ({
              id: r.id,
              memory: r.memory,
              score: r.score,
              categories: r.categories,
              created_at: r.created_at,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `Found ${results.length} memories:\n\n${text}`,
                },
              ],
              details: { count: results.length, memories: sanitized },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory search failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_search" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description:
          "Save important information in long-term memory via Mem0. Use for preferences, facts, decisions, and anything worth remembering.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          userId: Type.Optional(
            Type.String({
              description: "User ID to scope this memory",
            }),
          ),
          metadata: Type.Optional(
            Type.Record(Type.String(), Type.Unknown(), {
              description: "Optional metadata to attach to this memory",
            }),
          ),
          longTerm: Type.Optional(
            Type.Boolean({
              description:
                "Store as long-term (user-scoped) memory. Default: true. Set to false for session-scoped memory.",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { text, userId, longTerm = true } = params as {
            text: string;
            userId?: string;
            metadata?: Record<string, unknown>;
            longTerm?: boolean;
          };

          try {
            const runId = !longTerm && currentSessionId ? currentSessionId : undefined;
            const result = await provider.add(
              [{ role: "user", content: text }],
              buildAddOptions(userId, runId),
            );

            const added =
              result.results?.filter((r) => r.event === "ADD") ?? [];
            const updated =
              result.results?.filter((r) => r.event === "UPDATE") ?? [];

            const summary = [];
            if (added.length > 0)
              summary.push(
                `${added.length} new memor${added.length === 1 ? "y" : "ies"} added`,
              );
            if (updated.length > 0)
              summary.push(
                `${updated.length} memor${updated.length === 1 ? "y" : "ies"} updated`,
              );
            if (summary.length === 0)
              summary.push("No new memories extracted");

            return {
              content: [
                {
                  type: "text",
                  text: `Stored: ${summary.join(", ")}. ${result.results?.map((r) => `[${r.event}] ${r.memory}`).join("; ") ?? ""}`,
                },
              ],
              details: {
                action: "stored",
                results: result.results,
              },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory store failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description: "Retrieve a specific memory by its ID from Mem0.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "The memory ID to retrieve" }),
        }),
        async execute(_toolCallId, params) {
          const { memoryId } = params as { memoryId: string };

          try {
            const memory = await provider.get(memoryId);

            return {
              content: [
                {
                  type: "text",
                  text: `Memory ${memory.id}:\n${memory.memory}\n\nCreated: ${memory.created_at ?? "unknown"}\nUpdated: ${memory.updated_at ?? "unknown"}`,
                },
              ],
              details: { memory },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory get failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_get" },
    );

    api.registerTool(
      {
        name: "memory_list",
        label: "Memory List",
        description:
          "List all stored memories for a user. Use this when you want to see everything that's been remembered, rather than searching for something specific.",
        parameters: Type.Object({
          userId: Type.Optional(
            Type.String({
              description:
                "User ID to list memories for (default: configured userId)",
            }),
          ),
          scope: Type.Optional(
            Type.Union([
              Type.Literal("session"),
              Type.Literal("long-term"),
              Type.Literal("all"),
            ], {
              description:
                'Memory scope: "session" (current session only), "long-term" (user-scoped only), or "all" (both). Default: "all"',
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { userId, scope = "all" } = params as { userId?: string; scope?: "session" | "long-term" | "all" };

          try {
            let memories: MemoryItem[] = [];
            const uid = userId || cfg.userId;

            if (scope === "session") {
              if (currentSessionId) {
                memories = await provider.getAll({
                  user_id: uid,
                  run_id: currentSessionId,
                });
              }
            } else if (scope === "long-term") {
              memories = await provider.getAll({ user_id: uid });
            } else {
              // "all" — combine both scopes
              const longTerm = await provider.getAll({ user_id: uid });
              let session: MemoryItem[] = [];
              if (currentSessionId) {
                session = await provider.getAll({
                  user_id: uid,
                  run_id: currentSessionId,
                });
              }
              const seen = new Set(longTerm.map((r) => r.id));
              memories = [
                ...longTerm,
                ...session.filter((r) => !seen.has(r.id)),
              ];
            }

            if (!memories || memories.length === 0) {
              return {
                content: [
                  { type: "text", text: "No memories stored yet." },
                ],
                details: { count: 0 },
              };
            }

            const text = memories
              .map(
                (r, i) =>
                  `${i + 1}. ${r.memory} (id: ${r.id})`,
              )
              .join("\n");

            const sanitized = memories.map((r) => ({
              id: r.id,
              memory: r.memory,
              categories: r.categories,
              created_at: r.created_at,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `${memories.length} memories:\n\n${text}`,
                },
              ],
              details: { count: memories.length, memories: sanitized },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory list failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_list" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description:
          "Delete memories from Mem0. Provide a specific memoryId to delete directly, or a query to search and delete matching memories. GDPR-compliant.",
        parameters: Type.Object({
          query: Type.Optional(
            Type.String({
              description: "Search query to find memory to delete",
            }),
          ),
          memoryId: Type.Optional(
            Type.String({ description: "Specific memory ID to delete" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, memoryId } = params as {
            query?: string;
            memoryId?: string;
          };

          try {
            if (memoryId) {
              await provider.delete(memoryId);
              return {
                content: [
                  { type: "text", text: `Memory ${memoryId} forgotten.` },
                ],
                details: { action: "deleted", id: memoryId },
              };
            }

            if (query) {
              const results = await provider.search(
                query,
                buildSearchOptions(undefined, 5),
              );

              if (!results || results.length === 0) {
                return {
                  content: [
                    { type: "text", text: "No matching memories found." },
                  ],
                  details: { found: 0 },
                };
              }

              // If single high-confidence match, delete directly
              if (
                results.length === 1 ||
                (results[0].score ?? 0) > 0.9
              ) {
                await provider.delete(results[0].id);
                return {
                  content: [
                    {
                      type: "text",
                      text: `Forgotten: "${results[0].memory}"`,
                    },
                  ],
                  details: { action: "deleted", id: results[0].id },
                };
              }

              const list = results
                .map(
                  (r) =>
                    `- [${r.id}] ${r.memory.slice(0, 80)}${r.memory.length > 80 ? "..." : ""} (score: ${((r.score ?? 0) * 100).toFixed(0)}%)`,
                )
                .join("\n");

              const candidates = results.map((r) => ({
                id: r.id,
                memory: r.memory,
                score: r.score,
              }));

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${results.length} candidates. Specify memoryId to delete:\n${list}`,
                  },
                ],
                details: { action: "candidates", candidates },
              };
            }

            return {
              content: [
                { type: "text", text: "Provide a query or memoryId." },
              ],
              details: { error: "missing_param" },
            };
          } catch (err) {
            return {
              content: [
                {
                  type: "text",
                  text: `Memory forget failed: ${String(err)}`,
                },
              ],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "memory_forget" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem0 = program
          .command("mem0")
          .description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search memories in Mem0")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(cfg.topK))
          .option("--scope <scope>", 'Memory scope: "session", "long-term", or "all"', "all")
          .action(async (query: string, opts: { limit: string; scope: string }) => {
            try {
              const limit = parseInt(opts.limit, 10);
              const scope = opts.scope as "session" | "long-term" | "all";

              let allResults: MemoryItem[] = [];

              if (scope === "session" || scope === "all") {
                if (currentSessionId) {
                  const sessionResults = await provider.search(
                    query,
                    buildSearchOptions(undefined, limit, currentSessionId),
                  );
                  if (sessionResults?.length) {
                    allResults.push(...sessionResults.map((r) => ({ ...r, _scope: "session" as const })));
                  }
                } else if (scope === "session") {
                  console.log("No active session ID available for session-scoped search.");
                  return;
                }
              }

              if (scope === "long-term" || scope === "all") {
                const longTermResults = await provider.search(
                  query,
                  buildSearchOptions(undefined, limit),
                );
                if (longTermResults?.length) {
                  allResults.push(...longTermResults.map((r) => ({ ...r, _scope: "long-term" as const })));
                }
              }

              // Deduplicate by ID when searching "all"
              if (scope === "all") {
                const seen = new Set<string>();
                allResults = allResults.filter((r) => {
                  if (seen.has(r.id)) return false;
                  seen.add(r.id);
                  return true;
                });
              }

              if (!allResults.length) {
                console.log("No memories found.");
                return;
              }

              const output = allResults.map((r) => ({
                id: r.id,
                memory: r.memory,
                score: r.score,
                scope: (r as any)._scope,
                categories: r.categories,
                created_at: r.created_at,
              }));
              console.log(JSON.stringify(output, null, 2));
            } catch (err) {
              console.error(`Search failed: ${String(err)}`);
            }
          });

        mem0
          .command("stats")
          .description("Show memory statistics from Mem0")
          .action(async () => {
            try {
              const memories = await provider.getAll({
                user_id: cfg.userId,
              });
              console.log(`Mode: ${cfg.mode}`);
              console.log(`User: ${cfg.userId}`);
              console.log(
                `Total memories: ${Array.isArray(memories) ? memories.length : "unknown"}`,
              );
              console.log(`Graph enabled: ${cfg.enableGraph}`);
              console.log(
                `Auto-recall: ${cfg.autoRecall}, Auto-capture: ${cfg.autoCapture}`,
              );
            } catch (err) {
              console.error(`Stats failed: ${String(err)}`);
            }
          });
      },
      { commands: ["mem0"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    // ========================================================================
    // Reflection Engine — Active Brain
    // ========================================================================

    const reflectionEngine = new ReflectionEngine(
      cfg.oss?.llm,
      api.logger,
    );

    // Track last active channel/sender for proactive message delivery
    // Auto-detected from incoming messages, overridden by config
    let lastActiveChannel: string | undefined = cfg.proactiveChannel;
    let lastActiveFrom: string | undefined = cfg.proactiveTarget;
    let lastActiveAccountId: string | undefined;

    // Listen for incoming messages to auto-detect channel and sender
    api.on("message_received", (event: any, ctx: any) => {
      if (ctx?.channelId) lastActiveChannel = ctx.channelId;
      if (ctx?.accountId) lastActiveAccountId = ctx.accountId;
      if (event?.from) lastActiveFrom = event.from;
      api.logger.debug?.(
        `openclaw-mem0: tracked sender — channel=${lastActiveChannel}, from=${lastActiveFrom}`,
      );
    });

    // Auto-recall: inject relevant memories + proactive insights before agent starts
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;

        // Track session ID
        const sessionId = (ctx as any)?.sessionKey ?? undefined;
        if (sessionId) currentSessionId = sessionId;

        try {
          // Search long-term memories (user-scoped)
          const longTermResults = await provider.search(
            event.prompt,
            buildSearchOptions(),
          );

          // Search session memories (session-scoped) if we have a session ID
          let sessionResults: MemoryItem[] = [];
          if (currentSessionId) {
            sessionResults = await provider.search(
              event.prompt,
              buildSearchOptions(undefined, undefined, currentSessionId),
            );
          }

          // Deduplicate session results against long-term
          const longTermIds = new Set(longTermResults.map((r) => r.id));
          const uniqueSessionResults = sessionResults.filter(
            (r) => !longTermIds.has(r.id),
          );

          // Build context with clear labels
          let memoryContext = "";
          if (longTermResults.length > 0) {
            memoryContext += longTermResults
              .map(
                (r) =>
                  `- ${r.memory}${r.categories?.length ? ` [${r.categories.join(", ")}]` : ""}`,
              )
              .join("\n");
          }
          if (uniqueSessionResults.length > 0) {
            if (memoryContext) memoryContext += "\n";
            memoryContext += "\nSession memories:\n";
            memoryContext += uniqueSessionResults
              .map((r) => `- ${r.memory}`)
              .join("\n");
          }

          // Check for proactive insights from the reflection engine
          const pendingAction = reflectionEngine.checkPendingActions();
          let proactiveContext = "";
          if (pendingAction) {
            proactiveContext = `\n<proactive-insight>\n系统检测到以下需要关注的事项：\n${pendingAction.message}\n</proactive-insight>`;
            api.logger.info(
              `openclaw-mem0: injecting proactive insight: "${pendingAction.message}"`,
            );
          }

          const totalCount = longTermResults.length + uniqueSessionResults.length;
          if (totalCount === 0 && !proactiveContext) return;

          if (totalCount > 0) {
            api.logger.info(
              `openclaw-mem0: injecting ${totalCount} memories into context (${longTermResults.length} long-term, ${uniqueSessionResults.length} session)`,
            );
          }

          let systemContext = "";
          if (memoryContext) {
            systemContext += `<relevant-memories>\nThe following memories may be relevant to this conversation:\n${memoryContext}\n</relevant-memories>`;
          }
          systemContext += proactiveContext;

          return { systemContext };
        } catch (err) {
          api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
        }
      });
    }

    // Auto-capture: store conversation context after agent ends
    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages || event.messages.length === 0) {
          return;
        }

        // Track session ID
        const sessionId = (ctx as any)?.sessionKey ?? undefined;
        if (sessionId) currentSessionId = sessionId;

        try {
          // Extract messages, limiting to last 10
          const recentMessages = event.messages.slice(-10);
          const formattedMessages: Array<{
            role: string;
            content: string;
          }> = [];

          for (const msg of recentMessages) {
            if (!msg || typeof msg !== "object") continue;
            const msgObj = msg as Record<string, unknown>;

            const role = msgObj.role;
            if (role !== "user" && role !== "assistant") continue;

            let textContent = "";
            const content = msgObj.content;

            if (typeof content === "string") {
              textContent = content;
            } else if (Array.isArray(content)) {
              for (const block of content) {
                if (
                  block &&
                  typeof block === "object" &&
                  "type" in block &&
                  (block as Record<string, unknown>).type === "text" &&
                  "text" in block &&
                  typeof (block as Record<string, unknown>).text === "string"
                ) {
                  textContent +=
                    (textContent ? "\n" : "") +
                    ((block as Record<string, unknown>).text as string);
                }
              }
            }

            if (!textContent) continue;
            // Skip injected memory context
            if (textContent.includes("<relevant-memories>")) continue;

            formattedMessages.push({
              role: role as string,
              content: textContent,
            });
          }

          if (formattedMessages.length === 0) return;

          const addOpts = buildAddOptions(undefined, currentSessionId);
          const result = await provider.add(
            formattedMessages,
            addOpts,
          );

          const capturedCount = result.results?.length ?? 0;
          if (capturedCount > 0) {
            api.logger.info(
              `openclaw-mem0: auto-captured ${capturedCount} memories`,
            );

            // ── Reflection: analyze new memories for user intent ──
            try {
              const recentMemories = await provider.search(
                formattedMessages.map((m) => m.content).join(" "),
                buildSearchOptions(),
              );
              await reflectionEngine.reflect(formattedMessages, recentMemories);
            } catch (reflectErr) {
              // Silent — reflection must never break the main flow
              api.logger.debug?.(
                `openclaw-mem0: reflection skipped: ${String(reflectErr)}`,
              );
            }
          }
        } catch (err) {
          api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    // Heartbeat timer for proactive action checking
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    /**
     * Attempt to send a proactive message via the Gateway's `send` method.
     * Falls back to next-turn injection if no target is available.
     */
    const deliverProactiveMessage = async (action: PendingAction): Promise<boolean> => {
      // Resolve target: config overrides > auto-detected
      const channel = cfg.proactiveChannel || lastActiveChannel;
      const target = cfg.proactiveTarget || lastActiveFrom;

      if (!channel || !target) {
        // No target available — leave it for next-turn injection
        api.logger.info(
          `openclaw-mem0: ⏳ proactive action queued for next-turn (no target — channel=${channel ?? "?"}, to=${target ?? "?"})`,
        );
        // Un-fire so it stays in the queue for next-turn injection
        action.fired = false;
        return false;
      }

      try {
        // Call Gateway HTTP API to send outbound message
        // Use configured port or fallback to env.PORT or default 3000
        const gatewayPort = cfg.gatewayPort || Number(process.env.PORT) || 3000;
        const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/gateway`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            method: "send",
            params: {
              to: target,
              message: action.message,
              channel,
              ...(lastActiveAccountId ? { accountId: lastActiveAccountId } : {}),
              idempotencyKey: action.id,
            },
          }),
        });

        if (response.ok) {
          api.logger.info(
            `openclaw-mem0: ✅ proactive message sent via ${channel} → ${target}: "${action.message}"`,
          );
          return true;
        } else {
          const body = await response.text().catch(() => "(no body)");
          api.logger.warn(
            `openclaw-mem0: Gateway send failed (${response.status}): ${body} — falling back to next-turn`,
          );
          action.fired = false;
          return false;
        }
      } catch (err) {
        // Network/Gateway unavailable — leave for next-turn
        api.logger.debug?.(
          `openclaw-mem0: Gateway send error: ${String(err)} — queued for next-turn`,
        );
        action.fired = false;
        return false;
      }
    };

    // ========================================================================
    // Auto-Update Checker
    // ========================================================================

    const GITHUB_REPO = "1960697431/openclaw-mem0";
    const LOCAL_VERSION = "0.3.2"; // Keep in sync with package.json

    const checkForUpdates = async () => {
      const { execSync } = await import("node:child_process");
      const { fileURLToPath } = await import("node:url");
      const { dirname, join } = await import("node:path");
      const { writeFileSync, readFileSync } = await import("node:fs");

      // Resolve plugin directory from this file's location
      const pluginDir = dirname(fileURLToPath(import.meta.url));
      const RAW_BASE = `https://raw.githubusercontent.com/${GITHUB_REPO}/main`;

      try {
        // Step 1: Check remote version
        const pkgResponse = await fetch(
          `${RAW_BASE}/package.json`,
          { signal: AbortSignal.timeout(8000) },
        );
        if (!pkgResponse.ok) return;

        const remotePkgText = await pkgResponse.text();
        const remotePkg = JSON.parse(remotePkgText) as {
          version?: string;
          dependencies?: Record<string, string>;
        };
        const remoteVersion = remotePkg.version ?? "0.0.0";

        if (remoteVersion === LOCAL_VERSION) {
          api.logger.debug?.(
            `openclaw-mem0: ✅ v${LOCAL_VERSION} is up to date`,
          );
          return;
        }

        // Step 2: New version found — download updated files
        api.logger.warn(
          `openclaw-mem0: ⬆️ 发现新版本 v${remoteVersion} (当前 v${LOCAL_VERSION})，正在自动更新...`,
        );

        try {
          // Download core files from GitHub raw
          const filesToUpdate = ["index.ts", "package.json", "README.md", "openclaw.plugin.json"];
          for (const file of filesToUpdate) {
            const res = await fetch(
              `${RAW_BASE}/${file}`,
              { signal: AbortSignal.timeout(15000) },
            );
            if (res.ok) {
              const content = await res.text();
              writeFileSync(join(pluginDir, file), content, "utf-8");
              api.logger.info(`openclaw-mem0: ✅ 已更新 ${file}`);
            }
          }

          // Check if dependencies changed — only run npm install if needed
          let needsNpmInstall = false;
          try {
            const localPkg = JSON.parse(
              readFileSync(join(pluginDir, "package.json"), "utf-8"),
            ) as { dependencies?: Record<string, string> };
            const localDeps = JSON.stringify(localPkg.dependencies ?? {});
            const remoteDeps = JSON.stringify(remotePkg.dependencies ?? {});
            needsNpmInstall = localDeps !== remoteDeps;
          } catch {
            needsNpmInstall = true;
          }

          if (needsNpmInstall) {
            api.logger.info("openclaw-mem0: 📦 依赖有变化，正在安装...");
            execSync("npm install --production --no-audit --no-fund", {
              cwd: pluginDir,
              timeout: 60_000,
              stdio: "pipe",
            });
            api.logger.info("openclaw-mem0: ✅ npm install 完成");
          }

          api.logger.warn(
            `openclaw-mem0: 🔄 更新完成 v${LOCAL_VERSION} → v${remoteVersion}，Gateway 将在 10 秒后自动重启...`,
          );

          // Step 3: Graceful restart — wait 10s then exit
          // launchd will automatically restart the Gateway process
          setTimeout(() => {
            api.logger.warn("openclaw-mem0: 🔄 正在重启 Gateway 以加载新版本...");
            process.exit(0);
          }, 10_000);

        } catch (updateErr) {
          api.logger.error(
            `openclaw-mem0: ❌ 自动更新失败: ${String(updateErr)}\n` +
            `  请手动运行: cd ${pluginDir} && openclaw plugins update openclaw-mem0`,
          );
        }
      } catch {
        // Network error, skip silently
        api.logger.debug?.("openclaw-mem0: update check skipped (network unavailable)");
      }
    };

    api.registerService({
      id: "openclaw-mem0",
      start: () => {
        api.logger.info(
          `openclaw-mem0: initialized (mode: ${cfg.mode}, user: ${cfg.userId}, autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture}, activeBrain: true, proactive: ${cfg.proactiveChannel ?? "auto-detect"})`,
        );

        // Check for plugin updates on startup (non-blocking)
        checkForUpdates();

        // Start heartbeat: check pending actions every 60 seconds
        heartbeatTimer = setInterval(async () => {
          const action = reflectionEngine.checkPendingActions();
          if (action) {
            await deliverProactiveMessage(action);
          }
        }, 60_000);
      },
      stop: () => {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        api.logger.info("openclaw-mem0: stopped (active brain deactivated)");
      },
    });
  },
};

export default memoryPlugin;
