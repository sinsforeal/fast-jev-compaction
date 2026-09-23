import type { JevAnswer, JevQuestions, JevResponse, JevState } from './types.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** The HTTP request for one Jev call, for any fetch-like transport. */
export function buildJevRequest(
  params: {
    apiKey: string;
    model?: string;
    baseUrl?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: params.model ?? DEFAULT_MODEL,
      state,
      questions,
    }),
  };
}

/** A non-2xx Jev response; `status` lets callers decide whether a retry can help. */
export class JevHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Jev request failed (${status}): ${detail}`);
    this.name = 'JevHttpError';
  }
}

/** Statuses worth one retry: an edge block or rate limit (403 HTML, 429) and server errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 403 || status === 429 || status >= 500;
}

/**
 * The useful part of a failure body. A Cloudflare block page is HTML whose first
 * 200 chars are IE conditional comments; its title and Ray ID are what identify the rule.
 */
export function describeFailureBody(text: string): string {
  if (!/^\s*<(!DOCTYPE|html|!--)/i.test(text)) return text.slice(0, 200);
  const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
  const ray = /Ray ID:\s*(?:<[^>]*>)?\s*([0-9a-f]{8,})/i.exec(text)?.[1];
  const parts = ['HTML block page'];
  if (title) parts.push(`title "${title}"`);
  if (ray) parts.push(`Cloudflare Ray ID ${ray}`);
  return parts.join(', ');
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new JevHttpError(status, describeFailureBody(text));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}
