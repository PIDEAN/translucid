// Synthetic markup mirroring structures observed on real productivity apps
// (Base UI / Radix + Tailwind, React useId ids). All names are invented.

/** Settings modal: nav buttons are cousins under ul > li, only the active section is rendered. */
export function claudeSettings(section: 'general' | 'account' = 'general'): string {
  const nav = ['General', 'Account', 'Privacy', 'Billing']
    .map((n) => `<li data-testid="${n.toLowerCase()}-settings"><button type="button"${n.toLowerCase() === section ? ' aria-current="page"' : ''} class="flex h-control w-full"><span aria-hidden="true">•</span><span class="min-w-0 truncate">${n}</span></button></li>`)
    .join('');
  const general = `
    <h3>Appearance</h3>
    <div role="group" aria-labelledby="_r_a1_"><span id="_r_a1_">Theme</span>
      <div role="radiogroup" aria-label="Theme">
        <span role="radio" aria-checked="true" aria-label="System"></span>
        <span role="radio" aria-checked="false" aria-label="Light"></span>
        <span role="radio" aria-checked="false" aria-label="Dark"></span>
      </div></div>
    <div role="group" aria-labelledby="_r_a2_" aria-describedby="_r_a3_"><span id="_r_a2_">Transcript text size</span><div id="_r_a3_">Size of text in the transcript.</div>
      <div role="radiogroup" aria-label="Transcript text size"><span role="radio" id="size-s">Small</span><span role="radio" id="size-m">Medium</span><span role="radio">Large</span></div></div>
    <div role="group" aria-labelledby="_r_a4_" aria-describedby="_r_a5_"><span id="_r_a4_">Transcript width</span><div id="_r_a5_">Maximum width of the transcript column.</div>
      <div role="radiogroup" aria-label="Transcript width"><span role="radio">Narrow</span><span role="radio" id="width-m">Medium</span><span role="radio">Wide</span></div></div>
    <div role="group" aria-labelledby="_r_a6_"><span id="_r_a6_">Chat font</span>
      <button type="button" role="combobox" aria-expanded="false" aria-haspopup="dialog" aria-label="Chat font"><span>Serif</span></button></div>
    <div role="group" aria-labelledby="_r_a7_" aria-describedby="_r_a8_"><span id="_r_a7_">Scheduled tasks</span><div id="_r_a8_">Get notified when scheduled tasks finish.</div>
      <span role="switch" aria-checked="true" aria-label="Scheduled tasks"></span></div>`;
  const account = `
    <h3>Profile</h3>
    <input aria-label="Full name"><input aria-label="Display name">
    <div role="group" aria-labelledby="_r_b1_"><span id="_r_b1_">What best describes your work?</span>
      <div><div><button type="button" id="_r_b2_-trigger" role="combobox" aria-expanded="false" aria-haspopup="dialog" aria-labelledby="_r_b2_-trigger-value"><span id="_r_b2_-trigger-value">Engineering</span></button></div></div></div>
    <h3>Account</h3>`;
  return `
    <div role="dialog" aria-labelledby="base-ui-_r_d1_" class="fixed inset-0">
      <nav aria-label="Settings"><h2 id="base-ui-_r_d1_">Settings</h2>
        <ul aria-labelledby="_r_n0_">${nav}</ul></nav>
      <div class="content"><button type="button" aria-label="Close"></button>${section === 'general' ? general : account}</div>
    </div>`;
}

/** Listbox popup portalled to <body>, opened from the occupation combobox (no aria-controls). */
export const occupationPopup = `
  <div role="listbox" id="_r_p1_"><div role="option">Engineering</div><div role="option">Design</div><div role="option">Product management</div></div>`;

/** Sidebar with nav items, a chat list (user content) and an account trigger. */
export const sidebar = `
  <aside aria-label="Sidebar"><div data-testid="sidebar">
    <div data-testid="nav-pin-rows">
      <div data-row><a href="/new" aria-current="page"><span>New</span></a></div>
      <div data-row><a href="/projects"><span>Projects</span></a></div>
      <div data-row><a href="/artifacts"><span>Artifacts</span></a></div>
    </div>
    <div data-testid="sidebar-recents">
      <a href="/chat/3f2b8c1e-9a7d-4e21-b5c3-0d9e8f7a6b5c"><span>Trip planning with Mira</span></a>
      <a href="/chat/9a7d4e21-3f2b-8c1e-b5c3-0d9e8f7a6b5d"><span>Budget review</span></a>
    </div>
    <button type="button" aria-haspopup="menu" aria-expanded="false" data-testid="user-menu-button"><span>MC</span><span>Mira Chen</span><span>Pro</span></button>
  </div></aside>`;

/** Devin-style shell: landmarks, menu triggers, settings hub links under headings. */
export const devinShell = `
  <div data-testid="sidebar"><aside aria-label="Session navigation" data-state="expanded">
    <nav aria-label="Primary"><a href="/org/acme/new" aria-current="page">New session</a></nav>
    <nav aria-label="Pages"><ul><li><a href="/org/acme/automations">Automations</a></li><li><a href="/org/acme/review">Review</a></li><li><a href="/org/acme/wiki">Wiki</a></li></ul></nav>
    <button type="button" aria-haspopup="menu" aria-expanded="false">New</button>
    <button type="button" aria-haspopup="menu" aria-expanded="false">Help</button>
  </aside></div>
  <main><h2>Acme</h2><h3>Products</h3><a href="/org/acme/settings/devin">Devin</a><h3>Administration</h3><a href="/org/acme/settings/members">Members</a></main>`;

/** Two user-made cards (skills/connectors style): names and descriptions are the user's, "More options" is UI. */
export const userCards = `
  <main><h2>Skills</h2><div class="grid gap-3">
    <div class="card rounded-xl"><h3 id="c1">pdf-helper</h3><p id="d1">Fills PDF forms for Mira</p><button type="button" aria-haspopup="menu" aria-label="More options"></button><span id="e1">Enabled</span></div>
    <div class="card rounded-xl"><h3 id="c2">Weekly digest</h3><p id="d2">Summarizes my week</p><button type="button" aria-haspopup="menu" aria-label="More options"></button><span id="e2">Enabled</span></div>
  </div></main>`;

/** A single user item in a list. */
export const singleCard = `<main><ul><li><span id="only">My travel connector</span><button type="button" aria-haspopup="menu" aria-label="More options"></button></li></ul></main>`;

/** Transcript with a control under a message. */
export const transcript = `
  <main><div role="log"><div data-message-author-role="user"><p id="msg">Hello there, plan my week</p></div><button type="button" id="copy">Copy</button></div></main>`;

/** Account menu portalled to <body>, opened from the sidebar account trigger. */
export const accountMenu = `
  <div role="menu" id="acct"><div id="who">Mira Chen</div><div role="menuitem" id="mi-settings">Settings</div><div role="menuitem" id="mi-help">Get help</div><div role="menuitem" id="mi-out">Log out</div></div>`;

/** Model picker options: a listbox, never a user list. */
export const modelPicker = `<div role="listbox"><div role="option" id="m1">Opus 5.5</div><div role="option" id="m2">Haiku 5.5</div><div role="option" id="m3">More models</div></div>`;

/** GitHub-style settings page: native forms (fieldset/legend, radio inputs, select, checkboxes with notes). */
export const githubSettings = `
  <header><button aria-haspopup="menu" aria-label="Open user navigation menu"><img alt="@mira-chen" src="data:,"></button></header>
  <div class="layout">
    <nav aria-label="User settings"><h2>Public profile</h2><ul>
      <li><a href="/settings/profile">Public profile</a></li>
      <li><a href="/settings/admin">Account</a></li>
      <li><a href="/settings/appearance" aria-current="page">Appearance</a></li>
      <li><a href="/settings/accessibility">Accessibility</a></li>
      <li><a href="/settings/notifications">Notifications</a></li></ul></nav>
    <main><h2>Theme preferences</h2>
      <form>
        <fieldset><legend>Theme mode</legend>
          <label><input type="radio" name="mode" value="single" checked> Single theme</label>
          <label><input type="radio" name="mode" value="sync"> Sync with system</label></fieldset>
        <label for="tab-size">Tab size preference</label>
        <select id="tab-size"><option>2</option><option>4</option><option selected>8</option></select>
        <label for="emoji-skin">Emoji skin tone preference</label>
        <select id="emoji-skin" aria-describedby="emoji-note"><option>Default</option><option>Light</option><option>Medium</option><option>Dark</option></select>
        <p id="emoji-note" class="note">Preferred default emoji skin tone.</p>
        <div class="form-checkbox"><label><input type="checkbox" aria-describedby="motion-note"> Reduce motion</label>
          <p id="motion-note" class="note">Limit animations across the site.</p></div>
        <button type="submit">Update preferences</button>
      </form>
      <h2>Members</h2>
      <table><thead><tr><th>Name</th><th>Role</th></tr></thead>
        <tbody><tr><td id="n1">Mira Chen</td><td>Owner</td></tr><tr><td id="n2">Jonas Weber</td><td>Member</td></tr><tr><td>Ana Ruiz</td><td>Member</td></tr></tbody></table>
    </main></div>`;

/** Linear-style settings: rows with title + description on the left and the control on the right, no group roles. */
export const linearSettings = `
  <aside aria-label="Settings navigation">
    <button type="button" aria-haspopup="menu" id="ws">Acme's Workspace</button>
    <div><h4>Account</h4><a href="/settings/account/preferences" aria-current="page">Preferences</a><a href="/settings/account/profile">Profile</a><a href="/settings/account/security">Security &amp; access</a></div>
  </aside>
  <main><h1>Preferences</h1><h2>Interface and theme</h2>
    <div class="row"><div><div class="title">Display density</div><div class="desc">How much space items take up.</div></div>
      <div role="radiogroup"><button role="radio" aria-checked="true">Compact</button><button role="radio" aria-checked="false">Comfortable</button></div></div>
    <div class="row"><div><div class="title">Font size</div><div class="desc">Text size across the app.</div></div>
      <div role="radiogroup"><button role="radio" aria-checked="false">Small</button><button role="radio" aria-checked="true">Medium</button><button role="radio" aria-checked="false">Large</button></div></div>
    <div class="row"><div><div class="title">Open in desktop app</div><div class="desc">Automatically open links in the desktop app.</div></div>
      <button role="switch" aria-checked="false"></button></div>
    <div class="row"><div><div class="title">Home view</div></div><button type="button" aria-haspopup="menu" aria-expanded="false">Inbox</button></div>
  </main>`;
