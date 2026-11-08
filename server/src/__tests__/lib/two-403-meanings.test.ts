import { describe, it, expect } from 'vitest';

// A 403 means opposite things depending on who sent it:
//   - GitHub Models / Cloudflare: "this key's tier cannot reach this model"
//     (issue #256) — a model-level gate worth a long bench.
//   - AnyAPI: "your request was flagged by content moderation"
//     (type "moderation_error") — a verdict on the PROMPT, nothing wrong
//     with the model or the key.
// Both arrive as bare HTTP 403. The two classifiers must not overlap, or
// routing benches a healthy model for 24h over one moderated prompt.

import { providerHttpError } from '../../providers/base.js';
import { isContentModerationError, isModelAccessForbiddenError } from '../../lib/error-classify.js';

const res = (status: number, statusText = 'Error') =>
  ({ status, statusText, headers: new Headers() }) as unknown as Response;

function anyapiModeration403() {
  return providerHttpError(
    res(403, 'Forbidden'),
    'AnyAPI API error 403: Your request was flagged by content moderation',
    { error: { code: 403, message: 'Your request was flagged by content moderation', type: 'moderation_error', metadata: { reasons: ['violence'], provider_name: 'openai' } } },
  );
}

/** The same status, the #256 meaning: this key's tier cannot reach this model. */
function tier403() {
  return Object.assign(
    new Error('Groq API error 403: model llama-guard is not available on the free tier'),
    { status: 403 },
  );
}

describe('the two 403s stay apart', () => {
  it('a moderation 403 is no longer a model-access verdict', () => {
    expect(isModelAccessForbiddenError(anyapiModeration403())).toBe(false);
  });

  it('a tier 403 is not a moderation verdict', () => {
    expect(isContentModerationError(tier403())).toBe(false);
    // ...and it still is exactly what #256 says it is.
    expect(isModelAccessForbiddenError(tier403())).toBe(true);
  });

  it('neither classifier claims a 403 that is neither of the two', () => {
    const other = Object.assign(new Error('Cloudflare API error 403: unknown'), { status: 403 });
    expect(isModelAccessForbiddenError(other)).toBe(true);
    expect(isContentModerationError(other)).toBe(false);
  });
});
