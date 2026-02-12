
import * as fs from "node:fs";
import * as path from "node:path";
import { type PendingAction } from "./types.js";
import { REFLECTION_PROMPT } from "./constants.js";
import { cleanJsonResponse } from "./utils.js";
import { type OpenClawPluginApi } from "openclaw/plugin-sdk";

export class ReflectionEngine {
  private pendingActions: PendingAction[] = [];
  private readonly MAX_PENDING = 20; // Increased limit
  private readonly ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (longer memory)
  private readonly DB_FILE = "mem0-actions.json";
  private dbPath: string;

  constructor(
    private readonly llmConfig: { provider: string; config: Record<string, unknown> } | undefined,
    private readonly logger: OpenClawPluginApi["logger"],
    private readonly dataDir: string // ~/.openclaw/extensions/openclaw-mem0/ or similar
  ) {
    this.dbPath = path.join(this.dataDir, this.DB_FILE);
    this.loadActions();
  }

  private loadActions() {
    try {
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, "utf-8");
        this.pendingActions = JSON.parse(data);
        this.logger.debug?.(`[mem0] Loaded ${this.pendingActions.length} pending actions from ${this.dbPath}`);
      }
    } catch (err) {
      this.logger.warn(`[mem0] Failed to load pending actions: ${err}`);
      this.pendingActions = [];
    }
  }

  private saveActions() {
    try {
      // Ensure dir exists
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      
      fs.writeFileSync(this.dbPath, JSON.stringify(this.pendingActions, null, 2));
    } catch (err) {
      this.logger.warn(`[mem0] Failed to save pending actions: ${err}`);
    }
  }

  async reflect(
    recentMessages: Array<{ role: string; content: string }>,
    recentMemories: Array<{ memory: string }>,
  ): Promise<void> {
    if (!this.llmConfig) return;
    if (recentMessages.length === 0) return;

    this.pruneActions();
    if (this.pendingActions.length >= this.MAX_PENDING) return;

    try {
      const conversationSummary = recentMessages.map((m) => `${m.role}: ${m.content}`).join("\n");
      const memorySummary = recentMemories.length > 0
        ? recentMemories.map((m) => `- ${m.memory}`).join("\n")
        : "(no stored memories yet)";

      const userPrompt = `Recent conversation:\n${conversationSummary}\n\nStored memories:\n${memorySummary}`;
      
      const llmCfg = this.llmConfig.config;
      const provider = this.llmConfig.provider?.toLowerCase() ?? "openai";
      const model = (llmCfg.model as string) || "gpt-4o";

      let responseText = "";

      // Call LLM (Ollama or OpenAI-compatible)
      if (provider === "ollama") {
        const ollamaUrl = (llmCfg.url as string) || "http://127.0.0.1:11434";
        const response = await fetch(`${ollamaUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: REFLECTION_PROMPT },
              { role: "user", content: userPrompt },
            ],
            stream: false,
            options: { temperature: 0.3 },
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return;
        const data = (await response.json()) as any;
        responseText = data?.message?.content ?? "";
      } else {
        const baseURL = (llmCfg.baseURL as string) || "https://api.openai.com/v1";
        const apiKey = (llmCfg.apiKey as string) || "";
        const response = await fetch(`${baseURL}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: REFLECTION_PROMPT },
              { role: "user", content: userPrompt },
            ],
            temperature: 0.3,
            max_tokens: 200,
            response_format: { type: "json_object" } // Try to enforce JSON
          }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) return;
        const data = (await response.json()) as any;
        responseText = data?.choices?.[0]?.message?.content ?? "";
      }

      const content = cleanJsonResponse(responseText);
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
        this.saveActions(); // Persist immediately
        this.logger.info(`[mem0] Intent detected: "${action.message}" (trigger in ${result.delay_minutes}m)`);
      }
    } catch (err) {
      this.logger.debug?.(`[mem0] Reflection error: ${err}`);
    }
  }

  checkPendingActions(): PendingAction | null {
    this.pruneActions();
    const now = Date.now();

    for (const action of this.pendingActions) {
      if (!action.fired && action.triggerAt <= now) {
        action.fired = true;
        this.saveActions(); // Persist state change
        return action;
      }
    }
    return null;
  }

  // Called when delivery fails to un-fire so we can try again or inject later
  markActionFailed(actionId: string) {
    const action = this.pendingActions.find(a => a.id === actionId);
    if (action) {
      action.fired = false;
      action.deliveryAttempts = (action.deliveryAttempts || 0) + 1;
      this.saveActions();
    }
  }

  private pruneActions(): void {
    const now = Date.now();
    const initialLen = this.pendingActions.length;
    
    this.pendingActions = this.pendingActions.filter(
      (a) => !a.fired && (now - a.createdAt < this.ACTION_TTL_MS),
    );

    if (this.pendingActions.length !== initialLen) {
      this.saveActions();
    }
  }
}
