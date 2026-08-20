/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { SharedFetchCoordinator } from '../autofetch';

/** Key shape produced by `AutoFetcher.objectStoreKey`: object store + fetch mode. */
function key(objectStore: string, mode: 'all' | 'default' = 'default'): string {
	return `${objectStore}\u0000${mode}`;
}

suite('SharedFetchCoordinator', () => {

	const period = 180_000;

	test('lets the first caller for an object store fetch', () => {
		const coordinator = new SharedFetchCoordinator();

		assert.strictEqual(coordinator.tryClaim(key('/repo/.git'), period, 0), true);
	});

	test('holds back worktrees sharing one object store for the rest of the period', () => {
		const coordinator = new SharedFetchCoordinator();
		// Three worktrees of one repository all resolve to the same common dir.
		const shared = key('/repo/.git');

		const claims = [
			coordinator.tryClaim(shared, period, 0),
			coordinator.tryClaim(shared, period, 10),
			coordinator.tryClaim(shared, period, 20),
		];

		assert.deepStrictEqual(claims, [true, false, false]);
	});

	test('lets a sibling fetch again once the period has elapsed', () => {
		const coordinator = new SharedFetchCoordinator();
		const shared = key('/repo/.git');

		coordinator.tryClaim(shared, period, 0);

		assert.deepStrictEqual({
			justBefore: coordinator.tryClaim(shared, period, period - 1),
			atExpiry: coordinator.tryClaim(shared, period, period),
		}, {
			justBefore: false,
			atExpiry: true,
		});
	});

	test('measures the next period from the claim that actually fetched', () => {
		const coordinator = new SharedFetchCoordinator();
		const shared = key('/repo/.git');

		coordinator.tryClaim(shared, period, 0);
		// A skipped claim must not extend the window.
		coordinator.tryClaim(shared, period, 100);

		assert.strictEqual(coordinator.tryClaim(shared, period, period), true);
	});

	test('never holds back clones, which own their objects', () => {
		const coordinator = new SharedFetchCoordinator();

		const claims = [
			coordinator.tryClaim(key('/repo/.git'), period, 0),
			coordinator.tryClaim(key('/repo.clones/a/.git'), period, 0),
			coordinator.tryClaim(key('/repo.clones/b/.git'), period, 0),
		];

		assert.deepStrictEqual(claims, [true, true, true]);
	});

	test('does not let a default fetch stand in for fetching all remotes', () => {
		const coordinator = new SharedFetchCoordinator();

		const claims = [
			coordinator.tryClaim(key('/repo/.git', 'default'), period, 0),
			coordinator.tryClaim(key('/repo/.git', 'all'), period, 0),
		];

		assert.deepStrictEqual(claims, [true, true]);
	});
});
