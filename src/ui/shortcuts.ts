import { browser } from 'wxt/browser';
import { h } from './dom';

export type CommandName = 'toggle-translate' | 'toggle-mode' | 'pick-regions';

const DEFAULTS: Record<CommandName, string> = { 'toggle-translate': 'Alt+A', 'toggle-mode': 'Alt+S', 'pick-regions': 'Alt+Shift+P' };
let current: Partial<Record<string, string>> = {};

/** Read the shortcuts as the browser has them now (the user can change them in the browser's shortcut settings). */
export async function loadShortcuts(): Promise<void> {
  try {
    const list = await browser.commands.getAll();
    current = Object.fromEntries(list.filter((c) => c.name).map((c) => [c.name!, c.shortcut ?? '']));
  } catch {
    current = {};
  }
}

/** The key for a command, or a hint when the user removed it. */
export function shortcut(name: CommandName): HTMLElement {
  const key = current[name];
  if (key === '') return h('span', { class: 'hint' }, '未设置快捷键');
  return h('kbd', {}, key ?? DEFAULTS[name]);
}
