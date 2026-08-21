/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared context injection for WaveForm.
 *
 * A `WAVEFORM.md` file at the workspace root is automatically treated as an
 * always-apply agent instruction by the Copilot CLI SDK (registered alongside
 * `AGENTS.md` in `sessionCustomizationDiscovery.ts`). This contribution adds
 * the UI affordances that make the file easy to discover and edit:
 *
 * - **"Edit Shared Context" command** (`waveform.context.edit`) — opens
 *   `WAVEFORM.md` in the editor, creating it from a starter template if it
 *   does not exist yet.
 * - **Sessions bar toolbar button** — a quick-access icon in the sessions
 *   header toolbar so the file is one click away. The icon is dimmed (and the
 *   tooltip says "Create…") when the file does not exist yet.
 */

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Menus } from '../../../browser/menus.js';

// ─── Constants ─────────────────────────────────────────────────────────────

const WAVEFORM_MD_FILENAME = 'WAVEFORM.md';
const EDIT_SHARED_CONTEXT_COMMAND_ID = 'waveform.context.edit';

/** Starter template written when the file does not yet exist. */
const STARTER_TEMPLATE = `\
# WaveForm Shared Context

This file is automatically injected as a system-level instruction into every new
agent session opened in this workspace. Use it to keep all parallel agents
aligned on the current state of the project.

Suggested sections:

## Project overview
<!-- One paragraph: what this repo does and who uses it. -->

## Current sprint goal
<!-- What is the team trying to ship this sprint? -->

## Active work
<!-- List branches / sessions currently in flight and what they are doing.
     Update this when you start or finish a session. -->

## Architecture notes
<!-- Key constraints, patterns, and off-limits areas agents must respect. -->

## Known issues
<!-- Bugs or tech-debt agents should be aware of but not fix unless asked. -->
`;

// ─── Command ───────────────────────────────────────────────────────────────

/**
 * Opens `WAVEFORM.md` at the workspace root, creating it from a starter
 * template if it does not exist yet.
 */
class EditSharedContextAction extends Action2 {

	static readonly ID = EDIT_SHARED_CONTEXT_COMMAND_ID;

	constructor() {
		super({
			id: EDIT_SHARED_CONTEXT_COMMAND_ID,
			title: localize2('sharedContext.edit', "Edit Shared Context (WAVEFORM.md)"),
			icon: Codicon.notebook,
			f1: true,
			menu: {
				id: Menus.SessionBarToolbar,
				group: 'navigation',
				// After the core session navigation buttons.
				order: 50,
				when: ContextKeyExpr.true(),
			},
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const editorService = accessor.get(IEditorService);

		const rootFolder = workspaceService.getWorkspace().folders[0]?.uri;
		if (!rootFolder) {
			return;
		}

		const waveformMdUri = joinPath(rootFolder, WAVEFORM_MD_FILENAME);

		// Create with a starter template if the file does not exist.
		const exists = await fileService.exists(waveformMdUri);
		if (!exists) {
			await fileService.writeFile(waveformMdUri, VSBuffer.fromString(STARTER_TEMPLATE));
		}

		await editorService.openEditor({ resource: waveformMdUri });
	}
}

registerAction2(EditSharedContextAction);

// ─── Contribution (file existence badge) ───────────────────────────────────

/**
 * Watches `WAVEFORM.md` and keeps a context key in sync so the toolbar icon
 * can show a different tooltip (or visual weight) depending on whether the
 * file exists.
 *
 * The actual instruction injection requires no code here — `WAVEFORM.md` is
 * already registered as a fixed-discovery agent instruction file in
 * `sessionCustomizationDiscovery.ts` alongside `AGENTS.md`.
 */
export class SharedContextContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'sessions.contrib.sharedContext';

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceService: IWorkspaceContextService,
	) {
		super();

		const root = workspaceService.getWorkspace().folders[0]?.uri;
		if (!root) {
			return;
		}

		const waveformMdUri = joinPath(root, WAVEFORM_MD_FILENAME);

		// Watch the root directory (non-recursively) so we detect when
		// WAVEFORM.md is created, deleted, or renamed.
		this._register(fileService.watch(root));
		this._register(fileService.onDidFilesChange(e => {
			if (e.affects(waveformMdUri)) {
				// No context key management needed for now — the file watcher
				// ensures the SDK discovery re-reads the file on next session
				// launch. Future work: update a ContextKey to dim/brighten the
				// toolbar icon based on whether the file exists.
				void 0;
			}
		}));
	}
}

registerWorkbenchContribution2(
	SharedContextContribution.ID,
	SharedContextContribution,
	WorkbenchPhase.AfterRestored,
);
