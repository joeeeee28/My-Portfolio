/**
 * AI model catalogue and providers (§43, §65, §66).
 *
 * No model is hard-coded into a task. Tasks are routed at runtime by the model
 * router in ./router.ts based on quality, cost, latency, context needs and
 * reliability — and only models whose provider is actually configured can be
 * selected for live calls.
 */
import type { AiProvider } from '@/lib/providers/registry';
import { providerCredential } from '@/lib/providers/registry';
import { httpJson } from '@/lib/http';

export interface ModelSpec {
  providerKey: string;
  modelId: string;
  label: string;
  tier: 'nano' | 'standard' | 'strong' | 'vision' | 'image';
  capabilities: string[];
  quality: number;
  speedMs: number;
  costPer1kIn: number;
  costPer1kOut: number;
  contextWindow: number;
  notes?: string;
}

/** Pricing is expressed per 1k tokens so the router can reason about cost. */
export const MODEL_CATALOGUE: ModelSpec[] = [
  // ── OpenAI ──
  { providerKey: 'openai', modelId: 'gpt-4o-mini', label: 'GPT-4o mini', tier: 'nano', capabilities: ['text', 'classification', 'summarization'], quality: 0.72, speedMs: 700, costPer1kIn: 0.00015, costPer1kOut: 0.0006, contextWindow: 128_000 },
  { providerKey: 'openai', modelId: 'gpt-4o', label: 'GPT-4o', tier: 'strong', capabilities: ['text', 'vision', 'outreach', 'copy'], quality: 0.9, speedMs: 1600, costPer1kIn: 0.0025, costPer1kOut: 0.01, contextWindow: 128_000 },
  { providerKey: 'openai', modelId: 'gpt-4.1', label: 'GPT-4.1', tier: 'strong', capabilities: ['text', 'vision', 'code', 'copy'], quality: 0.93, speedMs: 1800, costPer1kIn: 0.002, costPer1kOut: 0.008, contextWindow: 1_000_000 },
  { providerKey: 'openai', modelId: 'o4-mini', label: 'o4-mini (reasoning)', tier: 'strong', capabilities: ['text', 'reasoning', 'scoring'], quality: 0.94, speedMs: 4200, costPer1kIn: 0.0011, costPer1kOut: 0.0044, contextWindow: 200_000 },
  // ── Anthropic ──
  { providerKey: 'anthropic', modelId: 'claude-haiku-4', label: 'Claude Haiku 4', tier: 'nano', capabilities: ['text', 'classification'], quality: 0.76, speedMs: 600, costPer1kIn: 0.001, costPer1kOut: 0.005, contextWindow: 200_000 },
  { providerKey: 'anthropic', modelId: 'claude-sonnet-4', label: 'Claude Sonnet 4', tier: 'strong', capabilities: ['text', 'vision', 'outreach', 'copy', 'proposal'], quality: 0.94, speedMs: 1500, costPer1kIn: 0.003, costPer1kOut: 0.015, contextWindow: 200_000 },
  { providerKey: 'anthropic', modelId: 'claude-opus-4', label: 'Claude Opus 4', tier: 'strong', capabilities: ['text', 'vision', 'reasoning', 'proposal'], quality: 0.97, speedMs: 3000, costPer1kIn: 0.015, costPer1kOut: 0.075, contextWindow: 200_000 },
  // ── Google ──
  { providerKey: 'google', modelId: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'nano', capabilities: ['text', 'vision', 'summarization'], quality: 0.8, speedMs: 550, costPer1kIn: 0.0001, costPer1kOut: 0.0004, contextWindow: 1_000_000 },
  { providerKey: 'google', modelId: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'strong', capabilities: ['text', 'vision', 'reasoning', 'research'], quality: 0.95, speedMs: 2600, costPer1kIn: 0.00125, costPer1kOut: 0.01, contextWindow: 1_000_000 },
  // ── Ollama (local, open-weight, free — no API key, no network egress) ──
  { providerKey: 'ollama', modelId: 'llama3.2:3b', label: 'Llama 3.2 3B (Ollama)', tier: 'nano', capabilities: ['text', 'classification', 'summarization'], quality: 0.6, speedMs: 900, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 128_000 },
  { providerKey: 'ollama', modelId: 'llama3.1:8b', label: 'Llama 3.1 8B (Ollama)', tier: 'standard', capabilities: ['text', 'classification', 'summarization', 'outreach'], quality: 0.74, speedMs: 1800, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 128_000 },
  { providerKey: 'ollama', modelId: 'qwen2.5:7b', label: 'Qwen 2.5 7B (Ollama)', tier: 'standard', capabilities: ['text', 'summarization', 'copy'], quality: 0.76, speedMs: 1700, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 128_000 },
  { providerKey: 'ollama', modelId: 'qwen2.5:14b', label: 'Qwen 2.5 14B (Ollama)', tier: 'strong', capabilities: ['text', 'outreach', 'copy', 'proposal'], quality: 0.84, speedMs: 3200, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 128_000 },
  { providerKey: 'ollama', modelId: 'llama3.1:70b', label: 'Llama 3.1 70B (Ollama)', tier: 'strong', capabilities: ['text', 'research', 'outreach', 'proposal'], quality: 0.9, speedMs: 9000, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 128_000 },

  // ── Local deterministic ──
  { providerKey: 'local', modelId: 'local-grounded-v1', label: 'Local grounded engine', tier: 'standard', capabilities: ['text', 'outreach', 'copy', 'summarization', 'classification', 'scoring', 'proposal'], quality: 0.62, speedMs: 12, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 64_000, notes: 'Deterministic, offline. Grounded strictly in supplied facts — never invents claims.' },
  { providerKey: 'local', modelId: 'local-design-v1', label: 'Local design planner', tier: 'standard', capabilities: ['website_design', 'copy'], quality: 0.68, speedMs: 25, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 64_000, notes: 'Design direction + layout planning from brand inputs.' },
  { providerKey: 'local', modelId: 'local-svg-v1', label: 'Local SVG artwork', tier: 'image', capabilities: ['image_generation'], quality: 0.5, speedMs: 8, costPer1kIn: 0, costPer1kOut: 0, contextWindow: 0, notes: 'Procedural abstract artwork; not photographic.' },
];

export const openAiProvider: AiProvider = {
  key: 'openai',
  label: 'OpenAI',
  requiresCredentials: true,
  credentialLabel: 'OpenAI API key',
  description: 'GPT-4o / GPT-4.1 / o-series for research, outreach, copy and proposals.',
  models: MODEL_CATALOGUE.filter((m) => m.providerKey === 'openai'),

  async complete(orgId, modelId, req) {
    const key = providerCredential(orgId, 'openai');
    const started = Date.now();
    if (!key) return empty('OpenAI key not configured', modelId, started);

    const res = await httpJson<{
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    }>('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: {
        model: modelId,
        temperature: req.temperature ?? 0.4,
        max_tokens: req.maxTokens ?? 1200,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          { role: 'user', content: req.prompt },
        ],
      },
      timeoutMs: 120_000,
    });

    if (!res.ok) return empty(res.data?.error?.message ?? res.error ?? 'request failed', modelId, started);
    const text = res.data?.choices?.[0]?.message?.content ?? '';
    const spec = MODEL_CATALOGUE.find((m) => m.modelId === modelId && m.providerKey === 'openai');
    const tokensIn = res.data?.usage?.prompt_tokens ?? estimateTokens(req.prompt);
    const tokensOut = res.data?.usage?.completion_tokens ?? estimateTokens(text);
    return {
      text,
      json: req.json ? tryParse(text) : undefined,
      tokensIn,
      tokensOut,
      cost: costOf(spec, tokensIn, tokensOut),
      latencyMs: Date.now() - started,
      model: modelId,
      live: true,
    };
  },
};

export const anthropicProvider: AiProvider = {
  key: 'anthropic',
  label: 'Anthropic',
  requiresCredentials: true,
  credentialLabel: 'Anthropic API key',
  description: 'Claude family — strong at long-form proposals, research synthesis and copy.',
  models: MODEL_CATALOGUE.filter((m) => m.providerKey === 'anthropic'),

  async complete(orgId, modelId, req) {
    const key = providerCredential(orgId, 'anthropic');
    const started = Date.now();
    if (!key) return empty('Anthropic key not configured', modelId, started);

    const res = await httpJson<{
      content?: { text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    }>('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        ...(req.json ? { 'anthropic-beta': 'json-mode' } : {}),
      },
      body: {
        model: modelId,
        max_tokens: req.maxTokens ?? 1500,
        temperature: req.temperature ?? 0.4,
        system: req.system,
        messages: [{ role: 'user', content: req.prompt }],
      },
      timeoutMs: 120_000,
    });

    if (!res.ok) return empty(res.data?.error?.message ?? res.error ?? 'request failed', modelId, started);
    const text = (res.data?.content ?? []).map((c) => c.text ?? '').join('');
    const spec = MODEL_CATALOGUE.find((m) => m.modelId === modelId && m.providerKey === 'anthropic');
    const tokensIn = res.data?.usage?.input_tokens ?? estimateTokens(req.prompt);
    const tokensOut = res.data?.usage?.output_tokens ?? estimateTokens(text);
    return {
      text,
      json: req.json ? tryParse(text) : undefined,
      tokensIn,
      tokensOut,
      cost: costOf(spec, tokensIn, tokensOut),
      latencyMs: Date.now() - started,
      model: modelId,
      live: true,
    };
  },
};

export const googleProvider: AiProvider = {
  key: 'google',
  label: 'Google Gemini',
  requiresCredentials: true,
  credentialLabel: 'Google AI Studio API key',
  description: 'Gemini family with very large context — good for research synthesis and cheap high-volume classification.',
  models: MODEL_CATALOGUE.filter((m) => m.providerKey === 'google'),

  async complete(orgId, modelId, req) {
    const key = providerCredential(orgId, 'google');
    const started = Date.now();
    if (!key) return empty('Google key not configured', modelId, started);

    const res = await httpJson<{
      candidates?: { content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      error?: { message?: string };
    }>(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        body: {
          contents: [{ role: 'user', parts: [{ text: req.system ? `${req.system}\n\n${req.prompt}` : req.prompt }] }],
          generationConfig: { temperature: req.temperature ?? 0.4, maxOutputTokens: req.maxTokens ?? 1500 },
        },
        timeoutMs: 120_000,
      }
    );

    if (!res.ok) return empty(res.data?.error?.message ?? res.error ?? 'request failed', modelId, started);
    const text = (res.data?.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const spec = MODEL_CATALOGUE.find((m) => m.modelId === modelId && m.providerKey === 'google');
    const tokensIn = res.data?.usageMetadata?.promptTokenCount ?? estimateTokens(req.prompt);
    const tokensOut = res.data?.usageMetadata?.candidatesTokenCount ?? estimateTokens(text);
    return {
      text,
      json: req.json ? tryParse(text) : undefined,
      tokensIn,
      tokensOut,
      cost: costOf(spec, tokensIn, tokensOut),
      latencyMs: Date.now() - started,
      model: modelId,
      live: true,
    };
  },
};

/**
 * Ollama — local open-weight inference (§7).
 *
 * Free in the strongest sense: no API key, no account, no per-token cost, and
 * no data leaves the machine. Requires an Ollama server running locally (or a
 * reachable host via OLLAMA_HOST). If the server is absent the provider reports
 * itself unavailable and the router falls through to the grounded engine.
 *
 * Availability is probed, never assumed: an uninstalled Ollama is reported as
 * not configured rather than silently producing nothing.
 */
export const ollamaProvider: AiProvider = {
  key: 'ollama',
  label: 'Ollama (local, open-weight)',
  // No credential is needed, but the server must be reachable. We model that as
  // "requires credentials" = false and report availability via health().
  requiresCredentials: false,
  description:
    'Local open-weight inference. Free, private, no rate limits, no data egress. Requires an Ollama server (default http://localhost:11434, override with OLLAMA_HOST).',
  models: MODEL_CATALOGUE.filter((m) => m.providerKey === 'ollama'),

  async complete(orgId, modelId, req) {
    const started = Date.now();
    const base = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

    // SSRF guard: OLLAMA_HOST is operator-controlled, but validate it anyway so
    // a misconfigured value cannot be pointed at cloud metadata.
    const { assertSafeUrl } = await import('@/lib/ssrf');
    const allowed = await assertSafeUrl(base, { resolve: false });
    const isLoopbackOllama = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base);
    if (!allowed.safe && !isLoopbackOllama) {
      return { text: '', tokensIn: 0, tokensOut: 0, cost: 0, latencyMs: Date.now() - started, model: modelId, live: false, error: `OLLAMA_HOST refused: ${allowed.reason}` };
    }

    const res = await httpJson<{ message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; error?: string }>(
      `${base.replace(/\/$/, '')}/api/chat`,
      {
        method: 'POST',
        body: {
          model: modelId,
          stream: false,
          format: req.json ? 'json' : undefined,
          options: { temperature: req.temperature ?? 0.4, num_predict: req.maxTokens ?? 1200 },
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: req.prompt },
          ],
        },
        timeoutMs: 120_000,
      }
    );

    if (!res.ok) {
      return { text: '', tokensIn: 0, tokensOut: 0, cost: 0, latencyMs: Date.now() - started, model: modelId, live: false, error: res.data?.error ?? res.error };
    }
    const text = res.data?.message?.content ?? '';
    void orgId;
    return {
      text,
      json: req.json ? tryParse(text) : undefined,
      tokensIn: res.data?.prompt_eval_count ?? estimateTokens(req.prompt),
      tokensOut: res.data?.eval_count ?? estimateTokens(text),
      cost: 0,
      latencyMs: Date.now() - started,
      model: modelId,
      live: true,
    };
  },
};

/**
 * The local grounded engine. Always available, zero cost, and — critically —
 * it can only work from facts handed to it. It produces structured, usable
 * output; it does not simulate a large language model or invent claims.
 */
export const localProvider: AiProvider = {
  key: 'local',
  label: 'Local grounded engine',
  requiresCredentials: false,
  description:
    'Offline deterministic generator. Produces grounded copy, scoring rationale, summaries and design plans strictly from supplied facts. No API cost. Lower linguistic range than a hosted strong model — the router prefers hosted models for outreach and proposals when they are configured.',
  models: MODEL_CATALOGUE.filter((m) => m.providerKey === 'local'),

  async complete(_orgId, modelId, req) {
    const started = Date.now();
    const { localGenerate } = await import('./local');
    const out = localGenerate(req);
    return {
      text: out.text,
      json: out.json,
      tokensIn: estimateTokens(req.prompt),
      tokensOut: estimateTokens(out.text),
      cost: 0,
      latencyMs: Date.now() - started,
      model: modelId,
      live: false,
    };
  },
};

export const AI_PROVIDERS: AiProvider[] = [openAiProvider, anthropicProvider, googleProvider, ollamaProvider, localProvider];

// ── helpers ──────────────────────────────────────────────────
function empty(error: string, model: string, started: number) {
  return { text: '', tokensIn: 0, tokensOut: 0, cost: 0, latencyMs: Date.now() - started, model, live: false, error };
}

export function costOf(spec: ModelSpec | undefined, tokensIn: number, tokensOut: number): number {
  if (!spec) return 0;
  return (tokensIn / 1000) * spec.costPer1kIn + (tokensOut / 1000) * spec.costPer1kOut;
}

export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

export function tryParse(text: string): unknown {
  if (!text) return undefined;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(cleaned.slice(start));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

export function specFor(providerKey: string, modelId: string): ModelSpec | undefined {
  return MODEL_CATALOGUE.find((m) => m.providerKey === providerKey && m.modelId === modelId);
}
