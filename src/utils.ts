
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
 * Clean JSON response from LLMs that might wrap it in markdown or add commentary.
 */
export function cleanJsonResponse(content: string): string {
  if (!content || typeof content !== "string") return content;

  let cleaned = content.trim();

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
 * Wraps an LLM instance to strip markdown code blocks from JSON responses.
 */
export class JsonCleaningLLM {
  constructor(private wrappedLLM: any, private logger?: OpenClawPluginApi["logger"]) { }

  async generateResponse(
    messages: Array<{ role: string; content: string }>,
    responseFormat?: any,
    tools?: any
  ): Promise<string | { content: string; role: string; toolCalls?: any[] }> {
    const response = await this.wrappedLLM.generateResponse(messages, responseFormat, tools);

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
}
