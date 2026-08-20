/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { Severity } from '../../../../platform/notification/common/notification.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IActiveSession } from '../../../services/sessions/common/sessionsManagement.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';

/**
 * A file-path key that is stable across worktrees and clones of the same
 * repository. Two sessions working on different checkouts of `main` will have
 * different absolute URIs for `src/auth.ts`, but the same normalized key.
 *
 * Format: `<repo-root-uri>::<relative-path-within-repo>`.
 */
function normalizedFileKey(fileUri: URI, workingDirectory: URI, repoRoot: URI): string | undefined {
	const rel = extUri.relativePath(workingDirectory, fileUri) ?? extUri.relativePath(repoRoot, fileUri);
	if (!rel) {
		return undefined;
	}
	return `${repoRoot.toString()}::${rel}`;
}

/**
 * Collects the normalized file-path keys for all files changed by a session.
 * Returns a map from normalized key → display basename for use in messages.
 */
function sessionFileKeys(session: IActiveSession): Map<string, string> {
	const workspace = session.workspace.get();
	const folder = workspace?.folders[0];
	if (!folder) {
		return new Map();
	}

	const result = new Map<string, string>();
	const changes = session.changes.get();
	for (const change of changes) {
		const fileUri = isIChatSessionFileChange2(change) ? change.uri : change.modifiedUri;
		if (!fileUri) {
			continue;
		}
		const key = normalizedFileKey(fileUri, folder.workingDirectory, folder.root);
		if (key) {
			result.set(key, basename(fileUri));
		}
	}
	return result;
}

/** A stable, order-independent key for a pair of session IDs. */
function pairKey(idA: string, idB: string): string {
	return idA < idB ? `${idA}::${idB}` : `${idB}::${idA}`;
}

/**
 * Watches all visible agent sessions and notifies the user when two or more
 * sessions are editing the same file.
 *
 * In the single-branch world each session has its own working directory, so
 * concurrent edits are physically separated and the IDE has no way to warn
 * about them. WaveForm mounts all visible sessions at once, which makes cross-
 * session edits detectable for the first time.
 *
 * Why this matters for parallel agents:
 * - Two agents independently fixing `src/auth.ts` will produce divergent changes
 *   that neither knows about. One fix will silently overwrite the other when the
 *   branches are merged.
 * - Early warning lets the user steer one agent away, decompose the task
 *   differently, or decide to let both proceed and merge carefully.
 *
 * Implementation notes:
 * - Notifications are debounced (3 s) to avoid firing while an agent is
 *   actively mid-edit, which would spam a flood of updates.
 * - Each session-pair is notified at most once per "conflict window". The
 *   notified set is cleared whenever the visible session list changes, giving
 *   the user a fresh slate after they restructure their agents.
 * - File keys are normalized to repo-root-relative paths so two checkouts of
 *   the same file on different branches map to the same key.
 */
export class ConflictDetectorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.conflictDetector';

	/** Session pairs for which a conflict notification has already been shown. */
	private _notifiedPairs = new Set<string>();

	/** Pending debounce timer. */
	private readonly _debounce = this._register(new MutableDisposable());

	constructor(
		@ISessionsService private readonly _sessionsService: ISessionsService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();

		this._register(autorun(reader => {
			const visible = this._sessionsService.visibleSessions.read(reader);

			// Read each session's changes inside the reactive scope so the autorun
			// re-fires whenever any session's file set changes.
			const sessions: IActiveSession[] = [];
			for (const s of visible) {
				if (!s) {
					continue;
				}
				// Read to track dependency; actual values are re-read outside the
				// reactive scope when the debounce timer fires.
				s.changes.read(reader);
				s.workspace.read(reader);
				sessions.push(s);
			}

			// A change in the visible session list resets the notified pairs so the
			// user sees fresh warnings after they reorganise their agents.
			this._notifiedPairs = new Set();

			// Debounce: wait for things to settle before comparing file sets.
			// Active agent edits land as rapid successive updates; waiting 3 s
			// avoids firing during mid-turn streaming.
			this._debounce.value = {
				dispose: () => { /* cleared by MutableDisposable */ },
			};

			const currentSessions = sessions.slice();
			timeout(3000).then(() => {
				if (!this._store.isDisposed) {
					this._checkConflicts(currentSessions);
				}
			});
		}));
	}

	private _checkConflicts(sessions: IActiveSession[]): void {
		if (sessions.length < 2) {
			return;
		}

		// Build normalized file sets for each session.
		const fileSets: Array<{ session: IActiveSession; files: Map<string, string> }> = sessions.map(s => ({
			session: s,
			files: sessionFileKeys(s),
		}));

		// Compare every pair.
		for (let i = 0; i < fileSets.length; i++) {
			for (let j = i + 1; j < fileSets.length; j++) {
				const a = fileSets[i];
				const b = fileSets[j];

				const key = pairKey(a.session.sessionId, b.session.sessionId);
				if (this._notifiedPairs.has(key)) {
					continue;
				}

				const overlapping: string[] = [];
				for (const [fileKey, displayName] of a.files) {
					if (b.files.has(fileKey)) {
						overlapping.push(displayName);
					}
				}

				if (overlapping.length === 0) {
					continue;
				}

				this._notifiedPairs.add(key);
				this._notify(a.session, b.session, overlapping);
			}
		}
	}

	private _notify(sessionA: IActiveSession, sessionB: IActiveSession, files: string[]): void {
		const nameA = sessionA.title.get() ?? localize('conflictDetector.unnamed', "unnamed");
		const nameB = sessionB.title.get() ?? localize('conflictDetector.unnamed', "unnamed");

		const fileList = files.slice(0, 5).join(', ');
		const more = files.length > 5 ? localize('conflictDetector.moreFiles', " and {0} more", files.length - 5) : '';

		const message = localize(
			'conflictDetector.conflict',
			"Two agents are editing the same file{0}: {1}{2}. Check \"{3}\" and \"{4}\" to avoid conflicts.",
			files.length > 1 ? 's' : '',
			fileList,
			more,
			nameA,
			nameB,
		);

		this._notificationService.notify({
			severity: Severity.Warning,
			message,
			neverShowAgain: {
				id: 'sessions.conflictDetector.neverShowAgain',
				isSecondary: true,
			},
		});
	}
}

registerWorkbenchContribution2(
	ConflictDetectorContribution.ID,
	ConflictDetectorContribution,
	WorkbenchPhase.AfterRestored,
);
