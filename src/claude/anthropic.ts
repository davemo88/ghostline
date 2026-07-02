// Real Anthropic API transport for the Claude player.
//
// - Structured outputs (output_config.format json_schema) guarantee a
//   parseable {memo, commands} object.
// - The stable system prompt carries a cache_control breakpoint (rules + map
//   digest are identical every turn of a match).
// - Default model is claude-fable-5 per DESIGN_2.md §15, with server-side
//   refusal fallbacks to claude-opus-4-8 enabled by default (Fable's safety
//   classifiers can occasionally decline benign requests; the fallback keeps
//   the match running inside the same call). Pass model: 'claude-haiku-4-5'
//   for cheap testing runs.
// - Thinking: `{type: 'adaptive', display: 'summarized'}` on models that
//   support adaptive thinking, so the debug/spectator UI can show Claude's
//   summarized reasoning. Models without adaptive support get no thinking
//   param at all.

import Anthropic from '@anthropic-ai/sdk';
import { TURN_OUTPUT_SCHEMA, type Transport, type TurnResponse } from './driver';

export interface AnthropicTransportOptions {
  apiKey?: string; // omitted → SDK resolves from environment (Node only)
  model?: string;
  fallbackModel?: string | null; // null disables fallbacks
  maxTokens?: number;
  /** Set when running in a browser (debug view). Exposes the key to the page — local play only. */
  dangerouslyAllowBrowser?: boolean;
  onError?: (err: unknown) => void;
}

export const DEFAULT_MODEL = 'claude-fable-5';
const DEFAULT_FALLBACK = 'claude-opus-4-8';

export function createAnthropicTransport(opts: AnthropicTransportOptions = {}): Transport {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    dangerouslyAllowBrowser: opts.dangerouslyAllowBrowser,
  });
  const model = opts.model ?? DEFAULT_MODEL;
  const fallbackModel = opts.fallbackModel === undefined ? DEFAULT_FALLBACK : opts.fallbackModel;
  const useFallbacks = fallbackModel !== null && fallbackModel !== model;
  // Adaptive thinking (and therefore summarized-thinking display) exists on
  // Fable/Mythos and the 4.6+ Opus/Sonnet family.
  const supportsAdaptive = /fable|mythos|opus-4-[678]|sonnet-4-[6-9]/.test(model);

  return async ({ system, user }): Promise<TurnResponse> => {
    try {
      const response = await client.beta.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 8000,
        ...(useFallbacks
          ? {
              betas: ['server-side-fallback-2026-06-01' as const],
              fallbacks: [{ model: fallbackModel }],
            }
          : {}),
        ...(supportsAdaptive ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: {
          format: { type: 'json_schema', schema: TURN_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: 'user', content: user }],
      });

      if (response.stop_reason === 'refusal') {
        opts.onError?.(new Error('model declined the turn (stop_reason: refusal)'));
        return { memo: '', commands: [], skipped: true };
      }

      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const thinking = response.content
        .filter((b): b is Anthropic.Beta.BetaThinkingBlock => b.type === 'thinking')
        .map((b) => b.thinking)
        .join('\n')
        .trim();
      const parsed = JSON.parse(text) as { memo?: unknown; commands?: unknown };
      return {
        memo: typeof parsed.memo === 'string' ? parsed.memo : '',
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        thinking,
      };
    } catch (err) {
      // Rate limits and 5xx are already retried by the SDK; anything that
      // still fails becomes a skipped turn so the match keeps running.
      opts.onError?.(err);
      return { memo: '', commands: [], skipped: true };
    }
  };
}
