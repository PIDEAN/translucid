import { describe, expect, it } from 'vitest';
import { skeleton } from '../src/pack/skeleton';
import { claudeSettings, sidebar } from './fixtures/ui-structures';

describe('skeleton (debug research export)', () => {
  it('keeps structure, never content: canaries do not survive', () => {
    history.replaceState(null, '', '/org/acme-corp-7781/settings?tab=members');
    document.body.innerHTML = `${claudeSettings('account')}${sidebar}
      <div data-testid="user-8812-card" aria-label="Mira Chen" title="mira.chen@example.org"><a href="/org/acme-corp-7781/chat/3f2b8c1e?ref=mira">Canary Zeta Quokka</a>
      <input placeholder="Search Quokka" value="Zeta draft"></div>
      <div data-testid="workspace-mira-chen" class="workspace-acme-corp flex gap-2"><span class="sidebar-item">x</span></div>`;
    const out = skeleton(document.body);
    for (const canary of ['Mira', 'mira', 'Chen', 'chen', 'mira.chen', 'example.org', 'Quokka', 'Zeta', 'acme', '7781', '3f2b8c1e', 'Engineering', 'Trip planning', '_r_b1_', '8812', 'corp']) {
      expect(out).not.toContain(canary);
    }
    // Structure the research needs is still there.
    expect(out).toMatch(/div\[role=dialog\]\[aria-labelledby=r\d+\]/);
    expect(out).toMatch(/button\[aria-current=page\]/);
    expect(out).toMatch(/button\[role=combobox\]\[aria-haspopup=dialog\]\[aria-expanded=false\](\[type=button\])?\[id=r\d+\]\[aria-labelledby=r\d+\]/);
    expect(out).toContain('[href=/org/:seg/chat/:seg?…]');
    expect(out).toContain('[data-testid=⟨id⟩]');
    expect(out).toContain('⟨Aa 2w⟩');
    expect(out).toContain('[data-testid=workspace-⟨x⟩-⟨x⟩]');
    expect(out).toContain('.workspace-⟨x⟩-⟨x⟩.flex.gap-2');
    expect(out).toContain('.sidebar-item');
  });
});
