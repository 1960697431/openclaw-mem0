
import { type OpenClawPluginApi } from "openclaw/plugin-sdk";

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export function resolveEnvVarsDeep(obj: Record<string, unknown>): Record<string, unknown> {
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

/**
 * Smartly fix common configuration mistakes for LLM providers, especially for Chinese models.
 */
export function fixLlmConfig(provider: string, config: Record<string, unknown>): { provider: string; config: Record<string, unknown> } {
  const cfg = { ...config };
  let prov = provider.toLowerCase();

  // 1. Normalize provider names (allow users to say "deepseek" instead of "openai")
  const KNOWN_PROVIDERS: Record<string, string> = {
    "deepseek": "https://api.deepseek.com/v1",
    "moonshot": "https://api.moonshot.cn/v1",
    "kimi": "https://api.moonshot.cn/v1",
    "qwen": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "glm": "https://open.bigmodel.cn/api/paas/v4",
    "yi": "https://api.lingyiwanwu.com/v1",
    "siliconflow": "https://api.siliconflow.cn/v1",
    "dashscope": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "zhipu": "https://open.bigmodel.cn/api/paas/v4",
    "minimax": "https://api.minimax.chat/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "baichuan": "https://api.baichuan-ai.com/v1",
    "doubao": "https://ark.cn-beijing.volces.com/api/v3",
    "ark": "https://ark.cn-beijing.volces.com/api/v3",
  };

  if (KNOWN_PROVIDERS[prov]) {
    // If user used a specific provider name, switch to "openai" but inject the correct baseURL
    if (!cfg.baseURL) {
      cfg.baseURL = KNOWN_PROVIDERS[prov];
    }
    // DeepSeek specific: ensure v1 suffix if user manually typed it wrong
    if (prov === "deepseek" && cfg.baseURL && typeof cfg.baseURL === "string" && !cfg.baseURL.endsWith("/v1")) {
       cfg.baseURL = cfg.baseURL.replace(/\/$/, "") + "/v1";
    }
    prov = "openai";
  }

  // 2. Fix common URL mistakes for OpenAI-compatible providers
  if (prov === "openai" && cfg.baseURL && typeof cfg.baseURL === "string") {
    let url = cfg.baseURL.trim();
    // Remove common endpoint-level mistakes
    url = url.replace(/\/chat\/completions\/?$/i, "");
    
    // DeepSeek: https://api.deepseek.com -> https://api.deepseek.com/v1
    if (url.includes("api.deepseek.com") && !url.includes("/v1")) {
      url = url.replace(/\/$/, "") + "/v1";
    }
    // Moonshot: https://api.moonshot.cn -> https://api.moonshot.cn/v1
    if (url.includes("api.moonshot.cn") && !url.includes("/v1")) {
      url = url.replace(/\/$/, "") + "/v1";
    }
    // Yi: https://api.lingyiwanwu.com -> https://api.lingyiwanwu.com/v1
    if (url.includes("api.lingyiwanwu.com") && !url.includes("/v1")) {
      url = url.replace(/\/$/, "") + "/v1";
    }
    // Baichuan: https://api.baichuan-ai.com -> https://api.baichuan-ai.com/v1
    if (url.includes("api.baichuan-ai.com") && !url.includes("/v1")) {
      url = url.replace(/\/$/, "") + "/v1";
    }
    // OpenRouter: https://openrouter.ai/api -> https://openrouter.ai/api/v1
    if (url.includes("openrouter.ai/api") && !url.includes("/api/v1")) {
      url = url.replace(/\/$/, "").replace(/\/api$/, "/api/v1");
    }
    // Doubao/Ark: https://ark.cn-beijing.volces.com -> https://ark.cn-beijing.volces.com/api/v3
    if (url.includes("volces.com") && !url.includes("/api/v3")) {
      url = url.replace(/\/$/, "") + "/api/v3";
    }
    
    cfg.baseURL = url;
  }

  // 3. Ollama: ensure url (not baseURL)
  if (prov === "ollama") {
    if (cfg.baseURL && !cfg.url) {
      cfg.url = cfg.baseURL; // User mistake: used baseURL for ollama
      delete cfg.baseURL;
    }
  }

  return { provider: prov, config: cfg };
}

/**
 * Clean JSON response from LLMs that might wrap it in markdown or add commentary.
 */
export function cleanJsonResponse(content: string): string {
  if (!content || typeof content !== "string") return content;

  let cleaned = content.trim();
  cleaned = cleaned
    .replace(/```(?:thinking|reasoning|analysis)\s*[\s\S]*?```/gi, "")
    .replace(/<\|begin_of_thought\|>[\s\S]*?<\|end_of_thought\|>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();

  // Strategy 1: Full-text code block
  const fullMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fullMatch) return fullMatch[1].trim();

  // Strategy 2: Last code block
  const codeBlocks = [...cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/g)];
  if (codeBlocks.length > 0) {
    const lastBlock = codeBlocks[codeBlocks.length - 1][1].trim();
    if (lastBlock.startsWith("{") || lastBlock.startsWith("[")) return lastBlock;
    return lastBlock;
  }

  // Strategy 3: Raw JSON object/array
  const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      JSON.parse(jsonMatch[1]);
      return jsonMatch[1];
    } catch { /* ignore */ }
  }

  return cleaned;
}

/**
 * Wraps an LLM instance to:
 * 1. Strip markdown code blocks from JSON responses
 * 2. Handle providers that don't support response_format (MiniMax, etc.)
 */
export class JsonCleaningLLM {
  private static JSON_PROMPT = `\n\nIMPORTANT: You must respond with valid JSON only. No markdown, no explanations, just the JSON object.`;
  
  constructor(
    private wrappedLLM: any, 
    private logger?: OpenClawPluginApi["logger"],
    private config?: Record<string, unknown>
  ) { }

  async generateResponse(
    messages: Array<{ role: string; content: string }>,
    responseFormat?: any,
    tools?: any
  ): Promise<string | { content: string; role: string; toolCalls?: any[] }> {
    // Handle providers that don't support response_format
    let modifiedMessages = messages;
    let modifiedFormat = responseFormat;
    
    if (responseFormat?.type === 'json_object') {
      const providerInfo = this.detectProvider();
      
      if (providerInfo.needsJsonWorkaround) {
        this.logger?.debug?.(`[mem0] Provider '${providerInfo.name}' doesn't support json_object mode, using prompt-based JSON enforcement`);
        
        // Remove the unsupported response_format
        modifiedFormat = undefined;
        
        // Add JSON enforcement to the last user message
        modifiedMessages = messages.map((msg, idx) => {
          if (idx === messages.length - 1 && msg.role === 'user') {
            return { ...msg, content: msg.content + JsonCleaningLLM.JSON_PROMPT };
          }
          return msg;
        });
      }
    }

    const response = await this.wrappedLLM.generateResponse(modifiedMessages, modifiedFormat, tools);

    if (typeof response === "string") {
      return cleanJsonResponse(response);
    }

    if (response && typeof response === "object" && response.content) {
      return {
        ...response,
        content: cleanJsonResponse(response.content),
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
        content: cleanJsonResponse(response.content),
      };
    }

    return response;
  }

  /**
   * Detect the LLM provider and whether it needs JSON mode workaround
   */
  private detectProvider(): { name: string; needsJsonWorkaround: boolean } {
    const baseURL = (this.config?.baseURL || this.config?.baseUrl || '') as string;
    const model = (this.config?.model || '') as string;
    
    // Providers known to NOT support response_format: json_object
    const noJsonModeProviders = [
      { pattern: 'minimax', name: 'MiniMax' },
      { pattern: 'api.minimax', name: 'MiniMax' },
      { pattern: 'abab', name: 'MiniMax' },
      { pattern: 'minimaxi', name: 'MiniMax' },
    ];
    
    // Providers that DO support json_object (no workaround needed)
    const supportsJsonMode = [
      'openai.com',
      'api.openai.com',
      'api.deepseek.com',
      'api.moonshot.cn',
      'claude',
      'anthropic',
      'api.anthropic',
    ];

    const urlLower = baseURL.toLowerCase();
    const modelLower = model.toLowerCase();

    // Check if it's a known no-json-mode provider
    for (const provider of noJsonModeProviders) {
      if (urlLower.includes(provider.pattern) || modelLower.includes(provider.pattern)) {
        return { name: provider.name, needsJsonWorkaround: true };
      }
    }

    // Check if it's a known json-mode supporter
    for (const provider of supportsJsonMode) {
      if (urlLower.includes(provider)) {
        return { name: provider, needsJsonWorkaround: false };
      }
    }

    // Default for non-OpenAI URLs: assume no json_object support
    // This is safer for Chinese/local LLMs
    if (urlLower && !urlLower.includes('openai.com')) {
      return { name: baseURL.split('//')[1]?.split('/')[0] || 'unknown', needsJsonWorkaround: true };
    }

    return { name: 'unknown', needsJsonWorkaround: false };
  }
}
