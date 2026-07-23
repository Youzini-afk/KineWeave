import { canonicalStringify } from "@kineweave/project-format";
import type { JsonObject } from "@kineweave/protocol";
import {
  cubicBezierEasing,
  isStandardInterpolatedValueType,
  STANDARD_KEYFRAME_EASINGS
} from "@kineweave/standard-motion-document";
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

const EASING_PRESETS: Readonly<Record<string, JsonObject | null>> = {
  auto: null,
  linear: { kind: STANDARD_KEYFRAME_EASINGS.linear },
  hold: { kind: STANDARD_KEYFRAME_EASINGS.hold },
  ease: cubicBezierEasing(0.25, 0.1, 0.25, 1),
  "ease-in": cubicBezierEasing(0.42, 0, 1, 1),
  "ease-out": cubicBezierEasing(0, 0, 0.58, 1),
  "ease-in-out": cubicBezierEasing(0.42, 0, 0.58, 1)
};

function required<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (value === null) throw new Error(`Timeline element is missing: ${selector}`);
  return value;
}

function sameTime(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000_000_5;
}

export function easingPreset(easing: JsonObject | undefined): string {
  if (easing === undefined) return "auto";
  for (const [name, preset] of Object.entries(EASING_PRESETS)) {
    if (preset !== null && canonicalStringify(preset) === canonicalStringify(easing)) return name;
  }
  return "custom";
}

export class TimelineController {
  readonly #controller: StudioController;
  readonly #rows = required<HTMLElement>("#timeline-rows");
  readonly #summary = required<HTMLElement>("#track-summary");
  readonly #selectionLabel = required<HTMLElement>("#keyframe-selection");
  readonly #easing = required<HTMLSelectElement>("#keyframe-easing");
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
  #suppressClick: string | undefined;

  constructor(controller: StudioController) {
    this.#controller = controller;
    this.#snapshot = controller.snapshot();
    this.#easing.addEventListener("change", () => {
      const selected = this.#selected;
      const preset = EASING_PRESETS[this.#easing.value];
      if (selected === undefined || preset === undefined) return;
      this.#run(this.#controller.setKeyframeEasing(selected.trackId, selected.keyframeId, preset));
    });
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
    const selected = this.#selectedKeyframe();
    if (selected === undefined) {
      this.#selectionLabel.textContent = "No keyframe selected";
      this.#easing.value = "auto";
      this.#easing.disabled = true;
      this.#delete.disabled = true;
    } else {
      const { track, keyframe } = selected;
      const ordered = sortedKeyframes(track);
      const index = ordered.findIndex((item) => item.keyframeId === keyframe.keyframeId);
      const isLast = index === ordered.length - 1;
      this.#selectionLabel.textContent = `${track.target.property} · ${keyframeSeconds(keyframe).toFixed(3)}s${isLast ? " · end key" : ""}`;
      const preset = easingPreset(keyframe.easing);
      this.#ensureCustomEasingOption(preset === "custom");
      this.#easing.value = preset;
      this.#easing.disabled = isLast;
      for (const option of this.#easing.options) {
        option.disabled =
          isLast ||
          (!isStandardInterpolatedValueType(track.valueType) &&
            option.value !== "auto" &&
            option.value !== "hold");
      }
      this.#delete.disabled = false;
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
    if (this.#selected !== undefined && this.#selectedKeyframe() === undefined) {
      this.#selected = undefined;
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

  #ensureCustomEasingOption(needed: boolean): void {
    const existing = this.#easing.querySelector<HTMLOptionElement>('option[value="custom"]');
    if (needed && existing === null) {
      const option = document.createElement("option");
      option.value = "custom";
      option.textContent = "Custom cubic Bézier";
      option.disabled = true;
      this.#easing.append(option);
    } else if (!needed) {
      existing?.remove();
    }
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
