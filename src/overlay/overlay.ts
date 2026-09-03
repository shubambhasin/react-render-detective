import { explainEvents, formatExplanation } from "../core/explain.js";
import { getDetective } from "../core/store.js";
import type { RenderEvent } from "../core/types.js";

export interface OverlayHandle {
  destroy: () => void;
  show: () => void;
  hide: () => void;
}

const MOUNTED = Symbol.for("react-render-detective.overlay");
type Global = typeof globalThis & { [MOUNTED]?: OverlayHandle };

/**
 * Development overlay.
 *
 * Deliberately plain DOM: rendering the inspector *inside* the app's React tree
 * would add renders to the tree it is measuring. It consumes the same event
 * model as console mode — no diagnostic logic is duplicated here (§68).
 */
export function mountOverlay(): OverlayHandle {
  const g = globalThis as Global;
  if (g[MOUNTED]) return g[MOUNTED] as OverlayHandle;
  if (typeof document === "undefined") {
    const noop: OverlayHandle = { destroy: () => {}, show: () => {}, hide: () => {} };
    return noop;
  }

  const detective = getDetective();
  const root = document.createElement("div");
  root.setAttribute("data-rrd-overlay", "");
  root.attachShadow({ mode: "open" });
  const shadow = root.shadowRoot as ShadowRoot;
  shadow.innerHTML = TEMPLATE;
  document.body.appendChild(root);

  const $ = <T extends HTMLElement>(sel: string): T => shadow.querySelector(sel) as T;
  const listEl = $<HTMLDivElement>("#list");
  const detailEl = $<HTMLPreElement>("#detail");
  const filterEl = $<HTMLInputElement>("#filter");
  const summaryEl = $<HTMLDivElement>("#summary");
  const panelEl = $<HTMLDivElement>("#panel");

  let selected: string | undefined;
  let paused = false;
  let dirty = true;
  let filter = "";
  const recent: RenderEvent[] = [];

  const unsubscribe = detective.subscribe((event) => {
    if (paused) return;
    recent.push(event);
    if (recent.length > 200) recent.shift();
    dirty = true;
  });

  filterEl.addEventListener("input", () => {
    filter = filterEl.value.trim().toLowerCase();
    dirty = true;
  });
  $("#pause").addEventListener("click", () => {
    paused = !paused;
    ($("#pause") as HTMLButtonElement).textContent = paused ? "Resume" : "Pause";
  });
  $("#clear").addEventListener("click", () => {
    detective.clear();
    recent.length = 0;
    selected = undefined;
    detailEl.textContent = "";
    dirty = true;
  });
  $("#close").addEventListener("click", () => handle.hide());
  listEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("[data-name]") as HTMLElement | null;
    if (!row) return;
    selected = row.dataset.name as string;
    dirty = true;
  });

  const timer = setInterval(() => {
    if (!dirty || panelEl.hidden) return;
    dirty = false;
    render();
  }, 400);

  function render(): void {
    const stats = detective.getStats();
    summaryEl.textContent =
      `${stats.totalRenders} renders · ${stats.totalRenderTime.toFixed(0)}ms · ` +
      `${stats.potentiallyAvoidableRenders} potentially avoidable` +
      (stats.devReplays > 0 ? ` · ${stats.devReplays} dev replays` : "");

    const rows = stats.mostExpensive
      .concat(stats.mostRendered)
      .filter((s, i, arr) => arr.findIndex((o) => o.name === s.name) === i)
      .filter((s) => !filter || s.name.toLowerCase().includes(filter))
      .sort((a, b) => b.totalSelfDuration - a.totalSelfDuration)
      .slice(0, 40);

    listEl.innerHTML = rows
      .map((s) => {
        const waste = s.potentiallyAvoidableRenders;
        const flag = waste > 0 ? `<span class="warn">${waste} avoidable</span>` : "";
        return `<div class="row${s.name === selected ? " sel" : ""}" data-name="${escapeHtml(s.name)}" title="${escapeHtml(s.source ?? s.name)}">
          <span class="name">${escapeHtml(s.name)}</span>
          <span class="num">${s.renderCount}</span>
          <span class="num">${s.totalSelfDuration.toFixed(0)}ms</span>
          ${flag}
        </div>`;
      })
      .join("");

    if (selected) {
      const explanation = explainEvents(selected, detective.getEvents());
      detailEl.textContent = explanation ? formatExplanation(explanation) : `No recorded renders for ${selected}.`;
    }
  }

  const handle: OverlayHandle = {
    destroy() {
      unsubscribe();
      clearInterval(timer);
      root.remove();
      (globalThis as Global)[MOUNTED] = undefined;
    },
    show() {
      panelEl.hidden = false;
      dirty = true;
    },
    hide() {
      panelEl.hidden = true;
    },
  };

  g[MOUNTED] = handle;
  return handle;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

const TEMPLATE = `
<style>
  :host { all: initial; }
  #panel {
    position: fixed; right: 16px; bottom: 16px; width: 460px; max-height: 70vh;
    display: flex; flex-direction: column; z-index: 2147483000;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    background: #14161a; color: #e6e6e6; border: 1px solid #2b2f36; border-radius: 10px;
    box-shadow: 0 12px 40px rgba(0,0,0,.45); overflow: hidden;
  }
  header { display: flex; gap: 8px; align-items: center; padding: 8px 10px; background: #1b1e24; border-bottom: 1px solid #2b2f36; }
  header b { font-weight: 600; letter-spacing: .02em; }
  header .spacer { flex: 1; }
  button, input { font: inherit; color: inherit; background: #23272e; border: 1px solid #333842; border-radius: 6px; padding: 3px 8px; }
  button { cursor: pointer; }
  #summary { padding: 6px 10px; color: #9aa4b2; border-bottom: 1px solid #2b2f36; }
  #list { overflow: auto; max-height: 30vh; }
  .row { display: flex; gap: 8px; padding: 4px 10px; cursor: pointer; align-items: baseline; }
  .row:hover { background: #1d2128; }
  .row.sel { background: #263041; }
  .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .num { color: #9aa4b2; min-width: 56px; text-align: right; }
  .warn { color: #f2b263; }
  #detail { margin: 0; padding: 10px; overflow: auto; white-space: pre-wrap; border-top: 1px solid #2b2f36; color: #cfd6df; }
</style>
<div id="panel">
  <header>
    <b>Render Detective</b>
    <span class="spacer"></span>
    <input id="filter" placeholder="filter" size="10" />
    <button id="pause">Pause</button>
    <button id="clear">Clear</button>
    <button id="close">×</button>
  </header>
  <div id="summary"></div>
  <div id="list"></div>
  <pre id="detail">Select a component to see why it rendered.</pre>
</div>
`;
