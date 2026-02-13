import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

/**
 * Supported API formats
 */
export type ApiFormat = "openai" | "anthropic" | "gemini" | "minimax" | "deepseek" | "zhipu" | "ollama" | "custom";

export interface UnifiedLLMConfig {
  provider: string;
  apiFormat?: ApiFormat; // Explicit format override
  apiKey: string;
  model: string;
  baseURL?: string;
  url?: string; // Used by Ollama
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  timeout?: number;
  headers?: Record<string, string>;
  // Provider-specific configs
  minimax?: {
    groupId?: string;
  };
  gemini?: {
    apiVersion?: string;
  };
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletion {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

async function parseJsonResponse(response: Response, label: string, url: string): Promise<any> {
  const bodyText = await response.text();
  const shortBody = bodyText.slice(0, 240).replace(/\s+/g, " ").trim();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(`${label} API error: ${response.status} ${response.statusText} (${url}) - ${shortBody}`);
  }

  if (!contentType.toLowerCase().includes("json")) {
    throw new Error(`${label} returned non-JSON content (${contentType || "unknown"}) from ${url}: ${shortBody}`);
  }

  try {
    return JSON.parse(bodyText);
  } catch (err: any) {
    throw new Error(`${label} returned invalid JSON from ${url}: ${shortBody} (${err.message})`);
  }
}

function extractContentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;

    const type = String((part as any).type || "").toLowerCase();
    if (type === "reasoning" || type === "thinking" || type === "analysis") {
      continue;
    }
    if (typeof (part as any).text === "string") {
      parts.push((part as any).text);
      continue;
    }
    if (typeof (part as any).content === "string") {
      parts.push((part as any).content);
      continue;
    }
  }

  return parts.join("\n").trim();
}

function extractOpenAIChoiceText(choice: any): string {
  const message = choice?.message ?? {};
  let content = extractContentText(message.content);
  if (!content && typeof message.output_text === "string") {
    content = message.output_text;
  }
  if (!content && typeof message.text === "string") {
    content = message.text;
  }
  // Some reasoning models expose only reasoning_content when content is empty.
  if (!content && typeof message.reasoning_content === "string") {
    content = message.reasoning_content;
  }
  return content || "";
}

/**
 * Clean reasoning/thinking tags from LLM response (MiniMax, DeepSeek, etc.)
 */
function cleanThinkingTags(content: string): string {
  // Remove fenced thinking/reasoning blocks
  content = content.replace(/```(?:thinking|reasoning|analysis)\s*[\s\S]*?```/gi, "");
  // Remove common sentinel markers from reasoning models
  content = content.replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, "");

  // Remove <think>...</think> blocks (common in reasoning models)
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  
  // Remove <thinking>...</thinking> blocks
  content = content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
  
  // Remove <reasoning>...</reasoning> blocks
  content = content.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
  content = content.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '');
  content = content.replace(/<thought>[\s\S]*?<\/thought>/gi, '');

  // If model returns "thinking... Final Answer: ...", keep only final answer section.
  const markerRegex = /(final answer|最终答案|最终结论|结论)[:：]/i;
  const markerMatch = markerRegex.exec(content);
  if (markerMatch && markerMatch.index > 0) {
    const prefix = content.slice(0, markerMatch.index);
    if (/(thinking|reasoning|思考|推理)/i.test(prefix)) {
      content = content.slice(markerMatch.index + markerMatch[0].length).trim();
    }
  }
  
  // Trim whitespace
  return content.trim();
}

/**
 * Unified LLM wrapper supporting multiple API formats
 */
export class UnifiedLLM {
  private config: UnifiedLLMConfig;
  private logger: OpenClawPluginApi["logger"];
  private format: ApiFormat;

  constructor(config: UnifiedLLMConfig, logger: OpenClawPluginApi["logger"]) {
    this.config = {
      temperature: 0.7,
      maxTokens: 4096,
      topP: 1,
      timeout: 60000,
      ...config,
    };
    this.logger = logger;
    this.format = this.detectFormat();
    this.logger.info(`[mem0] UnifiedLLM initialized with format: ${this.format} (${config.model})`);
  }

  /**
   * Auto-detect API format from config
   */
  private detectFormat(): ApiFormat {
    // Explicit override
    if (this.config.apiFormat) {
      return this.config.apiFormat;
    }

    const baseURL = this.config.baseURL?.toLowerCase() || "";
    const provider = this.config.provider.toLowerCase();
    const model = this.config.model.toLowerCase();

    // Detect by URL patterns
    if (baseURL.includes("anthropic") || baseURL.includes("claude")) {
      return "anthropic";
    }
    if (baseURL.includes("googleapis") || baseURL.includes("generativelanguage") || model.includes("gemini")) {
      return "gemini";
    }
    if (baseURL.includes("minimax") || model.includes("minimax")) {
      return "minimax";
    }
    if (baseURL.includes("deepseek")) {
      return "deepseek";
    }
    if (baseURL.includes("bigmodel.cn") || baseURL.includes("zhipu")) {
      return "zhipu";
    }

    // Detect by provider name
    if (provider === "anthropic") return "anthropic";
    if (provider === "gemini" || provider === "google") return "gemini";
    if (provider === "minimax") return "minimax";
    if (provider === "deepseek") return "deepseek";
    if (provider === "zhipu") return "zhipu";
    if (provider === "ollama") return "ollama";

    // Default to OpenAI (most common)
    return "openai";
  }

  private getTimeoutSignal(): AbortSignal {
    const timeoutMs = Math.max(1_000, Number(this.config.timeout) || 60_000);
    return AbortSignal.timeout(timeoutMs);
  }

  private resolveMiniMaxUrl(): string {
    const configured = (this.config.baseURL || "").trim();
    if (!configured) {
      return "https://api.minimaxi.com/v1/text/chatcompletion_v2";
    }

    let url = configured.replace(/\/$/, "");
    // Common copy-paste of OpenAI path - MiniMax expects v2 endpoint.
    url = url.replace(/\/chat\/completions$/i, "");

    if (url.endsWith("/text/chatcompletion_v2")) return url;

    // Older root/base patterns.
    if (url.endsWith("/v1")) return `${url}/text/chatcompletion_v2`;
    if (url.endsWith("/api/v1")) return `${url}/text/chatcompletion_v2`;

    // Users sometimes reuse anthropic endpoint from OpenClaw model provider.
    if (url.includes("/anthropic")) {
      return `${url.replace(/\/anthropic.*$/i, "")}/v1/text/chatcompletion_v2`;
    }

    return url;
  }

  /**
   * Generate chat completion
   */
  async generate(messages: Message[], options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }): Promise<string> {
    try {
      let result: string;
      switch (this.format) {
        case "openai":
        case "deepseek":
        case "zhipu":
          result = await this.callOpenAICompatible(messages, options);
          break;
        case "ollama":
          result = await this.callOllama(messages, options);
          break;
        case "anthropic":
          result = await this.callAnthropic(messages, options);
          break;
        case "gemini":
          result = await this.callGemini(messages, options);
          break;
        case "minimax":
          result = await this.callMiniMax(messages, options);
          break;
        default:
          result = await this.callOpenAICompatible(messages, options);
      }
      
      // Clean thinking/reasoning tags from response (MiniMax, DeepSeek, etc.)
      return cleanThinkingTags(result);
    } catch (error: any) {
      this.logger.error(`[mem0] LLM call failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * OpenAI-compatible API (OpenAI, DeepSeek, Zhipu, etc.)
   */
  private async callOpenAICompatible(messages: Message[], options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }): Promise<string> {
    const url = this.config.baseURL 
      ? `${this.config.baseURL.replace(/\/$/, "")}/chat/completions`
      : "https://api.openai.com/v1/chat/completions";

    const body: any = {
      model: this.config.model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      top_p: this.config.topP,
    };

    if (options?.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { "Authorization": `Bearer ${this.config.apiKey}` } : {}),
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal: this.getTimeoutSignal(),
    });

    const data = await parseJsonResponse(response, "OpenAI-compatible", url) as ChatCompletion;
    return extractOpenAIChoiceText(data.choices?.[0]);
  }

  /**
   * Ollama local API
   */
  private async callOllama(messages: Message[], options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }): Promise<string> {
    const baseURL = (this.config.url || this.config.baseURL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const url = `${baseURL}/api/chat`;

    const payloadMessages = options?.jsonMode
      ? [
          ...messages,
          {
            role: "user" as const,
            content: "Respond with valid JSON only.",
          },
        ]
      : messages;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: payloadMessages,
        stream: false,
        options: {
          temperature: options?.temperature ?? this.config.temperature,
          num_predict: options?.maxTokens ?? this.config.maxTokens,
        },
      }),
      signal: this.getTimeoutSignal(),
    });

    const data = await parseJsonResponse(response, "Ollama", url) as any;
    return extractContentText(data?.message?.content) || data?.message?.content || "";
  }

  /**
   * Anthropic Claude API
   */
  private async callAnthropic(messages: Message[], options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }): Promise<string> {
    const url = this.config.baseURL 
      ? `${this.config.baseURL.replace(/\/$/, "")}/messages`
      : "https://api.anthropic.com/v1/messages";

    // Separate system message from other messages
    const systemMessage = messages.find(m => m.role === "system")?.content;
    const chatMessages = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    }));

    const body: any = {
      model: this.config.model,
      messages: chatMessages,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
      temperature: options?.temperature ?? this.config.temperature,
      top_p: this.config.topP,
    };

    if (systemMessage) {
      body.system = systemMessage;
    }

    // Anthropic doesn't have native JSON mode, add instruction
    if (options?.jsonMode) {
      body.messages[body.messages.length - 1].content += "\n\nRespond with valid JSON only.";
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { "x-api-key": this.config.apiKey } : {}),
        "anthropic-version": "2023-06-01",
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal: this.getTimeoutSignal(),
    });

    const data = await parseJsonResponse(response, "Anthropic", url) as any;
    const contentList = Array.isArray(data.content) ? data.content : [];
    const text = contentList
      .map((item: any) => (typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || "";
  }

  /**
   * Google Gemini API
   */
  private async callGemini(messages: Message[], options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }): Promise<string> {
    const apiVersion = this.config.gemini?.apiVersion || "v1beta";
    const modelName = this.config.model.startsWith("models/") 
      ? this.config.model 
      : `models/${this.config.model}`;
    
    const url = this.config.baseURL
      ? `${this.config.baseURL.replace(/\/$/, "")}/${apiVersion}/${modelName}:generateContent`
      : `https://generativelanguage.googleapis.com/${apiVersion}/${modelName}:generateContent`;

    // Convert messages to Gemini format
    const contents = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const systemInstruction = messages.find(m => m.role === "system")?.content;

    const body: any = {
      contents,
      generationConfig: {
        temperature: options?.temperature ?? this.config.temperature,
        maxOutputTokens: options?.maxTokens ?? this.config.maxTokens,
        topP: this.config.topP,
      },
    };

    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    if (options?.jsonMode) {
      body.generationConfig.responseMimeType = "application/json";
    }

    const separator = url.includes("?") ? "&" : "?";
    const fullUrl = `${url}${separator}key=${this.config.apiKey}`;

    const response = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(body),
      signal: this.getTimeoutSignal(),
    });

    const data = await parseJsonResponse(response, "Gemini", fullUrl) as any;
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  /**
   * MiniMax API
   */
  private async callMiniMax(messages: Message[], options?: { jsonMode?: boolean; temperature?: number; maxTokens?: number }): Promise<string> {
    // MiniMax uses OpenAI-compatible format but with some differences
    const groupId = this.config.minimax?.groupId;
    
    const url = this.resolveMiniMaxUrl();

    // Map user-friendly model names to API IDs
    let model = this.config.model;
    const normalizedModel = model.toLowerCase();
    if (
      normalizedModel === "minimax-m2.5" ||
      normalizedModel === "minimax2.5" ||
      normalizedModel.includes("m2.5") ||
      normalizedModel.includes("lightning") ||
      normalizedModel.includes("highspeed")
    ) {
      model = "abab6.5-chat";
    }

    const body: any = {
      model: model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      temperature: options?.temperature ?? this.config.temperature,
      max_tokens: options?.maxTokens ?? this.config.maxTokens,
    };

    if (options?.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.config.apiKey ? { "Authorization": `Bearer ${this.config.apiKey}` } : {}),
      ...this.config.headers,
    };

    if (groupId) {
      headers["Group-Id"] = groupId;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: this.getTimeoutSignal(),
    });

    const data = await parseJsonResponse(response, "MiniMax", url) as ChatCompletion;
    return extractOpenAIChoiceText(data.choices?.[0]);
  }
}

/**
 * Create appropriate LLM client based on config
 */
export function createLLM(
  config: { provider: string; config: Record<string, unknown> },
  logger: OpenClawPluginApi["logger"]
): UnifiedLLM {
  const provider = String(config.provider || "openai").trim().toLowerCase();
  const apiKey = ((config.config.apiKey as string | undefined) || "").trim();
  const headers = config.config.headers as Record<string, string> | undefined;
  const hasAuthHeader = Boolean(
    headers && Object.keys(headers).some((key) => {
      const lowered = key.toLowerCase();
      return lowered === "authorization" || lowered === "x-api-key" || lowered === "api-key";
    })
  );

  if (provider === "gemini" && !apiKey) {
    throw new Error("[mem0] Missing apiKey for provider 'gemini'.");
  }

  if (provider !== "ollama" && !apiKey && !hasAuthHeader) {
    throw new Error(`[mem0] Missing apiKey for provider '${provider}'. Set apiKey or provide auth headers in oss.llm.config.headers.`);
  }

  const llmConfig: UnifiedLLMConfig = {
    provider,
    apiKey,
    model: (config.config.model as string) || "gpt-4",
    baseURL: (config.config.baseURL as string | undefined) ?? (config.config.baseUrl as string | undefined),
    url: config.config.url as string | undefined,
    temperature: config.config.temperature as number | undefined,
    maxTokens: config.config.maxTokens as number | undefined,
    topP: config.config.topP as number | undefined,
    timeout: config.config.timeout as number | undefined,
    headers,
    apiFormat: config.config.apiFormat as ApiFormat | undefined,
    minimax: config.config.minimax as { groupId?: string } | undefined,
    gemini: config.config.gemini as { apiVersion?: string } | undefined,
  };

  return new UnifiedLLM(llmConfig, logger);
}
