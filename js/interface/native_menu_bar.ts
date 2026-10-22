import { ipcRenderer } from '../native_apis';
import { MenuBar } from './menu_bar';
import type { MenuItem, CustomMenuItem } from './menu';

/**
 * Serializable menu item that gets sent to the main process to build the native application menu
 */
export interface NativeMenuItem {
	label?: string
	type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
	checked?: boolean
	accelerator?: string
	submenu?: NativeMenuItem[]
	id?: number
}
export interface NativeBarMenu {
	id: string
	label: string
	submenu: NativeMenuItem[]
}

const KEY_CODE_ACCELERATORS: Record<number, string> = {
	8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape', 32: 'Space',
	33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
	37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down', 45: 'Insert', 46: 'Delete',
	106: 'nummult', 107: 'numadd', 109: 'numsub', 110: 'numdec', 111: 'numdiv',
	186: ';', 187: '=', 188: ',', 189: '-', 190: '.', 191: '/', 192: '`',
	219: '[', 220: '\\', 221: ']', 222: '\'',
};
// Reserved by the native edit roles that keep text inputs working
const RESERVED_ACCELERATORS = ['Command+X', 'Command+C', 'Command+V', 'Command+A'];

/**
 * Converts a keybind into an accelerator, purely for display in the native menu.
 * Only keybinds with Cmd or Ctrl are converted, since the system only routes those through the menu.
 */
function getAccelerator(keybind?: Keybind): string | undefined {
	if (!keybind || keybind.key < 0) return;
	if (!keybind.meta && !keybind.ctrl) return;
	let key: string;
	if (keybind.key >= 65 && keybind.key <= 90) key = String.fromCharCode(keybind.key);
	else if (keybind.key >= 48 && keybind.key <= 57) key = String.fromCharCode(keybind.key);
	else if (keybind.key >= 96 && keybind.key <= 105) key = 'num' + (keybind.key - 96);
	else if (keybind.key >= 112 && keybind.key <= 123) key = 'F' + (keybind.key - 111);
	else key = KEY_CODE_ACCELERATORS[keybind.key];
	if (!key) return;

	let modifiers = [];
	if (keybind.meta) modifiers.push('Command');
	if (keybind.ctrl) modifiers.push('Ctrl');
	if (keybind.alt) modifiers.push('Alt');
	if (keybind.shift) modifiers.push('Shift');
	let accelerator = [...modifiers, key].join('+');
	if (RESERVED_ACCELERATORS.includes(accelerator)) return;
	return accelerator;
}

let callbacks = new Map<number, () => void>();
let previous_callbacks = new Map<number, () => void>();
let next_id = 0;

function registerCallback(callback: () => void): number {
	let id = next_id++;
	callbacks.set(id, callback);
	return id;
}

function cleanSeparators(list: NativeMenuItem[]): NativeMenuItem[] {
	return list.filter((item, i) => {
		if (item.type != 'separator') return true;
		let previous = list[i-1];
		return i > 0 && i < list.length-1 && previous.type != 'separator';
	})
}

function convertList(list: MenuItem[], context: any): NativeMenuItem[] {
	let result: NativeMenuItem[] = [];
	for (let item of list) {
		let converted = convertItem(item, context);
		if (converted) result.push(converted);
	}
	return cleanSeparators(result);
}

function convertItem(item: MenuItem, context: any): NativeMenuItem | undefined {
	if (item === '_' || item instanceof MenuSeparator || (typeof item == 'string' && item.startsWith('#'))) {
		return {type: 'separator'};
	}
	if (typeof item == 'string') {
		item = BarItems[item] as Action;
	}
	if (typeof item == 'function') {
		item = item(context);
	}
	if (!item || typeof item != 'object' || item instanceof HTMLElement) return;
	if ('context' in item) context = item.context;
	if ('condition' in item && !Condition(item.condition, context)) return;

	if (item instanceof Action) {
		let action = item;
		if (action.children) {
			let children = typeof action.children == 'function' ? action.children(context) : action.children;
			let submenu = convertList(children, context);
			if (!submenu.length) return;
			return {label: action.name, submenu};
		}
		let native_item: NativeMenuItem = {
			label: action.name,
			accelerator: getAccelerator(action.keybind),
			id: registerCallback(() => action.trigger(new MouseEvent('click'))),
		};
		if (action instanceof Toggle) {
			native_item.type = 'checkbox';
			native_item.checked = !!action.value;
		}
		return native_item;

	} else if (item instanceof BarSelect) {
		let select = item;
		let submenu: NativeMenuItem[] = [];
		for (let key in select.options) {
			let option = select.options[key];
			if (!option) continue;
			if (typeof option == 'object' && option.condition && !Condition(option.condition)) continue;
			submenu.push({
				label: select.getNameFor(key),
				type: 'radio',
				checked: select.value == key,
				id: registerCallback(() => {
					select.set(key);
					if (select.onChange) select.onChange(select, new MouseEvent('click'));
				})
			})
		}
		if (!submenu.length) return;
		return {label: tl(select.name), submenu};

	} else if (item instanceof BarItem) {
		// Sliders and other widgets have no native equivalent
		return;

	} else {
		let menu_item = item as CustomMenuItem;
		if (menu_item.children) {
			let children = typeof menu_item.children == 'function' ? menu_item.children(context) : menu_item.children;
			let submenu = convertList(children, context);
			if (submenu.length) {
				return {label: tl(menu_item.name), submenu};
			}
		}
		if (typeof menu_item.click != 'function') return;
		let scope_context = context;
		let native_item: NativeMenuItem = {
			label: tl(menu_item.name),
			id: registerCallback(() => menu_item.click(scope_context, new MouseEvent('click'))),
		};
		if (menu_item.keybind instanceof Keybind) {
			native_item.accelerator = getAccelerator(menu_item.keybind);
		}
		if (menu_item.marked !== undefined) {
			native_item.type = 'checkbox';
			native_item.checked = !!Condition(menu_item.marked, context);
		}
		return native_item;
	}
}

/**
 * Sends the current state of the menu bar to the main process, which turns it into the native application menu
 */
function updateNativeMenuBar() {
	previous_callbacks = callbacks;
	callbacks = new Map();

	let menus: NativeBarMenu[] = [];
	let added = new Set<BarMenu>();
	for (let id in MenuBar.menus) {
		let menu = MenuBar.menus[id];
		// Skip aliases such as "filter"
		if (added.has(menu) || !menu.conditionMet()) continue;
		added.add(menu);
		let structure = typeof menu.structure == 'function' ? menu.structure(undefined) : menu.structure;
		try {
			menus.push({
				id,
				label: menu.name,
				submenu: convertList(structure, undefined)
			});
		} catch (error) {
			console.error(`Failed to build native menu "${id}"`, error);
		}
	}
	ipcRenderer.send('update-native-menu-bar', menus);
}

let update_timeout: ReturnType<typeof setTimeout> | undefined;
function scheduleUpdate() {
	if (update_timeout) clearTimeout(update_timeout);
	update_timeout = setTimeout(() => {
		update_timeout = undefined;
		updateNativeMenuBar();
	}, 50);
}

/**
 * Replaces the in-app menu bar with the native macOS application menu
 */
export function setupNativeMenuBar() {
	document.body.classList.add('native_menu_bar');

	ipcRenderer.on('native-menu-bar-click', (event, id: number) => {
		let callback = callbacks.get(id) ?? previous_callbacks.get(id);
		if (callback) callback();
	})
	// Menu content depends on the current state, so refresh it whenever a menu was closed
	ipcRenderer.on('native-menu-bar-closed', scheduleUpdate);
	window.addEventListener('focus', scheduleUpdate);
	Blockbench.on('update_menu_bar', scheduleUpdate);
	Blockbench.on('select_project', scheduleUpdate);
	Blockbench.on('select_no_project', scheduleUpdate);
	Blockbench.on('select_mode', scheduleUpdate);

	updateNativeMenuBar();
}
