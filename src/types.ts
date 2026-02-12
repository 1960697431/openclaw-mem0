
export type Mem0Mode = "platform" | "open-source";

export type Mem0Config = {
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
  proactiveChannel?: string;
  proactiveTarget?: string;
  gatewayPort?: number;
};

export interface MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
  _scope?: "session" | "long-term";
}

export interface AddResultItem {
  id: string;
  memory: string;
  event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
}

export interface AddResult {
  results: AddResultItem[];
}

export interface PendingAction {
  id: string;
  message: string;
  createdAt: number;
  triggerAt: number;
  fired: boolean;
  deliveryAttempts?: number;
}

// Unified Provider Interfaces
export interface AddOptions {
  user_id: string;
  run_id?: string;
  custom_instructions?: string;
  custom_categories?: Array<Record<string, string>>;
  enable_graph?: boolean;
  output_format?: string;
}

export interface SearchOptions {
  user_id: string;
  run_id?: string;
  top_k?: number;
  threshold?: number;
  limit?: number;
  keyword_search?: boolean;
  reranking?: boolean;
}

export interface ListOptions {
  user_id: string;
  run_id?: string;
  page_size?: number;
}

export interface Mem0Provider {
  add(messages: Array<{ role: string; content: string }>, options: AddOptions): Promise<AddResult>;
  search(query: string, options: SearchOptions): Promise<MemoryItem[]>;
  get(memoryId: string): Promise<MemoryItem>;
  getAll(options: ListOptions): Promise<MemoryItem[]>;
  delete(memoryId: string): Promise<void>;
}
