/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';

export const ISearchScopeService = createDecorator<ISearchScopeService>('searchScopeService');

/**
 * Narrows workspace-wide search to the part of the workspace the user is
 * actually working in.
 *
 * Most windows have no such notion: every workspace folder is equally in play,
 * the scope stays unset, and search behaves exactly as upstream. The Agents
 * window is the exception. It mounts one folder per visible session, and
 * several of those are typically different checkouts of the *same* repository.
 * Sibling checkouts are not nested inside one another, so nothing dedupes
 * them — a workspace-wide search would return every match once per branch.
 *
 * The window that knows which checkout the user is looking at pushes it here,
 * the same way it supplies the terminal's default cwd.
 */
export interface ISearchScopeService {
	readonly _serviceBrand: undefined;

	/**
	 * The folders search should cover by default, or `undefined` when the
	 * whole workspace should be searched.
	 */
	readonly scopedFolders: readonly URI[] | undefined;

	/** Sets {@link scopedFolders}. Pass `undefined` to search the whole workspace again. */
	setScopedFolders(folders: readonly URI[] | undefined): void;

	/**
	 * The workspace folders to search, given the full set.
	 *
	 * Returns every folder when no scope is set, or when the scope names
	 * nothing currently mounted — a scope that matches no folder is stale
	 * rather than a reason to search nothing.
	 */
	resolveSearchFolders(allFolders: readonly IWorkspaceFolder[]): readonly IWorkspaceFolder[];
}

export class SearchScopeService implements ISearchScopeService {
	declare readonly _serviceBrand: undefined;

	private _scopedFolders: readonly URI[] | undefined;

	get scopedFolders(): readonly URI[] | undefined {
		return this._scopedFolders;
	}

	setScopedFolders(folders: readonly URI[] | undefined): void {
		this._scopedFolders = folders?.length ? folders : undefined;
	}

	resolveSearchFolders(allFolders: readonly IWorkspaceFolder[]): readonly IWorkspaceFolder[] {
		const scoped = this._scopedFolders;
		if (!scoped) {
			return allFolders;
		}
		const keys = new Set(scoped.map(uri => uri.toString()));
		const matched = allFolders.filter(folder => keys.has(folder.uri.toString()));
		return matched.length ? matched : allFolders;
	}
}
