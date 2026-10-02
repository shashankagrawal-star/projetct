import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logger.js';
import type { ToolDef } from './tools.js';

/**
 * Minimal model-client boundary so the agent loop is testable without the network and the real
 * implementation is the only file that knows about the Anthropic SDK.
 */
export type LlmBlock = { type: string; [key: string]: unknown };
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmBlock[];
}
export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolDef[];
  maxTokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  serverFallbacks: boolean;
}
export interface LlmResponse {
  content: LlmBlock[];
  stopReason: string | null;
  stopCategory: string | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}
export interface AgentLlm {
  complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export class AnthropicLlm implements AgentLlm {
  private readonly client: Anthropic;
  private fallbacksDisabled = false;

  constructor(
    apiKey: string,
    private readonly logger: Logger,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
  }

  async complete(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const useFallbacks = req.serverFallbacks && !this.fallbacksDisabled;
    try {
      return await this.call(req, useFallbacks, signal);
    } catch (err) {
      // Server-side fallbacks are a beta opt-in. If the API rejects the request shape, retry once without
      // them (and remember), rather than taking the whole agent down over an optional safety net.
      if (useFallbacks && err instanceof Anthropic.BadRequestError) {
        this.logger.warn({ event: 'agent.fallbacks_rejected', status: err.status, message: err.message }, 'server-side fallbacks rejected; retrying without them');
        this.fallbacksDisabled = true;
        return this.call(req, false, signal);
      }
      throw err;
    }
  }

  private async call(req: LlmRequest, fallbacks: boolean, signal?: AbortSignal): Promise<LlmResponse> {
    const res = await this.client.beta.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages as Anthropic.Beta.BetaMessageParam[],
        tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Beta.BetaTool['input_schema'] })),
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: req.effort },
        cache_control: { type: 'ephemeral' },
        ...(fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      },
      { signal },
    );
    return {
      content: res.content as unknown as LlmBlock[],
      stopReason: res.stop_reason,
      stopCategory: res.stop_details?.category ?? null,
      usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
      model: res.model,
    };
  }
}

/** Turns an SDK error into something an operator can act on, without leaking request bodies or keys. */
export function explainLlmError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'The API key is not permitted to use this model (403). Check ANTHROPIC_MODEL and key permissions.';
  if (err instanceof Anthropic.NotFoundError) return 'Model not found (404). Check ANTHROPIC_MODEL.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit or spend limit reached (429). Try again shortly.';
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request (400): ${err.message}`;
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'The request to Anthropic timed out.';
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API (network error).';
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ''}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
