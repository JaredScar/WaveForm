/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

type DispatchMode = 'parallel' | 'best-of-n';
type IsolationMode = 'clone' | 'worktree';

const MODE_ITEMS: (IQuickPickItem & { readonly value: DispatchMode })[] = [
	{
		id: 'parallel',
		value: 'parallel',
		label: '$(run-all) Parallel Tasks',
		description: 'Spawn agents working on different tasks simultaneously',
		detail: 'Each task gets its own isolated branch. Agents work independently.',
	},
	{
		id: 'best-of-n',
		value: 'best-of-n',
		label: '$(versions) Best-of-N',
		description: 'Attempt the same task with N parallel agents, then compare',
		detail: 'All agents receive the same prompt. Pick the best result, or cherry-pick across solutions.',
	},
];

const COUNT_ITEMS: IQuickPickItem[] = [2, 3, 4, 5, 8].map(n => ({
	id: String(n),
	label: `${n} agents`,
	description: n === 3 ? '(recommended)' : undefined,
}));

const ISOLATION_ITEMS: (IQuickPickItem & { readonly value: IsolationMode })[] = [
	{
		id: 'clone',
		value: 'clone',
		label: '$(git-branch) Clone isolation',
		description: 'Recommended',
		detail: 'Each agent gets a full local clone — multiple agents can work the same source branch in parallel.',
	},
	{
		id: 'worktree',
		value: 'worktree',
		label: '$(file-symlink-directory) Worktree isolation',
		description: 'Faster setup, branch names must be unique',
		detail: 'Linked checkouts share the parent repo\'s object store. Best when tasks are on distinct branches.',
	},
];

/**
 * Dispatches one or more agent sessions in a single action. Two modes:
 *
 * - **Parallel Tasks**: each task description spawns its own agent on a
 *   fresh isolated branch. Useful for splitting a sprint's worth of work
 *   across agents without any manual session setup.
 *
 * - **Best-of-N**: the same task goes to N agents simultaneously. Each
 *   produces an independent solution, and the developer picks the best one
 *   (or cherry-picks across solutions).
 *
 * Clone isolation is the default recommendation because it is the only mode
 * that allows multiple agents to share the same source branch without
 * conflicting — git refuses to check out one branch in two worktrees of the
 * same repository.
 */
class DispatchTasksAction extends Action2 {

	static readonly ID = 'waveform.dispatch.tasks';

	constructor() {
		super({
			id: DispatchTasksAction.ID,
			title: localize2('waveform.dispatchTasks', "Dispatch Tasks..."),
			icon: Codicon.checklist,
			f1: true,
			menu: [
				{
					id: Menus.SidebarSessionsHeader,
					group: 'navigation',
					order: 10,
				},
				{
					id: Menus.TitleBarLeftLayout,
					group: 'waveform',
					order: 10,
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const sessionsManagementService = accessor.get(ISessionsManagementService);
		const sessionsService = accessor.get(ISessionsService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);

		// ── Step 1: Mode ──────────────────────────────────────────────────────

		const modePick = await quickInputService.pick(MODE_ITEMS, {
			title: localize('waveform.dispatch.mode.title', "Dispatch — Select Mode"),
			canPickMany: false,
			matchOnDescription: true,
		});
		if (!modePick) {
			return;
		}

		// ── Step 2: Task descriptions ─────────────────────────────────────────

		let tasks: string[];

		if (modePick.value === 'parallel') {
			tasks = await this._collectParallelTasks(quickInputService);
			if (!tasks.length) {
				return;
			}
		} else {
			// Best-of-N: single task, picked N times
			const task = await quickInputService.input({
				title: localize('waveform.dispatch.bestOfN.task', "Best-of-N — Task Description"),
				placeHolder: localize('waveform.dispatch.bestOfN.placeholder', "What should all agents work on?"),
				prompt: localize('waveform.dispatch.bestOfN.prompt', "Enter the task all N agents will attempt independently."),
			});
			if (!task?.trim()) {
				return;
			}

			const countPick = await quickInputService.pick(COUNT_ITEMS, {
				title: localize('waveform.dispatch.bestOfN.count', "Best-of-N — How Many Parallel Agents?"),
				canPickMany: false,
			});
			if (!countPick?.id) {
				return;
			}

			const n = parseInt(countPick.id, 10);
			const baseTitle = task.substring(0, 60);
			// Give each session a numbered title so they are easy to tell apart in
			// the sessions list even though they received the same prompt.
			tasks = Array.from({ length: n }, (_, i) =>
				`${baseTitle} [${i + 1}/${n}]`
			);
			// The query is always the raw task; only the session title is numbered.
			tasks = tasks.map((title, i) => JSON.stringify({ query: task.trim(), title }));
		}

		// ── Step 3: Isolation mode ────────────────────────────────────────────

		const isolationPick = await quickInputService.pick(ISOLATION_ITEMS, {
			title: localize('waveform.dispatch.isolation.title', "Dispatch — Isolation Mode"),
			canPickMany: false,
			matchOnDescription: true,
		});
		if (!isolationPick) {
			return;
		}

		// ── Determine workspace folder URI ────────────────────────────────────

		const activeSession = sessionsService.activeSession.get();
		const activeWorkspace = activeSession?.workspace.get();
		const folderUri =
			activeWorkspace?.folders[0]?.workingDirectory
			?? workspaceContextService.getWorkspace().folders[0]?.uri;

		if (!folderUri) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('waveform.dispatch.noFolder', "No workspace folder found. Open a folder or start a session first."),
			});
			return;
		}

		// ── Dispatch ──────────────────────────────────────────────────────────

		const cts = new CancellationTokenSource();

		// Parse the task payload — for Best-of-N it contains separate query and
		// title; for Parallel Tasks the entire string is both.
		const parsedTasks = (modePick.value === 'best-of-n')
			? tasks.map(t => JSON.parse(t) as { query: string; title: string })
			: tasks.map(t => ({ query: t, title: t.substring(0, 100) }));

		const results = await Promise.allSettled(
			parsedTasks.map(({ query, title }) =>
				sessionsManagementService.createAndSendNewChatRequest(
					folderUri,
					{ query, title, background: true },
					{ isolationMode: isolationPick.value },
					cts.token,
				)
			)
		);

		cts.dispose();

		const succeeded = results.filter(r => r.status === 'fulfilled' && r.value).length;
		const failed = results.length - succeeded;

		if (failed === 0) {
			notificationService.notify({
				severity: Severity.Info,
				message: localize('waveform.dispatch.success', "Dispatched {0} agent session(s).", succeeded),
			});
		} else {
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('waveform.dispatch.partial', "Dispatched {0} of {1} sessions ({2} failed to start).", succeeded, results.length, failed),
			});
		}
	}

	/**
	 * Collects task descriptions one at a time until the user presses Escape.
	 * Using separate `InputBox` calls per task (rather than a multiline field)
	 * lets the user refine each description before moving on to the next, and
	 * gives clear feedback about how many tasks have been added so far.
	 */
	private async _collectParallelTasks(quickInputService: IQuickInputService): Promise<string[]> {
		const tasks: string[] = [];

		while (true) {
			const prompt = tasks.length === 0
				? localize('waveform.dispatch.parallel.prompt.first', "Enter the first task. Press Escape when done.")
				: localize('waveform.dispatch.parallel.prompt.more', "{0} task(s) added. Enter another, or press Escape to dispatch.", tasks.length);

			const input = await quickInputService.input({
				title: localize('waveform.dispatch.parallel.title', "Parallel Tasks — Task {0}", tasks.length + 1),
				placeHolder: localize('waveform.dispatch.parallel.placeholder', "Describe this task..."),
				prompt,
			});

			// Escape → stop collecting
			if (input === undefined) {
				break;
			}

			const trimmed = input.trim();
			if (trimmed) {
				tasks.push(trimmed);
			}
		}

		return tasks;
	}
}

registerAction2(DispatchTasksAction);
