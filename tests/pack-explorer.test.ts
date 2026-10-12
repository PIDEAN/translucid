import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BUDGET, Explorer, hasDraft } from '../src/pack/explorer';
import { mountExploreApp, type ExploreApp } from './fixtures/explore-app';

let app: ExploreApp | undefined;
afterEach(() => {
  app?.destroy();
  app = undefined;
  history.replaceState(null, '', '/');
});

function explorer(opts: { stopAfter?: number } = {}) {
  const seen = new Set<string>();
  let calls = 0;
  const ex = new Explorer(document, {
    collect: (root) => {
      calls++;
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue!.trim()) seen.add(n.nodeValue!.trim());
    },
    shouldStop: () => opts.stopAfter !== undefined && calls >= opts.stopAfter,
  }, { ...DEFAULT_BUDGET, ms: 20_000 });
  return { ex, seen };
}

describe('Explorer', { timeout: 30_000 }, () => {
  it('visits every section and popup, collects hidden strings, never touches settings, and restores', async () => {
    app = mountExploreApp(document);
    const { ex, seen } = explorer();
    const report = await ex.run();
    expect(report.visited).toEqual(expect.arrayContaining(['Account', 'Privacy', 'Billing', 'Serif', 'Engineering', 'English', 'Invoices', 'Payment']));
    // Strings that only exist inside sections, tabs and popups.
    for (const s of ['Design', 'Product management', 'Deutsch', 'Dyslexic friendly', 'Past invoices appear here', 'Payment method on file']) expect(seen).toContain(s);
    // Destructive trigger skipped with a reason; never opened.
    expect(report.skipped).toContainEqual({ label: 'Delete account', reason: '可能执行操作' });
    expect(seen).not.toContain('Delete forever');
    expect(document.getElementById('sw')).toBeNull(); // back on General: the switch's section is gone
    expect(app.section()).toBe('General');
    expect(app.openPopups()).toBe(0);
    expect(report.restore).toBe('full');
    expect(report.guard).toBeUndefined();
  });

  it('aborts when a step changes a setting, and still restores', async () => {
    app = mountExploreApp(document);
    // Opening the font list secretly flips the theme radio: the guard must notice.
    app.sabotage('fonts', () => document.querySelector('[role="radio"]')!.setAttribute('aria-checked', 'false'));
    const { ex } = explorer();
    const report = await ex.run();
    expect(report.guard).toContain('Serif');
    expect(app.openPopups()).toBe(0);
  });

  it('reports a partial restore when Escape also closes the parent dialog', async () => {
    // Triggers that only open (no toggle) are closed with Escape, which here also closes the dialog.
    app = mountExploreApp(document, { escapeClosesDialog: true, noToggle: true });
    const { ex } = explorer();
    const report = await ex.run();
    expect(report.restore).toBe('partial');
    expect(report.unrestored.join()).toContain('上一层对话框');
  });

  it('stops on request', async () => {
    app = mountExploreApp(document);
    const { ex } = explorer({ stopAfter: 2 });
    const report = await ex.run();
    expect(report.stopped).toBe(true);
    expect(app.section()).toBe('General');
  });

  it('refuses to start over a dialog with unsaved input', () => {
    document.body.innerHTML = '<div role="dialog"><input id="name" value="Mira"></div>';
    expect(hasDraft(document)).toBe(false);
    (document.getElementById('name') as HTMLInputElement).value = 'Mira C';
    expect(hasDraft(document)).toBe(true);
  });

  it('follows client-side routed sub-pages only, never reloading the page', async () => {
    history.replaceState(null, '', '/org/acme/settings');
    document.body.innerHTML = `<main><h2>Settings</h2>
      <a href="/org/acme/settings/members" id="spa">Members</a>
      <a href="/org/acme/settings/legacy" id="plain">Legacy page</a>
      <a href="/sessions/9a7d4e21-3f2b-8c1e-b5c3-0d9e8f7a6b5d">A session</a>
      <a href="https://elsewhere.example.com/settings">Docs</a></main>`;
    const onClick = (e: Event) => {
      const a = (e.target as Element).closest('#spa');
      if (!a) return;
      e.preventDefault();
      history.pushState(null, '', a.getAttribute('href')!);
      document.querySelector('main h2')!.textContent = 'Members';
    };
    document.addEventListener('click', onClick);
    const { ex, seen } = explorer();
    const report = await ex.run();
    document.removeEventListener('click', onClick);
    expect(report.visited).toContain('Members');
    expect(report.skipped).toContainEqual({ label: 'Legacy page', reason: '会重新加载页面' });
    expect(report.skipped.map((s) => s.label)).not.toContain('A session'); // not a sub-page: never considered
    expect(seen).toContain('Members');
    expect(location.pathname).toBe('/org/acme/settings');
  });
});

describe('Explorer after the review', { timeout: 30_000 }, () => {
  it('never clicks a button that would submit a form', async () => {
    document.body.innerHTML = '<form id="f"><button aria-haspopup="dialog">Preferences</button></form>';
    let submitted = 0;
    document.getElementById('f')!.addEventListener('submit', (e) => {
      submitted++;
      e.preventDefault();
    });
    const { ex } = explorer();
    const report = await ex.run();
    expect(submitted).toBe(0);
    expect(report.skipped).toContainEqual({ label: 'Preferences', reason: '可能提交表单' });
  });

  it('dispatches nothing more once stopped, even mid-step', async () => {
    document.body.innerHTML = '<nav><button aria-haspopup="menu" data-state="closed" id="t">Help</button></nav>';
    let stop = false;
    let pointerdowns = 0;
    const t = document.getElementById('t')!;
    t.addEventListener('click', () => (stop = true)); // the user presses Stop right after the click
    t.addEventListener('pointerdown', () => pointerdowns++);
    const ex = new Explorer(document, { collect: () => {}, shouldStop: () => stop }, { ...DEFAULT_BUDGET, ms: 10_000 });
    const report = await ex.run();
    expect(pointerdowns).toBe(0);
    expect(report.stopped).toBe(true);
  });

  it('a close that changes a setting is reported, not called restored', async () => {
    app = mountExploreApp(document);
    app.sabotage('fonts', () => {
      const r = document.querySelector('[role="radio"]')!;
      // Flip the setting only when the list closes again.
      const mo = new MutationObserver(() => {
        if (!document.querySelector('[role="listbox"]')) {
          r.setAttribute('aria-checked', 'false');
          mo.disconnect();
        }
      });
      mo.observe(document.body, { childList: true });
    });
    const { ex } = explorer();
    const report = await ex.run();
    expect(report.guard).toBeTruthy();
    expect(report.restore).toBe('partial');
    expect(report.unrestored.join()).toContain('设置值被改动');
  });

  it('goes back from a sub-page even when stopped there', async () => {
    history.replaceState(null, '', '/hub');
    document.body.innerHTML = '<main><h2>Hub</h2><a href="/hub/preferences" id="p">Preferences</a></main>';
    const onClick = (e: Event) => {
      if (!(e.target as Element).closest('#p')) return;
      e.preventDefault();
      history.pushState(null, '', '/hub/preferences');
    };
    const onPop = () => undefined;
    document.addEventListener('click', onClick);
    addEventListener('popstate', onPop);
    let calls = 0;
    const ex = new Explorer(document, { collect: () => void calls++, shouldStop: () => calls >= 2 }, { ...DEFAULT_BUDGET, ms: 10_000 });
    const report = await ex.run();
    document.removeEventListener('click', onClick);
    removeEventListener('popstate', onPop);
    expect(report.stopped).toBe(true);
    expect(location.pathname).toBe('/hub');
  });

  it('starts from the home page: opens settings through the account menu link and explores them', async () => {
    document.body.innerHTML = '<aside><button aria-haspopup="menu" aria-expanded="false" id="acct">Account</button></aside><main><h1>Home</h1></main>';
    const acct = document.getElementById('acct')!;
    const close = () => {
      document.getElementById('menu')?.remove();
      acct.setAttribute('aria-expanded', 'false');
    };
    const openSettings = () => {
      close();
      history.pushState(null, '', '#settings');
      mountExploreApp(document, { keepBody: true });
    };
    acct.addEventListener('click', () => {
      if (acct.getAttribute('aria-expanded') === 'true') return close();
      acct.setAttribute('aria-expanded', 'true');
      document.body.insertAdjacentHTML('beforeend', '<div role="menu" id="menu"><a role="menuitem" href="#settings" id="s">Settings</a><div role="menuitem">Log out</div></div>');
      document.getElementById('s')!.addEventListener('click', (e) => {
        e.preventDefault();
        openSettings();
      });
    });
    const onPop = () => {
      if (location.hash !== '#settings') document.getElementById('settings')?.remove();
    };
    addEventListener('popstate', onPop);
    const { ex, seen } = explorer();
    const report = await ex.run();
    removeEventListener('popstate', onPop);
    expect(report.visited).toEqual(expect.arrayContaining(['Account', 'Settings', 'Privacy', 'Billing']));
    expect(seen).toContain('Past invoices appear here');
    expect(location.hash).toBe('');
    expect(document.getElementById('settings')).toBeNull();
  });

  it('treats an editable dialog with a live Save button, or a field being edited, as a possible draft', () => {
    document.body.innerHTML = '<div role="dialog"><input id="n" value="Mira"><button>Save changes</button></div>';
    expect(hasDraft(document)).toBe(true);
    document.body.innerHTML = '<div role="dialog"><input id="n" value="Mira"><button disabled>Save changes</button></div>';
    expect(hasDraft(document)).toBe(false);
    (document.getElementById('n') as HTMLInputElement).focus();
    expect(hasDraft(document)).toBe(true);
  });
});

describe('page drafts and anonymous skip reports', () => {
  it('counts only focused non-empty editors and ignores permanent unfocused document content', () => {
    document.body.innerHTML = '<div contenteditable="true" tabindex="0">Document body</div><div id="composer" contenteditable="true" tabindex="0">  </div><input type="search" id="search">';
    expect(hasDraft(document)).toBe(false);
    document.getElementById('composer')!.focus();
    expect(hasDraft(document)).toBe(false);
    document.getElementById('search')!.focus();
    expect(hasDraft(document)).toBe(false);
    document.getElementById('composer')!.textContent = 'Draft message';
    document.getElementById('composer')!.focus();
    expect(hasDraft(document)).toBe(true);
    document.getElementById('composer')!.blur();
    expect(hasDraft(document)).toBe(false);
    const search = document.getElementById('search') as HTMLInputElement;
    search.defaultValue = 'Search text'; search.value = 'Search text'; search.focus();
    expect(hasDraft(document)).toBe(true);
  });

  it('does not treat an untouched page form with an enabled Save button as a draft', () => {
    document.body.innerHTML = '<form><input value="Profile"><button>Save changes</button></form><section data-settings><button>Apply</button></section>';
    expect(hasDraft(document)).toBe(false);
  });

  it('visits later settings sections with an enabled Save button and restores the original section', async () => {
    app = mountExploreApp(document);
    const addSave = (e: Event) => {
      if ((e.target as Element).getAttribute('data-nav') === 'Account') document.getElementById('content')!.insertAdjacentHTML('beforeend', '<input value="Profile"><button>Save changes</button>');
    };
    document.addEventListener('click', addSave);
    try {
      const report = await explorer().ex.run();
      expect(report.visited).toEqual(expect.arrayContaining(['Account', 'Privacy', 'Billing']));
      expect(app.section()).toBe('General');
      expect(report.restore).toBe('full');
      expect(report.refused).toBeUndefined();
    } finally { document.removeEventListener('click', addSave); }
  }, 30_000);

  it('closes an autofocused dialog opened by the scan even when it contains Save', async () => {
    document.body.innerHTML = '<button id="open" type="button" aria-haspopup="dialog" aria-expanded="false">Preferences</button>';
    const trigger = document.getElementById('open')!;
    trigger.addEventListener('click', () => {
      const dialog = document.getElementById('autofocused');
      trigger.setAttribute('aria-expanded', String(!dialog));
      if (dialog) dialog.remove();
      else {
        document.body.insertAdjacentHTML('beforeend', '<div role="dialog" id="autofocused"><input value="Profile"><button>Save changes</button></div>');
        document.querySelector<HTMLInputElement>('input')!.focus();
      }
    });
    const report = await explorer().ex.run();
    expect(report.visited).toContain('Preferences');
    expect(document.getElementById('autofocused')).toBeNull();
    expect(report.restore).toBe('full');
    expect(report.refused).toBeUndefined();
  });

  it('detects page text, checked and selected drafts without mistaking native defaults for edits', () => {
    document.body.innerHTML = '<form><input value="old"><input type="checkbox" checked><select><option>First</option><option>Second</option></select><select multiple><option selected>One</option><option>Two</option></select><button type="submit">Save</button></form>';
    expect(hasDraft(document)).toBe(false);
    const input = document.querySelector('input')!;
    input.value = 'new';
    expect(hasDraft(document)).toBe(true);
    input.value = 'old';
    const checkbox = document.querySelector<HTMLInputElement>('[type=checkbox]')!;
    checkbox.checked = false;
    expect(hasDraft(document)).toBe(true);
    checkbox.checked = true;
    document.querySelector('select')!.selectedIndex = 1;
    expect(hasDraft(document)).toBe(true);
    document.querySelector('select')!.selectedIndex = 0;
    document.querySelectorAll('select')[1]!.options[1]!.selected = true;
    expect(hasDraft(document)).toBe(true);
  });

  it.each(['checkbox', 'radio', 'select'])('ignores controlled-style %s defaults outside explicit-save forms', (kind) => {
    const field = kind === 'select' ? '<select><option selected>First</option><option>Second</option></select>' : `<input type="${kind}">`;
    const change = () => {
      const el = document.querySelector('input,select')!;
      if (el instanceof HTMLInputElement) el.checked = true;
      else (el as HTMLSelectElement).selectedIndex = 1;
    };
    for (const html of [field, `${field}<button>Save</button>`, `<form>${field}</form>`, `<form>${field}<button disabled>Save</button></form>`, `<form>${field}<button type="button" aria-disabled="true">Apply</button></form>`, `<form>${field}<button hidden>Save</button></form>`]) {
      document.body.innerHTML = html;
      change();
      expect(hasDraft(document), html).toBe(false);
    }
    document.body.innerHTML = `<form>${field}<button type="submit">Save</button></form>`;
    change();
    expect(hasDraft(document)).toBe(true);
  });

  it.each(['<button>Commit</button>', '<button type="submit">Commit</button>', '<input type="submit" value="Commit">', '<button type="button">Apply</button>'])('detects checked drafts in explicit-save forms with %s', (button) => {
    document.body.innerHTML = `<form><input type="checkbox">${button}</form>`;
    document.querySelector('input')!.checked = true;
    expect(hasDraft(document)).toBe(true);
  });

  it('requires a Save label or explicit submit inside dialogs without a form', () => {
    document.body.innerHTML = '<div role="dialog"><input type="checkbox"><button>Close</button></div>';
    document.querySelector('input')!.checked = true;
    expect(hasDraft(document)).toBe(false);
    document.querySelector('button')!.type = 'submit';
    expect(hasDraft(document)).toBe(true);
  });

  it.each(['input', 'textarea'])('still detects changed visible %s text outside forms', (tag) => {
    document.body.innerHTML = tag === 'input' ? '<input value="old">' : '<textarea>old</textarea>';
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(tag)!;
    field.value = 'new';
    expect(hasDraft(document)).toBe(true);
  });

  it('detects focused content but ignores always-enabled Save in untouched page forms and settings regions', () => {
    document.body.innerHTML = '<form><input id="f" value="old"><button disabled>Apply</button></form><section id="settings"><button disabled>Save</button></section>';
    expect(hasDraft(document)).toBe(false);
    document.getElementById('f')!.focus();
    expect(hasDraft(document)).toBe(true);
    (document.getElementById('f') as HTMLElement).blur();
    document.querySelector('section button')!.removeAttribute('disabled');
    expect(hasDraft(document)).toBe(false);
  });

  it('refuses navigation that would destroy an unsaved page form', async () => {
    document.body.innerHTML = '<nav><button type="button" aria-current="page">General</button><button type="button" id="next">Account</button></nav><form><input value="old"></form>';
    document.querySelector('input')!.value = 'draft';
    let clicks = 0;
    document.getElementById('next')!.addEventListener('click', () => { clicks++; document.querySelector('form')!.remove(); });
    const report = await explorer().ex.run();
    expect(clicks).toBe(0);
    expect(document.querySelector('input')!.value).toBe('draft');
    expect(report.refused).toBe('draft');
    expect(report.actions).toBe(0);
  });

  it('aggregates personal sub-page links without retaining their raw titles', async () => {
    history.replaceState(null, '', '/hub');
    document.body.innerHTML = '<a href="/hub/chat/a1b2c3">Budget review</a><a href="/hub/chat/z4x5c6">Personal plan</a>';
    const report = await explorer().ex.run();
    expect(report.skipped).toEqual([{ label: '个人内容链接', reason: '指向个人内容', count: 2 }]);
    expect(JSON.stringify(report)).not.toMatch(/Budget|Personal/);
  });
});

it('anonymizes personal titles before considering dangerous labels or external links', async () => {
  history.replaceState(null, '', '/hub');
  document.body.innerHTML = '<a href="/hub/chat/a1b2c3">Create marketing plan</a><a href="/hub/chat/z4x5c6">Save personal draft</a><a href="/hub/chat/p7q8r9">Share travel plan</a><nav><a href="/settings" aria-current="page">Settings</a><a href="https://elsewhere.example.org/chat/s1t2u3">Create project</a><a href="#unused">Delete action</a></nav>';
  const report = await explorer().ex.run();
  expect(report.skipped.find((s) => s.reason === '指向个人内容')).toEqual({ label: '个人内容链接', reason: '指向个人内容', count: 4 });
  expect(JSON.stringify(report)).not.toMatch(/marketing|personal draft|travel|Create project/);
});

it('anonymizes a personal settings link opened inside a menu even when its title looks dangerous', async () => {
  document.body.innerHTML = '<button id="account" type="button" aria-haspopup="menu" aria-expanded="false">Account</button>';
  const trigger = document.getElementById('account')!;
  trigger.addEventListener('click', () => {
    const open = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!open));
    if (open) document.getElementById('menu')!.remove();
    else document.body.insertAdjacentHTML('beforeend', '<div id="menu" role="menu"><a role="menuitem" href="/chat/a1b2c3">Share Settings project</a></div>');
  });
  const report = await explorer().ex.run();
  expect(report.skipped).toContainEqual({ label: '个人内容链接', reason: '指向个人内容', count: 1 });
  expect(JSON.stringify(report)).not.toContain('Share Settings project');
});
