/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ChangesetKind } from '../common/changesetUri.js';
import type { IChangesetOperationContribution, IChangesetOperationContext, IChangesetOperationRegistry } from '../common/agentHostChangesetOperationService.js';
import { ChangesetOperationScope, ChangesetOperationStatus, type ChangesetOperation } from '../common/state/sessionState.js';
import { AgentHostRollbackTurnOperationHandler } from './agentHostRollbackTurnOperationHandler.js';
import { AgentHostStateManager, IAgentHostStateManager } from './agentHostStateManager.js';

/**
 * Advertises and wires the `rollback-turn` changeset operation for turn
 * changesets that have a captured checkpoint.
 *
 * The operation appears in the Changes panel's per-turn action bar alongside
 * other turn-level verbs (commit, push, create-pr). It is only offered for
 * {@link ChangesetKind.Turn} changesets — not for branch, session, or
 * uncommitted-changes changesets.
 *
 * A confirmation dialog is required because the operation is destructive: it
 * resets tracked files in the working tree to the pre-turn state and cannot be
 * undone by a subsequent `git restore` (the pre-rollback state is not
 * automatically re-checkpointed).
 */
export class AgentHostRollbackTurnOperationContribution extends Disposable implements IChangesetOperationContribution {

	constructor(
		@IAgentHostStateManager private readonly _stateManager: AgentHostStateManager,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}

	registerHandlers(registry: IChangesetOperationRegistry): IDisposable {
		const store = new DisposableStore();
		const getSessionState = (sessionKey: string) => this._stateManager.getSessionState(sessionKey);
		const handler = this._instantiationService.createInstance(
			AgentHostRollbackTurnOperationHandler,
			getSessionState,
		);
		store.add(registry.registerChangesetOperationHandler(
			AgentHostRollbackTurnOperationHandler.OPERATION_ROLLBACK_TURN,
			handler,
		));
		return store;
	}

	getOperations({ changesetKind }: IChangesetOperationContext): ChangesetOperation[] {
		// Only offer rollback on per-turn changesets. Branch, session, and
		// uncommitted-changes changesets cover ranges that have no single
		// start-of-turn checkpoint to restore to.
		if (changesetKind !== ChangesetKind.Turn) {
			return [];
		}

		return [{
			id: AgentHostRollbackTurnOperationHandler.OPERATION_ROLLBACK_TURN,
			label: localize('agentHost.changeset.rollbackTurn', "Revert to Before This Turn"),
			// Prominent warning — restoring to a checkpoint resets tracked files in
			// the working tree. The agent's edits for this turn will be lost.
			confirmation: localize(
				'agentHost.changeset.rollbackTurn.confirmation',
				"This will restore the working tree to the state before this turn ran. The agent's changes for this turn will be lost and cannot be automatically recovered. Continue?",
			),
			icon: 'discard',
			scopes: [ChangesetOperationScope.Changeset],
			status: ChangesetOperationStatus.Idle,
		} satisfies ChangesetOperation];
	}
}
