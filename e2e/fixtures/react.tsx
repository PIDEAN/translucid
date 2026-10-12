import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';

const ACTIONS = ['Archive', 'Rename', 'Delete'];

/** Fixed pool of row elements whose text changes as you scroll: DOM nodes are recycled. */
function VirtualList() {
  const [offset, setOffset] = useState(0);
  return (
    <div>
      <button id="scroll" onClick={() => setOffset((o) => o + 1)}>Next page</button>
      <ul id="rows">
        {Array.from({ length: 6 }, (_, slot) => (
          <li key={slot} className="row">{ACTIONS[(slot + offset) % ACTIONS.length]}</li>
        ))}
      </ul>
    </div>
  );
}

function App() {
  const [count, setCount] = useState(0);
  const [mode, setMode] = useState(false);
  return (
    <main>
      <nav aria-label="Sidebar">
        <button id="new">New chat</button>
        <button id="swap" onClick={() => setMode((m) => !m)}>{mode ? 'Settings' : 'New chat'}</button>
        <input id="search" placeholder="Search chats" />
      </nav>
      <button id="inc" onClick={() => setCount((c) => c + 1)}>Settings</button>
      <span id="count">{count}</span>
      <VirtualList />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
