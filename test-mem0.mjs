// Test mem0 OSS LLM configuration - simplified without transformers.js
import { Memory, LLMFactory } from "mem0ai/oss";

process.env.MEM0_TELEMETRY = "false";

// Patch LLM to log what it's doing
const originalCreate = LLMFactory.create.bind(LLMFactory);
LLMFactory.create = (provider, config) => {
  console.log("[TEST] LLMFactory.create called:");
  console.log("  provider:", provider);
  console.log("  config:", JSON.stringify(config, null, 2));
  const llm = originalCreate(provider, config);
  console.log("[TEST] LLM created, type:", llm.constructor?.name);
  console.log("[TEST] LLM has openai?", !!llm.openai);
  if (llm.openai) {
    console.log("[TEST] openai.baseURL:", llm.openai.baseURL);
    console.log("[TEST] openai.apiKey (first 20 chars):", llm.openai.apiKey?.substring(0, 20) + "...");
  }
  return llm;
};

const config = {
  version: "v1.1",
  disableHistory: true,
  llm: {
    provider: "openai",
    config: {
      apiKey: process.env.MEM0_TEST_API_KEY || "",
      model: "abab6.5s-chat",
      baseURL: "https://api.minimax.chat/v1"
    }
  },
  vectorStore: {
    provider: "memory",
    config: { dimension: 1024 }
  }
};

console.log("[TEST] Creating Memory with config...");
try {
  if (!config.llm.config.apiKey) {
    throw new Error("Missing MEM0_TEST_API_KEY. Set it in environment before running this test.");
  }

  const memory = new Memory(config);
  console.log("[TEST] Memory created");
  
  console.log("[TEST] Testing add...");
  const result = await memory.add(
    [{ role: "user", content: "测试记忆存储" }],
    { userId: "test" }
  );
  console.log("[TEST] Success:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("[TEST] Error:", err.message);
  if (err.cause) console.error("[TEST] Cause:", err.cause);
}
