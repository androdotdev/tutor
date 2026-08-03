import type { AgentModel, AgentMessage, AgentModelEvent } from "@cline/shared";

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

/* ------------------------ Cline AgentMessage -> provider ------------------------ */

function renderMessages(
  systemPrompt: string | undefined,
  messages: readonly AgentMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  for (const m of messages) {
    if (m.role === "user") {
      const text = m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
      if (text) out.push({ role: "user", content: text });
    } else if (m.role === "assistant") {
      const msg: Record<string, unknown> = { role: "assistant" };
      const text = m.content.filter((p) => p.type === "text").map((p) => p.text).join("");
      if (text) msg.content = text;
      const calls = m.content
        .filter((p) => p.type === "tool-call")
        .map((p) => ({
          id: p.toolCallId,
          type: "function",
          function: {
            name: p.toolName,
            arguments:
              typeof p.input === "string" ? p.input : JSON.stringify(p.input ?? {}),
          },
        }));
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else if (m.role === "tool") {
      for (const p of m.content) {
        if (p.type === "tool-result") {
          out.push({
            role: "tool",
            tool_call_id: p.toolCallId,
            content:
              typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? null),
          });
        }
      }
    }
  }
  return out;
}

/* --------------------------------- SSE stream -------------------------------- */

async function* sse(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`provider ${res.status}: ${text.slice(0, 300) || res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload) as SseChunk;
      } catch {
        /* skip malformed heartbeats */
      }
    }
  }
}

interface SseToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface SseChoice {
  delta?: { content?: string; tool_calls?: SseToolCallDelta[] };
  finish_reason?: string | null;
}
interface SseChunk {
  choices?: SseChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function parseChunk(chunk: SseChunk, events: AgentModelEvent[]): void {
  const choice = chunk.choices?.[0];
  if (choice?.delta?.content) {
    events.push({ type: "text-delta", text: choice.delta.content });
  }
  for (const tc of choice?.delta?.tool_calls ?? []) {
    events.push({
      type: "tool-call-delta",
      index: tc.index ?? 0,
      toolCallId: typeof tc.id === "string" ? tc.id : undefined,
      toolName: tc.function?.name,
      inputText: tc.function?.arguments,
    });
  }
  if (typeof choice?.finish_reason === "string") {
    events.push({
      type: "finish",
      reason: choice.finish_reason === "tool_calls" ? "tool-calls" : "stop",
    });
  }
  if (chunk.usage && typeof chunk.usage.prompt_tokens === "number") {
    events.push({
      type: "usage",
      usage: {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  }
}

/** Cline AgentModel backed by an OpenAI-compatible /chat/completions stream. */
export function buildModel(sel: ProviderSelection): AgentModel {
  return {
    async *stream(request) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sel.apiKey) headers.authorization = `Bearer ${sel.apiKey}`;

      const body = {
        model: sel.modelId,
        messages: renderMessages(request.systemPrompt, request.messages),
        tools: (request.tools ?? []).map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
          },
        })),
        stream: true,
      };

      const events: AgentModelEvent[] = [];
      let finished = false;
      for await (const chunk of sse(`${sel.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.signal
          ? AbortSignal.any([request.signal, AbortSignal.timeout(60_000)])
          : AbortSignal.timeout(60_000),
      })) {
        parseChunk(chunk, events);
        if (events.some((e) => e.type === "finish")) finished = true;
        // Yield incrementally so the runtime forwards deltas live (streaming
        // UI) instead of only after the HTTP stream closes.
        if (events.length) yield* events.splice(0);
      }
      if (!finished) {
        yield { type: "finish", reason: "stop" };
      }
    },
  };
}