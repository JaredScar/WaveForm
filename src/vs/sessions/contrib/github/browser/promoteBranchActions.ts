/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { SessionHasChangesContext, SessionHasGitRepositoryContext, SessionHasPullRequestContext, SessionIsCreatedContext } from '../../../common/contextkeys.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { IActiveSession, ISessionsChangeEvent } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

// --- Promote Branch action (Create PR from session header)

/**
 * A "Create PR" shortcut in the session header meta row. It appears alongside
 * the diff-stats pill and the existing PR-open pill, but only when there are
 * uncommitted or unpushed changes, the session has a git repository, and no PR
 * exists yet.
 *
 * Clicking it delegates to the agent host's `create-pr` changeset operation,
 * which handles committing any remaining changes, pushing the branch with
 * `--set-upstream` when needed, and calling the GitHub API to open the pull
 * request. Clone-isolated sessions benefit most from this because their branch
 * lives only inside the clone until this operation runs.
 */
class PromoteBranchAction extends Action2 {

	static readonly ID = 'sessions.github.promoteBranch';

	constructor() {
		super({
			id: PromoteBranchAction.ID,
			title: localize2('sessions.github.promoteBranch', "Create PR"),
			icon: Codicon.gitPullRequest,
			f1: false,
			menu: {
				id: Menus.SessionHeaderMeta,
				group: 'navigation',
				// Placed after the diff-stats pill (order 0) and before the PR-open
				// pill (order 1), so "Create PR" is only ever present when there is
				// no PR yet — at which point the PR-open pill is absent anyway.
				order: 0.5,
				when: ContextKeyExpr.and(
					SessionIsCreatedContext,
					SessionHasChangesContext,
					SessionHasGitRepositoryContext,
					ContextKeyExpr.not(SessionHasPullRequestContext.key),
				),
			},
		});
	}

	override async run(accessor: ServicesAccessor, session?: IActiveSession): Promise<void> {
		const sessionsService = accessor.get(ISessionsService);
		const target = session ?? sessionsService.activeSession.get();
		if (!target) {
			return;
		}
		await invokeCreatePr(target);
	}
}

registerAction2(PromoteBranchAction);

// --- Session completion notifier

/**
 * Shows a prompt when an agent session completes with unpromoted changes, so
 * the user can push and create a pull request without having to find the button
 * in the Changes panel. The prompt fires at most once per session.
 *
 * Clone-isolated sessions are the primary target: their commits do not exist in
 * the parent repository until pushed, so there is no other signal that work is
 * ready to ship. Worktree and workspace sessions benefit too — the branch
 * already exists in the parent repo, but the PR still needs to be opened.
 */
export class SessionCompletionNotifier extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.sessionCompletionNotifier';

	/** Sessions for which we have already fired the completion prompt. */
	private readonly _notifiedIds = new Set<string>();

	/** Per-session reactive watcher disposables. */
	private readonly _trackers = this._register(new DisposableMap<string>());

	constructor(
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();

		this._sessionsManagementService.onDidChangeSessions(this._onDidChangeSessions, this, this._store);
		this._onDidChangeSessions({
			added: this._sessionsManagementService.getSessions(),
			removed: [],
			changed: [],
		});
	}

	private _onDidChangeSessions(e: ISessionsChangeEvent): void {
		for (const session of [...e.added, ...e.changed]) {
			this._trackSession(session);
		}
		for (const session of e.removed) {
			this._trackers.deleteAndDispose(session.sessionId);
		}
	}

	private _trackSession(session: ISession): void {
		// Avoid replacing an existing tracker for the same session — the poller
		// is stateful (tracks the last-seen status) and replacing it would reset
		// the "already notified" guard inside the autorun.
		if (this._trackers.has(session.sessionId)) {
			return;
		}

		const disposable = autorun(reader => {
			const status = session.status.read(reader);

			// Only act on the Completed → idle transition.
			if (status !== SessionStatus.Completed) {
				return;
			}

			// Fire at most once per session.
			if (this._notifiedIds.has(session.sessionId)) {
				return;
			}

			// Must have a git repository with no existing PR.
			const workspace = session.workspace.read(reader);
			const gitRepository = workspace?.folders[0]?.gitRepository;
			if (!gitRepository) {
				return;
			}
			const hasPR = !!gitRepository.gitHubInfo.read(reader)?.pullRequest;
			if (hasPR) {
				return;
			}

			// Must have pending changes in the default changeset.
			const changesets = session.changesets.read(reader);
			const defaultChangeset = changesets?.find(c => c.isDefault.read(reader));
			const changes = defaultChangeset?.changes.read(reader) ?? session.changes?.read(reader);
			if (!changes?.length) {
				return;
			}

			this._notifiedIds.add(session.sessionId);
			this._promptPromotion(session);
		});

		this._trackers.set(session.sessionId, disposable);
	}

	private _promptPromotion(session: ISession): void {
		const workspace = session.workspace.get();
		const branch = workspace?.folders[0]?.gitRepository?.branchName?.trim();
		const message = branch
			? localize(
				'sessions.github.completion.notification.branch',
				"Agent finished work on `{0}`. Create a pull request to share the changes?",
				branch,
			)
			: localize(
				'sessions.github.completion.notification',
				"Agent finished work. Create a pull request to share the changes?",
			);

		this._notificationService.prompt(
			Severity.Info,
			message,
			[
				{
					label: localize('sessions.github.completion.createPr', "Create PR"),
					run: () => invokeCreatePr(session),
				},
			],
			{
				neverShowAgain: {
					id: 'sessions.github.completion.neverShowAgain',
					isSecondary: true,
				},
			},
		);
	}
}

registerWorkbenchContribution2(
	SessionCompletionNotifier.ID,
	SessionCompletionNotifier,
	WorkbenchPhase.AfterRestored,
);

// --- Shared helper

/**
 * Invokes the agent host's `create-pr` changeset operation on the default
 * changeset of `session`. The operation commits any remaining changes, pushes
 * the branch with `--set-upstream` when no upstream exists, and creates the
 * pull request on GitHub via Octokit.
 */
async function invokeCreatePr(session: ISession): Promise<void> {
	const changesets = session.changesets.get();
	const defaultChangeset = changesets?.find(c => c.isDefault.get());
	if (defaultChangeset) {
		await defaultChangeset.invokeOperation('create-pr');
	}
}
