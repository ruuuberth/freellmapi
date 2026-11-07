import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// AnyAPI documents its 403 as a CONTENT-MODERATION refusal — "Your request was
// flagged by content moderation", `type: "moderation_error"` (docs.anyapi.ai/
// guides/errors) — not as "this key's tier can't reach this model" (#256).
//
// Classified as model-forbidden, a single flagged prompt took a 24h 'tier'
// bench that the cooldown-probe never revisits, a scorer penalty, and answered
// the client with 429 "All models rate-limited ... Soonest cooldown reset ~5h"
// for a request no amount of waiting could ever serve. The model and the key
// were healthy the whole time; only the PROMPT was refused.
//
// The fix reads the provider's own structured `error.type`, gives moderation its
// own attempt class, and keeps it off every durable book (no cooldown, no
// penalty, no limit learning) while still failing over — another provider's
// moderation filter may well accept the same prompt.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { providerHttpError, readErrorType } from '../../providers/base.js';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import {
  isContentModerationError,
  isModelAccessForbiddenError,
  isRetryableError,
  isProviderLevelError,
  isKeyAuthError,
  isAccountSuspendedError,
} from '../../lib/error-classify.js';
import {
  classifyAttemptError,
  cooldownDecisionForError,
  exhaustedRetryError,
  newFallbackState,
  recordRetryableFailure,
  runFallbackLoop,
  type AttemptRecord,
  type FallbackHooks,
} from '../../lib/fallback-loop.js';
import { isOnCooldown } from '../../services/ratelimit.js';
import { getAllPenalties, clearAllPenalties } from '../../services/router.js';
import type { RouteResult } from '../../services/router.js';

const PLATFORM = 'anyapi';
const MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MODEL_DB_ID = 1_060_403;
let keySeq = 403_000;

function route(overrides: Partial<RouteResult> = {}): RouteResult {
  return {
    provider: {} as any,
    modelId: MODEL,
    modelDbId: MODEL_DB_ID,
    apiKey: {} as any,
    keyId: ++keySeq,
    platform: PLATFORM,
    displayName: MODEL,
    rpdLimit: null,
    tpdLimit: null,
    ...overrides,
  };
}

/** AnyAPI's documented 403 body, built through the real provider error path so
 *  the structured `error.type` travels exactly as it does in production. */
function anyapiModeration403() {
  const body = {
    error: {
      code: 403,
      message: 'Your request was flagged by content moderation',
      type: 'moderation_error',
      metadata: { reasons: ['violence'], provider_name: 'openai', model_slug: 'gpt-4o' },
    },
  };
  return providerHttpError(
    { status: 403, statusText: 'Forbidden', headers: new Headers() } as Response,
    `AnyAPI API error 403: ${body.error.message}`,
    body,
  );
}

/** The same status, the OLD meaning: this key's tier cannot reach this model. */
function tier403() {
  return Object.assign(
    new Error('Groq API error 403: model llama-guard is not available on the free tier'),
    { status: 403 },
  );
}

const record = (classes: AttemptRecord['errorClass'][]): AttemptRecord[] =>
  classes.map((errorClass, i) => ({ platform: PLATFORM, modelId: `m${i}`, keyOrdinal: i + 1, errorClass }));

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM rate_limit_cooldowns').run();
  // The bandit penalty map is module state shared across the file's tests.
  clearAllPenalties();
});

// ── The classifier ───────────────────────────────────────────────────────────

describe('isContentModerationError', () => {
  it('recognises AnyAPI\'s documented 403 moderation_error body', () => {
    const err = anyapiModeration403();
    expect(err.status).toBe(403);
    expect(err.upstreamErrorType).toBe('moderation_error');
    expect(isContentModerationError(err)).toBe(true);
  });

  it('recognises the structured type even when the prose says nothing', () => {
    const err = Object.assign(new Error('AnyAPI API error 403: refused'), {
      status: 403,
      upstreamErrorType: 'moderation_error',
    });
    expect(isContentModerationError(err)).toBe(true);
  });

  it('recognises the prose when a gateway sends no structured type', () => {
    // AnyAPI bodies are flattened to `error.message` by the OpenAI-compat
    // adapter, so the wording alone must still classify correctly.
    expect(isContentModerationError(Object.assign(
      new Error('AnyAPI API error 403: Your request was flagged by content moderation'),
      { status: 403 },
    ))).toBe(true);
  });

  it('recognises OpenAI-style 400 content_policy_violation (same verdict, other status)', () => {
    const err = Object.assign(new Error('OpenAI API error 400: Your request violates our content policy'), {
      status: 400,
      upstreamErrorType: 'content_policy_violation',
    });
    expect(isContentModerationError(err)).toBe(true);
  });

  it('does NOT claim a tier/permission 403 (#256 keeps its meaning)', () => {
    expect(isContentModerationError(tier403())).toBe(false);
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
    expect(isAccountSuspendedError(suspended)).toBe(true);
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

describe('readErrorType (what providerHttpError retains)', () => {
  it('reads the nested OpenAI-shaped error.type, lowercased', () => {
    expect(readErrorType({ error: { type: 'Moderation_Error' } })).toBe('moderation_error');
  });

  it('falls back to a top-level type on flatter gateway bodies', () => {
    expect(readErrorType({ type: 'content_filter' })).toBe('content_filter');
  });

  it('ignores absent, non-string, overlong and body-less shapes', () => {
    expect(readErrorType(null)).toBeUndefined();
    expect(readErrorType('a bare string')).toBeUndefined();
    expect(readErrorType({ error: { message: 'no type here' } })).toBeUndefined();
    expect(readErrorType({ error: { type: 403 } })).toBeUndefined();
    expect(readErrorType({ error: { type: 'x'.repeat(80) } })).toBeUndefined();
    expect(readErrorType({ error: { type: '   ' } })).toBeUndefined();
  });
});

// ── Classification of the WHOLE chain ────────────────────────────────────────

describe('a moderation 403 is no longer a model-access verdict', () => {
  it('leaves isModelAccessForbiddenError behind', () => {
    expect(isModelAccessForbiddenError(anyapiModeration403())).toBe(false);
    // ...while the genuine tier 403 still is one.
    expect(isModelAccessForbiddenError(tier403())).toBe(true);
  });

  it('gets its own attempt class instead of "forbidden"', () => {
    expect(classifyAttemptError(anyapiModeration403())).toBe('content_filtered');
    expect(classifyAttemptError(tier403())).toBe('forbidden');
  });

  it('still fails over (another provider may accept the prompt) but is not provider-level', () => {
    expect(isRetryableError(anyapiModeration403())).toBe(true);
    // Not a sick platform: the other models of the same provider stay usable.
    expect(isProviderLevelError(anyapiModeration403())).toBe(false);
    // Not a dead key either.
    expect(isKeyAuthError(anyapiModeration403())).toBe(false);
  });
});

// ── No durable book is written ───────────────────────────────────────────────

describe('recordRetryableFailure keeps a moderation refusal off every bench', () => {
  it('writes NO cooldown and NO penalty, and skips the model for this request only', () => {
    const r = route();
    const state = newFallbackState();
    recordRetryableFailure(r, anyapiModeration403(), state);

    // The request is rerouted away from this model...
    expect(state.skipModels.has(r.modelDbId)).toBe(true);
    expect(state.skipKeys.has(`${PLATFORM}:${MODEL}:${r.keyId}`)).toBe(true);
    // ...but nothing outlives it.
    expect(isOnCooldown(PLATFORM, MODEL, r.keyId)).toBe(false);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get()).toEqual({ n: 0 });
    expect(getAllPenalties().filter(p => p.modelDbId === r.modelDbId)).toEqual([]);
    // And the platform is not ruled out: sibling models are still candidates.
    expect(state.skipPlatforms.has(PLATFORM)).toBe(false);
  });

  it('does not scrub the account-level books either (no suspension semantics)', () => {
    const r = route();
    recordRetryableFailure(r, anyapiModeration403(), newFallbackState());
    expect(isAccountSuspendedError(anyapiModeration403())).toBe(false);
    expect(isOnCooldown(PLATFORM, 'some-other-model', r.keyId)).toBe(false);
  });

  it('the genuine tier 403 keeps its day-long bench and its penalty (regression guard)', () => {
    const r = route({ modelId: 'llama-guard', modelDbId: MODEL_DB_ID + 1 });
    const state = newFallbackState();
    recordRetryableFailure(r, tier403(), state);

    expect(state.skipModels.has(r.modelDbId)).toBe(true);
    expect(isOnCooldown(PLATFORM, 'llama-guard', r.keyId)).toBe(true);
    expect(cooldownDecisionForError(r, tier403()).source).toBe('tier');
    const rows = getDb().prepare(
      'SELECT source FROM rate_limit_cooldowns WHERE platform = ? AND model_id = ?',
    ).all(PLATFORM, 'llama-guard') as { source: string }[];
    expect(rows.map(x => x.source)).toEqual(['tier']);
    expect(getAllPenalties().some(p => p.modelDbId === r.modelDbId)).toBe(true);
  });

  it('is exempt from the per-request breaker: the chain keeps trying other providers', () => {
    // `true` = the skipBench-style exemption held, so the loop's breaker does
    // NOT count this failure. A moderation verdict is not evidence that the
    // pool is sick — and the next provider may well accept the same prompt.
    expect(recordRetryableFailure(route(), anyapiModeration403(), newFallbackState())).toBe(true);
    // A genuine provider failure is still counted.
    expect(recordRetryableFailure(route(), Object.assign(new Error('Bad Gateway'), { status: 502 }), newFallbackState())).toBe(false);
  });
});

// ── The client-facing exhaustion body ────────────────────────────────────────

describe('exhaustedRetryError renders an honest 400 for a filtered prompt', () => {
  it('all attempts content-filtered → 400 invalid_request_error / content_filtered', () => {
    const body = exhaustedRetryError(anyapiModeration403(), 20, {
      attempts: record(['content_filtered', 'content_filtered']),
    });
    expect(body.status).toBe(400);
    expect(body.type).toBe('invalid_request_error');
    expect(body.code).toBe('content_filtered');
    // Never a promise of recovery: no retry time, no 429.
    expect(body.retryAtMs).toBeUndefined();
    expect(body.message).toContain('content-moderation');
    expect(body.message).toContain('No provider or model was benched');
    expect(body.message).toContain('Attempt trail:');
  });

  it('a mixed trail (filtered + a real upstream failure) is not a 400', () => {
    const body = exhaustedRetryError(Object.assign(new Error('Bad Gateway'), { status: 502 }), 20, {
      attempts: record(['content_filtered', 'upstream_error']),
    });
    expect(body.status).toBe(502);
    expect(body.code).not.toBe('content_filtered');
  });

  it('an all-forbidden chain keeps the 429 contract (a tier gate really does recover)', () => {
    const body = exhaustedRetryError(tier403(), 20, { attempts: record(['forbidden']) });
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_exceeded');
  });
});

// ── End to end through the real loop ─────────────────────────────────────────

function loopHooks(overrides: Partial<FallbackHooks>): FallbackHooks {
  return {
    state: newFallbackState(),
    timeBudgetMs: 0,
    route: () => route(),
    dispatch: async () => 'done',
    logFailure: () => {},
    onFatal: () => {},
    onRoutingExhausted: () => {},
    onExhausted: () => {},
    ...overrides,
  };
}

describe('runFallbackLoop on AnyAPI\'s documented 403', () => {
  it('reroutes the request, benches nothing, and ends on a 400', async () => {
    const onExhausted = vi.fn();
    const state = newFallbackState();
    // A model id unique to this test: the bandit penalties above live in
    // module state shared by the whole file, so asserting on the shared
    // MODEL_DB_ID would read another test's penalty as a leak.
    const MODERATED_MODEL = MODEL_DB_ID + 7;
    const dispatch = vi.fn(async () => { throw anyapiModeration403(); });

    await runFallbackLoop(loopHooks({ maxRetries: 2, state, dispatch, onExhausted, route: () => route({ modelDbId: MODERATED_MODEL }) }));

    expect(onExhausted).toHaveBeenCalledTimes(1);
    const [body] = onExhausted.mock.calls[0];
    expect(body.status).toBe(400);
    expect(body.code).toBe('content_filtered');
    // The whole point: after the request ends, the model+key are still routable.
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get()).toEqual({ n: 0 });
    expect(getAllPenalties().filter(p => p.modelDbId === MODERATED_MODEL)).toEqual([]);
  });
});

// ── End to end from the raw HTTP response ───────────────────────────────────

describe('the real OpenAI-compat adapter, fed AnyAPI\'s raw 403 body', () => {
  it('carries error.type from the response into the classifier', async () => {
    // The whole chain, no shortcuts: HTTP 403 → adapter → providerHttpError →
    // upstreamErrorType → isContentModerationError → attempt class.
    const body = {
      error: {
        code: 403,
        message: 'Your request was flagged by content moderation',
        type: 'moderation_error',
        metadata: { reasons: ['violence'], provider_name: 'openai' },
      },
    };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    } as any);

    const provider = new OpenAICompatProvider({
      platform: 'anyapi',
      name: 'AnyAPI',
      baseUrl: 'https://api.anyapi.ai/v1',
    });

    let thrown: any;
    try {
      await provider.chatCompletion('test-key', [{ role: 'user', content: 'hi' }], MODEL);
    } catch (e) { thrown = e; }
    vi.restoreAllMocks();

    expect(thrown).toBeDefined();
    expect(thrown.status).toBe(403);
    // The structured type survived the adapter...
    expect(thrown.upstreamErrorType).toBe('moderation_error');
    // ...and the classifier claims it as moderation, not as a tier gate.
    expect(isContentModerationError(thrown)).toBe(true);
    expect(isModelAccessForbiddenError(thrown)).toBe(false);
    expect(classifyAttemptError(thrown)).toBe('content_filtered');
    // The message the operator sees still names the moderation verdict.
    expect(thrown.message).toContain('flagged by content moderation');
  });

  it('leaves a genuine tier 403 on the OpenAI-compat path as forbidden', async () => {
    const body = { error: { message: 'model llama-guard is not available on the free tier', type: 'forbidden' } };
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve(body),
    } as any);

    const provider = new OpenAICompatProvider({
      platform: 'anyapi', name: 'AnyAPI', baseUrl: 'https://api.anyapi.ai/v1',
    });

    let thrown: any;
    try {
      await provider.chatCompletion('test-key', [{ role: 'user', content: 'hi' }], MODEL);
    } catch (e) { thrown = e; }
    vi.restoreAllMocks();

    expect(thrown.status).toBe(403);
    expect(isContentModerationError(thrown)).toBe(false);
    expect(isModelAccessForbiddenError(thrown)).toBe(true);
    expect(classifyAttemptError(thrown)).toBe('forbidden');
  });
});