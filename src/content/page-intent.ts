// The user's choices for a page (on or off, display mode, expert) have one source: the top document.
// Page commands go to it alone; it applies them and records them under a growing version. Whoever sent
// the command then writes the new intent into every frame (src/shared/tab-state.ts, acknowledged by
// scripting.executeScript), state reads put frames that fell behind back in step, and a frame asks the top
// document again when it loads, gets focus or becomes visible. A frame applies only intents of the top
// document it belongs to, and only versions newer than the one it has.
import type { Controller } from './controller';
import type { PageIntent, TabCommand } from '../shared/messages';

const newDocId = () => (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

/** The intent of a new top document: no choices yet. */
export const emptyIntent = (doc = newDocId()): PageIntent => ({ doc, version: 0, enabled: null, mode: null, expertId: null });

export const isIntent = (i: unknown): i is PageIntent =>
  !!i && typeof (i as PageIntent).doc === 'string' && typeof (i as PageIntent).version === 'number';

/** In the top document, after a page command ran: what it chose, under a new version. */
export function noteIntent(intent: PageIntent, cmd: TabCommand, controller: Controller): void {
  if (cmd.type === 'set-enabled' || cmd.type === 'toggle') intent.enabled = controller.enabled;
  if (cmd.type === 'set-mode' || cmd.type === 'toggle-mode') {
    intent.enabled = controller.enabled;
    intent.mode = controller.mode;
  }
  if (cmd.type === 'set-expert') intent.expertId = cmd.expertId;
  intent.version++;
}

/** Make a frame's controller match the page intent; null fields are no choice and change nothing. */
export function applyIntent(controller: Controller, intent: PageIntent): void {
  if (intent.mode && intent.mode !== controller.mode) controller.setMode(intent.mode);
  if (intent.expertId !== null && intent.expertId !== controller.expertOverride) controller.setExpert(intent.expertId);
  if (intent.enabled === true) controller.start();
  else if (intent.enabled === false) controller.stop();
}

/** Which intent a frame follows, for state reads to put it back in step. */
export interface FollowStatus {
  doc: string | null;
  version: number;
}

/**
 * In a frame. Until the top document has named itself (a valid answer to `frame-join`), intents offered
 * only wait: a frame never guesses which page it belongs to. Once named, the newest waiting intent of
 * that page is applied, and after that only newer versions of the same page, each once.
 */
export class IntentFollower {
  private doc: string | null = null;
  private waiting: PageIntent[] = [];
  private applied = -1;

  constructor(private apply: (intent: PageIntent) => void) {}

  /** The top document of this frame has answered, so updates for it can be applied. */
  get bound(): boolean {
    return this.doc !== null;
  }

  offer(intent: unknown): void {
    if (!isIntent(intent)) return;
    if (this.doc === null) {
      // Only the newest few matter until the page answers.
      this.waiting = [...this.waiting, intent].slice(-8);
      return;
    }
    if (intent.doc !== this.doc || intent.version <= this.applied) return;
    this.applied = intent.version;
    this.apply(intent);
  }

  /** An answer from the top document (at setup, or asked again later). An empty answer binds nothing. */
  join(snapshot: unknown): void {
    if (!isIntent(snapshot)) return;
    if (this.doc === null) {
      this.doc = snapshot.doc;
      const newest = [...this.waiting, snapshot].filter((i) => i.doc === snapshot.doc).reduce((a, b) => (b.version > a.version ? b : a));
      this.waiting = [];
      this.offer(newest);
      return;
    }
    this.offer(snapshot);
  }

  status(): FollowStatus {
    return { doc: this.doc, version: this.applied };
  }
}
