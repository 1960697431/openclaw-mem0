
import type { MemoryItem } from "./types.js";

// Rough token estimation (1 token ~= 4 chars for English, 1.5 chars for Chinese)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  
  // Check if text contains Chinese characters
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - chineseChars;
  
  // Chinese: ~1.5 chars per token, English: ~4 chars per token
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

// Model context limits (conservative estimates)
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-4": 8192,
  "gpt-4-32k": 32768,
  "gpt-4-turbo": 128000,
  "gpt-4o": 128000,
  "gpt-3.5-turbo": 16385,
  "claude-3-opus": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-haiku": 200000,
  "claude-3-5-sonnet": 200000,
  "deepseek-chat": 64000,
  "deepseek-coder": 16000,
  "moonshot-v1": 32000,
  "qwen-max": 32000,
  "qwen-plus": 32000,
  "abab6.5s-chat": 32000,
  "default": 8192,
};

// Default memory context budget (percentage of total context)
const MEMORY_BUDGET_RATIO = 0.15; // 15% of context for memories
const MIN_MEMORY_TOKENS = 200;
const MAX_MEMORY_TOKENS = 4000;
const MEMORY_OVERHEAD = 50; // XML tags and formatting overhead

export interface SmartInjectionConfig {
  modelId?: string;
  maxContextTokens?: number;
  memoryBudgetRatio?: number;
  maxMemories?: number;
  enableSummarization?: boolean;
}

export interface InjectionResult {
  context: string;
  injectedCount: number;
  totalMemories: number;
  estimatedTokens: number;
  truncated: boolean;
  summarized?: boolean;
}

// Smart context injection with token budget management
export function buildMemoryContext(
  memories: MemoryItem[],
  config: SmartInjectionConfig = {}
): InjectionResult {
  const {
    modelId = "default",
    maxContextTokens,
    memoryBudgetRatio = MEMORY_BUDGET_RATIO,
    maxMemories = 20,
    enableSummarization = true,
  } = config;

  // Determine context limit for model
  const modelLimit = findModelLimit(modelId);
  const effectiveLimit = maxContextTokens || modelLimit;
  
  // Calculate memory token budget
  const rawBudget = Math.floor(effectiveLimit * memoryBudgetRatio);
  const budget = Math.max(MIN_MEMORY_TOKENS, Math.min(MAX_MEMORY_TOKENS, rawBudget));
  
  if (memories.length === 0) {
    return {
      context: "",
      injectedCount: 0,
      totalMemories: 0,
      estimatedTokens: 0,
      truncated: false,
    };
  }

  // Sort by score (if available) and recency
  const sorted = [...memories].sort((a, b) => {
    const scoreA = a.score ?? 0;
    const scoreB = b.score ?? 0;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });

  // Build context within token budget
  const selectedMemories: MemoryItem[] = [];
  let currentTokens = MEMORY_OVERHEAD; // Start with overhead for XML tags
  
  for (const mem of sorted) {
    if (selectedMemories.length >= maxMemories) break;
    
    const memTokens = estimateTokens(mem.memory) + 10; // +10 for bullet point
    if (currentTokens + memTokens <= budget) {
      selectedMemories.push(mem);
      currentTokens += memTokens;
    } else if (selectedMemories.length === 0 && enableSummarization) {
      // If first memory is too long, truncate it
      const truncated = truncateMemory(mem, budget - MEMORY_OVERHEAD - 20);
      selectedMemories.push(truncated);
      currentTokens = budget;
      break;
    } else {
      break;
    }
  }

  // Build context string
  const context = buildContextString(selectedMemories);

  return {
    context,
    injectedCount: selectedMemories.length,
    totalMemories: memories.length,
    estimatedTokens: currentTokens,
    truncated: selectedMemories.length < memories.length,
    summarized: selectedMemories.some(m => m.memory.endsWith("...")),
  };
}

function findModelLimit(modelId: string): number {
  const normalizedId = modelId.toLowerCase();
  
  for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (normalizedId.includes(key.toLowerCase())) {
      return limit;
    }
  }
  
  return MODEL_CONTEXT_LIMITS.default;
}

function truncateMemory(mem: MemoryItem, maxTokens: number): MemoryItem {
  const maxChars = maxTokens * 2; // Conservative char estimate
  if (mem.memory.length <= maxChars) return mem;
  
  return {
    ...mem,
    memory: mem.memory.substring(0, maxChars - 3) + "...",
  };
}

function buildContextString(memories: MemoryItem[]): string {
  if (memories.length === 0) return "";
  
  const lines = memories.map((m, i) => {
    const score = m.score ? ` [${(m.score * 100).toFixed(0)}%]` : "";
    const source = (m as any)._source === "archive" ? " [ARCHIVE]" : "";
    return `${i + 1}. ${m.memory}${score}${source}`;
  });
  
  return `<relevant-memories>\n${lines.join("\n")}\n</relevant-memories>`;
}

// Summarize memories if they're too long (simple extractive summary)
export function summarizeMemories(memories: MemoryItem[], targetTokens: number): string {
  if (memories.length === 0) return "";
  
  // Simple strategy: extract key phrases (first sentence of each memory)
  const phrases: string[] = [];
  let currentTokens = MEMORY_OVERHEAD;
  
  for (const mem of memories) {
    const firstSentence = mem.memory.split(/[。.!?\n]/)[0];
    const tokens = estimateTokens(firstSentence) + 5;
    
    if (currentTokens + tokens <= targetTokens) {
      phrases.push(firstSentence + (firstSentence !== mem.memory ? "..." : ""));
      currentTokens += tokens;
    }
  }
  
  if (phrases.length === 0) return "";
  
  return `<memory-summary>\nKey facts:\n${phrases.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n</memory-summary>`;
}
