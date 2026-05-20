import * as assert from 'assert';
import type { OverviewBuilder } from '@cluesmith/codev-types';
import { isIdleWaiting } from '@cluesmith/codev-core/builder-helpers';
import { orderForDisplay } from '../views/builders.js';

const FIVE_MIN_MS = 5 * 60 * 1000;
const NOW = 1_700_000_000_000;

function builder(
  id: string,
  opts: {
    blocked?: boolean;
    blockedSince?: string;
    phase?: string;
    lastDataAt?: string | null;
  } = {},
): OverviewBuilder {
  return {
    id,
    blocked: opts.blocked ? 'gate-x' : null,
    blockedSince: opts.blockedSince ?? null,
    phase: opts.phase ?? 'implement',
    lastDataAt: opts.lastDataAt === undefined ? null : opts.lastDataAt,
  } as unknown as OverviewBuilder;
}

const iso = (ms: number) => new Date(ms).toISOString();

suite('isIdleWaiting', () => {
	test('false when builder is blocked', () => {
		const b = builder('b', { blocked: true, lastDataAt: iso(NOW - 10 * 60_000) });
		assert.strictEqual(isIdleWaiting(b, NOW), false);
	});

	test('false when no lastDataAt timestamp (no live session)', () => {
		assert.strictEqual(isIdleWaiting(builder('a'), NOW), false);
	});

	test('false when phase is complete', () => {
		const b = builder('a', { phase: 'complete', lastDataAt: iso(NOW - 10 * 60_000) });
		assert.strictEqual(isIdleWaiting(b, NOW), false);
	});

	test('false when phase is verified', () => {
		const b = builder('a', { phase: 'verified', lastDataAt: iso(NOW - 10 * 60_000) });
		assert.strictEqual(isIdleWaiting(b, NOW), false);
	});

	test('false when last activity is fresher than the threshold', () => {
		const b = builder('a', { lastDataAt: iso(NOW - (FIVE_MIN_MS - 1000)) });
		assert.strictEqual(isIdleWaiting(b, NOW), false);
	});

	test('false right at the threshold (>, not >=)', () => {
		const b = builder('a', { lastDataAt: iso(NOW - FIVE_MIN_MS) });
		assert.strictEqual(isIdleWaiting(b, NOW), false);
	});

	test('true past the threshold', () => {
		const b = builder('a', { lastDataAt: iso(NOW - (FIVE_MIN_MS + 1)) });
		assert.strictEqual(isIdleWaiting(b, NOW), true);
	});
});

suite('orderForDisplay', () => {
	test('three buckets in order: blocked, then idle-waiting, then active', () => {
		const active = builder('a-active', { lastDataAt: iso(NOW - 1000) }); // fresh
		const idle = builder('i-idle', { lastDataAt: iso(NOW - 10 * 60_000) }); // stale
		const blockd = builder('b-blocked', { blocked: true, blockedSince: iso(NOW - 60_000) });
		const out = orderForDisplay([active, idle, blockd], NOW);
		assert.deepStrictEqual(out.map(x => x.id), ['b-blocked', 'i-idle', 'a-active']);
	});

	test('blocked sorted by blockedSince ascending (longest-waiting first)', () => {
		const newer = builder('new', { blocked: true, blockedSince: iso(NOW - 60_000) });
		const older = builder('old', { blocked: true, blockedSince: iso(NOW - 3600_000) });
		const out = orderForDisplay([newer, older], NOW);
		assert.deepStrictEqual(out.map(x => x.id), ['old', 'new']);
	});

	test('blocked takes precedence over idle: blocked+stale goes in blocked bucket', () => {
		const both = builder('both', { blocked: true, blockedSince: iso(NOW - 60_000), lastDataAt: iso(NOW - 10 * 60_000) });
		const idle = builder('idle', { lastDataAt: iso(NOW - 10 * 60_000) });
		const active = builder('active');
		const out = orderForDisplay([active, idle, both], NOW);
		assert.deepStrictEqual(out.map(x => x.id), ['both', 'idle', 'active']);
	});

	test('builders with null lastDataAt go to active (not idle)', () => {
		const idle = builder('idle', { lastDataAt: iso(NOW - 10 * 60_000) });
		const noActivity = builder('no-activity'); // lastDataAt: null
		const out = orderForDisplay([idle, noActivity], NOW);
		assert.deepStrictEqual(out.map(x => x.id), ['idle', 'no-activity']);
	});

	test('empty input -> empty output', () => {
		assert.deepStrictEqual(orderForDisplay([], NOW), []);
	});

	test('does not drop any builders (count is preserved)', () => {
		const bs = [
			builder('a'),
			builder('b', { lastDataAt: iso(NOW - 10 * 60_000) }),
			builder('c', { blocked: true, blockedSince: iso(NOW - 60_000) }),
			builder('d', { phase: 'complete', lastDataAt: iso(NOW - 10 * 60_000) }),
		];
		assert.strictEqual(orderForDisplay(bs, NOW).length, bs.length);
	});
});
