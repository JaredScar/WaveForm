/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { MULTI_BRANCH_ENABLED_SETTING, MULTI_BRANCH_MAX_FOLDERS_DEFAULT, MULTI_BRANCH_MAX_FOLDERS_SETTING, WorkspaceFolderManagementContribution } from './workspaceFolderManagement.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'waveform',
	title: localize('waveform.multiBranch.title', "WaveForm"),
	properties: {
		[MULTI_BRANCH_ENABLED_SETTING]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('waveform.multiBranch.enabled', "Mount the folders of every session visible in the grid at the same time, so several branches of a repository are reachable from the explorer, search, source control, and terminals concurrently. When disabled, only the active session's folder is mounted."),
		},
		[MULTI_BRANCH_MAX_FOLDERS_SETTING]: {
			type: 'number',
			default: MULTI_BRANCH_MAX_FOLDERS_DEFAULT,
			minimum: 1,
			scope: ConfigurationScope.APPLICATION,
			description: localize('waveform.multiBranch.maxFolders', "Maximum number of branch folders mounted at once. Each mounted folder costs file watchers, a source control repository, and language service work. The active session's folders are always mounted, even beyond this limit."),
		},
	},
});

registerWorkbenchContribution2(WorkspaceFolderManagementContribution.ID, WorkspaceFolderManagementContribution, WorkbenchPhase.AfterRestored);
