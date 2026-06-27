export interface KeyboardShortcut {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  description: string;
  action: () => void;
}

export class KeyboardController {
  private shortcuts: Map<string, KeyboardShortcut> = new Map();
  private pressed: Set<string> = new Set();

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  registerShortcut(shortcut: KeyboardShortcut): void {
    const key = this.buildKey(shortcut);
    this.shortcuts.set(key, shortcut);
  }

  unregisterShortcut(key: string): void {
    this.shortcuts.delete(key.toLowerCase());
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.pressed.has(e.key)) return;
    this.pressed.add(e.key);

    const combo: KeyboardShortcut = {
      key: e.key.toLowerCase(),
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
      description: '',
      action: () => {},
    };
    const key = this.buildKey(combo);
    const shortcut = this.shortcuts.get(key);
    if (shortcut) {
      e.preventDefault();
      shortcut.action();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.pressed.delete(e.key);
  };

  private buildKey(s: { key: string; ctrl?: boolean; shift?: boolean; alt?: boolean }): string {
    const parts: string[] = [];
    if (s.ctrl) parts.push('ctrl');
    if (s.shift) parts.push('shift');
    if (s.alt) parts.push('alt');
    parts.push(s.key.toLowerCase());
    return parts.join('+');
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.shortcuts.clear();
  }
}
