/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import 'vs/workbench/browser/parts/editor/editor.contribution';
import { IThemeService, registerThemingParticipant } from 'vs/platform/theme/common/themeService';
import { Part } from 'vs/workbench/browser/part';
import { Dimension, isAncestor, toggleClass, addClass, clearNode } from 'vs/base/browser/dom';
import { Event, Emitter, once } from 'vs/base/common/event';
import { contrastBorder, editorBackground } from 'vs/platform/theme/common/colorRegistry';
import { INextEditorGroupsService, GroupDirection, IAddGroupOptions, GroupsArrangement, GroupOrientation, IMergeGroupOptions, MergeGroupMode, ICopyEditorOptions, GroupsOrder, GroupChangeKind, GroupLocation, IFindGroupScope } from 'vs/workbench/services/group/common/nextEditorGroupsService';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { Direction, SerializableGrid, Sizing, ISerializedGrid, Orientation, ISerializedNode, GridBranchNode, isGridBranchNode, GridNode } from 'vs/base/browser/ui/grid/grid';
import { GroupIdentifier, IWorkbenchEditorConfiguration } from 'vs/workbench/common/editor';
import { values } from 'vs/base/common/map';
import { EDITOR_GROUP_BORDER } from 'vs/workbench/common/theme';
import { distinct } from 'vs/base/common/arrays';
import { INextEditorGroupsAccessor, INextEditorGroupView, INextEditorPartOptions, getEditorPartOptions, impactsEditorPartOptions, INextEditorPartOptionsChangeEvent, EDITOR_MAX_DIMENSIONS, EDITOR_MIN_DIMENSIONS } from 'vs/workbench/browser/parts/editor2/editor2';
import { NextEditorGroupView } from 'vs/workbench/browser/parts/editor2/nextEditorGroupView';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IDisposable, dispose, toDisposable } from 'vs/base/common/lifecycle';
import { assign } from 'vs/base/common/objects';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { Scope } from 'vs/workbench/common/memento';
import { ISerializedEditorGroup, isSerializedEditorGroup } from 'vs/workbench/common/editor/editorGroup';
import { TValueCallback, TPromise } from 'vs/base/common/winjs.base';
import { always } from 'vs/base/common/async';
import { GroupOrientation as LegacyGroupOrientation } from 'vs/workbench/services/group/common/groupService';
import { INotificationService, Severity } from 'vs/platform/notification/common/notification';
import { IWindowService } from 'vs/platform/windows/common/windows';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { NextEditorDropTarget } from 'vs/workbench/browser/parts/editor2/nextEditorDropTarget';
import { localize } from 'vs/nls';

// TODO@grid enable minimized/maximized groups in one dimension
// - doCreateGroupView(): needs listener if the view gets minimized, the previous active group should become active
// - doSetGroupActive():  needs a listener if the group is minimized, it should now restore to be maximized

interface INextEditorPartUIState {
	serializedGrid: ISerializedGrid;
	activeGroup: GroupIdentifier;
	mostRecentActiveGroups: GroupIdentifier[];
}

export class NextEditorPart extends Part implements INextEditorGroupsService, INextEditorGroupsAccessor {

	_serviceBrand: any;

	private static readonly NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY = 'nexteditorpart.uiState';

	//#region Events

	private _onDidLayout: Emitter<Dimension> = this._register(new Emitter<Dimension>());
	get onDidLayout(): Event<Dimension> { return this._onDidLayout.event; }

	private _onDidActiveGroupChange: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidActiveGroupChange(): Event<INextEditorGroupView> { return this._onDidActiveGroupChange.event; }

	private _onDidAddGroup: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidAddGroup(): Event<INextEditorGroupView> { return this._onDidAddGroup.event; }

	private _onDidRemoveGroup: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidRemoveGroup(): Event<INextEditorGroupView> { return this._onDidRemoveGroup.event; }

	private _onDidMoveGroup: Emitter<INextEditorGroupView> = this._register(new Emitter<INextEditorGroupView>());
	get onDidMoveGroup(): Event<INextEditorGroupView> { return this._onDidMoveGroup.event; }

	private _onDidPreferredSizeChange: Emitter<void> = this._register(new Emitter<void>());
	get onDidPreferredSizeChange(): Event<void> { return this._onDidPreferredSizeChange.event; }

	//#endregion

	private dimension: Dimension;
	private _preferredSize: Dimension;

	private memento: object;
	private _partOptions: INextEditorPartOptions;

	private _activeGroup: INextEditorGroupView;
	private groupViews: Map<GroupIdentifier, INextEditorGroupView> = new Map<GroupIdentifier, INextEditorGroupView>();
	private mostRecentActiveGroups: GroupIdentifier[] = [];

	private container: HTMLElement;
	private gridWidget: SerializableGrid<INextEditorGroupView>;

	private _whenRestored: TPromise<void>;
	private whenRestoredComplete: TValueCallback<void>;

	constructor(
		id: string,
		private restorePreviousState: boolean,
		@IInstantiationService private instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IStorageService private storageService: IStorageService,
		@INotificationService private notificationService: INotificationService,
		@IWindowService private windowService: IWindowService,
		@ILifecycleService private lifecycleService: ILifecycleService
	) {
		super(id, { hasTitle: false }, themeService);

		this._partOptions = getEditorPartOptions(this.configurationService.getValue<IWorkbenchEditorConfiguration>());
		this.memento = this.getMemento(this.storageService, Scope.WORKSPACE);

		this._whenRestored = new TPromise(resolve => {
			this.whenRestoredComplete = resolve;
		});

		this.registerListeners();
	}

	//#region IEditorPartOptions

	private enforcedPartOptions: INextEditorPartOptions[] = [];

	private _onDidEditorPartOptionsChange: Emitter<INextEditorPartOptionsChangeEvent> = this._register(new Emitter<INextEditorPartOptionsChangeEvent>());
	get onDidEditorPartOptionsChange(): Event<INextEditorPartOptionsChangeEvent> { return this._onDidEditorPartOptionsChange.event; }

	private registerListeners(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(e)));
	}

	private onConfigurationUpdated(event: IConfigurationChangeEvent): void {
		if (impactsEditorPartOptions(event)) {
			this.handleChangedPartOptions();
		}
	}

	private handleChangedPartOptions(): void {
		const oldPartOptions = this._partOptions;
		const newPartOptions = getEditorPartOptions(this.configurationService.getValue<IWorkbenchEditorConfiguration>());

		this.enforcedPartOptions.forEach(enforcedPartOptions => {
			assign(newPartOptions, enforcedPartOptions); // check for overrides
		});

		this._partOptions = newPartOptions;

		this._onDidEditorPartOptionsChange.fire({ oldPartOptions, newPartOptions });
	}

	get partOptions(): INextEditorPartOptions {
		return this._partOptions;
	}

	enforcePartOptions(options: INextEditorPartOptions): IDisposable {
		this.enforcedPartOptions.push(options);
		this.handleChangedPartOptions();

		return toDisposable(() => {
			this.enforcedPartOptions.splice(this.enforcedPartOptions.indexOf(options), 1);
			this.handleChangedPartOptions();
		});
	}

	//#endregion

	//#region INextEditorGroupsService

	get activeGroup(): INextEditorGroupView {
		return this._activeGroup;
	}

	get groups(): INextEditorGroupView[] {
		return values(this.groupViews);
	}

	get count(): number {
		return this.groupViews.size;
	}

	get orientation(): GroupOrientation {
		if (!this.gridWidget) {
			return void 0; // we have not been created yet
		}

		return this.gridWidget.orientation === Orientation.VERTICAL ? GroupOrientation.VERTICAL : GroupOrientation.HORIZONTAL;
	}

	get whenRestored(): TPromise<void> {
		return this._whenRestored;
	}

	getGroups(order = GroupsOrder.CREATION_TIME): INextEditorGroupView[] {
		switch (order) {
			case GroupsOrder.CREATION_TIME:
				return this.groups;

			case GroupsOrder.MOST_RECENTLY_ACTIVE:
				const mostRecentActive = this.mostRecentActiveGroups.map(groupId => this.getGroup(groupId));

				// there can be groups that got never active, even though they exist. in this case
				// make sure to ust append them at the end so that all groups are returned properly
				return distinct([...mostRecentActive, ...this.groups]);

			case GroupsOrder.GRID_APPEARANCE:
				const views: INextEditorGroupView[] = [];
				if (this.gridWidget) {
					this.fillGridNodes(views, this.gridWidget.getViews());
				}

				return views;
		}
	}

	private fillGridNodes(target: INextEditorGroupView[], node: GridBranchNode<INextEditorGroupView> | GridNode<INextEditorGroupView>): void {
		if (isGridBranchNode(node)) {
			node.children.forEach(child => this.fillGridNodes(target, child));
		} else {
			target.push(node.view);
		}
	}

	getGroup(identifier: GroupIdentifier): INextEditorGroupView {
		return this.groupViews.get(identifier);
	}

	findGroup(scope: IFindGroupScope, source: INextEditorGroupView | GroupIdentifier = this.activeGroup): INextEditorGroupView {

		// by direction
		if (typeof scope.direction === 'number') {
			return this.doFindGroupByDirection(scope.direction, source);
		}

		// by location
		return this.doFindGroupByLocation(scope.location, source);
	}

	private doFindGroupByDirection(direction: GroupDirection, source: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		const sourceGroupView = this.assertGroupView(source);
		const groups = this.getGroups(GroupsOrder.GRID_APPEARANCE);
		const index = groups.indexOf(sourceGroupView);

		const neighbourGroupView = groups[direction === GroupDirection.RIGHT || direction === GroupDirection.DOWN ? index + 1 : index - 1];
		if (neighbourGroupView && this.gridWidget.getOrientation(neighbourGroupView) === this.gridWidget.getOrientation(sourceGroupView)) {
			return neighbourGroupView; // TODO@grid finding neighbour needs gridwidget support
		}

		return void 0;
	}

	private doFindGroupByLocation(location: GroupLocation, source: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		const sourceGroupView = this.assertGroupView(source);
		const groups = this.getGroups(GroupsOrder.CREATION_TIME);
		const index = groups.indexOf(sourceGroupView);

		switch (location) {
			case GroupLocation.FIRST:
				return groups[0];
			case GroupLocation.LAST:
				return groups[groups.length - 1];
			case GroupLocation.NEXT:
				return groups[index + 1];
			case GroupLocation.PREVIOUS:
				return groups[index - 1];
		}
	}

	activateGroup(group: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		const groupView = this.assertGroupView(group);
		this.doSetGroupActive(groupView);

		return groupView;
	}

	focusGroup(group: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		const groupView = this.assertGroupView(group);

		// Activate and focus group
		this.doSetGroupActive(groupView);
		groupView.focus();

		return groupView;
	}

	resizeGroup(group: INextEditorGroupView | GroupIdentifier, sizeDelta: number): INextEditorGroupView {
		const groupView = this.assertGroupView(group);
		const currentSize = this.gridWidget.getViewSize(groupView);

		this.gridWidget.resizeView(groupView, currentSize + sizeDelta);

		return groupView;
	}

	arrangeGroups(arrangement: GroupsArrangement): void {
		if (this.count < 2) {
			return; // require at least 2 groups to show
		}

		if (!this.gridWidget) {
			return; // we have not been created yet
		}

		// Even all group sizes
		if (arrangement === GroupsArrangement.EVEN) {
			this.groups.forEach(group => {
				this.gridWidget.resetViewSize(group);
			});
		}

		// Maximize the current active group
		else {
			this.groups.forEach(group => {
				const orientation = this.gridWidget.getOrientation(group);

				let newSize: number;
				if (this.activeGroup === group) {
					newSize = orientation === Orientation.HORIZONTAL ? EDITOR_MAX_DIMENSIONS.width : EDITOR_MAX_DIMENSIONS.height;
				} else {
					newSize = orientation === Orientation.HORIZONTAL ? EDITOR_MIN_DIMENSIONS.width : EDITOR_MIN_DIMENSIONS.height;
				}

				this.gridWidget.resizeView(group, newSize);
			});
		}
	}

	setGroupOrientation(orientation: GroupOrientation): void {
		if (!this.gridWidget) {
			return; // we have not been created yet
		}

		const newOrientation = (orientation === GroupOrientation.HORIZONTAL) ? Orientation.HORIZONTAL : Orientation.VERTICAL;
		if (this.gridWidget.orientation !== newOrientation) {
			this.gridWidget.orientation = newOrientation;

			// Mark preferred size as changed
			this.resetPreferredSize();
		}
	}

	addGroup(location: INextEditorGroupView | GroupIdentifier, direction: GroupDirection, options?: IAddGroupOptions): INextEditorGroupView {
		const locationView = this.assertGroupView(location);

		const group = this.doAddGroup(locationView, direction);

		if (options && options.activate) {
			this.doSetGroupActive(group);
		}

		return group;
	}

	private doAddGroup(locationView: INextEditorGroupView, direction: GroupDirection, groupToCopy?: INextEditorGroupView): INextEditorGroupView {
		const newGroupView = this.doCreateGroupView(groupToCopy);

		// Add to grid widget
		this.gridWidget.addView(
			newGroupView,
			Sizing.Distribute,
			locationView,
			this.toGridViewDirection(direction),
		);

		// Update container
		this.updateContainer();

		// Mark preferred size as changed
		this.resetPreferredSize();

		// Event
		this._onDidAddGroup.fire(newGroupView);

		return newGroupView;
	}

	private doCreateGroupView(from?: INextEditorGroupView | ISerializedEditorGroup): INextEditorGroupView {

		// Label: just use the number of existing groups as label
		const label = this.getGroupLabel(this.count + 1);

		// Create group view
		let groupView: INextEditorGroupView;
		if (from instanceof NextEditorGroupView) {
			groupView = NextEditorGroupView.createCopy(from, this, label, this.instantiationService);
		} else if (isSerializedEditorGroup(from)) {
			groupView = NextEditorGroupView.createFromSerialized(from, this, label, this.instantiationService);
		} else {
			groupView = NextEditorGroupView.createNew(this, label, this.instantiationService);
		}

		// Keep in map
		this.groupViews.set(groupView.id, groupView);

		// Track focus
		let groupDisposables: IDisposable[] = [];
		groupDisposables.push(groupView.onDidFocus(() => {
			this.doSetGroupActive(groupView);
		}));

		// Track editor change
		groupDisposables.push(groupView.onDidGroupChange(e => {
			if (e.kind === GroupChangeKind.EDITOR_ACTIVE) {
				this.updateContainer();
			}
		}));

		// Track dispose
		once(groupView.onWillDispose)(() => {
			groupDisposables = dispose(groupDisposables);
			this.groupViews.delete(groupView.id);
			this.doUpdateMostRecentActive(groupView);
		});

		return groupView;
	}

	private doSetGroupActive(group: INextEditorGroupView): void {
		if (this._activeGroup === group) {
			return; // return if this is already the active group
		}

		const previousActiveGroup = this._activeGroup;
		this._activeGroup = group;

		// Update list of most recently active groups
		this.doUpdateMostRecentActive(group, true);

		// Mark previous one as inactive
		if (previousActiveGroup) {
			previousActiveGroup.setActive(false);
		}

		// Mark group as new active
		group.setActive(true);

		// Event
		this._onDidActiveGroupChange.fire(group);
	}

	private doUpdateMostRecentActive(group: INextEditorGroupView, makeMostRecentlyActive?: boolean): void {
		const index = this.mostRecentActiveGroups.indexOf(group.id);

		// Remove from MRU list
		if (index !== -1) {
			this.mostRecentActiveGroups.splice(index, 1);
		}

		// Add to front as needed
		if (makeMostRecentlyActive) {
			this.mostRecentActiveGroups.unshift(group.id);
		}
	}

	private toGridViewDirection(direction: GroupDirection): Direction {
		switch (direction) {
			case GroupDirection.UP: return Direction.Up;
			case GroupDirection.DOWN: return Direction.Down;
			case GroupDirection.LEFT: return Direction.Left;
			case GroupDirection.RIGHT: return Direction.Right;
		}
	}

	removeGroup(group: INextEditorGroupView | GroupIdentifier): void {
		const groupView = this.assertGroupView(group);
		if (this.groupViews.size === 1) {
			return; // Cannot remove the last root group
		}

		// Remove empty group
		if (groupView.isEmpty()) {
			return this.doRemoveEmptyGroup(groupView);
		}

		// Remove group with editors
		this.doRemoveGroupWithEditors(groupView);
	}

	private doRemoveGroupWithEditors(groupView: INextEditorGroupView): void {
		const mostRecentlyActiveGroups = this.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);

		let lastActiveGroup: INextEditorGroupView;
		if (this._activeGroup === groupView) {
			lastActiveGroup = mostRecentlyActiveGroups[1];
		} else {
			lastActiveGroup = mostRecentlyActiveGroups[0];
		}

		// Removing a group with editors should merge these editors into the
		// last active group and then remove this group.
		this.mergeGroup(groupView, lastActiveGroup);
	}

	private doRemoveEmptyGroup(groupView: INextEditorGroupView): void {
		const groupHasFocus = isAncestor(document.activeElement, groupView.element);

		// Activate next group if the removed one was active
		if (this._activeGroup === groupView) {
			const mostRecentlyActiveGroups = this.getGroups(GroupsOrder.MOST_RECENTLY_ACTIVE);
			const nextActiveGroup = mostRecentlyActiveGroups[1]; // [0] will be the current group we are about to dispose
			this.activateGroup(nextActiveGroup);
		}

		// Remove from grid widget & dispose
		this.gridWidget.removeView(groupView, Sizing.Distribute);
		groupView.dispose();

		// Restore focus if we had it previously (we run this after gridWidget.removeView() is called
		// because removing a view can mean to reparent it and thus focus would be removed otherwise)
		if (groupHasFocus) {
			this.focusGroup(this._activeGroup);
		}

		// Update labels: since our labels are created using the index of the
		// group, removing a group might produce gaps. So we iterate over all
		// groups and reassign the label based on the index.
		this.getGroups(GroupsOrder.CREATION_TIME).forEach((group, index) => {
			group.setLabel(this.getGroupLabel(index + 1));
		});

		// Update container
		this.updateContainer();

		// Mark preferred size as changed
		this.resetPreferredSize();

		// Event
		this._onDidRemoveGroup.fire(groupView);
	}

	private getGroupLabel(index: number): string {
		return localize('groupLabel', "Group {0}", index);
	}

	moveGroup(group: INextEditorGroupView | GroupIdentifier, location: INextEditorGroupView | GroupIdentifier, direction: GroupDirection): INextEditorGroupView {
		const sourceView = this.assertGroupView(group);
		const targetView = this.assertGroupView(location);

		if (sourceView.id === targetView.id) {
			throw new Error('Cannot move group into its own');
		}

		const groupHasFocus = isAncestor(document.activeElement, sourceView.element);

		// Move is a simple remove and add of the same view
		this.gridWidget.removeView(sourceView, Sizing.Distribute);
		this.gridWidget.addView(sourceView, Sizing.Distribute, targetView, this.toGridViewDirection(direction));

		// Restore focus if we had it previously (we run this after gridWidget.removeView() is called
		// because removing a view can mean to reparent it and thus focus would be removed otherwise)
		if (groupHasFocus) {
			this.focusGroup(sourceView);
		}

		// Event
		this._onDidMoveGroup.fire(sourceView);

		return sourceView;
	}

	copyGroup(group: INextEditorGroupView | GroupIdentifier, location: INextEditorGroupView | GroupIdentifier, direction: GroupDirection): INextEditorGroupView {
		const groupView = this.assertGroupView(group);
		const locationView = this.assertGroupView(location);

		const groupHasFocus = isAncestor(document.activeElement, groupView.element);

		// Copy the group view
		const copiedGroupView = this.doAddGroup(locationView, direction, groupView);

		// Restore focus if we had it
		if (groupHasFocus) {
			this.focusGroup(copiedGroupView);
		}

		return copiedGroupView;
	}

	mergeGroup(group: INextEditorGroupView | GroupIdentifier, target: INextEditorGroupView | GroupIdentifier, options?: IMergeGroupOptions): INextEditorGroupView {
		const sourceView = this.assertGroupView(group);
		const targetView = this.assertGroupView(target);

		// Move/Copy editors over into target
		let index = targetView.count;
		sourceView.editors.forEach(editor => {
			const inactive = sourceView.activeEditor !== editor;
			const copyOptions: ICopyEditorOptions = { index, inactive, preserveFocus: inactive };

			if (options && options.mode === MergeGroupMode.COPY_EDITORS) {
				sourceView.copyEditor(editor, targetView, copyOptions);
			} else {
				sourceView.moveEditor(editor, targetView, copyOptions);
			}

			index++;
		});

		// Remove source if the view is now empty and not already removed
		if (sourceView.isEmpty() && !sourceView.disposed /* could have been disposed already via workbench.editor.closeEmptyGroups setting */) {
			this.removeGroup(sourceView);
		}

		return targetView;
	}

	private assertGroupView(group: INextEditorGroupView | GroupIdentifier): INextEditorGroupView {
		if (typeof group === 'number') {
			group = this.getGroup(group);
		}

		if (!group) {
			throw new Error('Invalid editor group provided!');
		}

		return group;
	}

	//#endregion

	//#region Part

	get preferredSize(): Dimension {
		if (!this._preferredSize) {
			let horizontalViews = 0;
			let verticalViews = 0;

			// TODO@grid this needs better support from the GridWidget to be correct for more complex layouts
			this.groupViews.forEach(groupView => {
				if (this.gridWidget.getOrientation(groupView) === Orientation.HORIZONTAL) {
					horizontalViews++;
				} else {
					verticalViews++;
				}
			});

			this._preferredSize = new Dimension(Math.max(horizontalViews, 1) * EDITOR_MIN_DIMENSIONS.width, Math.max(verticalViews) * EDITOR_MIN_DIMENSIONS.height);
		}

		return this._preferredSize;
	}

	private resetPreferredSize(): void {

		// Reset (will be computed upon next access)
		this._preferredSize = void 0;

		// Event
		this._onDidPreferredSizeChange.fire();
	}

	protected updateStyles(): void {
		this.container.style.backgroundColor = this.getColor(editorBackground);
	}

	createContentArea(parent: HTMLElement): HTMLElement {

		// Container
		this.container = document.createElement('div');
		addClass(this.container, 'content');
		parent.appendChild(this.container);

		// Grid control
		this.doCreateGridControl(this.container);

		// Drop support
		this._register(this.instantiationService.createInstance(NextEditorDropTarget, this, this.container));

		return this.container;
	}

	private doCreateGridControl(container: HTMLElement): void {

		// Grid Widget (with previous UI state)
		if (this.restorePreviousState) {
			try {
				this.doCreateGridControlWithPreviousState(container);
			} catch (error) { // TODO@grid remove this safe guard once the grid is stable
				if (this.gridWidget) {
					this.gridWidget.dispose();
					this.gridWidget = void 0;
				}

				clearNode(container);
				this.groupViews.forEach(group => group.dispose());
				this.groupViews.clear();
				this._activeGroup = void 0;
				this.mostRecentActiveGroups = [];

				this.gridError(error);
			}
		}

		// Grid Widget (no previous UI state or failed to restore)
		if (!this.gridWidget) {
			const initialGroup = this.doCreateGroupView();
			this.gridWidget = this._register(new SerializableGrid(container, initialGroup));

			// Ensure a group is active
			this.doSetGroupActive(initialGroup);
		}

		// Signal restored
		always(TPromise.join(this.groups.map(group => group.whenRestored)), () => this.whenRestoredComplete(void 0));

		// Update container
		this.updateContainer();
	}

	private doCreateGridControlWithPreviousState(container: HTMLElement): void {
		const uiState = this.doGetPreviousState();
		if (uiState && uiState.serializedGrid) {

			// MRU
			this.mostRecentActiveGroups = uiState.mostRecentActiveGroups;

			// Grid Widget
			this.gridWidget = this._register(SerializableGrid.deserialize(container, uiState.serializedGrid, {
				fromJSON: (serializedEditorGroup: ISerializedEditorGroup) => {
					const groupView = this.doCreateGroupView(serializedEditorGroup);
					if (groupView.id === uiState.activeGroup) {
						this.doSetGroupActive(groupView);
					}

					return groupView;
				}
			}));

			// Ensure last active group has focus
			this._activeGroup.focus();
		}
	}

	private doGetPreviousState(): INextEditorPartUIState {
		const legacyState = this.doGetPreviousLegacyState();
		if (legacyState) {
			return legacyState; // TODO@ben remove after a while
		}

		return this.memento[NextEditorPart.NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY] as INextEditorPartUIState;
	}

	private doGetPreviousLegacyState(): INextEditorPartUIState {
		const LEGACY_EDITOR_PART_UI_STATE_STORAGE_KEY = 'editorpart.uiState';
		const LEGACY_STACKS_MODEL_STORAGE_KEY = 'editorStacks.model';

		interface ILegacyEditorPartUIState {
			ratio: number[];
			groupOrientation: LegacyGroupOrientation;
		}

		interface ISerializedLegacyEditorStacksModel {
			groups: ISerializedEditorGroup[];
			active: number;
		}

		let legacyUIState: ISerializedLegacyEditorStacksModel;
		const legacyUIStateRaw = this.storageService.get(LEGACY_STACKS_MODEL_STORAGE_KEY, StorageScope.WORKSPACE);
		if (legacyUIStateRaw) {
			try {
				legacyUIState = JSON.parse(legacyUIStateRaw);
			} catch (error) { /* ignore */ }
		}

		if (legacyUIState) {
			this.storageService.remove(LEGACY_STACKS_MODEL_STORAGE_KEY, StorageScope.WORKSPACE);
		}

		const legacyPartState = this.memento[LEGACY_EDITOR_PART_UI_STATE_STORAGE_KEY] as ILegacyEditorPartUIState;
		if (legacyPartState) {
			delete this.memento[LEGACY_EDITOR_PART_UI_STATE_STORAGE_KEY];
		}

		if (legacyUIState && Array.isArray(legacyUIState.groups) && legacyUIState.groups.length > 0) {
			const splitHorizontally = legacyPartState && legacyPartState.groupOrientation === 'horizontal';

			const legacyState: INextEditorPartUIState = Object.create(null);

			const positionOneGroup = legacyUIState.groups[0];
			const positionTwoGroup = legacyUIState.groups[1];
			const positionThreeGroup = legacyUIState.groups[2];

			legacyState.activeGroup = legacyUIState.active;
			legacyState.mostRecentActiveGroups = [legacyUIState.active];

			if (positionTwoGroup || positionThreeGroup) {
				if (!positionThreeGroup) {
					legacyState.mostRecentActiveGroups.push(legacyState.activeGroup === 0 ? 1 : 0);
				} else {
					if (legacyState.activeGroup === 0) {
						legacyState.mostRecentActiveGroups.push(1, 2);
					} else if (legacyState.activeGroup === 1) {
						legacyState.mostRecentActiveGroups.push(0, 2);
					} else {
						legacyState.mostRecentActiveGroups.push(0, 1);
					}
				}
			}

			const toNode = function (group: ISerializedEditorGroup, size: number): ISerializedNode {
				return {
					data: group,
					size,
					type: 'leaf'
				};
			};

			const baseSize = 1200; // just some number because layout() was not called yet, but we only need the proportions

			// No split editor
			if (!positionTwoGroup) {
				legacyState.serializedGrid = {
					width: baseSize,
					height: baseSize,
					orientation: splitHorizontally ? Orientation.VERTICAL : Orientation.HORIZONTAL,
					root: toNode(positionOneGroup, baseSize)
				};
			}

			// Split editor (2 or 3 columns)
			else {
				const children: ISerializedNode[] = [];

				const size = positionThreeGroup ? baseSize / 3 : baseSize / 2;

				children.push(toNode(positionOneGroup, size));
				children.push(toNode(positionTwoGroup, size));

				if (positionThreeGroup) {
					children.push(toNode(positionThreeGroup, size));
				}

				legacyState.serializedGrid = {
					width: baseSize,
					height: baseSize,
					orientation: splitHorizontally ? Orientation.VERTICAL : Orientation.HORIZONTAL,
					root: {
						data: children,
						size: baseSize,
						type: 'branch'
					}
				};
			}

			return legacyState;
		}

		return void 0;
	}

	private updateContainer(): void {
		toggleClass(this.container, 'empty', this.isEmpty());
	}

	private isEmpty(): boolean {
		return this.groupViews.size === 1 && this._activeGroup.isEmpty();
	}

	// TODO@grid this should be removed once the gridwidget is stable
	private gridError(error: Error): void {
		console.error(error);

		this.lifecycleService.when(LifecyclePhase.Running).then(() => {
			this.notificationService.prompt(Severity.Error, `Grid Issue: ${error}. Please report this error stack with reproducible steps.`, [{ label: 'Open DevTools', run: () => this.windowService.openDevTools() }]);
		});
	}

	layout(dimension: Dimension): Dimension[] {
		const sizes = super.layout(dimension);

		this.dimension = sizes[1];

		// Layout Grid
		try {
			this.gridWidget.layout(this.dimension.width, this.dimension.height);
		} catch (error) {
			this.gridError(error);
		}

		// Event
		this._onDidLayout.fire(dimension);

		return sizes;
	}

	shutdown(): void {

		// Persist grid UI state
		if (this.gridWidget) {
			const uiState: INextEditorPartUIState = {
				serializedGrid: this.gridWidget.serialize(),
				activeGroup: this._activeGroup.id,
				mostRecentActiveGroups: this.mostRecentActiveGroups
			};

			if (this.isEmpty()) {
				delete this.memento[NextEditorPart.NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY];
			} else {
				this.memento[NextEditorPart.NEXT_EDITOR_PART_UI_STATE_STORAGE_KEY] = uiState;
			}
		}

		// Forward to all groups
		this.groupViews.forEach(group => group.shutdown());

		super.shutdown();
	}

	dispose(): void {

		// Forward to all groups
		this.groupViews.forEach(group => group.dispose());
		this.groupViews.clear();

		super.dispose();
	}

	//#endregion
}

// Group borders (TODO@grid this should be a color the GridView exposes)
registerThemingParticipant((theme, collector) => {
	const groupBorderColor = theme.getColor(EDITOR_GROUP_BORDER) || theme.getColor(contrastBorder);
	if (groupBorderColor) {
		collector.addRule(`
			.monaco-workbench > .part.editor > .content .split-view-view {
				position: relative;
			}

			.monaco-workbench > .part.editor > .content .monaco-grid-view .monaco-split-view2 > .split-view-container > .split-view-view:not(:first-child)::before {
				content: '';
				position: absolute;
				top: 0;
				left: 0;
				z-index: 100;
				pointer-events: none;
				background: ${groupBorderColor}
			}

			.monaco-workbench > .part.editor > .content .monaco-grid-view .monaco-split-view2.horizontal > .split-view-container>.split-view-view:not(:first-child)::before {
				height: 100%;
				width: 1px;
			}

			.monaco-workbench > .part.editor > .content .monaco-grid-view .monaco-split-view2.vertical > .split-view-container > .split-view-view:not(:first-child)::before {
				height: 1px;
				width: 100%;
			}
		`);
	}
});