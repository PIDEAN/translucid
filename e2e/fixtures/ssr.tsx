import { useState } from 'react';
import { hydrateRoot } from 'react-dom/client';

declare global {
  interface Window {
    __hydrationErrors: string[];
    __hydrated: boolean;
  }
}
window.__hydrationErrors = [];

function App() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <button id="new">New chat</button>
      <button id="inc" onClick={() => setCount((c) => c + 1)}>Settings</button>
      <span id="count">{count}</span>
    </main>
  );
}

// Hydrate a little after load, like a large app bundle would.
setTimeout(() => {
  hydrateRoot(document.getElementById('root')!, <App />, {
    onRecoverableError: (e) => window.__hydrationErrors.push(String((e as Error)?.message ?? e)),
  });
  window.__hydrated = true;
}, 200);
