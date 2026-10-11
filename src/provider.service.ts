import { Injectable } from '@nestjs/common';

export type ProviderResult = { provider: string; ok: boolean; text?: string; error?: string; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number };

// USD per 1M tokens [input, output]; override with PROVIDER_PRICES='{"model":[in,out]}'.
const PRICES: Record<string, [number, number]> = { 'claude-sonnet-5-5': [3, 15], 'claude-haiku-5-5': [1, 5], 'gpt-4o-mini': [0.15, 0.6] };
const price = (model: string): [number, number] => {
  try { return (JSON.parse(process.env.PROVIDER_PRICES ?? '{}') as Record<string, [number, number]>)[model] ?? PRICES[model] ?? [0, 0]; } catch { return PRICES[model] ?? [0, 0]; }
};

/** Real Claude/OpenAI adapters with ordered fallback; deterministic mock providers when no API keys are configured. */
@Injectable()
export class ProviderService {
  available() {
    const p: string[] = [];
    if (process.env.ANTHROPIC_API_KEY) p.push('anthropic');
    if (process.env.OPENAI_API_KEY) p.push('openai');
    return p.length ? p : ['mock-primary', 'mock-fallback'];
  }

  /** Runs one prompt on a single provider. */
  async run(provider: string, prompt: string): Promise<ProviderResult> {
    const started = Date.now();
    const done = (r: Omit<ProviderResult, 'provider' | 'latencyMs' | 'costUsd'> & { model?: string }): ProviderResult => {
      const [pi, po] = price(r.model ?? '');
      return { provider, ok: r.ok, text: r.text, error: r.error, inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: Date.now() - started, costUsd: Number(((r.inputTokens * pi + r.outputTokens * po) / 1e6).toFixed(6)) };
    };
    try {
      if (provider === 'anthropic') {
        const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5-5';
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: AbortSignal.timeout(20000),
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!res.ok) return done({ ok: false, error: `anthropic ${res.status}`, inputTokens: 0, outputTokens: 0 });
        const j = await res.json() as { content: Array<{ text?: string }>; usage: { input_tokens: number; output_tokens: number } };
        return done({ ok: true, text: j.content.map(c => c.text ?? '').join(''), inputTokens: j.usage.input_tokens, outputTokens: j.usage.output_tokens, model });
      }
      if (provider === 'openai') {
        const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST', signal: AbortSignal.timeout(20000),
          headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!res.ok) return done({ ok: false, error: `openai ${res.status}`, inputTokens: 0, outputTokens: 0 });
        const j = await res.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number; completion_tokens: number } };
        return done({ ok: true, text: j.choices[0]?.message.content, inputTokens: j.usage.prompt_tokens, outputTokens: j.usage.completion_tokens, model });
      }
      if (provider.startsWith('mock')) return done({ ok: true, text: `[${provider}] Policy decision looks consistent with the recorded reason.`, inputTokens: Math.ceil(prompt.length / 4), outputTokens: 12 });
      return done({ ok: false, error: `Unknown provider ${provider}`, inputTokens: 0, outputTokens: 0 });
    } catch (e) { return done({ ok: false, error: (e as Error).message, inputTokens: 0, outputTokens: 0 }); }
  }

  /** Tries providers in order (PROVIDER_ORDER or availability) and returns the first success plus every attempt. */
  async complete(prompt: string, order = (process.env.PROVIDER_ORDER?.split(',').map(s => s.trim()).filter(Boolean) ?? this.available())) {
    const attempts: ProviderResult[] = [];
    for (const p of order) {
      const r = await this.run(p, prompt);
      attempts.push(r);
      if (r.ok) return { selected: r, attempts };
    }
    return { selected: undefined, attempts };
  }
}
