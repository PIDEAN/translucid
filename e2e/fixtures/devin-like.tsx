// A hub-and-subpage settings area with client-side routing, shaped like real
// agent workspaces: sidebar landmarks, menu triggers (Base UI), settings links
// under headings, session links that a scan must never open, and one link the
// router does not handle (a full page load a scan must cancel). Invented names.
import { Menu } from '@base-ui/react/menu';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

declare global {
  interface Window {
    __visited: string[];
  }
}
window.__visited = [];
if (!location.pathname.startsWith('/org/')) history.replaceState(null, '', '/org/acme/settings');

const PAGES: Record<string, { title: string; body: string }> = {
  '/org/acme/settings': { title: 'Settings', body: 'Manage your organization.' },
  '/org/acme/settings/members': { title: 'Members', body: 'Invite teammates and manage roles.' },
  '/org/acme/settings/billing': { title: 'Billing', body: 'Usage-based billing and invoices.' },
  '/org/acme/settings/integrations': { title: 'Integrations', body: 'Connect source control and chat tools.' },
};

function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener('popstate', on);
    addEventListener('app:navigate', on);
    return () => {
      removeEventListener('popstate', on);
      removeEventListener('app:navigate', on);
    };
  }, []);
  return path;
}

function Link({ to, children, route = true }: { to: string; children: string; route?: boolean }) {
  return (
    <a
      href={to}
      onClick={(e) => {
        if (!route) return; // not handled by the router: the browser would load the page
        e.preventDefault();
        history.pushState(null, '', to);
        window.__visited.push(to);
        dispatchEvent(new Event('app:navigate'));
      }}
    >
      {children}
    </a>
  );
}

function App() {
  const path = usePath();
  const page = PAGES[path] ?? { title: 'Not found', body: '' };
  return (
    <div data-testid="shell">
      <aside aria-label="Session navigation">
        <nav aria-label="Primary">
          <Link to="/org/acme/new">New session</Link>
        </nav>
        <div data-testid="recent-sessions">
          <Link to="/org/acme/sessions/9a7d4e21-3f2b-8c1e-b5c3-0d9e8f7a6b5d">Fix login redirect for Mira</Link>
        </div>
        <Menu.Root>
          <Menu.Trigger>Help</Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner>
              <Menu.Popup>
                <Menu.Item>Documentation</Menu.Item>
                <Menu.Item>Keyboard shortcuts</Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </aside>
      <main>
        <h2>{page.title}</h2>
        <p>{page.body}</p>
        {path === '/org/acme/settings' && (
          <>
            <h3>Organization</h3>
            <Link to="/org/acme/settings/members">Members</Link>
            <Link to="/org/acme/settings/billing">Billing</Link>
            <h3>Workspace</h3>
            <Link to="/org/acme/settings/integrations">Integrations</Link>
            <Link to="/org/acme/settings/legacy" route={false}>
              Legacy settings
            </Link>
          </>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
