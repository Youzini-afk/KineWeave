import "./styles.css";
import type { JsonValue } from "@kineweave/protocol";
import type { MotionNode } from "@kineweave/standard-motion-document";
import type { StudioCommand } from "../bridge.js";
import { StudioController, type StudioSnapshot } from "./studio-controller.js";
import {
  defaultPropertyValue,
  flattenLayerTree,
  type InspectorField,
  inspectorFields,
  resolvedPropertyValue,
  shortNodeType
} from "./studio-model.js";
import { TimelineController } from "./timeline-controller.js";

const root = document.querySelector<HTMLDivElement>("#app");
if (root === null) throw new Error("Studio root element is missing");

root.innerHTML = `
  <div class="studio-shell">
    <header class="app-bar">
      <div class="brand-lockup" aria-label="KineWeave Studio">
        <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M4 5.5 14 2l10 3.5v17L14 26 4 22.5z"/><path d="m9 8 5 6 5-6M9 20l5-6 5 6"/></svg>
        <span>KineWeave</span><b>Studio</b>
      </div>
      <div class="project-heading">
        <span id="project-name">No project open</span>
        <span id="project-path"></span>
      </div>
      <div class="app-actions">
        <button id="open-project" class="button subtle" type="button">Open</button>
        <button id="undo" class="icon-button" type="button" title="Undo (Ctrl+Z)" aria-label="Undo">↶</button>
        <button id="redo" class="icon-button" type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo">↷</button>
        <button id="save" class="button primary" type="button">Save</button>
      </div>
    </header>

    <aside class="activity-rail" aria-label="Workspaces">
      <button class="rail-logo active" type="button" title="Stage">◆</button>
      <button type="button" title="Storyboard" disabled>▦</button>
      <button type="button" title="Graph" disabled>⌘</button>
      <button type="button" title="Code" disabled>&lt;/&gt;</button>
      <span class="rail-spacer"></span>
      <button type="button" title="Settings" disabled>⚙</button>
    </aside>

    <aside class="layers-panel panel">
      <div class="panel-header">
        <div><span class="eyebrow">Composition</span><h2>Layers</h2></div>
        <div class="compact-actions">
          <button id="move-up" class="icon-button small" type="button" title="Move layer up">↑</button>
          <button id="move-down" class="icon-button small" type="button" title="Move layer down">↓</button>
        </div>
      </div>
      <div class="insert-toolbar" aria-label="Add layer">
        <button type="button" data-add-node="text" title="Add text">T</button>
        <button type="button" data-add-node="rectangle" title="Add rectangle">▭</button>
        <button type="button" data-add-node="ellipse" title="Add ellipse">○</button>
        <button type="button" data-add-node="path" title="Add path">✦</button>
        <span></span>
        <button id="delete-node" type="button" title="Delete selected layer">⌫</button>
      </div>
      <div id="layers" class="layers-list" role="tree"></div>
    </aside>

    <main class="workspace">
      <div class="stage-toolbar">
        <div class="tool-group">
          <button class="tool active" type="button" title="Select">↖</button>
          <button class="tool" type="button" title="Hand" disabled>✋</button>
        </div>
        <div id="canvas-summary" class="canvas-summary">—</div>
        <div class="stage-badges"><span>Fit</span><span id="stage-scale">100%</span></div>
      </div>
      <section class="stage-viewport" aria-label="Stage">
        <div class="stage-grid"></div>
        <canvas id="stage-canvas"></canvas>
        <svg id="stage-overlay" aria-hidden="true">
          <polygon id="selection-polygon" points=""></polygon>
        </svg>
        <div class="stage-empty" id="stage-empty">
          <span class="empty-mark">◇</span>
          <p>Open a project to enter the Stage.</p>
        </div>
      </section>
      <section class="timeline-panel panel">
        <div class="transport">
          <div class="transport-controls">
            <button id="jump-start" class="icon-button" type="button" title="Go to start">|◀</button>
            <button id="play" class="play-button" type="button" title="Play / Pause">▶</button>
            <button id="previous-keyframe" class="icon-button" type="button" title="Previous keyframe">◆◀</button>
            <button id="next-keyframe" class="icon-button" type="button" title="Next keyframe">▶◆</button>
          </div>
          <span id="timecode" class="timecode">00:00.000</span>
          <label class="duration-control"><span>Duration</span><input id="composition-duration" type="number" min="0.001" step="0.1" value="1"/><small>s</small></label>
        </div>
        <div class="timeline-workspace">
          <div class="timeline-toolbar">
            <span id="keyframe-selection">No keyframe selected</span>
            <label><span>Outgoing easing</span><select id="keyframe-easing" disabled>
              <option value="auto">Auto / linear</option>
              <option value="linear">Linear</option>
              <option value="hold">Hold</option>
              <option value="ease">Ease</option>
              <option value="ease-in">Ease in</option>
              <option value="ease-out">Ease out</option>
              <option value="ease-in-out">Ease in-out</option>
            </select></label>
            <button id="delete-keyframe" class="button subtle compact" type="button" disabled>Delete key</button>
          </div>
          <div class="timeline-ruler"><span>0s</span><span id="duration-label">1s</span></div>
          <div class="scrubber-wrap">
            <input id="playhead" type="range" min="0" max="1" step="0.001" value="0" />
          </div>
          <div id="timeline-rows" class="timeline-rows"></div>
          <div id="track-summary" class="track-summary">Select a layer to inspect its animation tracks.</div>
        </div>
      </section>
    </main>

    <aside class="inspector-panel panel">
      <div class="panel-header">
        <div><span class="eyebrow">Selection</span><h2>Inspector</h2></div>
      </div>
      <div id="inspector" class="inspector-content"></div>
      <section class="history-section">
        <div class="section-title"><span>History</span><small>main</small></div>
        <div id="history" class="history-list"></div>
      </section>
    </aside>

    <footer class="status-bar">
      <button id="status" type="button"><span id="status-dot"></span><span id="status-message">Ready</span></button>
      <span id="save-state">Not saved</span>
      <span class="status-spacer"></span>
      <span id="diagnostic-count">0 diagnostics</span>
      <span>main</span>
    </footer>

    <div id="welcome" class="welcome-overlay">
      <div class="welcome-card">
        <div class="welcome-symbol">K</div>
        <span class="eyebrow">Open creation environment</span>
        <h1>Motion, time and structure<br/>in one project.</h1>
        <p>KineWeave Studio keeps the canvas, layers, properties and history on the same open project model.</p>
        <button id="welcome-open" class="button primary large" type="button">Open KineWeave Project</button>
        <small id="welcome-status">Choose a directory containing kineweave.project.json.</small>
      </div>
    </div>

    <dialog id="diagnostics-dialog">
      <div class="dialog-header"><div><span class="eyebrow">Runtime</span><h2>Diagnostics</h2></div><button id="close-diagnostics" class="icon-button" type="button">×</button></div>
      <div id="diagnostics-list" class="diagnostics-list"></div>
    </dialog>
  </div>
`;

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Studio element is missing: ${selector}`);
  return value;
}

const canvas = required<HTMLCanvasElement>("#stage-canvas");
const selection = required<SVGPolygonElement>("#selection-polygon");
const controller = new StudioController(window.kineweaveHost, canvas, selection);
const timeline = new TimelineController(controller);
let latest = controller.snapshot();
let renderedPanelRevision = -1;
let renderedPresentation = latest.presentation;
let scrubbing = false;

const elements = {
  shell: required<HTMLElement>(".studio-shell"),
  projectName: required<HTMLElement>("#project-name"),
  projectPath: required<HTMLElement>("#project-path"),
  welcome: required<HTMLElement>("#welcome"),
  welcomeStatus: required<HTMLElement>("#welcome-status"),
  stageEmpty: required<HTMLElement>("#stage-empty"),
  canvasSummary: required<HTMLElement>("#canvas-summary"),
  stageScale: required<HTMLElement>("#stage-scale"),
  layers: required<HTMLElement>("#layers"),
  inspector: required<HTMLElement>("#inspector"),
  history: required<HTMLElement>("#history"),
  play: required<HTMLButtonElement>("#play"),
  playhead: required<HTMLInputElement>("#playhead"),
  timecode: required<HTMLElement>("#timecode"),
  durationLabel: required<HTMLElement>("#duration-label"),
  save: required<HTMLButtonElement>("#save"),
  undo: required<HTMLButtonElement>("#undo"),
  redo: required<HTMLButtonElement>("#redo"),
  deleteNode: required<HTMLButtonElement>("#delete-node"),
  moveUp: required<HTMLButtonElement>("#move-up"),
  moveDown: required<HTMLButtonElement>("#move-down"),
  status: required<HTMLButtonElement>("#status"),
  statusDot: required<HTMLElement>("#status-dot"),
  statusMessage: required<HTMLElement>("#status-message"),
  saveState: required<HTMLElement>("#save-state"),
  diagnosticCount: required<HTMLElement>("#diagnostic-count"),
  diagnosticsDialog: required<HTMLDialogElement>("#diagnostics-dialog"),
  diagnosticsList: required<HTMLElement>("#diagnostics-list")
};

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function run(action: Promise<unknown>): void {
  void action.catch((error) => controller.reportError(error));
}

function inputLabel(text: string): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "field-label";
  const span = document.createElement("span");
  span.textContent = text;
  label.append(span);
  return label;
}

function renderInspectorField(
  snapshot: StudioSnapshot,
  node: MotionNode,
  field: InspectorField
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "inspector-field";
  const label = inputLabel(field.label);
  const editable = field.bindingKind !== "signal";
  const value =
    resolvedPropertyValue(snapshot.presentation, node, field.property) ??
    field.value ??
    defaultPropertyValue(field.property);
  if (!editable) {
    const badge = document.createElement("span");
    badge.className = "binding-badge";
    badge.textContent = field.bindingKind ?? "bound";
    label.append(badge);
  }
  wrapper.append(label);

  if (field.kind === "vector2") {
    const vector =
      Array.isArray(value) && value.length === 2
        ? value
        : (defaultPropertyValue(field.property) as JsonValue[]);
    const row = document.createElement("div");
    row.className = "vector-field";
    ["X", "Y"].forEach((axis, index) => {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "0.1";
      input.value = String(vector[index] ?? 0);
      input.disabled = !editable;
      input.setAttribute("aria-label", `${field.label} ${axis}`);
      input.addEventListener("change", () => {
        const next = [...vector] as number[];
        const parsed = Number(input.value);
        if (!Number.isFinite(parsed)) return;
        next[index] = parsed;
        run(controller.setProperty(node.nodeId, field.property, next));
      });
      const axisLabel = document.createElement("span");
      axisLabel.textContent = axis;
      const cell = document.createElement("label");
      cell.append(axisLabel, input);
      row.append(cell);
    });
    wrapper.append(row);
    return wrapper;
  }

  if (field.kind === "boolean") {
    const toggle = document.createElement("label");
    toggle.className = "switch-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", field.label);
    input.checked = value !== false;
    input.disabled = !editable;
    input.addEventListener("change", () =>
      run(controller.setProperty(node.nodeId, field.property, input.checked))
    );
    const visual = document.createElement("span");
    visual.className = "switch";
    const state = document.createElement("span");
    state.textContent = input.checked ? "Shown" : "Hidden";
    input.addEventListener("change", () => {
      state.textContent = input.checked ? "Shown" : "Hidden";
    });
    toggle.append(input, visual, state);
    wrapper.append(toggle);
    return wrapper;
  }

  const input =
    field.kind === "multiline"
      ? document.createElement("textarea")
      : document.createElement("input");
  input.className = "property-input";
  input.setAttribute("aria-label", field.label);
  input.disabled = !editable;
  if (input instanceof HTMLInputElement) {
    input.type = field.kind === "number" ? "number" : "text";
    if (field.kind === "number") input.step = "0.1";
  } else {
    input.rows = 4;
    input.spellcheck = false;
  }
  input.value = String(value);
  if (field.kind === "color") {
    const colorRow = document.createElement("div");
    colorRow.className = "color-field";
    const swatch = document.createElement("span");
    swatch.style.background = String(value);
    colorRow.append(swatch, input);
    wrapper.append(colorRow);
  } else {
    wrapper.append(input);
  }
  input.addEventListener("change", () => {
    const next: JsonValue = field.kind === "number" ? Number(input.value) : input.value;
    if (typeof next === "number" && !Number.isFinite(next)) return;
    run(controller.setProperty(node.nodeId, field.property, next));
  });
  return wrapper;
}

function renderLayers(snapshot: StudioSnapshot): void {
  elements.layers.replaceChildren();
  const composition = snapshot.document;
  if (composition === undefined) {
    const empty = window.document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "No composition loaded.";
    elements.layers.append(empty);
    return;
  }
  const fragment = window.document.createDocumentFragment();
  for (const item of flattenLayerTree(composition)) {
    const row = window.document.createElement("div");
    row.className = `layer-row${item.node.nodeId === snapshot.selectedNodeId ? " selected" : ""}`;
    row.dataset.nodeId = item.node.nodeId;
    row.dataset.nodeType = item.node.nodeType;
    row.style.setProperty("--depth", String(item.depth));
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(item.node.nodeId === snapshot.selectedNodeId));
    row.tabIndex = 0;
    row.addEventListener("click", () => controller.selectNode(item.node.nodeId));
    row.addEventListener("keydown", (event) => {
      if (event.target === row && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        controller.selectNode(item.node.nodeId);
      }
    });
    const disclosure = window.document.createElement("span");
    disclosure.className = "disclosure";
    disclosure.textContent = item.node.children.length > 0 ? "⌄" : "";
    const enabled = window.document.createElement("button");
    enabled.className = `layer-visibility${item.node.enabled ? " on" : ""}`;
    enabled.type = "button";
    enabled.title = item.node.enabled ? "Disable layer" : "Enable layer";
    enabled.textContent = item.node.enabled ? "●" : "○";
    enabled.addEventListener("click", (event) => {
      event.stopPropagation();
      run(controller.setNodeEnabled(item.node.nodeId, !item.node.enabled));
    });
    const icon = window.document.createElement("span");
    icon.className = "layer-icon";
    icon.textContent = item.node.nodeType.endsWith("/text")
      ? "T"
      : item.node.nodeType.endsWith("/rectangle")
        ? "▭"
        : item.node.nodeType.endsWith("/ellipse")
          ? "○"
          : item.node.nodeType.endsWith("/path")
            ? "✦"
            : "◇";
    const copy = window.document.createElement("span");
    copy.className = "layer-copy";
    const name = window.document.createElement("strong");
    name.textContent = item.node.name;
    const type = window.document.createElement("small");
    type.textContent = shortNodeType(item.node.nodeType);
    copy.append(name, type);
    row.append(disclosure, enabled, icon, copy);
    fragment.append(row);
  }
  elements.layers.append(fragment);
}

function renderInspector(snapshot: StudioSnapshot): void {
  elements.inspector.replaceChildren();
  const node =
    snapshot.document === undefined || snapshot.selectedNodeId === undefined
      ? undefined
      : snapshot.document.data.nodes[snapshot.selectedNodeId];
  if (node === undefined) {
    const empty = document.createElement("div");
    empty.className = "inspector-empty";
    empty.innerHTML = "<span>◇</span><p>Select a layer on the Stage or in Layers.</p>";
    elements.inspector.append(empty);
    return;
  }
  const identity = document.createElement("section");
  identity.className = "identity-section";
  const nameLabel = inputLabel("Layer name");
  const name = document.createElement("input");
  name.id = "layer-name";
  name.className = "property-input prominent";
  name.value = node.name;
  name.addEventListener("change", () => {
    const next = name.value.trim();
    if (next.length > 0 && next !== node.name) run(controller.renameNode(node.nodeId, next));
  });
  nameLabel.append(name);
  const meta = document.createElement("div");
  meta.className = "node-meta";
  const nodeType = document.createElement("span");
  nodeType.textContent = shortNodeType(node.nodeType);
  const nodeId = document.createElement("code");
  nodeId.textContent = node.nodeId;
  meta.append(nodeType, nodeId);
  identity.append(nameLabel, meta);
  elements.inspector.append(identity);
  const fields = document.createElement("section");
  fields.className = "property-section";
  for (const item of inspectorFields(node)) {
    fields.append(renderInspectorField(snapshot, node, item));
  }
  elements.inspector.append(fields);
}

function renderHistory(snapshot: StudioSnapshot): void {
  elements.history.replaceChildren();
  if (snapshot.history.length === 0) {
    const empty = document.createElement("p");
    empty.className = "panel-empty compact";
    empty.textContent = "No edits yet.";
    elements.history.append(empty);
    return;
  }
  snapshot.history.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = `history-row${entry.current ? " current" : ""}`;
    const marker = document.createElement("span");
    marker.className = "history-marker";
    const copy = document.createElement("span");
    const operation = entry.operationTypes[0]?.split("/").at(-1) ?? "edit";
    const title = document.createElement("strong");
    title.textContent = operation.replaceAll("-", " ");
    const detail = document.createElement("small");
    detail.textContent =
      index === 0 ? "Current state" : new Date(entry.timestamp).toLocaleTimeString();
    copy.append(title, detail);
    row.append(marker, copy);
    elements.history.append(row);
  });
}

function renderDiagnostics(snapshot: StudioSnapshot): void {
  elements.diagnosticsList.replaceChildren();
  if (snapshot.diagnostics.length === 0) {
    const empty = document.createElement("p");
    empty.className = "panel-empty";
    empty.textContent = "No active diagnostics.";
    elements.diagnosticsList.append(empty);
    return;
  }
  for (const diagnostic of snapshot.diagnostics) {
    const item = document.createElement("article");
    item.className = `diagnostic ${diagnostic.severity}`;
    const heading = document.createElement("div");
    const severity = document.createElement("span");
    severity.textContent = diagnostic.severity;
    const code = document.createElement("code");
    code.textContent = diagnostic.code;
    heading.append(severity, code);
    const message = document.createElement("p");
    message.textContent = diagnostic.message;
    item.append(heading, message);
    elements.diagnosticsList.append(item);
  }
}

function render(snapshot: StudioSnapshot): void {
  latest = snapshot;
  const ready = snapshot.phase === "ready";
  elements.shell.dataset.phase = snapshot.phase;
  elements.shell.dataset.dirty = String(snapshot.dirty);
  elements.shell.dataset.saving = String(snapshot.saving);
  elements.shell.dataset.playing = String(snapshot.playing);
  elements.projectName.textContent = snapshot.projectName ?? "No project open";
  elements.projectPath.textContent = snapshot.rootPath ?? "";
  elements.welcome.classList.toggle("hidden", ready);
  elements.welcome.toggleAttribute("inert", ready);
  elements.welcome.setAttribute("aria-hidden", String(ready));
  elements.welcome.classList.toggle("opening", snapshot.phase === "opening");
  elements.welcomeStatus.textContent = snapshot.status.message;
  elements.stageEmpty.classList.toggle("hidden", ready);
  elements.play.textContent = snapshot.playing ? "Ⅱ" : "▶";
  elements.play.classList.toggle("active", snapshot.playing);
  elements.play.disabled = !ready;
  elements.undo.disabled = !snapshot.canUndo;
  elements.redo.disabled = !snapshot.canRedo;
  elements.save.disabled = !ready || snapshot.saving || !snapshot.dirty;
  elements.save.textContent = snapshot.saving ? "Saving…" : "Save";
  elements.deleteNode.disabled = snapshot.selectedNodeId === undefined;
  elements.moveUp.disabled = snapshot.selectedNodeId === undefined;
  elements.moveDown.disabled = snapshot.selectedNodeId === undefined;
  elements.timecode.textContent = formatTime(snapshot.playheadSeconds);
  elements.durationLabel.textContent = `${snapshot.durationSeconds.toFixed(2)}s`;
  if (!scrubbing) {
    elements.playhead.max = String(snapshot.durationSeconds);
    elements.playhead.value = String(snapshot.playheadSeconds);
  }
  elements.playhead.disabled = !ready;
  elements.statusDot.dataset.kind = snapshot.status.kind;
  elements.statusMessage.textContent = snapshot.status.message;
  elements.saveState.textContent = snapshot.saving
    ? "Saving"
    : snapshot.dirty
      ? "Unsaved changes"
      : ready
        ? "Saved"
        : "No project";
  elements.diagnosticCount.textContent = `${snapshot.diagnostics.length} ${snapshot.diagnostics.length === 1 ? "diagnostic" : "diagnostics"}`;
  const canvasData = snapshot.document?.data.canvas;
  elements.canvasSummary.textContent =
    canvasData === undefined ? "—" : `${canvasData.width} × ${canvasData.height} · sRGB`;
  const bounds = canvas.getBoundingClientRect();
  const scale =
    canvasData === undefined
      ? 1
      : Math.min(bounds.width / canvasData.width, bounds.height / canvasData.height);
  elements.stageScale.textContent = `${Math.round(scale * 100)}%`;

  if (renderedPanelRevision !== snapshot.panelRevision) {
    renderedPanelRevision = snapshot.panelRevision;
    renderedPresentation = snapshot.presentation;
    renderLayers(snapshot);
    renderInspector(snapshot);
    renderHistory(snapshot);
  } else if (!snapshot.playing && renderedPresentation !== snapshot.presentation) {
    renderedPresentation = snapshot.presentation;
    renderInspector(snapshot);
  }
  timeline.render(snapshot);
  renderDiagnostics(snapshot);
}

controller.subscribe(render);

required<HTMLButtonElement>("#open-project").addEventListener("click", () =>
  run(controller.chooseAndOpenProject())
);
required<HTMLButtonElement>("#welcome-open").addEventListener("click", () =>
  run(controller.chooseAndOpenProject())
);
elements.save.addEventListener("click", () => run(controller.save()));
elements.undo.addEventListener("click", () => run(controller.undo()));
elements.redo.addEventListener("click", () => run(controller.redo()));
elements.play.addEventListener("click", () => controller.togglePlayback());
required<HTMLButtonElement>("#jump-start").addEventListener("click", () =>
  controller.setPlayhead(0)
);
elements.playhead.addEventListener("pointerdown", () => {
  scrubbing = true;
});
elements.playhead.addEventListener("input", () =>
  controller.setPlayhead(Number(elements.playhead.value))
);
elements.playhead.addEventListener("change", () => {
  scrubbing = false;
});
elements.deleteNode.addEventListener("click", () => run(controller.removeSelectedNode()));
elements.moveUp.addEventListener("click", () => run(controller.moveSelectedLayer(-1)));
elements.moveDown.addEventListener("click", () => run(controller.moveSelectedLayer(1)));
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-add-node]")) {
  button.addEventListener("click", () => {
    const kind = button.dataset.addNode;
    if (kind === "text" || kind === "rectangle" || kind === "ellipse" || kind === "path") {
      run(controller.addNode(kind));
    }
  });
}

elements.status.addEventListener("click", () => elements.diagnosticsDialog.showModal());
required<HTMLButtonElement>("#close-diagnostics").addEventListener("click", () =>
  elements.diagnosticsDialog.close()
);

function editingText(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
}

function prepareToClose(): void {
  void controller.prepareToClose().then(
    () => window.kineweaveHost.respondToClose(true),
    (error) => {
      controller.reportError(error);
      window.kineweaveHost.respondToClose(false);
    }
  );
}

function handleCommand(command: StudioCommand): void {
  if (command === "open-project") run(controller.chooseAndOpenProject());
  else if (command === "save-project") run(controller.save());
  else if (command === "undo") run(controller.undo());
  else if (command === "redo") run(controller.redo());
  else if (command === "toggle-playback" && !editingText()) controller.togglePlayback();
  else if (command === "prepare-close") prepareToClose();
}

window.kineweaveHost.onCommand(handleCommand);
window.kineweaveHost.onInitialProject((rootPath) => run(controller.openProject(rootPath)));

window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !editingText()) {
    event.preventDefault();
    controller.togglePlayback();
  }
  if ((event.key === "Delete" || event.key === "Backspace") && !editingText()) {
    event.preventDefault();
    run(controller.removeSelectedNode());
  }
});

window.addEventListener("beforeunload", (event) => {
  if (latest.dirty || latest.saving) {
    event.preventDefault();
    event.returnValue = "";
  }
});
