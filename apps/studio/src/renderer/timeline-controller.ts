import type { JsonObject } from "@kineweave/protocol";
import {
  isStandardInterpolatedValueType,
  STANDARD_KEYFRAME_EASINGS
} from "@kineweave/standard-motion-document";
import {
  CUBIC_BEZIER_GRAPH,
  type CubicBezierCoordinate,
  type CubicBezierCurve,
  type CubicBezierViewport,
  cubicBezierControlAtPlotPoint,
  cubicBezierEasingValue,
  cubicBezierParameters,
  cubicBezierPlotPoint,
  cubicBezierViewport,
  customCurveFromEasing,
  EASING_PRESETS,
  easingPreset,
  easingSignature,
  sameCubicBezierCurve,
  withCubicBezierCoordinate
} from "./easing-curve.js";
import type { StudioController, StudioSnapshot } from "./studio-controller.js";
import {
  keyframeSeconds,
  sortedKeyframes,
  type TimelineProperty,
  timelineProperties
} from "./studio-model.js";

interface SelectedKeyframe {
  readonly trackId: string;
  readonly keyframeId: string;
}

interface DragState extends SelectedKeyframe {
  readonly pointerId: number;
  readonly marker: HTMLButtonElement;
  readonly lane: HTMLElement;
  readonly startClientX: number;
  readonly startSeconds: number;
  previewSeconds: number;
  moved: boolean;
}

interface PendingSelection {
  readonly nodeId: string;
  readonly property: string;
  readonly seconds: number;
}

interface EasingDraftState extends SelectedKeyframe {
  selection: string;
  curve: CubicBezierCurve;
  targetSignature: string;
  pendingMutations: number;
}

interface CurveDragState {
  readonly draft: EasingDraftState;
  readonly pointerId: number;
  readonly coordinateX: "x1" | "x2";
  readonly coordinateY: "y1" | "y2";
  readonly persistedCurve: CubicBezierCurve;
  readonly persistedSelection: string;
  readonly persistedTargetSignature: string;
  readonly viewport: CubicBezierViewport;
  moved: boolean;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Timeline element is missing: ${selector}`);
  return value;
}

function sameTime(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000_000_5;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function pathCoordinate(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export class TimelineController {
  readonly #controller: Pick<
    StudioController,
    | "snapshot"
    | "setKeyframeEasing"
    | "setDuration"
    | "toggleKeyframe"
    | "setPlayhead"
    | "moveKeyframe"
    | "deleteKeyframe"
    | "reportError"
  >;
  readonly #rows = required<HTMLElement>("#timeline-rows");
  readonly #summary = required<HTMLElement>("#track-summary");
  readonly #selectionLabel = required<HTMLElement>("#keyframe-selection");
  readonly #easing = required<HTMLSelectElement>("#keyframe-easing");
  readonly #workspace = required<HTMLElement>(".workspace");
  readonly #curveEditor = required<HTMLElement>("#easing-curve-editor");
  readonly #curveGraph = required<SVGSVGElement>("#easing-curve-graph");
  readonly #curveInputs = new Map<CubicBezierCoordinate, HTMLInputElement>(
    (["x1", "y1", "x2", "y2"] as const).map((coordinate) => [
      coordinate,
      required<HTMLInputElement>(`#easing-${coordinate}`)
    ])
  );
  readonly #delete = required<HTMLButtonElement>("#delete-keyframe");
  readonly #previous = required<HTMLButtonElement>("#previous-keyframe");
  readonly #next = required<HTMLButtonElement>("#next-keyframe");
  readonly #duration = required<HTMLInputElement>("#composition-duration");
  #snapshot: StudioSnapshot;
  #renderedRevision = -1;
  #renderedNodeId: string | undefined;
  #selected: SelectedKeyframe | undefined;
  #pendingSelection: PendingSelection | undefined;
  #drag: DragState | undefined;
  #easingDraft: EasingDraftState | undefined;
  #curveDrag: CurveDragState | undefined;
  #suppressClick: string | undefined;

  constructor(
    controller: Pick<
      StudioController,
      | "snapshot"
      | "setKeyframeEasing"
      | "setDuration"
      | "toggleKeyframe"
      | "setPlayhead"
      | "moveKeyframe"
      | "deleteKeyframe"
      | "reportError"
    >
  ) {
    this.#controller = controller;
    this.#snapshot = controller.snapshot();
    this.#easing.addEventListener("change", () => {
      const selected = this.#selected;
      const current = this.#selectedKeyframe();
      if (selected === undefined || current === undefined) return;
      const draft = this.#ensureEasingDraft(selected, current.keyframe.easing);
      if (this.#easing.value === "custom") {
        draft.selection = "custom";
        if (draft.pendingMutations === 0) {
          draft.curve = customCurveFromEasing(current.keyframe.easing);
          draft.targetSignature = easingSignature(current.keyframe.easing);
        }
        this.#renderCurveEditor(draft.curve, false);
        return;
      }
      const selection = this.#easing.value;
      const preset = EASING_PRESETS[selection];
      if (preset === undefined) return;
      draft.selection = selection;
      draft.targetSignature = easingSignature(preset ?? undefined);
      if (preset?.kind === STANDARD_KEYFRAME_EASINGS.cubicBezier) {
        draft.curve = cubicBezierParameters(preset) ?? draft.curve;
        this.#renderCurveEditor(draft.curve, false);
      } else {
        this.#hideCurveEditor(false);
      }
      this.#commitEasingDraft(draft, preset);
    });
    for (const [coordinate, input] of this.#curveInputs) {
      input.addEventListener("change", () => this.#commitCurveInput(coordinate, input));
    }
    this.#curveGraph.addEventListener("pointermove", (event) => this.#curveDragMove(event));
    this.#curveGraph.addEventListener("pointerup", (event) => this.#curveDragEnd(event));
    this.#curveGraph.addEventListener("pointercancel", (event) => this.#curveDragCancel(event));
    this.#delete.addEventListener("click", () => this.#deleteSelected());
    this.#previous.addEventListener("click", () => this.#jumpKeyframe(-1));
    this.#next.addEventListener("click", () => this.#jumpKeyframe(1));
    this.#duration.addEventListener("change", () => {
      const seconds = Number(this.#duration.value);
      if (Number.isFinite(seconds) && seconds > 0) {
        this.#run(this.#controller.setDuration(seconds));
      } else {
        this.#duration.value = String(this.#snapshot.durationSeconds);
      }
    });
  }

  render(snapshot: StudioSnapshot): void {
    this.#snapshot = snapshot;
    this.#duration.disabled = snapshot.phase !== "ready";
    if (document.activeElement !== this.#duration) {
      this.#duration.value = String(Math.round(snapshot.durationSeconds * 1000) / 1000);
    }
    const mustRebuild =
      this.#renderedRevision !== snapshot.panelRevision ||
      this.#renderedNodeId !== snapshot.selectedNodeId;
    if (mustRebuild) {
      const draft = this.#matchingEasingDraft();
      if (draft === undefined || draft.pendingMutations === 0) this.#cancelCurveDrag();
      this.#renderedRevision = snapshot.panelRevision;
      this.#renderedNodeId = snapshot.selectedNodeId;
      this.#resolvePendingSelection();
      this.#validateSelection();
      this.#renderRows();
    } else {
      this.#updateCurrentIndicators();
    }
    this.#renderToolbar();
  }

  #renderRows(): void {
    this.#rows.replaceChildren();
    const composition = this.#snapshot.document;
    const nodeId = this.#snapshot.selectedNodeId;
    if (composition === undefined || nodeId === undefined) {
      this.#summary.textContent = "Select a layer to author its animation.";
      this.#rows.append(this.#empty("No layer selected."));
      return;
    }
    const properties = timelineProperties(composition, nodeId);
    if (properties.length === 0) {
      this.#summary.textContent = "This layer has no standard animatable properties.";
      this.#rows.append(this.#empty("No authorable properties."));
      return;
    }
    const fragment = document.createDocumentFragment();
    let animated = 0;
    let keyframes = 0;
    for (const property of properties) {
      if (property.track !== undefined) {
        animated += 1;
        keyframes += Object.keys(property.track.keyframes).length;
      }
      fragment.append(this.#propertyRow(nodeId, property));
    }
    this.#rows.append(fragment);
    this.#summary.textContent =
      animated === 0
        ? "Constant properties — use a diamond to start a track."
        : `${animated} animated ${animated === 1 ? "property" : "properties"} · ${keyframes} keyframes`;
    this.#updateCurrentIndicators();
  }

  #propertyRow(nodeId: string, property: TimelineProperty): HTMLElement {
    const row = document.createElement("div");
    row.className = `timeline-property-row${property.track === undefined ? " constant" : " animated"}`;
    row.dataset.property = property.property;

    const heading = document.createElement("div");
    heading.className = "timeline-property-heading";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "property-key-toggle";
    toggle.dataset.property = property.property;
    toggle.title = `Toggle ${property.label} keyframe at the playhead`;
    toggle.setAttribute("aria-label", toggle.title);
    toggle.disabled = property.bindingKind === "signal";
    toggle.textContent = "◆";
    toggle.addEventListener("click", () => {
      this.#pendingSelection = {
        nodeId,
        property: property.property,
        seconds: this.#snapshot.playheadSeconds
      };
      this.#run(this.#controller.toggleKeyframe(nodeId, property.property));
    });
    const label = document.createElement("span");
    label.textContent = property.label;
    const binding = document.createElement("small");
    binding.textContent =
      property.bindingKind === "signal" ? "signal" : property.track ? "track" : "constant";
    heading.append(toggle, label, binding);

    const lane = document.createElement("div");
    lane.className = "timeline-lane";
    lane.dataset.property = property.property;
    lane.addEventListener("pointerdown", (event) => {
      if (event.target !== lane || this.#snapshot.phase !== "ready") return;
      const bounds = lane.getBoundingClientRect();
      const seconds =
        ((event.clientX - bounds.left) / Math.max(1, bounds.width)) *
        this.#snapshot.durationSeconds;
      this.#controller.setPlayhead(seconds);
    });
    if (property.track !== undefined) {
      for (const keyframe of sortedKeyframes(property.track)) {
        lane.append(this.#marker(property, keyframe.keyframeId, keyframeSeconds(keyframe), lane));
      }
    }
    row.append(heading, lane);
    return row;
  }

  #marker(
    property: TimelineProperty,
    keyframeId: string,
    seconds: number,
    lane: HTMLElement
  ): HTMLButtonElement {
    const track = property.track!;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "timeline-keyframe";
    marker.dataset.trackId = track.trackId;
    marker.dataset.keyframeId = keyframeId;
    marker.dataset.seconds = String(seconds);
    marker.style.left = `${(seconds / this.#snapshot.durationSeconds) * 100}%`;
    marker.title = `${property.label} at ${seconds.toFixed(3)}s`;
    marker.setAttribute("aria-label", marker.title);
    marker.addEventListener("click", () => {
      const identity = `${track.trackId}/${keyframeId}`;
      if (this.#suppressClick === identity) {
        this.#suppressClick = undefined;
        return;
      }
      this.#selected = { trackId: track.trackId, keyframeId };
      this.#controller.setPlayhead(seconds);
      this.#renderRows();
      this.#renderToolbar();
    });
    marker.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      this.#selected = { trackId: track.trackId, keyframeId };
      this.#drag = {
        pointerId: event.pointerId,
        marker,
        lane,
        trackId: track.trackId,
        keyframeId,
        startClientX: event.clientX,
        startSeconds: seconds,
        previewSeconds: seconds,
        moved: false
      };
      marker.setPointerCapture(event.pointerId);
      this.#renderToolbar();
    });
    marker.addEventListener("pointermove", (event) => this.#dragMove(event));
    marker.addEventListener("pointerup", (event) => this.#dragEnd(event));
    marker.addEventListener("pointercancel", (event) => this.#dragCancel(event));
    marker.addEventListener("keydown", (event) => {
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        this.#selected = { trackId: track.trackId, keyframeId };
        this.#deleteSelected();
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = event.shiftKey ? 0.1 : 1 / 60;
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        this.#run(
          this.#controller.moveKeyframe(
            track.trackId,
            keyframeId,
            Math.min(this.#snapshot.durationSeconds, Math.max(0, seconds + direction * step))
          )
        );
      }
    });
    return marker;
  }

  #dragMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const width = Math.max(1, drag.lane.getBoundingClientRect().width);
    const raw =
      drag.startSeconds +
      ((event.clientX - drag.startClientX) / width) * this.#snapshot.durationSeconds;
    const step = event.altKey ? 0.001 : event.shiftKey ? 0.1 : 1 / 60;
    const preview = Math.min(
      this.#snapshot.durationSeconds,
      Math.max(0, Math.round(raw / step) * step)
    );
    drag.moved ||= Math.abs(event.clientX - drag.startClientX) >= 2;
    drag.previewSeconds = preview;
    drag.marker.style.left = `${(preview / this.#snapshot.durationSeconds) * 100}%`;
    drag.marker.classList.add("dragging");
    drag.marker.setAttribute("aria-label", `Move keyframe to ${preview.toFixed(3)}s`);
    this.#controller.setPlayhead(preview);
  }

  #dragEnd(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    this.#drag = undefined;
    if (drag.marker.hasPointerCapture(event.pointerId)) {
      drag.marker.releasePointerCapture(event.pointerId);
    }
    drag.marker.classList.remove("dragging");
    if (!drag.moved || sameTime(drag.previewSeconds, drag.startSeconds)) {
      drag.marker.style.left = `${(drag.startSeconds / this.#snapshot.durationSeconds) * 100}%`;
      return;
    }
    this.#suppressClick = `${drag.trackId}/${drag.keyframeId}`;
    this.#run(this.#controller.moveKeyframe(drag.trackId, drag.keyframeId, drag.previewSeconds));
  }

  #dragCancel(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    this.#drag = undefined;
    drag.marker.classList.remove("dragging");
    drag.marker.style.left = `${(drag.startSeconds / this.#snapshot.durationSeconds) * 100}%`;
  }

  #renderToolbar(): void {
    const identity = this.#selected;
    const existingDraft = this.#easingDraft;
    if (
      existingDraft !== undefined &&
      (identity === undefined ||
        existingDraft.trackId !== identity.trackId ||
        existingDraft.keyframeId !== identity.keyframeId)
    ) {
      this.#cancelCurveDrag();
      this.#easingDraft = undefined;
    }
    const selected = this.#selectedKeyframe();
    if (selected === undefined) {
      this.#selectionLabel.textContent = "No keyframe selected";
      this.#easing.value = "auto";
      this.#easing.disabled = true;
      this.#delete.disabled = true;
      this.#hideCurveEditor();
    } else {
      const { track, keyframe } = selected;
      const ordered = sortedKeyframes(track);
      const index = ordered.findIndex((item) => item.keyframeId === keyframe.keyframeId);
      const isLast = index === ordered.length - 1;
      this.#selectionLabel.textContent = `${track.target.property} · ${keyframeSeconds(keyframe).toFixed(3)}s${isLast ? " · end key" : ""}`;
      const canonicalPreset = easingPreset(keyframe.easing);
      let draft = this.#matchingEasingDraft();
      if (draft !== undefined && draft.pendingMutations === 0) {
        if (easingSignature(keyframe.easing) === draft.targetSignature) {
          draft = this.#normalizeEasingDraft(draft, keyframe.easing);
        } else {
          this.#easingDraft = undefined;
          draft = undefined;
        }
      }
      const displayedPreset = draft?.selection ?? canonicalPreset;
      this.#easing.value = displayedPreset;
      this.#easing.disabled = isLast;
      for (const option of this.#easing.options) {
        option.disabled =
          isLast ||
          (!isStandardInterpolatedValueType(track.valueType) &&
            option.value !== "auto" &&
            option.value !== "hold");
      }
      this.#delete.disabled = false;
      const draftPreset = draft === undefined ? undefined : EASING_PRESETS[draft.selection];
      const displayedCurve =
        draft === undefined
          ? cubicBezierParameters(keyframe.easing)
          : draft.selection === "custom" ||
              draftPreset?.kind === STANDARD_KEYFRAME_EASINGS.cubicBezier
            ? draft.curve
            : undefined;
      if (
        !isLast &&
        isStandardInterpolatedValueType(track.valueType) &&
        displayedCurve !== undefined
      ) {
        this.#renderCurveEditor(
          displayedCurve,
          this.#curveDrag === undefined &&
            [...this.#curveInputs.values()].includes(document.activeElement as HTMLInputElement)
        );
      } else {
        this.#hideCurveEditor(false);
      }
    }
    const hasKeyframes = this.#allKeyframes().length > 0;
    this.#previous.disabled = !hasKeyframes;
    this.#next.disabled = !hasKeyframes;
  }

  #updateCurrentIndicators(): void {
    const playhead = this.#snapshot.playheadSeconds;
    for (const toggle of this.#rows.querySelectorAll<HTMLButtonElement>(".property-key-toggle")) {
      const property = toggle.dataset.property;
      const row = property === undefined ? undefined : this.#property(property);
      const keyed =
        row?.track !== undefined &&
        sortedKeyframes(row.track).some((keyframe) =>
          sameTime(keyframeSeconds(keyframe), playhead)
        );
      toggle.classList.toggle("current", keyed);
    }
    for (const marker of this.#rows.querySelectorAll<HTMLButtonElement>(".timeline-keyframe")) {
      marker.classList.toggle("at-playhead", sameTime(Number(marker.dataset.seconds), playhead));
      marker.classList.toggle(
        "selected",
        marker.dataset.trackId === this.#selected?.trackId &&
          marker.dataset.keyframeId === this.#selected?.keyframeId
      );
    }
  }

  #deleteSelected(): void {
    const selected = this.#selected;
    if (selected === undefined) return;
    this.#run(this.#controller.deleteKeyframe(selected.trackId, selected.keyframeId));
  }

  #jumpKeyframe(direction: -1 | 1): void {
    const keyframes = this.#allKeyframes();
    if (keyframes.length === 0) return;
    const current = this.#snapshot.playheadSeconds;
    const candidate =
      direction < 0
        ? ([...keyframes].reverse().find((item) => item.seconds < current - 0.000_000_5) ??
          keyframes.at(-1))
        : (keyframes.find((item) => item.seconds > current + 0.000_000_5) ?? keyframes[0]);
    if (candidate === undefined) return;
    this.#selected = { trackId: candidate.trackId, keyframeId: candidate.keyframeId };
    this.#controller.setPlayhead(candidate.seconds);
    this.#renderRows();
    this.#renderToolbar();
  }

  #allKeyframes(): readonly (SelectedKeyframe & { readonly seconds: number })[] {
    const document = this.#snapshot.document;
    const nodeId = this.#snapshot.selectedNodeId;
    if (document === undefined || nodeId === undefined) return [];
    return Object.values(document.data.tracks)
      .filter((track) => track.target.nodeId === nodeId)
      .flatMap((track) =>
        sortedKeyframes(track).map((keyframe) => ({
          trackId: track.trackId,
          keyframeId: keyframe.keyframeId,
          seconds: keyframeSeconds(keyframe)
        }))
      )
      .sort((left, right) =>
        left.seconds === right.seconds
          ? `${left.trackId}/${left.keyframeId}`.localeCompare(
              `${right.trackId}/${right.keyframeId}`
            )
          : left.seconds - right.seconds
      );
  }

  #selectedKeyframe() {
    const selected = this.#selected;
    const track =
      selected === undefined ? undefined : this.#snapshot.document?.data.tracks[selected.trackId];
    const keyframe =
      selected === undefined || track === undefined
        ? undefined
        : track.keyframes[selected.keyframeId];
    return track === undefined || keyframe === undefined ? undefined : { track, keyframe };
  }

  #property(property: string): TimelineProperty | undefined {
    const document = this.#snapshot.document;
    const nodeId = this.#snapshot.selectedNodeId;
    return document === undefined || nodeId === undefined
      ? undefined
      : timelineProperties(document, nodeId).find((item) => item.property === property);
  }

  #validateSelection(): void {
    const selected = this.#selectedKeyframe();
    if (
      this.#selected !== undefined &&
      (selected === undefined || selected.track.target.nodeId !== this.#snapshot.selectedNodeId)
    ) {
      this.#cancelCurveDrag();
      this.#selected = undefined;
      this.#easingDraft = undefined;
    }
  }

  #resolvePendingSelection(): void {
    const pending = this.#pendingSelection;
    if (pending === undefined) return;
    this.#pendingSelection = undefined;
    const document = this.#snapshot.document;
    const node = document?.data.nodes[pending.nodeId];
    const binding = node?.properties[pending.property];
    const track =
      binding?.kind === "track" && typeof binding.trackId === "string"
        ? document?.data.tracks[binding.trackId]
        : undefined;
    const keyframe =
      track === undefined
        ? undefined
        : sortedKeyframes(track).find((item) => sameTime(keyframeSeconds(item), pending.seconds));
    if (track !== undefined && keyframe !== undefined) {
      this.#selected = { trackId: track.trackId, keyframeId: keyframe.keyframeId };
    }
  }

  #matchingEasingDraft(): EasingDraftState | undefined {
    const selected = this.#selected;
    const draft = this.#easingDraft;
    return selected !== undefined &&
      draft !== undefined &&
      draft.trackId === selected.trackId &&
      draft.keyframeId === selected.keyframeId
      ? draft
      : undefined;
  }

  #normalizeEasingDraft(
    draft: EasingDraftState,
    easing: JsonObject | undefined
  ): EasingDraftState | undefined {
    if (draft.selection !== "custom") {
      this.#easingDraft = undefined;
      return undefined;
    }
    const curve = cubicBezierParameters(easing);
    if (curve !== undefined) draft.curve = curve;
    draft.targetSignature = easingSignature(easing);
    return draft;
  }

  #ensureEasingDraft(selected: SelectedKeyframe, easing: JsonObject | undefined): EasingDraftState {
    const existing = this.#matchingEasingDraft();
    if (existing !== undefined) return existing;
    const draft: EasingDraftState = {
      ...selected,
      selection: easingPreset(easing),
      curve: customCurveFromEasing(easing),
      targetSignature: easingSignature(easing),
      pendingMutations: 0
    };
    this.#easingDraft = draft;
    return draft;
  }

  #commitEasingDraft(draft: EasingDraftState, easing: JsonObject | null): void {
    const targetSignature = easingSignature(easing ?? undefined);
    draft.targetSignature = targetSignature;
    draft.pendingMutations += 1;
    const action = this.#controller.setKeyframeEasing(draft.trackId, draft.keyframeId, easing);
    void action
      .then(() => {
        draft.pendingMutations = Math.max(0, draft.pendingMutations - 1);
        if (this.#easingDraft !== draft) return;
        const canonical = this.#selectedKeyframe()?.keyframe.easing;
        if (
          draft.pendingMutations === 0 &&
          easingSignature(canonical) === draft.targetSignature &&
          this.#curveDrag?.draft !== draft
        ) {
          this.#normalizeEasingDraft(draft, canonical);
          this.#renderToolbar();
        }
      })
      .catch((error) => {
        draft.pendingMutations = Math.max(0, draft.pendingMutations - 1);
        if (this.#easingDraft === draft && draft.pendingMutations === 0) {
          this.#easingDraft = undefined;
          this.#renderToolbar();
        }
        this.#controller.reportError(error);
      });
  }

  #renderCurveEditor(
    curve: CubicBezierCurve,
    preserveFocusedInput: boolean,
    viewport = cubicBezierViewport(curve)
  ): void {
    this.#curveEditor.hidden = false;
    this.#curveEditor.setAttribute("aria-hidden", "false");
    this.#workspace.classList.add("easing-editor-open");
    const draft = this.#matchingEasingDraft();
    if (draft !== undefined) draft.curve = curve;
    for (const [coordinate, input] of this.#curveInputs) {
      if (!preserveFocusedInput || document.activeElement !== input) {
        input.value = String(curve[coordinate]);
      }
    }
    this.#curveGraph.replaceChildren();
    const origin = cubicBezierPlotPoint(0, 0, viewport);
    const target = cubicBezierPlotPoint(1, 1, viewport);
    const first = cubicBezierPlotPoint(curve.x1, curve.y1, viewport);
    const second = cubicBezierPlotPoint(curve.x2, curve.y2, viewport);

    const grid = svgElement("path");
    const quarterXs = [0, 0.25, 0.5, 0.75, 1].map(
      (value) => cubicBezierPlotPoint(value, 0, viewport).x
    );
    const baselineY = cubicBezierPlotPoint(0, 0, viewport).y;
    const targetLineY = cubicBezierPlotPoint(0, 1, viewport).y;
    grid.setAttribute(
      "d",
      `${quarterXs.map((x) => `M ${pathCoordinate(x)} ${CUBIC_BEZIER_GRAPH.paddingY} V ${CUBIC_BEZIER_GRAPH.height - CUBIC_BEZIER_GRAPH.paddingY}`).join(" ")} M ${CUBIC_BEZIER_GRAPH.paddingX} ${pathCoordinate(baselineY)} H ${CUBIC_BEZIER_GRAPH.width - CUBIC_BEZIER_GRAPH.paddingX} M ${CUBIC_BEZIER_GRAPH.paddingX} ${pathCoordinate(targetLineY)} H ${CUBIC_BEZIER_GRAPH.width - CUBIC_BEZIER_GRAPH.paddingX}`
    );
    grid.setAttribute("class", "easing-curve-grid");

    const handles = svgElement("path");
    handles.setAttribute(
      "d",
      `M ${pathCoordinate(origin.x)} ${pathCoordinate(origin.y)} L ${pathCoordinate(first.x)} ${pathCoordinate(first.y)} M ${pathCoordinate(target.x)} ${pathCoordinate(target.y)} L ${pathCoordinate(second.x)} ${pathCoordinate(second.y)}`
    );
    handles.setAttribute("class", "easing-curve-lines");

    const curvePath = svgElement("path");
    curvePath.setAttribute(
      "d",
      `M ${pathCoordinate(origin.x)} ${pathCoordinate(origin.y)} C ${pathCoordinate(first.x)} ${pathCoordinate(first.y)} ${pathCoordinate(second.x)} ${pathCoordinate(second.y)} ${pathCoordinate(target.x)} ${pathCoordinate(target.y)}`
    );
    curvePath.setAttribute("class", "easing-curve-path");

    const startPoint = svgElement("circle");
    startPoint.setAttribute("cx", pathCoordinate(origin.x));
    startPoint.setAttribute("cy", pathCoordinate(origin.y));
    startPoint.setAttribute("r", "3");
    startPoint.setAttribute("class", "easing-curve-endpoint");
    const endPoint = svgElement("circle");
    endPoint.setAttribute("cx", pathCoordinate(target.x));
    endPoint.setAttribute("cy", pathCoordinate(target.y));
    endPoint.setAttribute("r", "3");
    endPoint.setAttribute("class", "easing-curve-endpoint");

    const firstHandle = this.#curveHandle("p1", "x1", "y1", first, viewport);
    const secondHandle = this.#curveHandle("p2", "x2", "y2", second, viewport);
    this.#curveGraph.append(
      grid,
      handles,
      curvePath,
      startPoint,
      endPoint,
      firstHandle,
      secondHandle
    );
  }

  #curveHandle(
    name: "p1" | "p2",
    coordinateX: "x1" | "x2",
    coordinateY: "y1" | "y2",
    point: { readonly x: number; readonly y: number },
    viewport: CubicBezierViewport
  ): SVGCircleElement {
    const handle = svgElement("circle");
    handle.setAttribute("cx", pathCoordinate(point.x));
    handle.setAttribute("cy", pathCoordinate(point.y));
    handle.setAttribute("r", "6");
    handle.setAttribute("class", "easing-curve-handle");
    handle.dataset.handle = name;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      const selected = this.#selected;
      const current = this.#selectedKeyframe();
      if (event.button !== 0 || selected === undefined || current === undefined) return;
      event.preventDefault();
      const draft = this.#ensureEasingDraft(selected, current.keyframe.easing);
      this.#curveDrag = {
        draft,
        pointerId: event.pointerId,
        coordinateX,
        coordinateY,
        persistedCurve: draft.curve,
        persistedSelection: draft.selection,
        persistedTargetSignature: draft.targetSignature,
        viewport,
        moved: false
      };
      this.#curveGraph.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
    });
    return handle;
  }

  #curveDragMove(event: PointerEvent): void {
    const drag = this.#curveDrag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const point = this.#curveClientPoint(event);
    const current = drag.draft.curve;
    const next = withCubicBezierCoordinate(
      withCubicBezierCoordinate(current, drag.coordinateX, point.x),
      drag.coordinateY,
      point.y
    );
    drag.moved ||= !sameCubicBezierCurve(next, drag.persistedCurve);
    this.#renderCurveEditor(next, false, drag.viewport);
  }

  #curveClientPoint(event: PointerEvent): { readonly x: number; readonly y: number } {
    const drag = this.#curveDrag!;
    const transform = this.#curveGraph.getScreenCTM();
    if (transform !== null) {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
      return cubicBezierControlAtPlotPoint(point.x, point.y, drag.viewport);
    }
    const bounds = this.#curveGraph.getBoundingClientRect();
    return cubicBezierControlAtPlotPoint(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * CUBIC_BEZIER_GRAPH.width,
      ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * CUBIC_BEZIER_GRAPH.height,
      drag.viewport
    );
  }

  #curveDragEnd(event: PointerEvent): void {
    const drag = this.#curveDrag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const next = drag.draft.curve;
    this.#curveDrag = undefined;
    if (this.#curveGraph.hasPointerCapture(event.pointerId)) {
      this.#curveGraph.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved || sameCubicBezierCurve(next, drag.persistedCurve)) {
      drag.draft.curve = drag.persistedCurve;
      this.#renderCurveEditor(drag.persistedCurve, false);
      return;
    }
    drag.draft.selection = "custom";
    this.#easing.value = "custom";
    this.#commitEasingDraft(drag.draft, cubicBezierEasingValue(next));
  }

  #curveDragCancel(event: PointerEvent): void {
    if (this.#curveDrag?.pointerId !== event.pointerId) return;
    this.#cancelCurveDrag();
  }

  #cancelCurveDrag(): void {
    const drag = this.#curveDrag;
    if (drag === undefined) return;
    this.#curveDrag = undefined;
    if (this.#curveGraph.hasPointerCapture(drag.pointerId)) {
      this.#curveGraph.releasePointerCapture(drag.pointerId);
    }
    drag.draft.curve = drag.persistedCurve;
    drag.draft.selection = drag.persistedSelection;
    drag.draft.targetSignature = drag.persistedTargetSignature;
    this.#renderCurveEditor(drag.persistedCurve, false);
  }

  #commitCurveInput(coordinate: CubicBezierCoordinate, input: HTMLInputElement): void {
    const selected = this.#selected;
    const persisted = this.#selectedKeyframe();
    const rawValue = input.value.trim();
    const value = input.valueAsNumber;
    if (selected === undefined || persisted === undefined) return;
    const draft = this.#ensureEasingDraft(selected, persisted.keyframe.easing);
    const current = draft.curve;
    if (rawValue.length === 0 || !Number.isFinite(value)) {
      input.setCustomValidity("Enter a finite number.");
      input.reportValidity();
      input.value = String(current[coordinate]);
      input.setCustomValidity("");
      return;
    }
    const next = withCubicBezierCoordinate(current, coordinate, value);
    input.value = String(next[coordinate]);
    input.setCustomValidity("");
    if (sameCubicBezierCurve(next, current)) return;
    draft.curve = next;
    draft.selection = "custom";
    this.#easing.value = "custom";
    this.#renderCurveEditor(next, true);
    this.#commitEasingDraft(draft, cubicBezierEasingValue(next));
  }

  #hideCurveEditor(clearDraft = true): void {
    this.#curveEditor.hidden = true;
    this.#curveEditor.setAttribute("aria-hidden", "true");
    this.#workspace.classList.remove("easing-editor-open");
    this.#curveGraph.replaceChildren();
    if (clearDraft) this.#easingDraft = undefined;
  }

  #empty(message: string): HTMLElement {
    const empty = document.createElement("p");
    empty.className = "timeline-empty";
    empty.textContent = message;
    return empty;
  }

  #run(action: Promise<unknown>): void {
    void action.catch((error) => this.#controller.reportError(error));
  }
}
