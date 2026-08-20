/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, Disposable, EventEmitter, Memento, window, MessageItem, ConfigurationTarget, Uri, ConfigurationChangeEvent, l10n, env } from 'vscode';
import { Repository } from './repository';
import { eventToPromise, filterEvent, onceEvent } from './util';
import { GitErrorCodes } from './api/git.constants';

/**
 * Keeps checkouts that share one object store from each fetching the same
 * commits.
 *
 * Worktrees of a repository share a git common directory, so `refs/remotes` is
 * shared too: a fetch in any one of them updates the remote-tracking refs every
 * sibling reads, and each sibling's `DotGitWatcher` is watching those shared
 * refs, so it refreshes its own ahead/behind without having fetched. A window
 * holding N worktrees of one repository would otherwise run N identical
 * fetches per period — a real cost, since the Agents window defaults
 * `git.autofetch` on.
 *
 * Clones do not share an object store, so they get distinct keys and continue
 * to fetch independently, which they must.
 */
export class SharedFetchCoordinator {

	private readonly lastFetchByKey = new Map<string, number>();

	/**
	 * Whether the caller should fetch now, recording the claim when it should.
	 * Returns `false` when a checkout sharing the same object store already
	 * fetched within `periodMs`.
	 */
	tryClaim(key: string, periodMs: number, now: number = Date.now()): boolean {
		const last = this.lastFetchByKey.get(key);
		if (last !== undefined && now - last < periodMs) {
			return false;
		}
		this.lastFetchByKey.set(key, now);
		return true;
	}
}

/** Process-wide coordinator; tests construct their own. */
export const sharedFetchCoordinator = new SharedFetchCoordinator();

export class AutoFetcher {

	private static DidInformUser = 'autofetch.didInformUser';

	private _onDidChange = new EventEmitter<boolean>();
	private onDidChange = this._onDidChange.event;

	private _enabled: boolean = false;
	private _fetchAll: boolean = false;
	get enabled(): boolean { return this._enabled; }
	set enabled(enabled: boolean) { this._enabled = enabled; this._onDidChange.fire(enabled); }

	private disposables: Disposable[] = [];

	constructor(private repository: Repository, private globalState: Memento, private coordinator: SharedFetchCoordinator = sharedFetchCoordinator) {
		workspace.onDidChangeConfiguration(this.onConfiguration, this, this.disposables);
		this.onConfiguration();

		const onGoodRemoteOperation = filterEvent(repository.onDidRunOperation, ({ operation, error }) => !error && operation.remote);
		const onFirstGoodRemoteOperation = onceEvent(onGoodRemoteOperation);
		onFirstGoodRemoteOperation(this.onFirstGoodRemoteOperation, this, this.disposables);

		env.onDidChangeMeteredConnection(() => this.onConfiguration(), this, this.disposables);
	}

	private async onFirstGoodRemoteOperation(): Promise<void> {
		const didInformUser = !this.globalState.get<boolean>(AutoFetcher.DidInformUser);

		if (this.enabled && !didInformUser) {
			this.globalState.update(AutoFetcher.DidInformUser, true);
		}

		const shouldInformUser = !this.enabled && didInformUser;

		if (!shouldInformUser) {
			return;
		}

		const yes: MessageItem = { title: l10n.t('Yes') };
		const no: MessageItem = { isCloseAffordance: true, title: l10n.t('No') };
		const askLater: MessageItem = { title: l10n.t('Ask Me Later') };
		const result = await window.showInformationMessage(l10n.t('Would you like {0} to [periodically run "git fetch"]({1})?', env.appName, 'https://go.microsoft.com/fwlink/?linkid=865294'), yes, no, askLater);

		if (result === askLater) {
			return;
		}

		if (result === yes) {
			const gitConfig = workspace.getConfiguration('git', Uri.file(this.repository.root));
			gitConfig.update('autofetch', true, ConfigurationTarget.Global);
		}

		this.globalState.update(AutoFetcher.DidInformUser, true);
	}

	private onConfiguration(e?: ConfigurationChangeEvent): void {
		if (e !== undefined && !e.affectsConfiguration('git.autofetch')) {
			return;
		}

		if (env.isMeteredConnection) {
			this.disable();
			return;
		}

		const gitConfig = workspace.getConfiguration('git', Uri.file(this.repository.root));
		switch (gitConfig.get<boolean | 'all'>('autofetch')) {
			case true:
				this._fetchAll = false;
				this.enable();
				break;
			case 'all':
				this._fetchAll = true;
				this.enable();
				break;
			case false:
			default:
				this._fetchAll = false;
				this.disable();
				break;
		}
	}

	enable(): void {
		if (this.enabled) {
			return;
		}

		this.enabled = true;
		this.run();
	}

	disable(): void {
		this.enabled = false;
	}

	/**
	 * Identifies the object store this checkout fetches into. Worktrees of one
	 * repository report their shared common directory here; a clone reports its
	 * own. The fetch mode is part of the key because `all` and the default
	 * fetch different things, so one cannot stand in for the other.
	 */
	private get objectStoreKey(): string {
		const { commonPath, path } = this.repository.dotGit;
		return `${commonPath ?? path}\u0000${this._fetchAll ? 'all' : 'default'}`;
	}

	private async run(): Promise<void> {
		while (this.enabled) {
			await this.repository.whenIdleAndFocused();

			if (!this.enabled) {
				return;
			}

			const period = workspace.getConfiguration('git', Uri.file(this.repository.root)).get<number>('autofetchPeriod', 180) * 1000;

			// Skip when a checkout sharing this object store already fetched
			// these refs; the shared-ref watcher still reports the result.
			if (this.coordinator.tryClaim(this.objectStoreKey, period)) {
				try {
					if (this._fetchAll) {
						await this.repository.fetchAll({ silent: true });
					} else {
						await this.repository.fetchDefault({ silent: true });
					}
				} catch (err) {
					if (err.gitErrorCode === GitErrorCodes.AuthenticationFailed) {
						this.disable();
					}
				}
			}

			if (!this.enabled) {
				return;
			}

			const timeout = new Promise(c => setTimeout(c, period));
			const whenDisabled = eventToPromise(filterEvent(this.onDidChange, enabled => !enabled));

			await Promise.race([timeout, whenDisabled]);
		}
	}

	dispose(): void {
		this.disable();
		this.disposables.forEach(d => d.dispose());
	}
}
