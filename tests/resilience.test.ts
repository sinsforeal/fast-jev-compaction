import { describe, expect, it } from 'vitest';
import { jevAsker } from '../hooks/fast-jev.js';
import { JevClient } from '../src/client.js';
import { mapLimit, MAX_CONCURRENT_REQUESTS } from '../src/compact.js';
import { describeFailureBody, JevHttpError, parseJevResponse } from '../src/request.js';

const CLOUDFLARE_403 = `<!DOCTYPE html>
<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->
<!--[if IE 7]>    <html class="no-js ie7 oldie" lang="en-US"> <![endif]-->
<head><title>Attention Required! | Cloudflare</title></head>
<body><span>Cloudflare Ray ID: <strong class="font-semibold">8c1f2a3b4d5e6f70</strong></span></body></html>`;

function response(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('failure bodies', () => {
  it('names the Cloudflare page title and Ray ID instead of IE comments', () => {
    const detail = describeFailureBody(CLOUDFLARE_403);
    expect(detail).toContain('Attention Required! | Cloudflare');
    expect(detail).toContain('Ray ID 8c1f2a3b4d5e6f70');
    expect(detail).not.toContain('[if lt IE 7]');
  });

  it('keeps a JSON error body as is', () => {
    const body = '{"detail":{"error_type":"authentication_error"}}';
    expect(describeFailureBody(body)).toBe(body);
  });

  it('throws a JevHttpError carrying the status', () => {
    expect(() => parseJevResponse(403, false, CLOUDFLARE_403)).toThrow(JevHttpError);
  });
});

describe('JevClient retry', () => {
  const ok = JSON.stringify({ answers: {} });

  it('retries a 403 block page once and returns the second answer', async () => {
    const calls: number[] = [];
    const fetcher = (async () => {
      calls.push(1);
      return calls.length === 1 ? response(403, CLOUDFLARE_403) : response(200, ok);
    }) as unknown as typeof fetch;
    const client = new JevClient({ apiKey: 'k', fetch: fetcher, retryDelayMs: 0 });
    await expect(client.ask({} as never, {})).resolves.toEqual({ answers: {} });
    expect(calls.length).toBe(2);
  });

  it('gives up after the retry and reports the Ray ID', async () => {
    const fetcher = (async () => response(403, CLOUDFLARE_403)) as unknown as typeof fetch;
    const client = new JevClient({ apiKey: 'k', fetch: fetcher, retryDelayMs: 0 });
    await expect(client.ask({} as never, {})).rejects.toThrow(/Ray ID 8c1f2a3b4d5e6f70/);
  });

  it('does not retry a 422', async () => {
    let n = 0;
    const fetcher = (async () => {
      n++;
      return response(422, '{"detail":"bad"}');
    }) as unknown as typeof fetch;
    const client = new JevClient({ apiKey: 'k', fetch: fetcher, retryDelayMs: 0 });
    await expect(client.ask({} as never, {})).rejects.toThrow(/422/);
    expect(n).toBe(1);
  });
});

describe('hook jevAsker retry', () => {
  it('retries the engine fetch once after a 403 block page', async () => {
    let n = 0;
    const fetchFn = async () => {
      n++;
      return n === 1
        ? { status: 403, ok: false, text: CLOUDFLARE_403 }
        : { status: 200, ok: true, text: JSON.stringify({ answers: {} }) };
    };
    const waits: number[] = [];
    const asker = jevAsker(fetchFn, 'k', 'jev-latest', async (ms) => {
      waits.push(ms);
    });
    await expect(asker.ask({} as never, {})).resolves.toEqual({ answers: {} });
    expect(n).toBe(2);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThanOrEqual(1125);
  });
});

describe('mapLimit', () => {
  it('never has more than the limit in flight and keeps order', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(
      Array.from({ length: 40 }, (_, i) => i),
      MAX_CONCURRENT_REQUESTS,
      async (i) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return i * 2;
      },
    );
    expect(peak).toBe(MAX_CONCURRENT_REQUESTS);
    expect(out).toEqual(Array.from({ length: 40 }, (_, i) => i * 2));
  });
});
