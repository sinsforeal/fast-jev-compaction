import { buildJevRequest, isRetryableStatus, JevHttpError, parseJevResponse } from './request.js';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.js';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries after a 403, 429 or 5xx. Defaults to 1. */
  retries?: number;
  /** Base backoff before a retry, jittered. Defaults to 1500 ms. */
  retryDelayMs?: number;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
    this.retries = Math.max(0, Math.floor(options.retries ?? 1));
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 1500);
  }

  async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      const text = await response.text();
      if (!response.ok && attempt < this.retries && isRetryableStatus(response.status)) {
        await sleep(this.retryDelayMs * (attempt + 1) * (0.75 + Math.random() * 0.5));
        continue;
      }
      try {
        return parseJevResponse(response.status, response.ok, text);
      } catch (error) {
        const ray = response.headers?.get?.('cf-ray');
        if (error instanceof JevHttpError && ray && !error.message.includes('Ray ID')) {
          error.message += ` (cf-ray ${ray})`;
        }
        throw error;
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
