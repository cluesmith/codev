import * as assert from 'assert';
import type { OverviewBacklogItem } from '@cluesmith/codev-types';
import { groupBacklogByArea, spawnableBacklog } from '../views/backlog.js';

function item(id: string, hasBuilder: boolean): OverviewBacklogItem {
	// Only the fields spawnableBacklog reads matter; cast the rest.
	return { id, title: `t${id}`, hasBuilder } as unknown as OverviewBacklogItem;
}

function backlogItem(id: string, area: string): OverviewBacklogItem {
	return { id, title: `t${id}`, area } as unknown as OverviewBacklogItem;
}

suite('spawnableBacklog', () => {
	test('drops items that already have an active builder', () => {
		const out = spawnableBacklog([
			item('1', false),
			item('2', true),
			item('3', false),
		]);
		assert.deepStrictEqual(out.map(i => i.id), ['1', '3']);
	});

	test('empty in -> empty out', () => {
		assert.deepStrictEqual(spawnableBacklog([]), []);
	});

	test('all have builders -> empty', () => {
		assert.deepStrictEqual(spawnableBacklog([item('1', true), item('2', true)]), []);
	});

	test('preserves input order of the kept items', () => {
		const out = spawnableBacklog([
			item('a', false),
			item('b', true),
			item('c', false),
			item('d', false),
		]);
		assert.deepStrictEqual(out.map(i => i.id), ['a', 'c', 'd']);
	});
});

suite('groupBacklogByArea', () => {
	test('empty in -> empty out', () => {
		assert.deepStrictEqual(groupBacklogByArea([]), []);
	});

	test('single Uncategorized item -> one Uncategorized group', () => {
		const out = groupBacklogByArea([backlogItem('1', 'Uncategorized')]);
		assert.deepStrictEqual(out.map(g => g.area), ['Uncategorized']);
		assert.deepStrictEqual(out[0].items.map(i => i.id), ['1']);
	});

	test('alphabetical specifics then Uncategorized last', () => {
		const out = groupBacklogByArea([
			backlogItem('1', 'tower'),
			backlogItem('2', 'Uncategorized'),
			backlogItem('3', 'auth'),
			backlogItem('4', 'porch'),
		]);
		assert.deepStrictEqual(
			out.map(g => g.area),
			['auth', 'porch', 'tower', 'Uncategorized'],
		);
	});

	test('omits empty area groups (no "<area> (0)" headers)', () => {
		// No items with area "vscode" -> no vscode header even though it's a
		// real area in the repo's label set.
		const out = groupBacklogByArea([
			backlogItem('1', 'auth'),
			backlogItem('2', 'tower'),
		]);
		assert.deepStrictEqual(out.map(g => g.area), ['auth', 'tower']);
	});

	test('preserves input order within a group (no internal re-sort)', () => {
		const out = groupBacklogByArea([
			backlogItem('5', 'vscode'),
			backlogItem('2', 'vscode'),
			backlogItem('9', 'vscode'),
			backlogItem('1', 'vscode'),
		]);
		assert.deepStrictEqual(out.map(g => g.area), ['vscode']);
		assert.deepStrictEqual(out[0].items.map(i => i.id), ['5', '2', '9', '1']);
	});

	test('groups multiple items per area correctly', () => {
		const out = groupBacklogByArea([
			backlogItem('1', 'vscode'),
			backlogItem('2', 'tower'),
			backlogItem('3', 'vscode'),
			backlogItem('4', 'tower'),
			backlogItem('5', 'vscode'),
		]);
		assert.deepStrictEqual(out.map(g => g.area), ['tower', 'vscode']);
		assert.deepStrictEqual(out[0].items.map(i => i.id), ['2', '4']);
		assert.deepStrictEqual(out[1].items.map(i => i.id), ['1', '3', '5']);
	});
});
