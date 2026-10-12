import { afterEach, describe, expect, it, vi } from 'vitest';
import { PackApplier } from '../src/pack/applier';
import { emptyPack, toRuntime, type PackEntry } from '../src/pack/format';
import { containsOwned } from '../src/pack/registry';

const entries: PackEntry[] = [
  { kind: 'text', src: 'New chat', t: '新建对话', status: 'auto' },
  { kind: 'text', src: 'Settings', t: '设置', status: 'auto' },
  { kind: 'text', src: 'Copy', t: '复制', status: 'auto' },
  { kind: 'placeholder', src: 'Search chats', t: '搜索对话', status: 'auto' },
  { kind: 'aria-label', src: 'Open menu', t: '打开菜单', status: 'auto' },
  { kind: 'title', src: 'Share', t: '分享', status: 'auto' },
  { kind: 'value', src: 'Send', t: '发送', status: 'auto' },
];
const rt = (more: PackEntry[] = [], excludes: string[] = []) =>
  toRuntime({ ...emptyPack('app.example.com', 'zh-CN'), entries: [...entries, ...more], excludes });

const tick = () => new Promise((r) => setTimeout(r, 0));
let applier: PackApplier | undefined;
afterEach(() => {
  applier?.restore();
  applier = undefined;
  document.body.innerHTML = '';
});

function start(html: string, runtime = rt()) {
  document.body.innerHTML = html;
  applier = new PackApplier(document, runtime);
  applier.start();
  return applier;
}

describe('PackApplier', () => {
  it('replaces text and attributes in place and restores them exactly', () => {
    start(`
      <nav><button id="b">  New chat </button><a id="s" href="/settings">Settings</a></nav>
      <input id="q" placeholder="Search chats"><button id="m" aria-label="Open menu" title="Share">≡</button>
      <input id="send" type="submit" value="Send"><input id="txt" type="text" value="Send">`);
    const b = document.getElementById('b')!;
    const textNode = b.firstChild!;
    expect(b.textContent).toBe('  新建对话 ');
    expect(b.firstChild).toBe(textNode); // same node, no re-parenting
    expect(document.getElementById('s')!.textContent).toBe('设置');
    expect(document.getElementById('q')!.getAttribute('placeholder')).toBe('搜索对话');
    expect(document.getElementById('m')!.getAttribute('aria-label')).toBe('打开菜单');
    expect(document.getElementById('m')!.getAttribute('title')).toBe('分享');
    expect(document.getElementById('send')!.getAttribute('value')).toBe('发送');
    expect(document.getElementById('txt')!.getAttribute('value')).toBe('Send'); // user-editable value untouched
    expect(containsOwned(b)).toBe(true);

    applier!.restore();
    expect(b.textContent).toBe('  New chat ');
    expect(document.getElementById('q')!.getAttribute('placeholder')).toBe('Search chats');
    expect(document.getElementById('send')!.getAttribute('value')).toBe('Send');
    expect(containsOwned(b)).toBe(false);
  });

  it('skips code, editors, excluded regions and icon fonts; keeps control labels in user content', () => {
    start(
      `<code>Settings</code><div contenteditable="true">Settings</div><textarea>Settings</textarea>
       <div class="user-msg">Settings</div>
       <span class="material-icons">settings</span><span class="material-symbols-outlined">Settings</span>
       <div class="prose"><p id="p">Copy</p><button id="c">Copy</button></div>`,
      rt([], ['.user-msg']),
    );
    expect(document.querySelector('code')!.textContent).toBe('Settings');
    expect(document.querySelector('[contenteditable]')!.textContent).toBe('Settings');
    expect(document.querySelector('textarea')!.textContent).toBe('Settings');
    expect(document.querySelector('.user-msg')!.textContent).toBe('Settings');
    expect(document.querySelector('.material-symbols-outlined')!.textContent).toBe('Settings');
    expect(document.getElementById('p')!.textContent).toBe('Copy'); // user content stays
    expect(document.getElementById('c')!.textContent).toBe('复制'); // its button label is UI
  });

  it('re-applies after the app re-renders, and keeps app values it does not know', async () => {
    start('<button id="b">New chat</button><span id="x">Settings</span>');
    const b = document.getElementById('b')!;
    // React-style update: the app sets nodeValue back to its own string.
    b.firstChild!.nodeValue = 'New chat';
    await tick();
    expect(b.textContent).toBe('新建对话');
    // The app shows something the pack does not know: leave it and forget ownership.
    b.firstChild!.nodeValue = 'Unknown label';
    await tick();
    expect(b.textContent).toBe('Unknown label');
    applier!.restore();
    expect(b.textContent).toBe('Unknown label'); // restore never overwrites app writes
    expect(document.getElementById('x')!.textContent).toBe('Settings');
  });

  it('handles added nodes, attribute changes and open shadow roots', async () => {
    start('<div id="host"></div><div id="list"></div>');
    const list = document.getElementById('list')!;
    list.innerHTML = '<button>Settings</button>';
    await tick();
    expect(list.textContent).toBe('设置');

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.setAttribute('placeholder', 'Search chats');
    await tick();
    expect(input.getAttribute('placeholder')).toBe('搜索对话');

    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>New chat</button>';
    await tick();
    // A fresh shadow root is found when its host is (re)visited.
    host.setAttribute('title', 'Share');
    await tick();
    expect(host.getAttribute('title')).toBe('分享');
  });

  it('walks shadow roots present at start and watches them', async () => {
    document.body.innerHTML = '<div id="host"></div>';
    const shadow = document.getElementById('host')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>New chat</button>';
    applier = new PackApplier(document, rt());
    applier.start();
    expect(shadow.querySelector('button')!.textContent).toBe('新建对话');
    const late = document.createElement('button');
    late.textContent = 'Settings';
    shadow.appendChild(late);
    await tick();
    expect(late.textContent).toBe('设置');
  });

  it('stops fighting an app that keeps rewriting a node', async () => {
    start('<button id="b">Settings</button>');
    const t = document.getElementById('b')!.firstChild!;
    for (let i = 0; i < 30; i++) {
      t.nodeValue = 'Settings';
      await tick();
    }
    expect(t.nodeValue).toBe('Settings');
  });

  it('swaps runtime revisions without leaving stale text', () => {
    start('<button id="b">Settings</button>');
    applier!.setRuntime(toRuntime({ ...emptyPack('app.example.com', 'zh-CN'), entries: [{ kind: 'text', src: 'Settings', t: '偏好设置', status: 'edited' }] }));
    expect(document.getElementById('b')!.textContent).toBe('偏好设置');
  });

  it('records originals in the shared registry so structure analysis reads the source language', async () => {
    const { originalText, originalAttr } = await import('../src/pack/registry');
    start('<nav><button id="b" aria-label="Open menu">Settings</button></nav>');
    const b = document.getElementById('b')!;
    expect(b.textContent).toBe('设置');
    expect(originalText(b)).toBe('Settings');
    expect(originalAttr(b, 'aria-label')).toBe('Open menu');
    applier!.restore();
    expect(originalText(b)).toBe('Settings');
  });
});

describe('PackApplier contexts', () => {
  const at = async (html: string, id: string) => {
    const { describe: where, signatures } = await import('../src/pack/structure');
    document.body.innerHTML = html;
    const sigs = signatures(where(document.getElementById(id)!));
    document.body.innerHTML = '';
    return sigs[0]!;
  };

  it('translates the same word differently per group and leaves unseen contexts untranslated', async () => {
    const { claudeSettings } = await import('./fixtures/ui-structures');
    const html = claudeSettings('general');
    const size = await at(html, 'size-m');
    const width = await at(html, 'width-m');
    expect(size).not.toBe(width);
    const misses: string[] = [];
    document.body.innerHTML = html + '<div role="group" aria-labelledby="x"><span id="x">Video quality</span><span role="radio" id="q-m">Medium</span></div>';
    applier = new PackApplier(document, rt([
      { kind: 'text', src: 'Medium', t: '中', ctx: size, status: 'auto' },
      { kind: 'text', src: 'Medium', t: '适中', ctx: width, status: 'auto' },
      { kind: 'text', src: 'Transcript width', t: '对话宽度', status: 'auto' },
    ]), { onMiss: (_k, src) => misses.push(src) });
    applier.start();
    expect(document.getElementById('size-m')!.textContent).toBe('中');
    expect(document.getElementById('width-m')!.textContent).toBe('适中');
    // Translating the group label does not change the options' context (signatures read originals).
    expect(document.getElementById('_r_a4_')!.textContent).toBe('对话宽度');
    expect(document.getElementById('q-m')!.textContent).toBe('Medium');
    expect(misses).toContain('Medium');
  });

  it('re-checks a recycled node whose text did not change but whose group did', async () => {
    const { claudeSettings } = await import('./fixtures/ui-structures');
    const html = claudeSettings('general');
    const size = await at(html, 'size-m');
    const width = await at(html, 'width-m');
    document.body.innerHTML = html;
    applier = new PackApplier(document, rt([
      { kind: 'text', src: 'Medium', t: '中', ctx: size, status: 'auto' },
      { kind: 'text', src: 'Medium', t: '适中', ctx: width, status: 'auto' },
    ]));
    applier.start();
    const sizeM = document.getElementById('size-m')!;
    expect(sizeM.textContent).toBe('中');
    // A virtualized list moves the element (same text node) into the width group.
    document.getElementById('width-m')!.remove();
    document.querySelector('[aria-label="Transcript width"]')!.appendChild(sizeM);
    await tick();
    expect(sizeM.textContent).toBe('适中');
    // Moved to a place with no known context: the original comes back.
    document.body.appendChild(sizeM);
    await tick();
    expect(sizeM.textContent).toBe('Medium');
  });

  it('applies a new revision in place without flashing unchanged strings', async () => {
    start('<nav><button id="a">Settings</button><button id="b">New chat</button><button id="c">Archive</button></nav>');
    const a = document.getElementById('a')!.firstChild as Text;
    let writesToA = 0;
    const mo = new MutationObserver((rs) => rs.forEach((r) => r.target === a && writesToA++));
    mo.observe(document.body, { characterData: true, subtree: true });
    const next = toRuntime({
      ...emptyPack('app.example.com', 'zh-CN'),
      entries: [
        { kind: 'text', src: 'Settings', t: '设置', status: 'auto' },
        { kind: 'text', src: 'Archive', t: '归档', status: 'auto' },
      ],
    });
    applier!.update(next);
    await tick();
    mo.disconnect();
    expect(writesToA).toBe(0);
    expect(document.getElementById('b')!.textContent).toBe('New chat'); // removed from the pack: original back
    expect(document.getElementById('c')!.textContent).toBe('归档');
  });

  // 3000 rows on purpose: under a full parallel run this can take longer than the default 5 s.
  it('finishes large subtrees across frames and survives the app removing nodes mid-walk', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `<li id="r${i}"><button>Copy</button></li>`).join('');
    start(`<ul id="list">${rows}</ul>`);
    document.getElementById('r10')?.remove();
    for (let i = 0; i < 200 && document.getElementById('r2999')!.textContent !== '复制'; i++) await new Promise((r) => setTimeout(r, 5));
    expect(document.getElementById('r2999')!.textContent).toBe('复制');
    expect([...document.querySelectorAll('#list button')].every((b) => b.textContent === '复制')).toBe(true);
  }, 20_000);
});


describe('PackApplier after the review', () => {
  const html = (label: string) =>
    `<div role="group" aria-labelledby="lab"><span id="lab">${label}</span><div role="radiogroup"><span role="radio" id="m">Medium</span></div></div>`;
  const sigFor = async (label: string) => {
    const { describe: where, signatures } = await import('../src/pack/structure');
    document.body.innerHTML = html(label);
    const s = signatures(where(document.getElementById('m')!))[0]!;
    document.body.innerHTML = '';
    return s;
  };

  it('follows the app rewriting an already translated label, and a context that comes back', async () => {
    const size = await sigFor('Size');
    const width = await sigFor('Width');
    document.body.innerHTML = html('Size');
    applier = new PackApplier(document, rt([
      { kind: 'text', src: 'Size', t: '尺寸', status: 'auto' },
      { kind: 'text', src: 'Width', t: '宽度', status: 'auto' },
      { kind: 'text', src: 'Medium', t: '中', ctx: size, status: 'auto' },
      { kind: 'text', src: 'Medium', t: '适中', ctx: width, status: 'auto' },
    ]));
    applier.start();
    const lab = document.getElementById('lab')!.firstChild as Text;
    const m = document.getElementById('m')!;
    expect([lab.data, m.textContent]).toEqual(['尺寸', '中']);
    lab.data = 'Width'; // the app rewrites the (translated) label
    await tick();
    expect([lab.data, m.textContent]).toEqual(['宽度', '适中']);
    lab.data = 'Unknown';
    await tick();
    expect(m.textContent).toBe('Medium');
    lab.data = 'Size'; // the context comes back: so does its translation
    await tick();
    expect(m.textContent).toBe('中');
  });
});

describe('native option values and shared content boundaries', () => {
  it('pins the original effective option value and removes only our attribute on restore', () => {
    document.body.innerHTML = '<form><select name="theme"><option>  New chat  </option><option value="settings">Settings</option></select></form>';
    const form = document.querySelector('form')!;
    const select = document.querySelector('select')!;
    const value = select.value;
    const before = new FormData(form).get('theme');
    applier = new PackApplier(document, rt());
    applier.start();
    expect(select.options[0]!.textContent).toBe('  新建对话  ');
    expect(select.value).toBe(value);
    expect(new FormData(form).get('theme')).toBe(before);
    expect(select.options[0]!.hasAttribute('value')).toBe(true);
    applier.restore();
    expect(select.options[0]!.hasAttribute('value')).toBe(false);
    expect(select.options[1]!.getAttribute('value')).toBe('settings');
    expect(select.value).toBe(value);
  });

  it('releases a pinned value when the pack no longer applies, preserving app value changes', () => {
    start('<select><option>New chat</option></select>');
    const option = document.querySelector('option')!;
    applier!.update(toRuntime(emptyPack('app.example.com', 'zh-CN')));
    expect(option.textContent).toBe('New chat');
    expect(option.hasAttribute('value')).toBe(false);
    applier!.update(rt());
    option.setAttribute('value', 'app-owned');
    applier!.restore();
    expect(option.getAttribute('value')).toBe('app-owned');
  });

  it('repins an option after the app replaces its text and restores the new original', async () => {
    start('<select><option>New chat</option></select>');
    const option = document.querySelector('option')!;
    option.textContent = 'Settings';
    await tick();
    expect(option.textContent).toBe('设置');
    expect(option.value).toBe('Settings');
    applier!.restore();
    expect(option.textContent).toBe('Settings');
    expect(option.hasAttribute('value')).toBe(false);
  });

  it('does not translate personal link titles, table values or account details matching approved strings', () => {
    start(`<nav><a href="/chat/a1b2c3">Settings</a><a href="/settings">Settings</a></nav>
      <table><tbody><tr><td>New chat</td><td>Settings</td></tr></tbody></table>
      <button aria-label="Account" aria-haspopup="menu" aria-expanded="true" aria-controls="account">A</button>
      <div id="account" role="menu"><span>New chat</span><button role="menuitem">Settings</button></div>`);
    expect(document.querySelector('a')!.textContent).toBe('Settings');
    expect(document.querySelectorAll('a')[1]!.textContent).toBe('设置');
    expect([...document.querySelectorAll('td')].map((e) => e.textContent)).toEqual(['New chat', 'Settings']);
    expect(document.querySelector('#account span')!.textContent).toBe('New chat');
    expect(document.querySelector('#account button')!.textContent).toBe('设置');
  });
});

it('restores a detached option before releasing its pinned value, so it can be safely reattached', async () => {
  start('<select><option>New chat</option></select>');
  const select = document.querySelector('select')!;
  const option = document.querySelector('option')!;
  option.remove();
  await tick();
  expect(option.textContent).toBe('New chat');
  expect(option.hasAttribute('value')).toBe(false);
  select.append(option);
  await tick();
  expect(option.textContent).toBe('新建对话');
  expect(select.value).toBe('New chat');
});

it('restores owned text and attributes when nodes move into personal links or table data cells', async () => {
  start('<nav><button id="b" title="Share">Settings</button><button id="c">New chat</button></nav><table><tbody><tr><td id="cell"></td></tr></tbody></table><a href="/chat/a1b2c3" id="personal"></a>');
  const b = document.getElementById('b')!, c = document.getElementById('c')!;
  expect(b.textContent).toBe('设置');
  document.getElementById('cell')!.append(b);
  document.getElementById('personal')!.append(c);
  await tick();
  expect(b.textContent).toBe('Settings');
  expect(b.getAttribute('title')).toBe('Share');
  expect(c.textContent).toBe('New chat');
});

it('rechecks a translated link when its href becomes personal, and an ancestor becomes editable', async () => {
  start('<nav><a id="link" href="/settings">Settings</a><span id="label">New chat</span></nav>');
  const link = document.getElementById('link')!, label = document.getElementById('label')!;
  link.setAttribute('href', '/chat/a1b2c3');
  label.parentElement!.setAttribute('contenteditable', 'true');
  await tick();
  expect(link.textContent).toBe('Settings');
  expect(label.textContent).toBe('New chat');
});

it('limits ordinary attribute boundary checks to the changed subtree and keeps href checks global', async () => {
  const pack = start(`<aside id="unrelated"></aside><nav>${'<button>Settings</button>'.repeat(400)}</nav>`);
  await new Promise((r) => setTimeout(r, 50));
  const internal = pack as unknown as { checkContentBoundary(n: Node): void; onRecords(r: MutationRecord[]): void; owned: Set<Node> };
  expect(internal.owned.size).toBe(400);
  const boundary = vi.spyOn(internal, 'checkContentBoundary');
  const record = (target: Element, name: string) => ({ type: 'attributes', target, attributeName: name } as unknown as MutationRecord);
  internal.onRecords([record(document.getElementById('unrelated')!, 'class')]);
  expect(boundary).not.toHaveBeenCalled();
  internal.onRecords([record(document.querySelector('button')!, 'class')]);
  expect(boundary).toHaveBeenCalledTimes(1);
  boundary.mockClear();
  internal.onRecords([record(document.getElementById('unrelated')!, 'href')]);
  expect(boundary).toHaveBeenCalledTimes(400);
});

it('snapshots owned nodes only once for a removal batch and does not release unrelated nodes', () => {
  const pack = start('<nav><button>Settings</button></nav>');
  const internal = pack as unknown as { onRecords(r: MutationRecord[]): void; owned: Set<Node>; giveBack(n: Text): void; drain(): void };
  vi.spyOn(internal, 'drain').mockImplementation(() => {});
  const iterator = vi.spyOn(internal.owned, Symbol.iterator);
  const release = vi.spyOn(internal, 'giveBack');
  const removed = [document.createElement('div'), document.createElement('span')];
  internal.onRecords(removed.map((node) => ({ type: 'childList', target: document.body, removedNodes: [node], addedNodes: [] } as unknown as MutationRecord)));
  expect(iterator).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  expect(document.querySelector('button')!.textContent).toBe('设置');
});

it('releases only the affected pinned option without enumerating all owned nodes', async () => {
  const pack = start(`<button>Settings</button><select>${'<option>New chat</option>'.repeat(40)}</select>`);
  await tick();
  const internal = pack as unknown as { owned: Set<Node>; giveBack(n: Text): void };
  const iterator = vi.spyOn(internal.owned, Symbol.iterator);
  internal.giveBack(document.querySelector('button')!.firstChild as Text);
  expect(iterator).not.toHaveBeenCalled();
  const options = document.querySelectorAll('option');
  const text = options[0]!.firstChild as Text;
  text.remove();
  internal.giveBack(text);
  expect(options[0]!.hasAttribute('value')).toBe(false);
  expect(options[1]!.getAttribute('value')).toBe('New chat');
  expect(iterator).not.toHaveBeenCalled();
});
