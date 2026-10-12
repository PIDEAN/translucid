// A settings-heavy app shaped like real productivity tools (hash-routed
// settings dialog whose nav buttons are cousins under ul > li, lazily rendered
// sections, grouped radios, a select whose trigger labels itself with its
// value, portalled popups without aria-controls, user-owned cards, an account
// menu), built with real Base UI and Radix components. All names are invented.
// window.__changed / __danger / __loggedOut record anything a scan must never do.
import { Dialog } from '@base-ui/react/dialog';
import { Menu } from '@base-ui/react/menu';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Select } from '@base-ui/react/select';
import { Switch } from '@base-ui/react/switch';
import { Tabs } from '@base-ui/react/tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { StrictMode, useEffect, useId, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

declare global {
  interface Window {
    __changed: boolean;
    __danger: boolean;
    __loggedOut: boolean;
  }
}
window.__changed = false;
window.__danger = false;
window.__loggedOut = false;
const changed = () => (window.__changed = true);

const SECTIONS = [
  ['general', 'General'],
  ['account', 'Account'],
  ['privacy', 'Privacy'],
  ['billing', 'Billing'],
  ['capabilities', 'Capabilities'],
  ['skills', 'Skills'],
] as const;
type SectionId = (typeof SECTIONS)[number][0];

function useHash(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Group({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={`${id}-l`} aria-describedby={description ? `${id}-d` : undefined} className="group">
      <span id={`${id}-l`}>{label}</span>
      {description && <div id={`${id}-d`}>{description}</div>}
      {children}
    </div>
  );
}

function Radios({ label, options, initial }: { label: string; options: string[]; initial: string }) {
  return (
    <RadioGroup aria-label={label} defaultValue={initial} onValueChange={changed}>
      {options.map((o) => (
        <label key={o} className="radio">
          <Radio.Root value={o}>
            <Radio.Indicator />
          </Radio.Root>
          <span>{o}</span>
        </label>
      ))}
    </RadioGroup>
  );
}

function Picker({ items, initial }: { items: string[]; initial: string }) {
  const id = useId();
  return (
    <Select.Root items={items.map((i) => ({ label: i, value: i }))} defaultValue={initial} onValueChange={changed}>
      <Select.Trigger id={`${id}-trigger`} aria-labelledby={`${id}-trigger-value`}>
        <Select.Value id={`${id}-trigger-value`} />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner>
          <Select.Popup>
            <Select.List>
              {items.map((i) => (
                <Select.Item key={i} value={i}>
                  <Select.ItemText>{i}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function Section({ id }: { id: SectionId }) {
  // Sections render a moment after the route changes, like code-split pages.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 120);
    return () => clearTimeout(t);
  }, [id]);
  if (!ready) return <div className="loading" />;
  switch (id) {
    case 'general':
      return (
        <>
          <h3>Appearance</h3>
          <Group label="Transcript text size" description="Size of text in the transcript.">
            <Radios label="Transcript text size" options={['Small', 'Medium', 'Large']} initial="Medium" />
          </Group>
          <Group label="Transcript width" description="Maximum width of the transcript column.">
            <Radios label="Transcript width" options={['Narrow', 'Medium', 'Wide']} initial="Medium" />
          </Group>
          <Group label="Chat font">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger>Serif</DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content>
                  {['Serif', 'Sans', 'Dyslexic friendly'].map((f) => (
                    <DropdownMenu.Item key={f} onSelect={changed}>
                      {f}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </Group>
        </>
      );
    case 'account':
      return (
        <>
          <h3>Profile</h3>
          <input aria-label="Full name" defaultValue="Mira Chen" />
          <Group label="What best describes your work?">
            <div>
              <div>
                <Picker items={['Engineering', 'Design', 'Product management', 'Research']} initial="Engineering" />
              </div>
            </div>
          </Group>
          <button type="button" aria-haspopup="dialog" onClick={() => (window.__danger = true)}>
            Delete account
          </button>
        </>
      );
    case 'privacy':
      return (
        <>
          <h3>Privacy</h3>
          <Group label="Location metadata" description="Allow approximate location in conversations.">
            <Switch.Root aria-label="Location metadata" defaultChecked onCheckedChange={changed}>
              <Switch.Thumb />
            </Switch.Root>
          </Group>
        </>
      );
    case 'billing':
      return (
        <Tabs.Root defaultValue="plan">
          <Tabs.List>
            <Tabs.Tab value="plan">Plan</Tabs.Tab>
            <Tabs.Tab value="invoices">Invoices</Tabs.Tab>
            <Tabs.Tab value="payment">Payment</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="plan">Your current plan renews monthly.</Tabs.Panel>
          <Tabs.Panel value="invoices">Past invoices appear here.</Tabs.Panel>
          <Tabs.Panel value="payment">Update the card used for billing.</Tabs.Panel>
        </Tabs.Root>
      );
    case 'capabilities':
      return (
        <>
          <h3>Capabilities</h3>
          <Group label="Response length">
            <Radios label="Response length" options={['Short', 'Medium', 'Long']} initial="Medium" />
          </Group>
        </>
      );
    case 'skills':
      return (
        <>
          <h3>Your skills</h3>
          <div className="grid">
            {[
              ['weekly-digest', 'Summarizes my week for Mira'],
              ['Trip planner', 'Plans the Lisbon trip'],
            ].map(([name, desc]) => (
              <div className="card" key={name}>
                <h4>{name}</h4>
                <p>{desc}</p>
                <Menu.Root>
                  <Menu.Trigger aria-label="More options" />
                  <Menu.Portal>
                    <Menu.Positioner>
                      <Menu.Popup>
                        <Menu.Item onClick={changed}>Edit skill</Menu.Item>
                        <Menu.Item onClick={() => (window.__danger = true)}>Remove skill</Menu.Item>
                      </Menu.Popup>
                    </Menu.Positioner>
                  </Menu.Portal>
                </Menu.Root>
                <span>Enabled</span>
              </div>
            ))}
          </div>
        </>
      );
  }
}

function Settings() {
  const hash = useHash();
  const m = hash.match(/^#(?:settings|customize)\/(\w+)/);
  const open = !!m;
  const current = (SECTIONS.find(([id]) => id === m?.[1])?.[0] ?? 'general') as SectionId;
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && history.replaceState(null, '', location.pathname)}>
      <Dialog.Portal>
        <Dialog.Popup className="settings">
          <nav aria-label="Settings">
            <Dialog.Title>Settings</Dialog.Title>
            <ul>
              {SECTIONS.map(([id, label]) => (
                <li key={id} data-testid={`${id}-settings`}>
                  <button type="button" aria-current={current === id ? 'page' : undefined} onClick={() => (location.hash = `#${id === 'skills' ? 'customize' : 'settings'}/${id}`)}>
                    <span aria-hidden="true">•</span>
                    <span>{label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <div className="content">
            <Dialog.Close aria-label="Close" />
            <Section key={current} id={current} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function App() {
  return (
    <>
      <aside aria-label="Sidebar">
        <a href="#new" aria-current="page">
          New chat
        </a>
        <div data-testid="recents">
          <a href="/chat/3f2b8c1e-9a7d-4e21-b5c3-0d9e8f7a6b5c">Trip planning with Mira</a>
        </div>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger data-testid="user-menu-button">
            <span>MC</span>
            <span>Mira Chen</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <div>mira.chen@example.org</div>
              <DropdownMenu.Item onSelect={() => (location.hash = '#settings/general')}>Settings</DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => (window.__loggedOut = true)}>Log out</DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </aside>
      <main>
        <h1>Good evening</h1>
        <button type="button" id="open-settings" onClick={() => (location.hash = '#settings/general')}>
          Open settings
        </button>
      </main>
      <Settings />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
