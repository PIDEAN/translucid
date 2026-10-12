import { afterEach, describe as suite, expect, it } from 'vitest';
import { claudeSettings, devinShell, occupationPopup, sidebar } from './fixtures/ui-structures';
import { describe, navCollectionOf, signatures, triggerOf } from '../src/pack/structure';
import { packRegistry } from '../src/pack/registry';

afterEach(() => (document.body.innerHTML = ''));
const $ = (s: string) => document.querySelector(s)!;
const byText = (t: string) => [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() === t)!;

suite('structure: settings modal', () => {
  it('finds the nav collection although buttons are cousins under ul > li', () => {
    document.body.innerHTML = claudeSettings('general');
    const nav = navCollectionOf(byText('Account').closest('button')!);
    expect(nav?.active.textContent).toContain('General');
  });

  it('describes radio options with surface, section and outer group', () => {
    document.body.innerHTML = claudeSettings('general');
    const w = describe($('#size-m'));
    expect(w).toEqual({
      surface: { kind: 'dialog', label: 'Settings' },
      section: 'General',
      group: { role: 'radiogroup', label: 'Transcript text size' },
      role: 'radio',
    });
    expect(describe($('#width-m')).group?.label).toBe('Transcript width');
  });

  it('gives the two "Medium" options different signatures, stable across option mounting', () => {
    document.body.innerHTML = claudeSettings('general');
    const a = signatures(describe($('#size-m')));
    const b = signatures(describe($('#width-m')));
    expect(a[0]).toMatch(/^g:[0-9a-z]{4,8}$/);
    expect(a[0]).not.toBe(b[0]);
    // Mounting another option does not change the signature.
    $('[aria-label="Transcript text size"]').insertAdjacentHTML('beforeend', '<span role="radio">Extra large</span>');
    expect(signatures(describe($('#size-m')))[0]).toBe(a[0]);
  });

  it('uses the outer question for a combobox that labels itself with its value', () => {
    document.body.innerHTML = claudeSettings('account');
    const w = describe(byText('Engineering'));
    expect(w.section).toBe('Account');
    expect(w.group).toEqual({ role: 'select', label: 'What best describes your work?' });
    expect(w.role).toBe('value');
  });

  it('attributes portalled options to the trigger that opened them (no aria-controls)', () => {
    document.body.innerHTML = claudeSettings('account') + occupationPopup;
    const trigger = $('[role="combobox"]');
    trigger.setAttribute('aria-expanded', 'true');
    expect(triggerOf($('[role="listbox"]'))).toBe(trigger);
    const w = describe(byText('Product management'));
    expect(w.surface.kind).toBe('listbox');
    expect(w.group?.label).toBe('What best describes your work?');
    expect(w.role).toBe('option');
    // Same group as the current value: the option set shares context with the question.
    expect(signatures(w)[0]).toBe(signatures(describe(byText('Engineering')))[0]);
  });

  it('labels group rows and describes switch rows as fields', () => {
    document.body.innerHTML = claudeSettings('general');
    const label = describe(byText('Scheduled tasks'));
    expect(label.group).toEqual({ role: 'field', label: 'Scheduled tasks' });
    expect(label.role).toBe('label');
    const desc = describe(byText('Get notified when scheduled tasks finish.'));
    expect(desc.group?.label).toBe('Scheduled tasks');
  });

  it('reads labels in the source language after the page was translated', () => {
    document.body.innerHTML = claudeSettings('general');
    const label = byText('Transcript width');
    const t = label.firstChild!;
    packRegistry().origText.set(t, 'Transcript width');
    t.nodeValue = '对话宽度';
    expect(describe($('#width-m')).group?.label).toBe('Transcript width');
  });

  it('never uses runtime ids in signatures (useId churn)', () => {
    document.body.innerHTML = claudeSettings('general');
    const before = signatures(describe($('#size-m')));
    document.body.innerHTML = claudeSettings('general').replaceAll('_r_a', '_r_z');
    expect(signatures(describe($('#size-m')))).toEqual(before);
  });
});

suite('structure: sidebar and shells', () => {
  it('a page section never comes from a personal link', () => {
    document.body.innerHTML = sidebar.replace('href="/new" aria-current="page"', 'href="/new"').replace('href="/chat/3f2b8c1e', 'aria-current="page" href="/chat/3f2b8c1e') + '<main><button>Share</button></main>';
    expect(describe(byText('Share')).section).toBeUndefined();
  });

  it('keeps personal group labels out of context', () => {
    document.body.innerHTML = '<div role="group" aria-label="mira.chen@example.org"><button>Edit</button></div>';
    expect(describe(byText('Edit')).group).toEqual({ role: 'group' });
  });

  it('recognizes hub link lists and menu triggers in a Devin-like shell', () => {
    document.body.innerHTML = devinShell;
    // The whole sidebar is one navigation collection (its active item is "New session").
    expect(navCollectionOf(byText('Automations'))?.container.tagName).toBe('ASIDE');
    const w = describe(byText('Help'));
    expect(w).toMatchObject({ surface: { kind: 'page' }, role: 'button' });
    expect(describe(byText('Members')).section).toBe('Administration');
  });
});

suite('structure: page sections kept in the DOM', () => {
  it('puts a heading in its own section', () => {
    document.body.innerHTML = `<main>
      <section hidden><h2>Profile</h2><div><b>Display name</b></div></section>
      <section><div class="head"><h2>Notifications</h2></div><div class="row"><b id="r">Email digests</b></div></section>
    </main>`;
    expect(describe(byText('Notifications')).section).toBe('Notifications');
    expect(describe($('#r')).section).toBe('Notifications');
  });

  it.each([
    ['hidden', '<section hidden><h2>Profile</h2></section>'],
    ['inert', '<section inert><h2>Profile</h2></section>'],
    ['aria-hidden', '<section aria-hidden="true"><h2>Profile</h2></section>'],
    ['display: none', '<section style="display: none"><h2>Profile</h2></section>'],
    ['a hidden part of a shown sibling', '<section><div hidden><h2>Profile</h2></div></section>'],
  ])('skips the heading of a sibling hidden by %s', (_kind, closed) => {
    document.body.innerHTML = `<main><h2>Notifications</h2>${closed}<div class="row"><b id="r">Email digests</b></div></main>`;
    expect(describe($('#r')).section).toBe('Notifications');
  });

  it('takes the shown heading of a sibling that also holds a hidden one', () => {
    document.body.innerHTML = `<main><section><div hidden><h2>Profile</h2></div><h2>Notifications</h2></section><div class="row"><b id="r">Email digests</b></div></main>`;
    expect(describe($('#r')).section).toBe('Notifications');
  });
});
