import { describe, it, expect } from 'vitest';

//providerHttpError is where a provider's error body stops being a body and
//becomes an Error the whole router can classify from. It deliberately keeps
//only two signals — a numeric back-off and the provider's own short
//`error.type` — and never the body itself, so nothing extra can reach a log or
//an attempt trace. These tests pin that contract, because a classifier reading
//a provider's vocabulary (AnyAPI's `moderation_error` reaching
//isContentModerationError) depends entirely on `error.type` surviving here.

import { providerHttpError, readErrorType } from '../../providers/base.js';

const res = (status: number, statusText = 'Error') =>
  ({ status, statusText, headers: new Headers() }) as unknown as Response;

describe('readErrorType', () => {
  it('reads a nested OpenAI-shaped error.type, lowercased', () => {
    expect(readErrorType({ error: { type: 'Moderation_Error' } })).toBe('moderation_error');
  });

  it('falls back to a top-level type on flatter gateway bodies', () => {
    expect(readErrorType({ type: 'content_filter' })).toBe('content_filter');
  });

  it('ignores whatever is not a short type string', () => {
    expect(readErrorType(null)).toBeUndefined();
    expect(readErrorType('a bare string')).toBeUndefined();
    expect(readErrorType({ error: { message: 'no type here' } })).toBeUndefined();
    expect(readErrorType({ error: { type: 403 } })).toBeUndefined();
    expect(readErrorType({ error: { type: 'x'.repeat(80) } })).toBeUndefined();
    expect(readErrorType({ error: { type: '   ' } })).toBeUndefined();
  });

  it('never mistakes a `code` for a type (numeric codes collide with HTTP)', () => {
    expect(readErrorType({ error: { code: 403 } })).toBeUndefined();
  });
});

describe('providerHttpError with a structured body', () => {
  it('carries the provider error.type onto the Error', () => {
    const err = providerHttpError(res(403, 'Forbidden'), 'AnyAPI API error 403: refused', {
      error: { code: 403, message: 'refused', type: 'moderation_error', metadata: { reasons: ['violence'] } },
    });
    expect(err.status).toBe(403);
    expect(err.upstreamErrorType).toBe('moderation_error');
    // The body itself is not retained on the Error.
    expect(Object.keys(err)).not.toContain('body');
  });

  it('leaves upstreamErrorType undefined when the body has no type', () => {
    const err = providerHttpError(res(500), 'upstream 500', { error: { message: 'boom' } });
    expect(err.upstreamErrorType).toBeUndefined();
  });

  it('reads the back-off from the header first and the body second', () => {
    // The provider stated a reset in the body...
    const fromBody = providerHttpError(res(429, 'Too Many Requests'), 'rate limited', {
      error: { type: 'rate_limit_error', retry_after: 999 },
    });
    expect(fromBody.retryAfterMs).toBe(999_000);

    // ...but the standard header wins when both are present.
    const fromHeader = providerHttpError(
      { status: 429, statusText: 'Too Many Requests', headers: new Headers({ 'retry-after': '30' }) } as unknown as Response,
      'rate limited',
      { error: { type: 'rate_limit_error', retry_after: 999 } },
    );
    expect(fromHeader.retryAfterMs).toBe(30_000);
  });
});
