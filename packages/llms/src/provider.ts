import type { AgentModel, AgentMessage, AgentModelEvent } from "@cline/shared";
import { streamSimple as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import type {
  AssistantMessageEvent,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
} from "@earendil-works/pi-ai";

export interface ProviderSelection {
  provider: "openai" | "ollama";
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  label: string;
}

const ENV = (k: string) => process.env[k] ?? undefined;

/** Values from the user's XDG config file; env vars take precedence per key. */
export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/** Provider-agnostic: ANTHROPIC (P1+) -> OPENAI_API_KEY -> OLLAMA_HOST. null => no LLM. */
export function resolveProvider(config?: ProviderConfig): ProviderSelection | null {
  // Env wins per key; config fills the gaps (e.g. a persisted key + model).
  const openaiKey = ENV("OPENAI_API_KEY") ?? config?.apiKey;
  if (openaiKey) {
    const isOpenRouter = openaiKey.startsWith("sk-or-");
    return {
      provider: "openai",
      modelId: ENV("TUTOR_MODEL") ?? config?.model ?? (isOpenRouter ? "openrouter/free" : "gpt-4o-mini"),
      baseUrl: (
        ENV("OPENAI_BASE_URL") ??
        config?.baseUrl ??
        (isOpenRouter ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1")
      ).replace(/\/+$/, ""),
      label: isOpenRouter ? "openrouter" : "openai",
      apiKey: openaiKey,
    };
  }
  // A config baseUrl without an apiKey is treated as a local/unauth endpoint.
  const ollama = ENV("OLLAMA_HOST") ?? config?.baseUrl;
  if (ollama) {
    const host = ollama.replace(/\/+$/, "");
    return {
      provider: "ollama",
      modelId: ENV("TUTOR_MODEL") ?? config?.model ?? "llama3.2",
      baseUrl: /\/v1$/.test(host) ? host : `${host}/v1`,
      label: "ollama",
    };
  }
  return null;
}

/* ------------------- Cline AgentMessage <-> pi Context bridge ------------------- */

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function parseToolArgs(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function toPiMessage(m: AgentMessage, model: Model<"openai-completions">): Message {
  if (m.role === "user") {
    const text = m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
    // Empty array form makes the wire converter skip the message entirely.
    return { role: "user", content: text || [], timestamp: 0 };
  }
  if (m.role === "assistant") {
    const content: (TextContent | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> })[] = [];
    for (const p of m.content) {
      if (p.type === "text") content.push({ type: "text", text: p.text });
      else if (p.type === "tool-call") {
        content.push({ type: "toolCall", id: p.toolCallId, name: p.toolName, arguments: parseToolArgs(p.input) });
      }
    }
    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: model.provider,
      model: model.id,
      usage: EMPTY_USAGE,
      stopReason: "stop",
      timestamp: 0,
    };
  }
  // role === "tool"
  const parts: TextContent[] = [];
  let toolCallId = "";
  let toolName = "";
  let isError = false;
  for (const p of m.content) {
    if (p.type === "tool-result") {
      toolCallId = p.toolCallId;
      toolName = p.toolName;
      isError = !!p.isError;
      parts.push({ type: "text", text: typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null) });
    }
  }
  return { role: "toolResult", toolCallId, toolName, content: parts, isError, timestamp: 0 };
}

function toPiTool(t: { name: string; description: string; inputSchema: Record<string, unknown> }): Tool {
  return {
    name: t.name,
    description: t.description,
    // Plain JSON-Schema objects pass through to the wire untouched; TypeBox
    // validation only runs inside pi-agent-core's loop (P3), not the stream.
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as unknown as Tool["parameters"],
  };
}

/** pi stream events -> cline AgentModelEvent deltas. */
function toClineEvents(e: AssistantMessageEvent): AgentModelEvent[] {
  switch (e.type) {
    case "text_delta":
      return [{ type: "text-delta", text: e.delta }];
    case "toolcall_end":
      // pi assembles tool-call fragments (by index and id) into one block, so a
      // single event carries the complete call — no per-fragment id bookkeeping.
      return [{
        type: "tool-call-delta",
        toolCallId: e.toolCall.id,
        toolName: e.toolCall.name,
        inputText: JSON.stringify(e.toolCall.arguments),
      }];
    case "done": {
      const events: AgentModelEvent[] = [];
      const u = e.message.usage;
      if (u && (u.input > 0 || u.output > 0)) {
        events.push({
          type: "usage",
          usage: { inputTokens: u.input, outputTokens: u.output, cacheReadTokens: u.cacheRead, cacheWriteTokens: u.cacheWrite },
        });
      }
      events.push({
        type: "finish",
        reason: e.reason === "toolUse" ? "tool-calls" : e.reason === "length" ? "max-tokens" : "stop",
      });
      return events;
    }
    case "error":
      return [{ type: "finish", reason: e.reason === "aborted" ? "aborted" : "error", error: e.error.errorMessage ?? "stream error" }];
    default:
      return [];
  }
}

/** Cline AgentModel backed by pi-ai's openai-completions stream. */
export function buildModel(sel: ProviderSelection): AgentModel {
  const model: Model<"openai-completions"> = {
    id: sel.modelId,
    name: sel.modelId,
    api: "openai-completions",
    provider: sel.provider,
    baseUrl: sel.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };

  return {
    async *stream(request) {
      // One stream per run covers a whole stage's generation, so a long
      // outline can legitimately take minutes; 60s was aborting mid-stream.
      const timeoutMs = Math.max(1_000, Number(process.env.TUTOR_REQUEST_TIMEOUT_MS ?? 300_000) || 300_000);
      const signal = request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);

      const context: Context = {
        systemPrompt: request.systemPrompt,
        messages: request.messages.map((m) => toPiMessage(m, model)),
        tools: request.tools.map(toPiTool),
      };
      const options: SimpleStreamOptions = { apiKey: sel.apiKey, signal };

      for await (const e of openaiCompletionsStream(model, context, options)) {
        yield* toClineEvents(e);
      }
    },
  };
}
