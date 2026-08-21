/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextmenu/common/contextmenu.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { ISessionsManagementService, ISessionsChangeEvent } from '../../../services/sessions/common/sessionsManagement.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { getSessionStatusMessage, ISession, SessionStatus } from '../../../services/sessions/common/session.js';

import './media/missionControl.css';

/** Extracts plain text from a status message that may be a markdown string or plain string. */
function statusText(msg: IMarkdownString | string | undefined): string {
	if (!msg) {
		return '';
	}
	return typeof msg === 'string' ? msg : msg.value;
}

/** CSS class suffix for a session status value. */
function statusClass(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.InProgress: return 'inprogress';
		case SessionStatus.NeedsInput: return 'needsinput';
		case SessionStatus.Completed: return 'completed';
		case SessionStatus.Error: return 'error';
		default: return 'idle';
	}
}

/**
 * The Mission Control view pane.
 *
 * Shows all agent sessions as compact scannable cards in the auxiliary bar.
 * Each card displays the session's status, title, current branch, the agent's
 * latest status message, and a `+n/-n` diff summary. Cards for sessions
 * currently open in the sessions grid receive a highlighted border so the user
 * can tell at a glance which branches are being worked on versus which are
 * completed and waiting to be reviewed.
 *
 * Clicking a card opens (or focuses) that session in the sessions grid.
 *
 * Every card's content is updated reactively — status, description, diff stats,
 * and the "in-grid" highlight all update without a full re-render whenever the
 * underlying observables change.
 */
export class MissionControlViewPane extends ViewPane {

	private _list: HTMLElement | undefined;

	/**
	 * Disposable store per session ID. Holds the card's DOM node and all its
	 * reactive update subscriptions. Deleting an entry removes the card and
	 * tears down its subscriptions.
	 */
	private readonly _cards = this._register(new DisposableMap<string>());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ISessionsManagementService private readonly _sessionsManagementService: ISessionsManagementService,
		@ISessionsService private readonly _sessionsService: ISessionsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);

		container.classList.add('mission-control-view');
		this._list = dom.append(container, dom.$('.mc-list'));

		// Seed from the current full catalog (not just visible sessions).
		const initial = this._sessionsManagementService.getSessions();
		if (initial.length === 0) {
			this._renderEmptyState();
		} else {
			for (const session of initial) {
				this._addCard(session);
			}
		}

		// Keep in sync with catalog changes.
		this._register(this._sessionsManagementService.onDidChangeSessions((e: ISessionsChangeEvent) => {
			this._onSessionsChanged(e);
		}));

		// Re-apply the "in-grid" highlight when the grid contents change.
		this._register(autorun(reader => {
			const visible = new Set(
				this._sessionsService.visibleSessions.read(reader)
					.filter((s): s is NonNullable<typeof s> => !!s)
					.map(s => s.sessionId),
			);
			this._list?.querySelectorAll('.mc-card').forEach(card => {
				const id = (card as HTMLElement).dataset['sessionId'];
				card.classList.toggle('mc-in-grid', !!id && visible.has(id));
			});
		}));
	}

	/** Handles the incremental `onDidChangeSessions` event. */
	private _onSessionsChanged(e: ISessionsChangeEvent): void {
		// Remove cards for deleted sessions first.
		for (const removed of e.removed) {
			this._cards.deleteAndDispose(removed.sessionId);
		}

		// Add cards for new sessions.
		for (const added of e.added) {
			this._addCard(added);
		}

		// Nothing explicit needed for `e.changed` — per-card autoruns handle
		// field-level updates reactively.

		// Show or hide the empty state.
		const total = this._sessionsManagementService.getSessions().length;
		const emptyEl = this._list?.querySelector('.mc-empty');
		if (total === 0 && !emptyEl) {
			this._renderEmptyState();
		} else if (total > 0 && emptyEl) {
			emptyEl.remove();
		}
	}

	/** Creates and inserts a card for a single session, wires reactive updates. */
	private _addCard(session: ISession): void {
		if (!this._list) {
			return;
		}

		const store = new DisposableStore();

		// ── DOM skeleton ─────────────────────────────────────────────────

		const card = dom.append(this._list, dom.$('.mc-card'));
		card.dataset['sessionId'] = session.sessionId;
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.title = localize('missionControl.card.tooltip', "Open session in the grid");

		const header = dom.append(card, dom.$('.mc-header'));
		const dot = dom.append(header, dom.$('.mc-status-dot'));
		void dot; // present for CSS animation; no JS reads needed
		const titleEl = dom.append(header, dom.$('span.mc-title'));
		const branchEl = dom.append(header, dom.$('span.mc-branch'));

		const descEl = dom.append(card, dom.$('.mc-desc'));

		const footer = dom.append(card, dom.$('.mc-footer'));
		const diffEl = dom.append(footer, dom.$('span.mc-diff'));
		const timeEl = dom.append(footer, dom.$('span.mc-time'));

		// ── Reactive content updates ─────────────────────────────────────

		store.add(autorun(reader => {
			const status = session.status.read(reader);
			const title = session.title.read(reader);
			const desc = statusText(
				getSessionStatusMessage(status, session.description.read(reader)),
			);
			const summary = session.changesSummary?.read(reader);
			const branch = session.workspace.read(reader)?.folders[0]?.gitRepository?.branchName;
			const updatedAt = session.updatedAt.read(reader);

			// Status class drives the CSS colour and animation.
			card.className = `mc-card mc-status-${statusClass(status)}`;
			card.dataset['sessionId'] = session.sessionId;

			// Text content.
			titleEl.textContent = title;
			branchEl.textContent = branch ?? '';
			branchEl.title = branch ?? '';
			descEl.textContent = desc;

			// Diff stats.
			dom.clearNode(diffEl);
			if (summary && (summary.additions > 0 || summary.deletions > 0)) {
				if (summary.additions > 0) {
					const add = dom.append(diffEl, dom.$('span.mc-diff-add'));
					add.textContent = `+${summary.additions}`;
				}
				if (summary.deletions > 0) {
					const del = dom.append(diffEl, dom.$('span.mc-diff-del'));
					del.textContent = `-${summary.deletions}`;
				}
			}

			// Relative time.
			timeEl.textContent = fromNow(updatedAt, true);
		}));

		// ── Interaction ──────────────────────────────────────────────────

		store.add(dom.addDisposableListener(card, dom.EventType.CLICK, () => {
			this._sessionsService.openSession(session.resource);
		}));

		store.add(dom.addDisposableListener(card, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._sessionsService.openSession(session.resource);
			}
		}));

		// Remove the card's DOM node when this disposable is released.
		store.add(toDisposable(() => card.remove()));

		this._cards.set(session.sessionId, store);
	}

	/** Renders a placeholder when there are no sessions yet. */
	private _renderEmptyState(): void {
		if (!this._list) {
			return;
		}
		const empty = dom.append(this._list, dom.$('.mc-empty'));
		dom.append(empty, dom.$('span.codicon.codicon-pulse'));
		const msg = dom.append(empty, dom.$('span'));
		msg.textContent = localize(
			'missionControl.empty',
			"No agent sessions yet. Use Dispatch Tasks or open a session to get started.",
		);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}

	override dispose(): void {
		super.dispose();
	}
}
