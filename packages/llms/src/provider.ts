import { streamSimple as openaiCompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
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

/**
 * pi `Model` for an OpenAI-compatible completions endpoint (OpenAI, OpenRouter,
 * Ollama `/v1`, ...). `provider` doubles as the pi ProviderId; OpenAI-compat
 * auto-detection keys off `baseUrl`, not the provider id.
 */
export function buildModel(sel: ProviderSelection): Model<"openai-completions"> {
  return {
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
}

/**
 * Stream function for the pi agent loop (its `streamFn` slot): the raw
 * openai-completions stream with the provider's apiKey injected and a
 * per-request timeout. One stream covers a whole stage's generation, so a
 * long outline can legitimately take minutes; 60s was aborting mid-stream.
 */
export function buildStreamFn(
  sel: ProviderSelection,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
  const timeoutMs = Math.max(1_000, Number(process.env.TUTOR_REQUEST_TIMEOUT_MS ?? 300_000) || 300_000);
  return (model, context, options) => {
    const signal = options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    return openaiCompletionsStream(model as Model<"openai-completions">, context, {
      ...options,
      // Keyless local endpoints (Ollama, llama.cpp) still need SOMETHING in
      // the key slot: pi's stream throws "No API key for provider" otherwise.
      // "unused" is pi's own convention for header-authed providers.
      apiKey: sel.apiKey ?? "unused",
      signal,
    });
  };
}
