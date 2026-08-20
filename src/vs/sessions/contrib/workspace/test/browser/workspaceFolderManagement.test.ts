/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspace, IWorkspaceContextService, Workspace, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceFolderCreationData } from '../../../../../platform/workspaces/common/workspaces.js';
import { IWorkspaceFolderLabelService } from '../../../../../workbench/services/workspaces/common/workspaceFolderLabelService.js';
import { IWorkspaceEditingService } from '../../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { ISessionFolder, ISessionWorkspace } from '../../../../services/sessions/common/session.js';
import { IActiveSession } from '../../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { ISearchScopeService, SearchScopeService } from '../../../../../workbench/contrib/search/common/searchScope.js';
import { WorkspaceFolderManagementContribution } from '../../browser/workspaceFolderManagement.js';

/**
 * A session's folder, described the way the sessions model describes one: a
 * repository root plus the checkout the agent actually works in.
 *
 * `name` stands in for whatever the label service resolved for that checkout,
 * so these tests exercise collision handling rather than re-testing labelling.
 */
function folder(root: string, checkout: string, name: string): ISessionFolder {
	return {
		root: URI.file(root),
		workingDirectory: URI.file(checkout),
		name,
		description: undefined,
	};
}

function sessionWith(folders: readonly ISessionFolder[], options?: { readonly requiresTrust?: boolean }): IActiveSession {
	return new class extends mock<IActiveSession>() {
		override readonly workspace = observableValue<ISessionWorkspace | undefined>(this, {
			uri: folders[0]?.root ?? URI.file('/repos/none'),
			label: 'workspace',
			icon: { id: 'folder' },
			folders: [...folders],
			requiresWorkspaceTrust: options?.requiresTrust ?? false,
			isVirtualWorkspace: false,
		});
	};
}

interface ITestHarness {
	readonly mounted: () => readonly string[];
	readonly labels: () => readonly string[];
	readonly trusted: () => readonly string[];
	/** The folders search would cover, given everything currently mounted. */
	readonly searchScope: () => readonly string[];
	readonly setVisible: (sessions: readonly (IActiveSession | undefined)[]) => void;
	readonly setActive: (session: IActiveSession | undefined) => void;
	readonly settle: () => Promise<void>;
}

suite('Sessions - Workspace Folder Management', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createHarness(options?: { readonly configuration?: Record<string, unknown> }): ITestHarness {
		const instantiationService = store.add(new TestInstantiationService());

		const activeSession = observableValue<IActiveSession | undefined>('activeSession', undefined);
		const visibleSessions = observableValue<readonly (IActiveSession | undefined)[]>('visibleSessions', []);
		instantiationService.stub(ISessionsService, new class extends mock<ISessionsService>() {
			override readonly activeSession = activeSession;
			override readonly visibleSessions = visibleSessions;
		});

		instantiationService.stub(IUriIdentityService, new class extends mock<IUriIdentityService>() {
			override readonly extUri = extUri;
		});

		// The workbench's folder list is real state that reconciliation diffs
		// against, so the two workspace services share one mutable array.
		let folders: WorkspaceFolder[] = [];
		const reindex = () => folders.forEach((f, index) => (f as { index: number }).index = index);
		instantiationService.stub(IWorkspaceContextService, new class extends mock<IWorkspaceContextService>() {
			override getWorkspace(): IWorkspace {
				return new Workspace('test', folders, false, null, () => false);
			}
		});
		instantiationService.stub(IWorkspaceEditingService, new class extends mock<IWorkspaceEditingService>() {
			override async addFolders(foldersToAdd: IWorkspaceFolderCreationData[]): Promise<void> {
				folders = [
					...folders,
					...foldersToAdd.map((f, i) => new WorkspaceFolder({ uri: f.uri, name: f.name ?? '', index: folders.length + i })),
				];
				reindex();
			}
			override async removeFolders(foldersToRemove: URI[]): Promise<void> {
				folders = folders.filter(f => !foldersToRemove.some(uri => extUri.isEqual(uri, f.uri)));
				reindex();
			}
		});

		const trusted: URI[] = [];
		instantiationService.stub(IWorkspaceTrustManagementService, new class extends mock<IWorkspaceTrustManagementService>() {
			override getTrustedUris(): URI[] {
				return trusted;
			}
			override async setUrisTrust(uris: URI[]): Promise<void> {
				trusted.push(...uris);
			}
		});

		instantiationService.stub(IWorkspaceFolderLabelService, new class extends mock<IWorkspaceFolderLabelService>() {
			override getWorkspaceFolderLabel(workspaceFolder: WorkspaceFolder): string {
				return workspaceFolder.name;
			}
		});

		instantiationService.stub(IConfigurationService, new TestConfigurationService(options?.configuration));

		const searchScope = new SearchScopeService();
		instantiationService.stub(ISearchScopeService, searchScope);

		store.add(instantiationService.createInstance(WorkspaceFolderManagementContribution));

		return {
			mounted: () => folders.map(f => f.uri.path),
			labels: () => folders.map(f => f.name),
			trusted: () => trusted.map(uri => uri.path),
			searchScope: () => searchScope.resolveSearchFolders(folders).map(f => f.uri.path),
			setVisible: sessions => visibleSessions.set(sessions, undefined),
			setActive: session => activeSession.set(session, undefined),
			// Reconciliation is queued and awaits only already-resolved
			// promises, so yielding the macrotask flushes it deterministically.
			settle: () => timeout(0),
		};
	}

	test('mounts every visible session, not only the active one', async () => {
		const harness = createHarness();
		const main = sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]);
		const feature = sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]);

		harness.setVisible([main, feature]);
		harness.setActive(main);
		await harness.settle();

		assert.deepStrictEqual(harness.mounted(), ['/repos/app', '/worktrees/app-feature']);
	});

	test('mounts only the active session when multi-branch is disabled', async () => {
		const harness = createHarness({ configuration: { waveform: { multiBranch: { enabled: false } } } });
		const main = sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]);
		const feature = sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]);

		harness.setVisible([main, feature]);
		harness.setActive(feature);
		await harness.settle();

		assert.deepStrictEqual(harness.mounted(), ['/worktrees/app-feature']);
	});

	test('leaves distinct labels alone', async () => {
		const harness = createHarness();
		harness.setVisible([
			sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]),
			sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]),
		]);
		await harness.settle();

		assert.deepStrictEqual(harness.labels(), ['app (main)', 'app (feature)']);
	});

	test('qualifies two checkouts of one branch by their directory on disk', async () => {
		const harness = createHarness();
		// What clone isolation makes possible, and what the branch name alone
		// cannot separate: the same repository and branch, checked out twice.
		harness.setVisible([
			sessionWith([folder('/repos/app', '/clones/app-main-a', 'app (main)')]),
			sessionWith([folder('/repos/app', '/clones/app-main-b', 'app (main)')]),
		]);
		await harness.settle();

		assert.deepStrictEqual(harness.labels(), ['app (main) — app-main-a', 'app (main) — app-main-b']);
	});

	test('qualifies only the colliding folders', async () => {
		const harness = createHarness();
		harness.setVisible([
			sessionWith([folder('/repos/app', '/clones/app-main-a', 'app (main)')]),
			sessionWith([folder('/repos/app', '/clones/app-main-b', 'app (main)')]),
			sessionWith([folder('/repos/api', '/repos/api', 'api (main)')]),
		]);
		await harness.settle();

		assert.deepStrictEqual(harness.labels(), ['app (main) — app-main-a', 'app (main) — app-main-b', 'api (main)']);
	});

	test('caps concurrent folders but never drops the active session', async () => {
		const harness = createHarness({ configuration: { waveform: { multiBranch: { maxFolders: 2 } } } });
		const first = sessionWith([folder('/repos/app', '/worktrees/one', 'app (one)')]);
		const second = sessionWith([folder('/repos/app', '/worktrees/two', 'app (two)')]);
		const last = sessionWith([folder('/repos/app', '/worktrees/three', 'app (three)')]);

		harness.setVisible([first, second, last]);
		harness.setActive(last);
		await harness.settle();

		assert.deepStrictEqual(harness.mounted(), ['/worktrees/one', '/worktrees/three']);
	});

	test('unmounts a session that leaves the grid without disturbing the survivors', async () => {
		const harness = createHarness();
		const main = sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]);
		const feature = sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]);
		const fix = sessionWith([folder('/repos/app', '/worktrees/app-fix', 'app (fix)')]);

		harness.setVisible([main, feature, fix]);
		await harness.settle();

		harness.setVisible([main, fix]);
		await harness.settle();

		assert.deepStrictEqual(harness.mounted(), ['/repos/app', '/worktrees/app-fix']);
	});

	test('points search at the active branch, so matches are not reported once per branch', async () => {
		const harness = createHarness();
		const main = sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]);
		const feature = sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]);

		harness.setVisible([main, feature]);
		harness.setActive(feature);
		await harness.settle();

		assert.deepStrictEqual({
			mounted: harness.mounted(),
			searched: harness.searchScope(),
		}, {
			mounted: ['/repos/app', '/worktrees/app-feature'],
			searched: ['/worktrees/app-feature'],
		});
	});

	test('follows the user to the branch they switch to', async () => {
		const harness = createHarness();
		const main = sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]);
		const feature = sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]);

		harness.setVisible([main, feature]);
		harness.setActive(feature);
		await harness.settle();

		harness.setActive(main);
		await harness.settle();

		assert.deepStrictEqual(harness.searchScope(), ['/repos/app']);
	});

	test('searches everything mounted when no session is active', async () => {
		const harness = createHarness();
		harness.setVisible([
			sessionWith([folder('/repos/app', '/repos/app', 'app (main)')]),
			sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')]),
		]);
		await harness.settle();

		assert.deepStrictEqual(harness.searchScope(), ['/repos/app', '/worktrees/app-feature']);
	});

	test('searches a multi-folder session in full', async () => {
		const harness = createHarness();
		const monorepo = sessionWith([
			folder('/repos/app', '/worktrees/app-feature', 'app (feature)'),
			folder('/repos/api', '/worktrees/api-feature', 'api (feature)'),
		]);

		harness.setVisible([monorepo, sessionWith([folder('/repos/app', '/repos/app', 'app (main)')])]);
		harness.setActive(monorepo);
		await harness.settle();

		assert.deepStrictEqual(harness.searchScope(), ['/worktrees/app-feature', '/worktrees/api-feature']);
	});

	test('trusts the checkouts it mounts for a session that demands trust', async () => {
		const harness = createHarness();
		harness.setVisible([sessionWith([folder('/repos/app', '/worktrees/app-feature', 'app (feature)')], { requiresTrust: true })]);
		await harness.settle();

		assert.deepStrictEqual(harness.trusted(), ['/worktrees/app-feature']);
	});
});
