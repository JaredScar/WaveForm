/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IAgentHostCheckpointService } from '../common/agentHostCheckpointService.js';
import { type IChangesetOperationHandler } from '../common/agentHostChangesetOperationService.js';
import { IAgentHostGitService } from '../common/agentHostGitService.js';
import { parseTurnChangesetUri } from '../common/changesetUri.js';
import { type InvokeChangesetOperationParams, type InvokeChangesetOperationResult } from '../common/state/protocol/channels-changeset/commands.js';
import { AHP_SESSION_NOT_FOUND, JsonRpcErrorCodes, ProtocolError } from '../common/state/sessionProtocol.js';
import { type SessionState } from '../common/state/sessionState.js';
import { ILogService } from '../../log/common/log.js';

/**
 * Server-side handler for the `rollback-turn` changeset operation.
 *
 * Restores the working tree of a session's checkout to the exact state it was
 * in before a specific turn ran, using the per-turn git checkpoint captured at
 * the start of that turn.
 *
 * The restore is applied to the **working tree only** (not staged index) so the
 * user can inspect the reverted state before staging or committing. Any staged
 * changes that the agent never committed are also reset because
 * `git restore --source=<ref>` replaces the content of tracked paths regardless
 * of their index state.
 *
 * A checkpoint must have been captured by {@link IAgentHostCheckpointService}
 * for the turn; if none is found the operation fails with a descriptive error.
 */
export class AgentHostRollbackTurnOperationHandler implements IChangesetOperationHandler {

	public static readonly OPERATION_ROLLBACK_TURN = 'rollback-turn';

	constructor(
		private readonly _getSessionState: (sessionKey: string) => SessionState | undefined,
		@IAgentHostGitService private readonly _gitService: IAgentHostGitService,
		@IAgentHostCheckpointService private readonly _checkpointService: IAgentHostCheckpointService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async invoke(params: InvokeChangesetOperationParams, token: CancellationToken): Promise<InvokeChangesetOperationResult> {
		const abortController = new AbortController();
		const cancellationListener = token.onCancellationRequested(() => abortController.abort());
		try {
			return await this._invoke(params, token);
		} finally {
			cancellationListener.dispose();
		}
	}

	private async _invoke(params: InvokeChangesetOperationParams, token: CancellationToken): Promise<InvokeChangesetOperationResult> {
		const parsed = parseTurnChangesetUri(params.channel);
		if (!parsed) {
			throw new ProtocolError(JsonRpcErrorCodes.InvalidParams, `Not a turn changeset URI: ${params.channel}`);
		}

		const { sessionUri, turnId } = parsed;
		const sessionState = this._getSessionState(sessionUri);
		if (!sessionState) {
			throw new ProtocolError(AHP_SESSION_NOT_FOUND, `Session not found: ${sessionUri}`);
		}

		this._throwIfCancelled(token);

		const workingDirectoryStr = sessionState.workingDirectories?.[0];
		if (!workingDirectoryStr) {
			throw new ProtocolError(JsonRpcErrorCodes.InternalError, `Session has no working directory: ${sessionUri}`);
		}

		const workingDirectory = URI.parse(workingDirectoryStr);
		const sessionUriParsed = URI.parse(sessionUri);

		// Resolve the checkpoint refs bracketing the turn. The `parent` ref is
		// the tree state captured *before* the turn ran — restoring to it undoes
		// all of the agent's edits for that turn.
		const pair = await this._checkpointService.getTurnCheckpointPair(sessionUriParsed, turnId, workingDirectory);
		if (!pair) {
			throw new ProtocolError(
				JsonRpcErrorCodes.InternalError,
				localize(
					'agentHost.changeset.rollbackTurn.noCheckpoint',
					"No checkpoint found for this turn. Rollback requires checkpoints, which are only captured for sessions running in isolated checkouts.",
				),
			);
		}

		this._logService.info(
			`[AgentHostRollbackTurnOperationHandler] Rolling back to pre-turn ref '${pair.parent}' ` +
			`(turn ${turnId}) in session ${sessionUri}`,
		);

		this._throwIfCancelled(token);

		try {
			// Restore the working tree to the state at the pre-turn checkpoint tree.
			// Using '.' as the path target restores every tracked file that the
			// turn touched, matching what the agent saw when it started.
			await this._gitService.restore(workingDirectory, ['.'], { ref: pair.parent });
		} catch (err) {
			this._throwIfCancelled(token);
			throw new ProtocolError(
				JsonRpcErrorCodes.InternalError,
				`Failed to roll back turn: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		return {
			message: {
				markdown: localize(
					'agentHost.changeset.rollbackTurn.done',
					"Rolled back to the state before this turn.",
				),
			},
		};
	}

	private _throwIfCancelled(token: CancellationToken): void {
		if (token.isCancellationRequested) {
			throw new ProtocolError(
				JsonRpcErrorCodes.InternalError,
				localize('agentHost.changeset.rollbackTurn.cancelled', "Rollback was cancelled."),
			);
		}
	}
}
