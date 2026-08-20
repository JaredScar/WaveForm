/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ISessionsService } from './sessionsService.js';

/**
 * The working directory of the session the user is currently looking at.
 *
 * WaveForm mounts the folders of every visible session at once, so the first
 * workspace folder is no longer a stand-in for the active session — it is
 * simply whichever branch folder was mounted first. Anything that means "the
 * repository behind the session in focus" must resolve it from the active
 * session, which is what this does. The first mounted folder is used only as a
 * fallback for when no session is active.
 *
 * Pass a `reader` from within an observable context to track changes.
 */
export function getActiveSessionFolderUri(
	sessionsService: ISessionsService,
	workspaceContextService: IWorkspaceContextService,
	reader?: IReader,
): URI | undefined {
	const activeSession = reader
		? sessionsService.activeSession.read(reader)
		: sessionsService.activeSession.get();

	const workspace = reader
		? activeSession?.workspace.read(reader)
		: activeSession?.workspace.get();

	return workspace?.folders[0]?.workingDirectory
		?? workspaceContextService.getWorkspace().folders[0]?.uri;
}
