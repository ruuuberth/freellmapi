import { describe, it, expect } from 'vitest';

// AnyAPI documents its 403 as a CONTENT-MODERATION refusal — "Your request was
// flagged by content moderation", `type: "moderation_error"
// (docs.anyapi.ai/guides/errors) — not as "this key's tier can't reach this
// model" (#256, the meaning a 403 carries on GitHub Models and Cloudflare).
// Both arrive as HTTP 403; only the provider's own body tells them apart.
//
// These tests pin the discriminator: same status, opposite meaning.

import { providerHttpError } from '../../providers/base.js';
import { isContentModerationError } from '../../lib/error-classify.js';

const res = (status: number, statusText = 'Error') =>
  ({ status, statusText, headers: new Headers() }) as unknown as Response;

/** AnyAPI's documented 403 body, built through the real provider error path so
 *  the structured `error.type` travels exactly as it does in production. */
function anyapiModeration403() {
  return providerHttpError(
    res(403, 'Forbidden'),
    'AnyAPI API error 403: Your request was flagged by content moderation',
    { error: { code: 403, message: 'Your request was flagged by content moderation', type: 'moderation_error', metadata: { reasons: ['violence'], provider_name: 'openai' } } },
  );
}

describe('isContentModerationError', () => {
  it('recognises AnyAPI\'s documented 403 moderation_error body', () => {
    const err = anyapiModeration403();
    expect(err.status).toBe(403);
    expect(err.upstreamErrorType).toBe('moderation_error');
    expect(isContentModerationError(err)).toBe(true);
  });

  it('recognises the structured type even when the prose says nothing', () => {
    expect(isContentModerationError(Object.assign(
      new Error('AnyAPI API error 403: refused'),
      { status: 403, upstreamErrorType: 'moderation_error' },
    ))).toBe(true);
  });

  it('recognises the prose when a gateway sends no structured type', () => {
    // OpenAI-compat adapters flatten upstream bodies into `error.message`, so
    // the wording alone must still classify correctly.
    expect(isContentModerationError(anyapiModeration403())).toBe(true);
    expect(isContentModerationError(Object.assign(
      new Error('AnyAPI API error 403: request blocked by content moderation'),
      { status: 403 },
    ))).toBe(true);
  });

  it('recognises OpenAI-style 400 content_policy_violation (same verdict, other status)', () => {
    const err = Object.assign(
      new Error('OpenAI API error 400: Your request violates our content policy'),
      { status: 400, upstreamErrorType: 'content_policy_violation' },
    );
    expect(isContentModerationError(err)).toBe(true);
  });

  it('does NOT claim a tier/permission 403 (#256 keeps its meaning)', () => {
    expect(isContentModerationError(Object.assign(
      new Error('Groq API error 403: model llama-guard is not available on the free tier'),
      { status: 403 },
    ))).toBe(false);
    expect(isContentModerationError(Object.assign(
      new Error('Cloudflare API error 403: model is subscription-only'),
      { status: 403 },
    ))).toBe(false);
  });

  it('does NOT claim an account suspension that happens to be a 403', () => {
    const suspended = Object.assign(
      new Error('NavyAI API error 403: The Free plan is temporarily disabled due to abuse.'),
      { status: 403 },
    );
    expect(isContentModerationError(suspended)).toBe(false);
  });

  it('is status-gated: moderation wording on a 429/402/5xx keeps its own class', () => {
    const flagged = () => new Error('Rate limit reached: requests flagged by content moderation are throttled');
    expect(isContentModerationError(Object.assign(flagged(), { status: 429 }))).toBe(false);
    expect(isContentModerationError(Object.assign(flagged(), { status: 402 }))).toBe(false);
    expect(isContentModerationError(Object.assign(flagged(), { status: 500 }))).toBe(false);
    // A status-less error (an adapter shaped its own) still qualifies.
    expect(isContentModerationError(flagged())).toBe(true);
  });
});
