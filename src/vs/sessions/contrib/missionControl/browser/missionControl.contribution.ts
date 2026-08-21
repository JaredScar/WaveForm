/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize2 } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import {
	Extensions as ViewContainerExtensions,
	IViewContainersRegistry,
	IViewsRegistry,
	ViewContainerLocation,
	WindowEnablement,
} from '../../../../workbench/common/views.js';
import { ViewPaneContainer } from '../../../../workbench/browser/parts/views/viewPaneContainer.js';
import { MissionControlViewPane } from './missionControlView.js';

export const MISSION_CONTROL_VIEW_CONTAINER_ID = 'sessions.missionControl';
export const MISSION_CONTROL_VIEW_ID = 'sessions.missionControl.view';

const missionControlIcon = registerIcon(
	'mission-control-view-icon',
	Codicon.pulse,
	localize2('missionControlViewIcon', 'View icon for the Mission Control view.').value,
);

const viewContainersRegistry = Registry.as<IViewContainersRegistry>(
	ViewContainerExtensions.ViewContainersRegistry,
);

/**
 * Registers Mission Control as an auxiliary-bar view container in the Sessions
 * window — the same pattern used by the Changes and Files panels.
 *
 * The container is always visible (`hideIfEmpty: false`) so it does not
 * disappear when there are no sessions yet; the view renders its own empty
 * state placeholder instead.
 */
const missionControlContainer = viewContainersRegistry.registerViewContainer(
	{
		id: MISSION_CONTROL_VIEW_CONTAINER_ID,
		title: localize2('missionControl', 'Mission Control'),
		icon: missionControlIcon,
		order: 30,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [
			MISSION_CONTROL_VIEW_CONTAINER_ID,
			{ mergeViewWithContainerWhenSingleView: true },
		]),
		storageId: MISSION_CONTROL_VIEW_CONTAINER_ID,
		hideIfEmpty: false,
		openCommandActionDescriptor: {
			id: MISSION_CONTROL_VIEW_CONTAINER_ID,
			mnemonicTitle: localize2('missionControl.openCommand', 'Mission &&Control').value,
			order: 30,
		},
		windowEnablement: WindowEnablement.Sessions,
	},
	ViewContainerLocation.AuxiliaryBar,
);

const viewsRegistry = Registry.as<IViewsRegistry>(ViewContainerExtensions.ViewsRegistry);

viewsRegistry.registerViews(
	[
		{
			id: MISSION_CONTROL_VIEW_ID,
			name: localize2('missionControl', 'Mission Control'),
			containerIcon: missionControlIcon,
			ctorDescriptor: new SyncDescriptor(MissionControlViewPane),
			canToggleVisibility: false,
			canMoveView: false,
			weight: 100,
			order: 1,
			windowEnablement: WindowEnablement.Sessions,
		},
	],
	missionControlContainer,
);
