import { Background } from './components/Background.jsx';
import { render } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { field } from './state.js';
import { setUpDevice } from './device.js';

import { Header } from './components/Header.jsx';
import { CommandBar } from './components/CommandBar.jsx';
import { Colors } from './components/Colors.jsx';
import { AutoMode } from './components/AutoMode.jsx';
import { Warm } from './components/Warm.jsx';
import { Effects } from './components/Effects.jsx';
import { Cues } from './components/Cues.jsx';
import { Fixtures } from './components/Fixtures.jsx';
import { StagePreview } from './components/StagePreview.jsx';
import { BottomDrawer } from './components/BottomDrawer.jsx';
import { ConnectionVeil } from './components/ConnectionVeil.jsx';
import { ShortcutsOverlay } from './components/Shortcuts.jsx';
import { Perform } from './components/Perform.jsx';
import { Show } from './components/Show.jsx';
import { Strip } from './components/Strip.jsx';
import { TimelineView } from './components/TimelineView.jsx';
import { StageView } from './components/StageView.jsx';
import { Sequence } from './components/Sequence.jsx';
import { SubTabs, SubPanel, useSubTab } from './components/setup/SubTabs.jsx';
import { Transport } from './components/Transport.jsx';
import { useTapShortcut } from './keys.js';
import { RigView } from './components/setup/RigView.jsx';
import { SourcesView } from './components/setup/SourcesView.jsx';
import { SettingsView } from './components/setup/SettingsView.jsx';
import { PreflightView } from './components/setup/PreflightView.jsx';
import { Wizard, useFirstRun } from './components/setup/Wizard.jsx';

import { VIEWS, VIEW_IDS, viewShortcut, resolveRoute } from './views.js';
import { pageTitle } from './brand.js';

const viewOfHash = () => resolveRoute(window.location.hash)?.view;

function initialView() {
  let route = resolveRoute(window.location.hash);
  if (!route) {
    try { route = resolveRoute(localStorage.getItem('lightshow.mode')); } catch { /* private mode */ }
  }
  const canonical = route?.canonical || 'show';
  window.history.replaceState(null, '', `#${canonical}`);
  return route?.view || 'show';
}

// Stored when chosen, not after the view renders: a reload during a slow first render keeps it.
function rememberView(mode) {
  try { localStorage.setItem('lightshow.mode', mode); } catch { /* private mode */ }
  // A view with tabs of its own keeps its part of the hash (/#rig/outputs).
  const route = resolveRoute(window.location.hash);
  const path = route?.view === mode ? route.canonical : mode;
  if (window.location.hash !== `#${path}`) window.history.replaceState(null, '', `#${path}`);
}

function ModeTabs({ mode, setMode }) {
  // Subscribes here rather than in Root, so an auto-show status change re-renders
  // this tab strip alone instead of the whole tree.
  const strip = useRef(null);
  // Measured in the next frame, whose layout is due anyway: read here, offsetLeft
  // forced layout of the view that had just mounted.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const tab = document.getElementById(`tab-${mode}`);
      if (tab && strip.current) strip.current.scrollLeft = tab.offsetLeft - strip.current.offsetLeft;
    });
    return () => cancelAnimationFrame(frame);
  }, [mode]);
  const autoShow = field('autoShow').value;
  const autoActive = !!(autoShow && autoShow.status && autoShow.status !== 'idle');

  // A tab strip is one stop in the tab order: the arrow keys, Home and End
  // move between its tabs (the ARIA tabs pattern).
  const onKeyDown = (e) => {
    const at = VIEW_IDS.indexOf(mode);
    const to = e.key === 'ArrowRight' ? (at + 1) % VIEWS.length
      : e.key === 'ArrowLeft' ? (at - 1 + VIEWS.length) % VIEWS.length
        : e.key === 'Home' ? 0 : e.key === 'End' ? VIEWS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setMode(VIEW_IDS[to]);
    document.getElementById(`tab-${VIEW_IDS[to]}`)?.focus();
  };

  return (
    <>
      <button class="mode-scroll" type="button" aria-label="Scroll views left" onClick={() => strip.current.scrollBy({ left: -strip.current.clientWidth })}>‹</button>
      <div ref={strip} class={`mode-tabs in-${mode}`} role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
        {VIEWS.map((v, i) => [
          i > 0 && VIEWS[i - 1].group !== v.group && <span key={`sep-${v.id}`} class="mode-tab-sep" role="presentation" />,
          <button
            key={v.id}
            id={`tab-${v.id}`}
            role="tab"
            type="button"
            aria-selected={mode === v.id}
            aria-controls={`panel-${v.id}`}
            tabIndex={mode === v.id ? 0 : -1}
            class={`mode-tab ${mode === v.id ? 'active' : ''}`}
            onClick={() => setMode(v.id)}
          >
            <span class="mode-tab-icon" aria-hidden="true">{v.icon}</span>
            <span class="mode-tab-label">{v.label}</span>
            <span class="mode-tab-hint">{v.id === 'auto' && autoActive ? 'Running' : v.hint}</span>
            {v.id === 'auto' && autoActive && <span class="mode-tab-dot" aria-hidden="true" />}
            {v.key && <kbd class="mode-tab-key" aria-hidden="true">{v.shift ? '⇧' : ''}{v.key}</kbd>}
          </button>,
        ])}
      </div>
      <button class="mode-scroll" type="button" aria-label="Scroll views right" onClick={() => strip.current.scrollBy({ left: strip.current.clientWidth })}>›</button>
    </>
  );
}

function EffectsView() {
  return (
    <div class="manual-view">
      <div class="manual-col col-patterns"><Cues /><Effects /></div>
      <div class="manual-col col-colors"><Colors /><Background /></div>
      <div class="manual-col col-fixtures"><StagePreview /><Fixtures /></div>
    </div>
  );
}

const AUTO_TABS = [{ id: 'show', label: 'Show' }, { id: 'timeline', label: 'Timeline' }];
function AutoView() {
  const [tab, setTab] = useSubTab('auto', AUTO_TABS);
  return (
    <div class="auto-view">
      <Transport prefer="auto" />
      <SubTabs view="auto" tabs={AUTO_TABS} tab={tab} setTab={setTab} label="Auto Show" />
      <SubPanel view="auto" tab={tab}>
        {tab === 'timeline' ? <TimelineView /> : <><AutoMode /><Warm /></>}
      </SubPanel>
    </div>
  );
}

// The bars stacked above a view, whose heights the sticky offsets in style.css read.
const BARS = [['header', '.app-header'], ['commands', '.command-bar'], ['views', '.mode-nav'], ['effects', '.effects-tools']];

const LIVE_VIEWS = new Set(VIEWS.filter((view) => view.group === 'live').map((view) => view.id));

const PANELS = {
  show: Show,
  effects: EffectsView,
  auto: AutoView,
  perform: Perform,
  stage: StageView,
  sequence: Sequence,
  rig: RigView,
  sources: SourcesView,
  settings: SettingsView,
  preflight: PreflightView,
};

function Root() {
  // Deliberately reads no signals. Subscribing the root made every component in
  // the tree re-render on every push; each component now subscribes to what it
  // actually needs.
  const [mode, showMode] = useState(initialView);
  const setMode = useCallback((next) => { rememberView(next); showMode(next); }, []);
  const Panel = PANELS[mode];
  // The strip — arm, picture source, auto show, blackout, master — sits above every live view.
  const live = LIVE_VIEWS.has(mode);
  // Show uses the header's look controls; Perform also carries its own transport.
  const bare = mode === 'show' || mode === 'perform';
  useFirstRun();
  useTapShortcut();

  // The bars' heights as the ResizeObserver reports them, from the layout the
  // frame computes anyway; measuring them on a switch forced style and layout of
  // the whole view that had just mounted.
  useEffect(() => {
    const root = document.documentElement.style;
    const names = new Map();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize && entry.borderBoxSize[0];
        root.setProperty(`--${names.get(entry.target)}-height`, `${box ? box.blockSize : entry.target.getBoundingClientRect().height}px`);
      }
    });
    for (const [name, selector] of BARS) {
      const element = document.querySelector(selector);
      if (element) {
        names.set(element, name);
        observer.observe(element);
      } else {
        root.setProperty(`--${name}-height`, '0px');
      }
    }
    return () => observer.disconnect();
  }, [mode]);

  useEffect(() => {
    document.title = pageTitle(VIEWS.find((view) => view.id === mode)?.label);
    rememberView(mode);
  }, [mode]);

  useEffect(() => {
    const onHash = () => {
      const hash = viewOfHash();
      if (VIEW_IDS.includes(hash)) setMode(hash);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // View shortcuts leave keys handled by the focused control alone.
  useEffect(() => {
    const onKey = (e) => {
      const view = viewShortcut(e);
      if (view) { e.preventDefault(); setMode(view.id); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {/* Focuses the view without touching the hash, which names the view. */}
      <a class="skip-link" href="#main" onClick={(e) => {
        e.preventDefault();
        document.getElementById(`panel-${mode}`)?.focus();
      }}>Skip to the controls</a>
      <Header />
      {!bare && <CommandBar transport={mode !== 'auto' && mode !== 'sequence'} />}
      <nav class="mode-nav" aria-label="Views">
        <ModeTabs mode={mode} setMode={setMode} />
      </nav>
      {live && <Strip />}
      <main id="main" class={`mode-${mode}`}>
        <div id={`panel-${mode}`} class="view-panel" role="tabpanel" aria-labelledby={`tab-${mode}`} tabIndex={-1}>
          <Panel />
        </div>
      </main>
      <footer class="app-footer">
        {!bare && <BottomDrawer />}
        <ShortcutsOverlay />
      </footer>
      <Wizard />
      <ConnectionVeil />
    </>
  );
}

setUpDevice();
render(<Root />, document.getElementById('app'));
