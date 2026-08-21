/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $ } from '../../../../base/browser/dom.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, IObservable } from '../../../../base/common/observable.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuItemAction, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { createDecorator, IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ChatPillActionViewItem } from '../../../../workbench/browser/chatPills.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { Menus } from '../../../browser/menus.js';
import { ISessionContext } from '../../../services/sessions/browser/sessionContext.js';
import { IActiveSession, ISessionsChangeEvent, ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ISession } from '../../../services/sessions/common/session.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';

// ─── Configuration ─────────────────────────────────────────────────────────

const BUDGET_CONFIG_SECTION = 'waveform.budget';
const BUDGET_DEFAULT_TURN_LIMIT_KEY = `${BUDGET_CONFIG_SECTION}.defaultTurnLimit`;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: BUDGET_CONFIG_SECTION,
	title: localize('budget.config.title', "Session Budget"),
	order: 801,
	properties: {
		[BUDGET_DEFAULT_TURN_LIMIT_KEY]: {
			type: 'number',
			default: 0,
			minimum: 0,
			markdownDescription: localize(
				'budget.config.defaultTurnLimit.desc',
				"Maximum number of agent turns per new session. Set to `0` to disable the budget. When a session reaches its limit a notification offers to stop or extend the agent.",
			),
		},
	},
});

// ─── Service ───────────────────────────────────────────────────────────────

export interface IBudgetState {
	/** Maximum turns allowed (0 = unlimited). */
	readonly turnLimit: number;
	/** Turns completed since the budget was attached to this session. */
	readonly completedTurns: number;
}

interface IMutableState extends IBudgetState {
	turnLimit: number;
	completedTurns: number;
	prevTurnEndMs: number | undefined;
	notified: boolean;
}

export const ISessionBudgetService = createDecorator<ISessionBudgetService>('sessionBudgetService');

export interface ISessionBudgetService {
	readonly _serviceBrand: undefined;
	/** Fires with the sessionId whenever turn count or budget limit changes. */
	readonly onDidChange: Event<string>;
	getState(sessionId: string): IBudgetState | undefined;
	/** Set turn limit (0 = unlimited). Preserves turn count, resets notification flag. */
	setBudget(sessionId: string, limit: number): void;
}

export class SessionBudgetService extends Disposable implements ISessionBudgetService {
	declare readonly _serviceBrand: undefined;

	private readonly _states = new Map<string, IMutableState>();
	private readonly _onChange = this._register(new Emitter<string>());
	readonly onDidChange: Event<string> = this._onChange.event;

	getState(sessionId: string): IBudgetState | undefined {
		return this._states.get(sessionId);
	}

	setBudget(sessionId: string, limit: number): void {
		const s = this._states.get(sessionId);
		if (s) {
			s.turnLimit = Math.max(0, Math.round(limit));
			s.notified = false;
			this._onChange.fire(sessionId);
		}
	}

	// Internal — called by SessionBudgetContribution.
	initSession(id: string, defaultLimit: number, seedTurnEnd: Date | undefined): void {
		if (!this._states.has(id)) {
			this._states.set(id, {
				turnLimit: Math.max(0, Math.round(defaultLimit)),
				completedTurns: 0,
				prevTurnEndMs: seedTurnEnd?.getTime(),
				notified: false,
			});
		}
	}

	recordTurnIfNew(id: string, turnEnd: Date): boolean {
		const s = this._states.get(id);
		if (!s) { return false; }
		const ms = turnEnd.getTime();
		if (ms === s.prevTurnEndMs) { return false; }
		s.prevTurnEndMs = ms;
		s.completedTurns++;
		this._onChange.fire(id);
		return true;
	}

	shouldNotify(id: string): boolean {
		const s = this._states.get(id);
		if (!s || s.turnLimit <= 0 || s.completedTurns < s.turnLimit || s.notified) {
			return false;
		}
		s.notified = true;
		return true;
	}

	removeSession(id: string): void { this._states.delete(id); }
}

registerSingleton(ISessionBudgetService, SessionBudgetService, InstantiationType.Delayed);

// ─── Contribution ──────────────────────────────────────────────────────────

/**
 * Watches every agent session's `lastTurnEnd` observable. Each time it
 * changes the turn counter for that session is incremented; if the new count
 * equals the configured budget limit the agent is paused via a notification.
 */
export class SessionBudgetContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.sessionBudget';

	private readonly _watchers = this._register(new DisposableMap<string>());

	constructor(
		@ISessionsManagementService private readonly _sessions: ISessionsManagementService,
		@ISessionBudgetService private readonly _budget: SessionBudgetService,
		@INotificationService private readonly _notifications: INotificationService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		for (const s of _sessions.getSessions()) { this._watch(s); }
		this._register(_sessions.onDidChangeSessions((e: ISessionsChangeEvent) => {
			for (const r of e.removed) { this._watchers.deleteAndDispose(r.sessionId); this._budget.removeSession(r.sessionId); }
			for (const a of e.added) { this._watch(a); }
		}));
	}

	private _defaultLimit(): number {
		return Math.max(0, Number(this._config.getValue<number>(BUDGET_DEFAULT_TURN_LIMIT_KEY) ?? 0));
	}

	private _watch(session: ISession): void {
		const store = new DisposableStore();
		this._budget.initSession(session.sessionId, this._defaultLimit(), session.lastTurnEnd.get());

		store.add(autorun(reader => {
			const turnEnd = session.lastTurnEnd.read(reader);
			if (!turnEnd) { return; }
			const recorded = this._budget.recordTurnIfNew(session.sessionId, turnEnd);
			if (recorded && this._budget.shouldNotify(session.sessionId)) {
				this._notify(session);
			}
		}));

		this._watchers.set(session.sessionId, store);
	}

	private _notify(session: ISession): void {
		const title = session.title.get();
		const limit = this._budget.getState(session.sessionId)?.turnLimit ?? 0;

		this._notifications.prompt(
			Severity.Warning,
			localize(
				'budget.notification.reached',
				'Session "{0}" has completed {1} turn{2} — its budget limit.',
				title, limit, limit === 1 ? '' : 's',
			),
			[
				{
					label: localize('budget.stop', "Stop Agent"),
					run: () => { this._sessions.cancelCurrentRequest(session).catch(onUnexpectedError); },
				},
				{
					label: localize('budget.extend', "Extend by 5 Turns"),
					run: () => {
						const cur = this._budget.getState(session.sessionId)?.completedTurns ?? 0;
						this._budget.setBudget(session.sessionId, cur + 5);
					},
				},
			],
		);
	}
}

registerWorkbenchContribution2(
	SessionBudgetContribution.ID,
	SessionBudgetContribution,
	WorkbenchPhase.AfterRestored,
);

// ─── Header pill ───────────────────────────────────────────────────────────

const SET_BUDGET_CMD = 'sessions.budget.setTurnBudget';

/**
 * Pill action shown in the session header meta row.
 *
 * Renders "Turn 5" (no limit) or "Turn 5 / 10" (with limit). Clicking it
 * opens a QuickInput to change or clear the budget for the current session.
 * The pill is always visible once any turn has completed, acting as both a
 * turn counter and a budget control.
 */
class SetTurnBudgetAction extends Action2 {
	static readonly ID = SET_BUDGET_CMD;

	constructor() {
		super({
			id: SET_BUDGET_CMD,
			title: localize2('budget.action', "Turn Budget"),
			f1: true,
			menu: {
				id: Menus.SessionHeaderMeta,
				group: 'navigation',
				order: 2,
			},
		});
	}

	override async run(
		accessor: ServicesAccessor,
		session?: IActiveSession,
	): Promise<void> {
		const quick = accessor.get(IQuickInputService);
		const budget = accessor.get(ISessionBudgetService);
		const mgmt = accessor.get(ISessionsManagementService);

		const target = session ?? mgmt.getSessions()[0];
		if (!target) { return; }

		const current = budget.getState(target.sessionId)?.turnLimit ?? 0;
		const raw = await quick.input({
			title: localize('budget.input.title', 'Set Turn Budget for "{0}"', target.title.get()),
			value: current > 0 ? String(current) : '',
			placeHolder: localize('budget.input.placeholder', "Turns (empty or 0 to disable)"),
			prompt: localize('budget.input.prompt', "The agent pauses after this many turns and asks what to do next."),
			validateInput: async v => {
				const n = parseInt(v, 10);
				if (v !== '' && (isNaN(n) || n < 0)) {
					return localize('budget.input.invalid', "Enter a positive whole number, or leave empty to disable.");
				}
				return undefined;
			},
		});
		if (raw === undefined) { return; }
		budget.setBudget(target.sessionId, raw === '' ? 0 : Math.max(0, parseInt(raw, 10)));
	}
}

registerAction2(SetTurnBudgetAction);

// ─── Pill view item ────────────────────────────────────────────────────────

class TurnBudgetPillViewItem extends ChatPillActionViewItem {
	private readonly _stateObs: IObservable<IBudgetState>;

	constructor(
		action: MenuItemAction,
		options: IActionViewItemOptions,
		@ISessionContext sessionContext: ISessionContext,
		@ISessionBudgetService private readonly _budgetService: ISessionBudgetService,
	) {
		super(undefined, action, options);

		this._stateObs = derived(this, reader => {
			const session = sessionContext.session.read(reader);
			return this._budgetService.getState(session?.sessionId ?? '') ?? { completedTurns: 0, turnLimit: 0 };
		});

		// The budget service emits a non-reactive event, so we subscribe and force
		// a label refresh manually alongside the reactive observable watcher.
		this._register(_budgetService.onDidChange(() => {
			this.updateLabel();
			this.updateTooltip();
			this.updateAriaLabel();
		}));

		this._register(autorun(reader => {
			this._stateObs.read(reader);
			this.updateLabel();
			this.updateTooltip();
			this.updateAriaLabel();
		}));
	}

	protected override getLabelText(): string {
		const { completedTurns, turnLimit } = this._stateObs.get();
		return turnLimit > 0
			? localize('budget.pill.withLimit', "Turn {0} / {1}", completedTurns, turnLimit)
			: localize('budget.pill.noLimit', "Turn {0}", completedTurns);
	}

	protected override getAdditionalLabelContent(): Array<HTMLElement | string> {
		const { completedTurns, turnLimit } = this._stateObs.get();
		return turnLimit > 0 && completedTurns >= turnLimit
			? [$('span.chat-pill-warning', undefined, '⚠')]
			: [];
	}

	protected override getTooltip(): string {
		const { completedTurns, turnLimit } = this._stateObs.get();
		return turnLimit > 0
			? localize('budget.pill.tooltip.limit', "{0} / {1} turns used — click to change budget", completedTurns, turnLimit)
			: localize('budget.pill.tooltip.open', "{0} turn{1} — click to set a budget", completedTurns, completedTurns === 1 ? '' : 's');
	}

	protected override getAriaLabel(): string {
		return this.getTooltip();
	}
}

// ─── Registration ──────────────────────────────────────────────────────────

class TurnBudgetPillContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.sessionBudget.pill';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
	) {
		super();
		const announce = this._register(new Emitter<void>());
		this._register(actionViewItemService.register(
			Menus.SessionHeaderMeta,
			SetTurnBudgetAction.ID,
			(action, options, instantiationService: IInstantiationService) => {
				if (!(action instanceof MenuItemAction)) { return undefined; }
				return instantiationService.createInstance(TurnBudgetPillViewItem, action, options);
			},
			announce.event,
		));
		announce.fire();
	}
}

registerWorkbenchContribution2(
	TurnBudgetPillContribution.ID,
	TurnBudgetPillContribution,
	WorkbenchPhase.AfterRestored,
);
