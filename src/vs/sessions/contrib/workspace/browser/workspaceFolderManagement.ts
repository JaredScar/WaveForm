/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IWorkspaceContextService, WorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceEditingService } from '../../../../workbench/services/workspaces/common/workspaceEditing.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { URI } from '../../../../base/common/uri.js';
import { autorun, observableValue } from '../../../../base/common/observable.js';
import { IWorkspaceFolderCreationData } from '../../../../platform/workspaces/common/workspaces.js';
import { Queue } from '../../../../base/common/async.js';
import { ISession, ISessionFolder } from '../../../services/sessions/common/session.js';
import { IWorkspaceFolderLabelService } from '../../../../workbench/services/workspaces/common/workspaceFolderLabelService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { basename } from '../../../../base/common/resources.js';

/**
 * When enabled, every session visible in the grid contributes its folders to
 * the window's workspace at once, instead of the workspace tracking only the
 * active session.
 */
export const MULTI_BRANCH_ENABLED_SETTING = 'waveform.multiBranch.enabled';

/**
 * Upper bound on how many folders may be mounted concurrently. Each mounted
 * folder costs a file watcher tree, an SCM repository, and language-service
 * work, so a large grid is capped rather than allowed to mount without limit.
 */
export const MULTI_BRANCH_MAX_FOLDERS_SETTING = 'waveform.multiBranch.maxFolders';

export const MULTI_BRANCH_MAX_FOLDERS_DEFAULT = 8;

/** A folder to mount, paired with the session and workspace it came from. */
interface IDesiredFolder {
	readonly folder: ISessionFolder;
	/** Fallback display name when the folder carries none. */
	readonly workspaceLabel: string;
	/** Whether the owning session's workspace demands trust before mounting. */
	readonly requiresTrust: boolean;
}

/** The resolved mount plan for one reconciliation pass. */
interface IWorkspacePlan {
	readonly folders: IWorkspaceFolderCreationData[];
	/** Subset of {@link folders} whose owning session demands trust first. */
	readonly trustRequired: URI[];
}

/**
 * Keeps the Agents window's workspace folders in sync with the sessions shown
 * in the grid.
 *
 * Upstream VS Code mounts exactly one folder — the active session's — and
 * swaps it whenever the user focuses a different session, so only one branch
 * checkout is ever reachable from the explorer, search, SCM, and terminals.
 * WaveForm instead mounts the union of every visible session's folders, which
 * is what makes several branches of the same repository usable side by side.
 *
 * Two consequences of that are deliberate:
 *
 * - **Folders are appended, never reordered.** Reconciliation only adds and
 *   removes, so a folder keeps its position for as long as it stays mounted.
 *   Rearranging or refocusing the grid therefore does not renumber workspace
 *   folders, which would otherwise churn every consumer keyed on folder index.
 * - **Duplicate base names are qualified by branch.** Two checkouts of one
 *   repository would otherwise both display as the repository name.
 */
export class WorkspaceFolderManagementContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.workspaceFolderManagement';
	private queue = this._register(new Queue<void>());

	/** Bumped on relevant configuration changes to re-drive the autorun. */
	private readonly _configEpoch = observableValue<number>(this, 0);

	constructor(
		@ISessionsService private readonly sessionsService: ISessionsService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceEditingService private readonly workspaceEditingService: IWorkspaceEditingService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IWorkspaceFolderLabelService private readonly workspaceFolderLabelService: IWorkspaceFolderLabelService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(MULTI_BRANCH_ENABLED_SETTING) || e.affectsConfiguration(MULTI_BRANCH_MAX_FOLDERS_SETTING)) {
				this._configEpoch.set(this._configEpoch.get() + 1, undefined);
			}
		}));

		this._register(autorun(reader => {
			this._configEpoch.read(reader);

			const activeSession = this.sessionsService.activeSession.read(reader);
			const visibleSessions = this.sessionsService.visibleSessions.read(reader);

			// Read every session's workspace so the autorun re-runs when a
			// session's folders resolve (a pending worktree becoming real, say).
			activeSession?.workspace.read(reader);
			for (const session of visibleSessions) {
				session?.workspace.read(reader);
			}

			const plan = this._computeDesiredFolders(activeSession, visibleSessions);
			this.queue.queue(() => this._reconcile(plan));
		}));
	}

	private get _multiBranchEnabled(): boolean {
		return this.configurationService.getValue<boolean>(MULTI_BRANCH_ENABLED_SETTING) !== false;
	}

	private get _maxFolders(): number {
		const configured = this.configurationService.getValue<number>(MULTI_BRANCH_MAX_FOLDERS_SETTING);
		return typeof configured === 'number' && configured >= 1 ? configured : MULTI_BRANCH_MAX_FOLDERS_DEFAULT;
	}

	private _key(uri: URI): string {
		return this.uriIdentityService.extUri.getComparisonKey(uri);
	}

	/**
	 * The folders that should be mounted, in grid order.
	 *
	 * The active session's folders are exempt from the cap: focusing a session
	 * must always make its files reachable, even in a grid larger than the
	 * limit allows.
	 */
	private _computeDesiredFolders(activeSession: ISession | undefined, visibleSessions: readonly (ISession | undefined)[]): IWorkspacePlan {
		const sessions = this._multiBranchEnabled
			? [...visibleSessions, activeSession]
			: [activeSession];

		const ordered: IDesiredFolder[] = [];
		const seen = new Set<string>();
		for (const session of sessions) {
			for (const desired of this._sessionFolders(session)) {
				const key = this._key(desired.folder.workingDirectory);
				if (!seen.has(key)) {
					seen.add(key);
					ordered.push(desired);
				}
			}
		}

		const capped = this._applyCap(ordered, activeSession);
		return {
			folders: this._applyLabels(capped),
			trustRequired: capped.filter(desired => desired.requiresTrust).map(desired => desired.folder.workingDirectory),
		};
	}

	private _sessionFolders(session: ISession | undefined): IDesiredFolder[] {
		const workspace = session?.workspace.get();
		if (!workspace) {
			return [];
		}
		return workspace.folders.map(folder => ({
			folder,
			workspaceLabel: workspace.label,
			requiresTrust: workspace.requiresWorkspaceTrust,
		}));
	}

	/** Trim to {@link _maxFolders}, preserving grid order and the active session's folders. */
	private _applyCap(ordered: IDesiredFolder[], activeSession: ISession | undefined): IDesiredFolder[] {
		const max = this._maxFolders;
		if (!this._multiBranchEnabled || ordered.length <= max) {
			return ordered;
		}

		const pinned = new Set(this._sessionFolders(activeSession).map(desired => this._key(desired.folder.workingDirectory)));
		const kept = new Set<string>();
		for (const desired of ordered) {
			if (pinned.has(this._key(desired.folder.workingDirectory))) {
				kept.add(this._key(desired.folder.workingDirectory));
			}
		}
		for (const desired of ordered) {
			if (kept.size >= max) {
				break;
			}
			kept.add(this._key(desired.folder.workingDirectory));
		}

		return ordered.filter(desired => kept.has(this._key(desired.folder.workingDirectory)));
	}

	/**
	 * Resolve display names, disambiguating only where they would otherwise
	 * collide — the normal case when several checkouts of one repository are
	 * mounted together.
	 *
	 * The label service already qualifies an isolated checkout by its branch
	 * (`my-app (agents/fix-auth)`), so that is usually distinct on its own.
	 * What it cannot separate is two checkouts of the same repository on the
	 * *same* branch, which clone isolation exists to make possible. Those fall
	 * back to the checkout's directory name, which is unique on disk. Appending
	 * the branch again would only repeat what the label already says.
	 */
	private _applyLabels(ordered: IDesiredFolder[]): IWorkspaceFolderCreationData[] {
		const baseNames = ordered.map(desired => this._baseLabel(desired));

		const counts = new Map<string, number>();
		for (const name of baseNames) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}

		return ordered.map((desired, index) => {
			const base = baseNames[index];
			if ((counts.get(base) ?? 0) < 2) {
				return { uri: desired.folder.workingDirectory, name: base };
			}
			const checkout = basename(desired.folder.workingDirectory);
			return {
				uri: desired.folder.workingDirectory,
				name: checkout ? `${base} — ${checkout}` : base,
			};
		});
	}

	private _baseLabel(desired: IDesiredFolder): string {
		const name = desired.folder.name || desired.workspaceLabel;
		return this.workspaceFolderLabelService.getWorkspaceFolderLabel(
			new WorkspaceFolder({ uri: desired.folder.workingDirectory, name, index: 0 }),
			true
		) ?? name;
	}

	private async _reconcile(plan: IWorkspacePlan): Promise<void> {
		await this._ensureTrusted(plan.trustRequired);

		const current = this.workspaceContextService.getWorkspace().folders;
		const desiredKeys = new Set(plan.folders.map(folder => this._key(folder.uri)));
		const currentKeys = new Set(current.map(folder => this._key(folder.uri)));

		const toRemove = current.filter(folder => !desiredKeys.has(this._key(folder.uri))).map(folder => folder.uri);
		const toAdd = plan.folders.filter(folder => !currentKeys.has(this._key(folder.uri)));

		// Remove first so a folder that moved on disk (an unarchived worktree
		// recreated at a new path) does not briefly collide with its successor.
		if (toRemove.length) {
			await this.workspaceEditingService.removeFolders(toRemove, true);
		}
		if (toAdd.length) {
			await this.workspaceEditingService.addFolders(toAdd, true);
		}
	}

	private async _ensureTrusted(trustRequired: URI[]): Promise<void> {
		const untrusted = trustRequired.filter(uri => !this._isUriTrusted(uri));
		if (untrusted.length) {
			await this.workspaceTrustManagementService.setUrisTrust(untrusted, true);
		}
	}

	private _isUriTrusted(uri: URI): boolean {
		return this.workspaceTrustManagementService.getTrustedUris().some(trustedUri => this.uriIdentityService.extUri.isEqual(trustedUri, uri));
	}
}
