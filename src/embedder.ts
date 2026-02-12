
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export class TransformersJsEmbedder {
  private extractor: any = null;
  private initPromise: Promise<void> | null = null;
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
    const transformers = await import("@huggingface/transformers");
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
    const output = await this.extractor([text], { pooling: "last_token", normalize: true });
    return output.tolist()[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureExtractor();
    const output = await this.extractor(texts, { pooling: "last_token", normalize: true });
    return output.tolist();
  }
}
