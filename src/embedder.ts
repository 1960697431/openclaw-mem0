
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export class TransformersJsEmbedder {
  private extractor: any = null;
  private initPromise: Promise<void> | null = null;
  private useHashFallback = false;
  private model: string;
  private embeddingDims: number;

  private static readonly DEFAULT_MODEL = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
  private static readonly GITHUB_REPO = "1960697431/openclaw-mem0";
  private static readonly GITHUB_MODEL_TAG = "models-v2";
  private static readonly MODEL_ARCHIVE = "qwen3-embedding-0.6b-q8.tar.gz";
  private static readonly MODEL_VERSION = "v2";

  constructor(config: { model?: string; embeddingDims?: number }) {
    this.model = config.model || TransformersJsEmbedder.DEFAULT_MODEL;
    this.embeddingDims = config.embeddingDims || 1024;
  }

  private async ensureExtractor(): Promise<void> {
    if (this.extractor) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async getPluginDir(): Promise<string> {
    // In compiled/run context, we need to go up one level from src/
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    // this file is in src/, so go up one level to root
    return path.join(dirname(fileURLToPath(import.meta.url)), "..");
  }

  private async getModelCacheDir(): Promise<string> {
    const pluginDir = await this.getPluginDir();
    return path.join(pluginDir, "models", this.model.replace(/\//g, "--"));
  }

  private async downloadFile(url: string, dest: string, retries = 3): Promise<void> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(1_800_000), // 30 min
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        if (!resp.body) throw new Error("No response body");

        const fileStream = fs.createWriteStream(dest);
        const reader = resp.body.getReader();

        const total = parseInt(resp.headers.get("content-length") || "0", 10);
        let downloaded = 0;
        let lastPct = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
          downloaded += value.length;

          if (total > 1_000_000) {
            const pct = Math.floor((downloaded / total) * 100);
            if (pct >= lastPct + 10) {
              console.log(`[mem0] Download: ${pct}%`);
              lastPct = pct;
            }
          }
        }

        fileStream.end();
        await new Promise((resolve, reject) => {
          fileStream.on("finish", resolve);
          fileStream.on("error", reject);
        });

        return;
      } catch (err) {
        try { fs.unlinkSync(dest); } catch { }
        if (attempt === retries) throw err;
        console.warn(`[mem0] Download failed (${attempt}/${retries}): ${err}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async ensureModelLocal(): Promise<string> {
    const cacheDir = await this.getModelCacheDir();
    const marker = path.join(cacheDir, ".download-complete");

    if (fs.existsSync(marker)) {
      const content = fs.readFileSync(marker, "utf-8").trim();
      if (content.startsWith(TransformersJsEmbedder.MODEL_VERSION)) {
        return cacheDir;
      }
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }

    const baseUrl = `https://github.com/${TransformersJsEmbedder.GITHUB_REPO}/releases/download/${TransformersJsEmbedder.GITHUB_MODEL_TAG}`;
    const archiveUrl = `${baseUrl}/${TransformersJsEmbedder.MODEL_ARCHIVE}`;
    const archivePath = path.join(cacheDir, TransformersJsEmbedder.MODEL_ARCHIVE);

    fs.mkdirSync(cacheDir, { recursive: true });
    
    console.log(`[mem0] Downloading model from ${archiveUrl}...`);
    await this.downloadFile(archiveUrl, archivePath);

    console.log(`[mem0] Extracting...`);
    execSync(`tar xzf "${archivePath}" -C "${cacheDir}"`, { timeout: 120_000 });
    try { fs.unlinkSync(archivePath); } catch { }

    fs.writeFileSync(marker, `${TransformersJsEmbedder.MODEL_VERSION}|${new Date().toISOString()}`);
    return cacheDir;
  }

  private async _init(): Promise<void> {
    console.log(`[mem0] Loading transformers.js model: ${this.model}`);
    let transformers: any;
    try {
      transformers = await import("@huggingface/transformers");
    } catch (err: any) {
      // Keep plugin usable even if dependency installation failed.
      if (String(err?.message || err).includes("@huggingface/transformers")) {
        this.useHashFallback = true;
        console.warn("[mem0] @huggingface/transformers is missing. Falling back to lightweight hash embeddings (lower recall quality).");
        return;
      }
      throw err;
    }
    const { pipeline, env } = transformers;

    let modelPath = this.model;

    if (this.model === TransformersJsEmbedder.DEFAULT_MODEL) {
      try {
        modelPath = await this.ensureModelLocal();
      } catch (err) {
        console.warn(`[mem0] GitHub download failed, using HuggingFace fallback: ${err}`);
        const hfMirror = process.env.HF_ENDPOINT || process.env.HF_MIRROR;
        if (hfMirror) env.remoteHost = hfMirror;
      }
    } else {
      const hfMirror = process.env.HF_ENDPOINT || process.env.HF_MIRROR;
      if (hfMirror) env.remoteHost = hfMirror;
    }

    if (process.env.HF_HOME) env.cacheDir = process.env.HF_HOME;

    this.extractor = await pipeline("feature-extraction", modelPath, { dtype: "q8" });
    console.log(`[mem0] Model loaded.`);
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureExtractor();
    if (this.useHashFallback) return this.hashEmbedding(text);
    const output = await this.extractor([text], { pooling: "last_token", normalize: true });
    return output.tolist()[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureExtractor();
    if (this.useHashFallback) return texts.map((text) => this.hashEmbedding(text));
    const output = await this.extractor(texts, { pooling: "last_token", normalize: true });
    return output.tolist();
  }

  private hashEmbedding(text: string): number[] {
    const dim = Math.max(32, this.embeddingDims || 1024);
    const vector = new Array<number>(dim).fill(0);
    const normalized = (text || "").toLowerCase();
    const tokens = normalized.split(/[\s,.;:!?，。；：！？()（）[\]{}"'\n\r\t]+/).filter(Boolean);

    if (tokens.length === 0) {
      return vector;
    }

    for (const token of tokens) {
      let hash = 2166136261;
      for (let i = 0; i < token.length; i++) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const idx = Math.abs(hash) % dim;
      vector[idx] += 1;
    }

    // L2 normalize for cosine similarity compatibility.
    const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = vector[i] / norm;
      }
    }
    return vector;
  }
}

export type EmbeddingApiFormat = "openai" | "gemini" | "ollama" | "custom";

export interface RemoteEmbedderConfig {
  provider?: string;
  apiFormat?: EmbeddingApiFormat;
  apiKey?: string;
  model?: string;
  baseURL?: string;
  url?: string;
  endpoint?: string;
  timeout?: number;
  headers?: Record<string, string>;
  embeddingDims?: number;
  outputDimensionality?: number;
  batchSize?: number;
  gemini?: {
    apiVersion?: string;
    taskType?: string;
  };
}

const OPENAI_COMPAT_BASES: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  kimi: "https://api.moonshot.cn/v1",
  yi: "https://api.lingyiwanwu.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  glm: "https://open.bigmodel.cn/api/paas/v4",
  minimax: "https://api.minimax.chat/v1",
  openrouter: "https://openrouter.ai/api/v1",
  baichuan: "https://api.baichuan-ai.com/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  ark: "https://ark.cn-beijing.volces.com/api/v3",
};

const REMOTE_PROVIDERS = new Set<string>([
  "remote",
  "openai",
  "deepseek",
  "moonshot",
  "kimi",
  "yi",
  "siliconflow",
  "dashscope",
  "qwen",
  "zhipu",
  "glm",
  "minimax",
  "openrouter",
  "baichuan",
  "doubao",
  "ark",
  "gemini",
  "google",
  "ollama",
  "openai-compatible",
  "openai_compatible",
  "universal",
]);

export function isRemoteEmbedderProvider(provider: string): boolean {
  return REMOTE_PROVIDERS.has((provider || "").toLowerCase());
}

export function normalizeRemoteEmbedderConfig(
  provider: string,
  config: Record<string, any>
): RemoteEmbedderConfig {
  const prov = (provider || "").toLowerCase();
  const cfg: RemoteEmbedderConfig = { ...config, provider: prov || config?.provider || "remote" };

  if (!cfg.apiFormat) {
    if (prov === "gemini" || prov === "google") {
      cfg.apiFormat = "gemini";
    } else if (prov === "ollama") {
      cfg.apiFormat = "ollama";
    } else if (cfg.endpoint) {
      cfg.apiFormat = "custom";
    } else {
      cfg.apiFormat = "openai";
    }
  }

  if (cfg.apiFormat === "ollama") {
    if (!cfg.url) {
      cfg.url = (cfg.baseURL as string) || "http://127.0.0.1:11434";
    }
    if (!cfg.model) cfg.model = "nomic-embed-text";
    if (!cfg.embeddingDims) cfg.embeddingDims = 1024;
    return cfg;
  }

  if (cfg.apiFormat === "gemini") {
    if (!cfg.baseURL) cfg.baseURL = "https://generativelanguage.googleapis.com";
    if (!cfg.model) cfg.model = "text-embedding-004";
    if (!cfg.embeddingDims) cfg.embeddingDims = 768;
    return cfg;
  }

  if (!cfg.baseURL && OPENAI_COMPAT_BASES[prov]) {
    cfg.baseURL = OPENAI_COMPAT_BASES[prov];
  }
  if (!cfg.model) cfg.model = "text-embedding-3-small";
  if (!cfg.embeddingDims) cfg.embeddingDims = 1024;

  if (typeof cfg.baseURL === "string") {
    let baseURL = cfg.baseURL.trim();
    baseURL = baseURL.replace(/\/embeddings\/?$/i, "");
    cfg.baseURL = baseURL;
  }

  return cfg;
}

function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
  const size = Math.max(1, batchSize);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export class RemoteEmbedder {
  private readonly config: RemoteEmbedderConfig;
  private readonly format: EmbeddingApiFormat;

  constructor(config: RemoteEmbedderConfig) {
    this.config = {
      timeout: 30_000,
      batchSize: 32,
      ...config,
    };
    this.format = this.detectFormat();
    this.validateConfig();
  }

  private detectFormat(): EmbeddingApiFormat {
    if (this.config.apiFormat) return this.config.apiFormat;
    const provider = (this.config.provider || "").toLowerCase();
    if (provider === "gemini" || provider === "google") return "gemini";
    if (provider === "ollama") return "ollama";

    const baseURL = (this.config.baseURL || this.config.url || "").toLowerCase();
    if (baseURL.includes("generativelanguage") || baseURL.includes("googleapis")) return "gemini";
    if (baseURL.includes("11434") || baseURL.includes("ollama")) return "ollama";
    return this.config.endpoint ? "custom" : "openai";
  }

  private validateConfig() {
    const headers = this.config.headers || {};
    const hasAuthHeader = Object.keys(headers).some((key) => {
      const lowered = key.toLowerCase();
      return lowered === "authorization" || lowered === "x-api-key" || lowered === "api-key";
    });

    if (this.format === "gemini" && !this.config.apiKey) {
      throw new Error("[mem0] Remote embedder (gemini) requires apiKey.");
    }

    if (this.format !== "ollama" && this.format !== "custom" && !this.config.apiKey && !hasAuthHeader) {
      throw new Error("[mem0] Remote embedder requires apiKey or auth headers.");
    }
  }

  private getTimeoutSignal(): AbortSignal {
    const timeoutMs = Math.max(1000, Number(this.config.timeout) || 30000);
    return AbortSignal.timeout(timeoutMs);
  }

  private normalizeVectorDimensions(vector: number[]): number[] {
    const targetDim = Math.max(32, Number(this.config.embeddingDims) || 1024);
    if (vector.length === targetDim) return vector;
    if (vector.length > targetDim) return vector.slice(0, targetDim);

    const padded = vector.slice();
    while (padded.length < targetDim) padded.push(0);
    return padded;
  }

  private normalizeVectors(vectors: number[][]): number[][] {
    return vectors.map((vector) => this.normalizeVectorDimensions(vector));
  }

  async embed(text: string): Promise<number[]> {
    const vectors = await this.embedBatch([text]);
    return vectors[0] || this.normalizeVectorDimensions([]);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const cleanedTexts = texts.map((text) => (typeof text === "string" ? text : String(text ?? "")));

    switch (this.format) {
      case "gemini":
        return this.callGemini(cleanedTexts);
      case "ollama":
        return this.callOllama(cleanedTexts);
      case "custom":
      case "openai":
      default:
        return this.callOpenAICompatible(cleanedTexts);
    }
  }

  private async callOpenAICompatible(texts: string[]): Promise<number[][]> {
    const endpoint = this.config.endpoint
      ? this.config.endpoint
      : `${(this.config.baseURL || "https://api.openai.com/v1").replace(/\/$/, "")}/embeddings`;
    const body: Record<string, any> = {
      model: this.config.model,
      input: texts,
    };
    if (typeof this.config.outputDimensionality === "number") {
      body.dimensions = this.config.outputDimensionality;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal: this.getTimeoutSignal(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Remote embedder request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    const vectors = Array.isArray(data?.data)
      ? data.data
          .map((item: any) => (Array.isArray(item?.embedding) ? item.embedding : null))
          .filter((v: any) => Array.isArray(v))
      : [];

    if (vectors.length !== texts.length) {
      throw new Error(`[mem0] Invalid embeddings response size: expected ${texts.length}, got ${vectors.length}`);
    }

    return this.normalizeVectors(vectors as number[][]);
  }

  private async callGemini(texts: string[]): Promise<number[][]> {
    const baseURL = (this.config.baseURL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    const apiVersion = this.config.gemini?.apiVersion || "v1beta";
    const model = (this.config.model || "text-embedding-004").startsWith("models/")
      ? (this.config.model as string)
      : `models/${this.config.model || "text-embedding-004"}`;
    const taskType = this.config.gemini?.taskType || "SEMANTIC_SIMILARITY";

    if (texts.length === 1) {
      const endpoint = `${baseURL}/${apiVersion}/${model}:embedContent?key=${this.config.apiKey}`;
      const body: Record<string, any> = {
        content: { parts: [{ text: texts[0] }] },
        taskType,
      };
      if (typeof this.config.outputDimensionality === "number") {
        body.outputDimensionality = this.config.outputDimensionality;
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify(body),
        signal: this.getTimeoutSignal(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini embed request failed: ${response.status} - ${errorText}`);
      }

      const data = await response.json() as any;
      const vector = data?.embedding?.values;
      if (!Array.isArray(vector)) {
        throw new Error("[mem0] Gemini embed response missing embedding.values");
      }
      return this.normalizeVectors([vector]);
    }

    const endpoint = `${baseURL}/${apiVersion}/${model}:batchEmbedContents?key=${this.config.apiKey}`;
    const requests = texts.map((text) => {
      const req: Record<string, any> = {
        model,
        content: { parts: [{ text }] },
        taskType,
      };
      if (typeof this.config.outputDimensionality === "number") {
        req.outputDimensionality = this.config.outputDimensionality;
      }
      return req;
    });

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify({ requests }),
      signal: this.getTimeoutSignal(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini batch embed request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as any;
    const vectors = Array.isArray(data?.embeddings)
      ? data.embeddings
          .map((item: any) => (Array.isArray(item?.values) ? item.values : null))
          .filter((v: any) => Array.isArray(v))
      : [];

    if (vectors.length !== texts.length) {
      throw new Error(`[mem0] Gemini batch embeddings size mismatch: expected ${texts.length}, got ${vectors.length}`);
    }
    return this.normalizeVectors(vectors as number[][]);
  }

  private async callOllama(texts: string[]): Promise<number[][]> {
    const baseURL = (this.config.url || this.config.baseURL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = this.config.model || "nomic-embed-text";

    // Newer Ollama endpoint supports batch input.
    const batchEndpoint = `${baseURL}/api/embed`;
    try {
      const batchResponse = await fetch(batchEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers,
        },
        body: JSON.stringify({
          model,
          input: texts,
        }),
        signal: this.getTimeoutSignal(),
      });

      if (batchResponse.ok) {
        const batchData = await batchResponse.json() as any;
        const vectors = Array.isArray(batchData?.embeddings)
          ? batchData.embeddings.filter((vector: any) => Array.isArray(vector))
          : [];
        if (vectors.length === texts.length) {
          return this.normalizeVectors(vectors as number[][]);
        }
      }
    } catch {
      // Fall back to legacy endpoint below.
    }

    const singleEndpoint = `${baseURL}/api/embeddings`;
    const batches = splitIntoBatches(texts, Math.max(1, Math.min(8, Number(this.config.batchSize) || 4)));
    const vectors: number[][] = [];

    for (const batch of batches) {
      const batchVectors = await Promise.all(batch.map(async (text) => {
        const response = await fetch(singleEndpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...this.config.headers,
          },
          body: JSON.stringify({
            model,
            prompt: text,
          }),
          signal: this.getTimeoutSignal(),
        });
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Ollama embed request failed: ${response.status} - ${errorText}`);
        }
        const data = await response.json() as any;
        if (!Array.isArray(data?.embedding)) {
          throw new Error("[mem0] Ollama embedding response missing embedding array");
        }
        return data.embedding as number[];
      }));
      vectors.push(...batchVectors);
    }

    return this.normalizeVectors(vectors);
  }
}
