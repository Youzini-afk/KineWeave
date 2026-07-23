import {
  CANVAS2D_SURFACE_TYPE,
  type Canvas2DContextLike,
  type Canvas2DPathLike,
  type Canvas2DSurfaceResource
} from "@kineweave/canvas2d-renderer";
import type { ProjectSession } from "@kineweave/project-session";
import {
  type JsonValue,
  type ResolvedPresentationGraph,
  STANDARD_PRESENTATION_PRIMITIVES
} from "@kineweave/protocol";
import type { InteractiveRenderSession, InteractiveRenderSurface } from "@kineweave/render-engine";
import {
  compositionSurfaceBounds,
  nodeAnchorSurfacePoint,
  nodesInsideStageRect,
  roundCompositionCoordinate,
  type StagePoint,
  selectionBounds,
  selectionPolygon,
  stageRotationDirection,
  surfaceDeltaToLocalDelta,
  surfaceDeltaToParentDelta
} from "./studio-model.js";

export type StageSelectionMode = "replace" | "toggle" | "add";
export type StageAlignment =
  | "left"
  | "horizontal-center"
  | "right"
  | "top"
  | "vertical-center"
  | "bottom";

export interface StagePropertyEdit {
  readonly nodeId: string;
  readonly property: string;
  readonly value: JsonValue;
}

export interface StageControllerCallbacks {
  readonly onGestureStart: () => void | Promise<void>;
  readonly onSelect: (nodeId: string | undefined, mode: StageSelectionMode) => void;
  readonly onMarqueeSelect: (nodeIds: readonly string[], mode: StageSelectionMode) => void;
  readonly onTransform: (
    edits: readonly StagePropertyEdit[],
    message: string
  ) => void | Promise<void>;
  readonly onError: (error: unknown) => void;
}

interface TransformSnapshot {
  readonly nodeId: string;
  readonly position: StagePoint;
  readonly scale: StagePoint;
  readonly rotation: number;
  readonly rotationDirection: 1 | -1 | undefined;
  readonly anchor: StagePoint;
  readonly origin: StagePoint;
  readonly polygon: readonly StagePoint[];
}

interface GestureBase {
  readonly pointerId: number;
  readonly start: StagePoint;
  moved: boolean;
}

interface MoveGesture extends GestureBase {
  readonly kind: "move";
  readonly snapshots: readonly TransformSnapshot[];
  readonly bounds: NonNullable<ReturnType<typeof selectionBounds>>;
  delta: StagePoint;
}

interface ScaleGesture extends GestureBase {
  readonly kind: "scale";
  readonly snapshots: readonly TransformSnapshot[];
  readonly pivot: StagePoint;
  readonly handle: StagePoint;
  factor: number;
}

interface RotateGesture extends GestureBase {
  readonly kind: "rotate";
  readonly snapshots: readonly TransformSnapshot[];
  readonly pivot: StagePoint;
  readonly startAngle: number;
  angle: number;
}

interface AnchorGesture extends GestureBase {
  readonly kind: "anchor";
  readonly snapshot: TransformSnapshot;
  delta: StagePoint;
}

interface MarqueeGesture extends GestureBase {
  readonly kind: "marquee";
  readonly mode: StageSelectionMode;
  current: StagePoint;
}

type Gesture = MoveGesture | ScaleGesture | RotateGesture | AnchorGesture | MarqueeGesture;

interface SnapResult {
  readonly delta: StagePoint;
  readonly guideX?: number;
  readonly guideY?: number;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function pointsAttribute(points: readonly StagePoint[]): string {
  return points.map((value) => `${value[0]},${value[1]}`).join(" ");
}

function translatePoints(points: readonly StagePoint[], delta: StagePoint): readonly StagePoint[] {
  return points.map((point) => [point[0] + delta[0], point[1] + delta[1]] as const);
}

function scalePoints(
  points: readonly StagePoint[],
  pivot: StagePoint,
  factor: number
): readonly StagePoint[] {
  return points.map(
    (point) =>
      [
        pivot[0] + (point[0] - pivot[0]) * factor,
        pivot[1] + (point[1] - pivot[1]) * factor
      ] as const
  );
}

function rotatePoint(point: StagePoint, pivot: StagePoint, degrees: number): StagePoint {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point[0] - pivot[0];
  const y = point[1] - pivot[1];
  return [pivot[0] + x * cosine - y * sine, pivot[1] + x * sine + y * cosine];
}

function rotatePoints(
  points: readonly StagePoint[],
  pivot: StagePoint,
  degrees: number
): readonly StagePoint[] {
  return points.map((point) => rotatePoint(point, pivot, degrees));
}

function pointBounds(points: readonly StagePoint[]): {
  readonly minimumX: number;
  readonly maximumX: number;
  readonly minimumY: number;
  readonly maximumY: number;
  readonly center: StagePoint;
} {
  const xs = points.map((item) => item[0]);
  const ys = points.map((item) => item[1]);
  const minimumX = Math.min(...xs);
  const maximumX = Math.max(...xs);
  const minimumY = Math.min(...ys);
  const maximumY = Math.max(...ys);
  return {
    minimumX,
    maximumX,
    minimumY,
    maximumY,
    center: [(minimumX + maximumX) / 2, (minimumY + maximumY) / 2]
  };
}

function vectorLength(value: StagePoint): number {
  return Math.hypot(value[0], value[1]);
}

function selectionMode(event: PointerEvent): StageSelectionMode {
  if (event.ctrlKey || event.metaKey) return "toggle";
  if (event.shiftKey) return "add";
  return "replace";
}

export class StageController {
  readonly #canvas: HTMLCanvasElement;
  readonly #overlay: SVGSVGElement;
  readonly #selection: SVGPolygonElement;
  readonly #members = svgElement("g");
  readonly #scaleHandles: readonly SVGCircleElement[];
  readonly #rotationStem = svgElement("line");
  readonly #rotationHandle = svgElement("circle");
  readonly #anchorHandle = svgElement("circle");
  readonly #anchorHorizontal = svgElement("line");
  readonly #anchorVertical = svgElement("line");
  readonly #guideX = svgElement("line");
  readonly #guideY = svgElement("line");
  readonly #marquee = svgElement("rect");
  readonly #callbacks: StageControllerCallbacks;
  readonly #resizeObserver: ResizeObserver;
  readonly #handleCanvasPointerDown = (event: PointerEvent): void => {
    void this.#canvasPointerDown(event);
  };
  readonly #handlePointerMove = (event: PointerEvent): void => this.#pointerMove(event);
  readonly #handlePointerUp = (event: PointerEvent): void => {
    void this.#pointerUp(event);
  };
  readonly #handlePointerCancel = (event: PointerEvent): void => {
    void this.#cancelPointer(event);
  };
  readonly #handleOverlayPointerDown = (event: PointerEvent): void => {
    void this.#overlayPointerDown(event);
  };
  #project: ProjectSession | undefined;
  #interactive: InteractiveRenderSession | undefined;
  #graph: ResolvedPresentationGraph | undefined;
  #selectedNodeIds: readonly string[] = [];
  #gesture: Gesture | undefined;
  #pendingPointerId: number | undefined;
  #hitTestGeneration = 0;
  readonly #pressedPointers = new Set<number>();
  #deferredPresentation:
    | { readonly project: ProjectSession; readonly graph: ResolvedPresentationGraph }
    | undefined;
  #operation = Promise.resolve();
  #disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    selection: SVGPolygonElement,
    callbacks: StageControllerCallbacks
  ) {
    const overlay = selection.ownerSVGElement;
    if (overlay === null) throw new Error("Stage selection overlay is missing");
    this.#canvas = canvas;
    this.#overlay = overlay;
    this.#selection = selection;
    this.#callbacks = callbacks;
    this.#members.classList.add("selection-members");
    this.#selection.before(this.#members);

    this.#scaleHandles = [0, 1, 2, 3].map((index) => {
      const handle = svgElement("circle");
      handle.classList.add("stage-handle", "scale-handle");
      handle.dataset.stageHandle = "scale";
      handle.dataset.corner = String(index);
      handle.setAttribute("r", "5");
      handle.style.display = "none";
      return handle;
    });
    this.#rotationStem.classList.add("rotation-stem");
    this.#rotationHandle.classList.add("stage-handle", "rotation-handle");
    this.#rotationHandle.dataset.stageHandle = "rotate";
    this.#rotationHandle.setAttribute("r", "5");
    this.#anchorHandle.classList.add("stage-handle", "anchor-handle");
    this.#anchorHandle.dataset.stageHandle = "anchor";
    this.#anchorHandle.setAttribute("r", "5");
    this.#anchorHorizontal.classList.add("anchor-cross");
    this.#anchorVertical.classList.add("anchor-cross");
    this.#guideX.classList.add("snap-guide");
    this.#guideY.classList.add("snap-guide");
    this.#marquee.classList.add("selection-marquee");
    for (const element of [
      this.#rotationStem,
      this.#rotationHandle,
      ...this.#scaleHandles,
      this.#anchorHorizontal,
      this.#anchorVertical,
      this.#anchorHandle,
      this.#guideX,
      this.#guideY,
      this.#marquee
    ]) {
      element.style.display = "none";
      this.#overlay.append(element);
    }

    this.#resizeObserver = new ResizeObserver(() => {
      void this.#enqueue(async () => {
        if (this.#interactive === undefined) return;
        await this.#interactive.resize(this.#surface());
        this.#updateSelection();
      }).catch(() => {});
    });
    this.#resizeObserver.observe(canvas);
    canvas.addEventListener("pointerdown", this.#handleCanvasPointerDown);
    canvas.addEventListener("pointermove", this.#handlePointerMove);
    canvas.addEventListener("pointerup", this.#handlePointerUp);
    canvas.addEventListener("pointercancel", this.#handlePointerCancel);
    overlay.addEventListener("pointerdown", this.#handleOverlayPointerDown);
    overlay.addEventListener("pointermove", this.#handlePointerMove);
    overlay.addEventListener("pointerup", this.#handlePointerUp);
    overlay.addEventListener("pointercancel", this.#handlePointerCancel);
  }

  async present(project: ProjectSession, graph: ResolvedPresentationGraph): Promise<void> {
    if (this.#interactionActive()) {
      this.#deferredPresentation = { project, graph };
      return;
    }
    await this.#applyPresentation(project, graph);
  }

  async #applyPresentation(
    project: ProjectSession,
    graph: ResolvedPresentationGraph
  ): Promise<void> {
    await this.#enqueue(async () => {
      if (this.#project !== project || this.#interactive === undefined) {
        await this.#interactive?.dispose();
        this.#interactive = undefined;
        this.#project = undefined;
        const interactive = await project.openInteractiveSession({
          graph,
          evaluationMode: "interactive",
          surface: this.#surface()
        });
        this.#project = project;
        this.#interactive = interactive;
      } else {
        await this.#interactive.updateGraph({ graph });
      }
      this.#graph = graph;
      this.#updateSelection();
    });
  }

  select(nodeIds: readonly string[]): void {
    this.#selectedNodeIds = nodeIds.filter((nodeId, index) => nodeIds.indexOf(nodeId) === index);
    this.#updateSelection();
  }

  async align(alignment: StageAlignment): Promise<void> {
    const graph = this.#graph;
    if (graph === undefined || this.#selectedNodeIds.length < 2) return;
    const surface = this.#surfaceSize();
    const overall = selectionBounds(graph, this.#selectedNodeIds, surface);
    if (overall === undefined) return;
    const edits: StagePropertyEdit[] = [];
    for (const nodeId of this.#selectedNodeIds) {
      const node = graph.nodes[nodeId];
      const polygon = selectionPolygon(graph, nodeId, surface);
      if (node === undefined || polygon === undefined) continue;
      const bounds = pointBounds(polygon);
      let surfaceDelta: StagePoint;
      if (alignment === "left") surfaceDelta = [overall.minimumX - bounds.minimumX, 0];
      else if (alignment === "horizontal-center") {
        surfaceDelta = [overall.center[0] - bounds.center[0], 0];
      } else if (alignment === "right") {
        surfaceDelta = [overall.maximumX - bounds.maximumX, 0];
      } else if (alignment === "top") surfaceDelta = [0, overall.minimumY - bounds.minimumY];
      else if (alignment === "vertical-center") {
        surfaceDelta = [0, overall.center[1] - bounds.center[1]];
      } else {
        surfaceDelta = [0, overall.maximumY - bounds.maximumY];
      }
      const parentDelta = surfaceDeltaToParentDelta(graph, nodeId, surface, surfaceDelta);
      if (parentDelta === undefined) continue;
      const [translationX = 0, translationY = 0] = node.transform.translation;
      edits.push({
        nodeId,
        property: "position",
        value: [
          roundCompositionCoordinate(translationX + parentDelta[0]),
          roundCompositionCoordinate(translationY + parentDelta[1])
        ]
      });
    }
    if (edits.length > 0) await this.#callbacks.onTransform(edits, "Aligned selection");
  }

  viewport(): {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: number;
  } {
    return {
      ...this.#surfaceSize(),
      pixelRatio: Math.max(1, window.devicePixelRatio || 1)
    };
  }

  async reset(): Promise<void> {
    this.cancelActiveGesture();
    await this.#enqueue(async () => {
      const interactive = this.#interactive;
      this.#interactive = undefined;
      this.#project = undefined;
      this.#graph = undefined;
      this.#selectedNodeIds = [];
      this.#deferredPresentation = undefined;
      try {
        await interactive?.dispose();
      } finally {
        this.#clearOverlay();
        const context = this.#canvas.getContext("2d");
        context?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      }
    });
  }

  cancelActiveGesture(): void {
    this.#hitTestGeneration += 1;
    this.#pendingPointerId = undefined;
    this.#gesture = undefined;
    for (const pointerId of this.#pressedPointers) this.#releasePointer(pointerId);
    this.#pressedPointers.clear();
    this.#deferredPresentation = undefined;
    this.#clearOverlay();
    this.#updateSelection();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resizeObserver.disconnect();
    this.#canvas.removeEventListener("pointerdown", this.#handleCanvasPointerDown);
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#handlePointerCancel);
    this.#overlay.removeEventListener("pointerdown", this.#handleOverlayPointerDown);
    this.#overlay.removeEventListener("pointermove", this.#handlePointerMove);
    this.#overlay.removeEventListener("pointerup", this.#handlePointerUp);
    this.#overlay.removeEventListener("pointercancel", this.#handlePointerCancel);
    await this.reset();
  }

  async #canvasPointerDown(event: PointerEvent): Promise<void> {
    if (
      event.button !== 0 ||
      this.#interactive === undefined ||
      this.#gesture !== undefined ||
      this.#pendingPointerId !== undefined
    ) {
      return;
    }
    const pointerId = event.pointerId;
    const start = this.#eventPoint(event);
    const mode = selectionMode(event);
    const generation = ++this.#hitTestGeneration;
    this.#pendingPointerId = pointerId;
    this.#pressedPointers.add(pointerId);
    this.#canvas.setPointerCapture(pointerId);
    try {
      await this.#callbacks.onGestureStart();
      if (generation !== this.#hitTestGeneration || this.#pendingPointerId !== pointerId) return;
      await this.#applyDeferredPresentation();
      await this.#enqueue(async () => {});
      if (generation !== this.#hitTestGeneration || this.#pendingPointerId !== pointerId) return;
      const interactive = this.#interactive;
      if (interactive === undefined) return;
      const hits = await interactive.hitTest({ x: start[0], y: start[1], mode: "topmost" });
      if (generation !== this.#hitTestGeneration || this.#pendingPointerId !== pointerId) return;
      this.#pendingPointerId = undefined;
      const nodeId = hits[0]?.presentationId;
      if (nodeId === undefined) {
        if (this.#pressedPointers.has(pointerId)) this.#beginMarquee(pointerId, start, mode);
        else this.#callbacks.onSelect(undefined, mode);
        return;
      }
      const wasSelected = this.#selectedNodeIds.includes(nodeId);
      if (!(mode === "replace" && wasSelected)) this.#callbacks.onSelect(nodeId, mode);
      if (
        !this.#pressedPointers.has(pointerId) ||
        mode !== "replace" ||
        !this.#selectedNodeIds.includes(nodeId)
      ) {
        return;
      }
      const snapshots = this.#snapshots();
      const graph = this.#graph;
      const bounds =
        graph === undefined
          ? undefined
          : selectionBounds(graph, this.#selectedNodeIds, this.#surfaceSize());
      if (snapshots.length === 0 || bounds === undefined) return;
      this.#gesture = {
        kind: "move",
        pointerId,
        start,
        snapshots,
        bounds,
        delta: [0, 0],
        moved: false
      };
    } catch (error) {
      if (generation === this.#hitTestGeneration) this.#callbacks.onError(error);
    } finally {
      if (this.#pendingPointerId === pointerId) this.#pendingPointerId = undefined;
      if (this.#gesture?.pointerId !== pointerId && !this.#pressedPointers.has(pointerId)) {
        this.#releasePointer(pointerId);
      }
      await this.#flushDeferredPresentation();
    }
  }

  async #overlayPointerDown(event: PointerEvent): Promise<void> {
    if (event.button !== 0 || this.#gesture !== undefined || this.#pendingPointerId !== undefined) {
      return;
    }
    const target =
      event.target instanceof Element
        ? event.target.closest<SVGElement>("[data-stage-handle]")
        : null;
    if (target === null) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const start = this.#eventPoint(event);
    const handle = target.dataset.stageHandle;
    const corner = Number(target.dataset.corner);
    const generation = ++this.#hitTestGeneration;
    this.#pendingPointerId = pointerId;
    this.#pressedPointers.add(pointerId);
    this.#overlay.setPointerCapture(pointerId);
    try {
      await this.#callbacks.onGestureStart();
      if (generation !== this.#hitTestGeneration || this.#pendingPointerId !== pointerId) return;
      await this.#applyDeferredPresentation();
      await this.#enqueue(async () => {});
      if (
        generation !== this.#hitTestGeneration ||
        this.#pendingPointerId !== pointerId ||
        !this.#pressedPointers.has(pointerId)
      ) {
        return;
      }
      this.#pendingPointerId = undefined;
      const graph = this.#graph;
      const snapshots = this.#snapshots();
      const bounds =
        graph === undefined
          ? undefined
          : selectionBounds(graph, this.#selectedNodeIds, this.#surfaceSize());
      if (graph === undefined || snapshots.length === 0 || bounds === undefined) return;
      if (handle === "scale") {
        const polygon = this.#activePolygon();
        if (polygon === undefined || !Number.isInteger(corner) || corner < 0 || corner > 3) return;
        this.#gesture = {
          kind: "scale",
          pointerId,
          start,
          snapshots,
          pivot: polygon[(corner + 2) % 4]!,
          handle: polygon[corner]!,
          factor: 1,
          moved: false
        };
      } else if (
        handle === "rotate" &&
        snapshots.every((item) => item.rotationDirection !== undefined)
      ) {
        const pivot = bounds.center;
        this.#gesture = {
          kind: "rotate",
          pointerId,
          start,
          snapshots,
          pivot,
          startAngle: Math.atan2(start[1] - pivot[1], start[0] - pivot[0]),
          angle: 0,
          moved: false
        };
      } else if (handle === "anchor" && snapshots.length === 1) {
        this.#gesture = {
          kind: "anchor",
          pointerId,
          start,
          snapshot: snapshots[0]!,
          delta: [0, 0],
          moved: false
        };
      }
    } catch (error) {
      if (generation === this.#hitTestGeneration) this.#callbacks.onError(error);
    } finally {
      if (this.#pendingPointerId === pointerId) this.#pendingPointerId = undefined;
      if (this.#gesture?.pointerId !== pointerId) {
        this.#pressedPointers.delete(pointerId);
        this.#releasePointer(pointerId);
      }
      await this.#flushDeferredPresentation();
    }
  }

  #beginMarquee(pointerId: number, start: StagePoint, mode: StageSelectionMode): void {
    this.#canvas.setPointerCapture(pointerId);
    this.#gesture = {
      kind: "marquee",
      pointerId,
      start,
      current: start,
      mode,
      moved: false
    };
    this.#updateMarquee(start, start);
  }

  #pointerMove(event: PointerEvent): void {
    const gesture = this.#gesture;
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return;
    const current = this.#eventPoint(event);
    if (gesture.kind === "move") this.#moveGesture(gesture, current, event);
    else if (gesture.kind === "scale") this.#scaleGesture(gesture, current);
    else if (gesture.kind === "rotate") this.#rotateGesture(gesture, current, event);
    else if (gesture.kind === "anchor") this.#anchorGesture(gesture, current, event);
    else {
      gesture.current = current;
      gesture.moved ||=
        vectorLength([current[0] - gesture.start[0], current[1] - gesture.start[1]]) >= 2;
      this.#updateMarquee(gesture.start, current);
    }
  }

  #moveGesture(gesture: MoveGesture, current: StagePoint, event: PointerEvent): void {
    let delta: StagePoint = [current[0] - gesture.start[0], current[1] - gesture.start[1]];
    if (event.shiftKey) {
      delta = Math.abs(delta[0]) >= Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]];
    }
    const snapped = this.#snapMove(gesture.bounds, delta, event.altKey);
    gesture.delta = snapped.delta;
    gesture.moved ||= vectorLength(delta) >= 2;
    this.#showGuides(snapped.guideX, snapped.guideY);
    this.#preview(
      gesture.snapshots.map((snapshot) => translatePoints(snapshot.polygon, gesture.delta))
    );
    if (gesture.snapshots.length === 1) {
      const origin = gesture.snapshots[0]!.origin;
      this.#placeAnchor([origin[0] + gesture.delta[0], origin[1] + gesture.delta[1]]);
    }
  }

  #scaleGesture(gesture: ScaleGesture, current: StagePoint): void {
    const startVector: StagePoint = [
      gesture.handle[0] - gesture.pivot[0],
      gesture.handle[1] - gesture.pivot[1]
    ];
    const currentVector: StagePoint = [
      current[0] - gesture.pivot[0],
      current[1] - gesture.pivot[1]
    ];
    const denominator = startVector[0] ** 2 + startVector[1] ** 2;
    let factor =
      denominator < 1e-6
        ? 1
        : (currentVector[0] * startVector[0] + currentVector[1] * startVector[1]) / denominator;
    if (Math.abs(factor) < 0.02) factor = factor < 0 ? -0.02 : 0.02;
    gesture.factor = factor;
    gesture.moved ||= Math.abs(factor - 1) >= 0.005;
    this.#preview(
      gesture.snapshots.map((snapshot) => scalePoints(snapshot.polygon, gesture.pivot, factor))
    );
    if (gesture.snapshots.length === 1) {
      this.#placeAnchor(scalePoints([gesture.snapshots[0]!.origin], gesture.pivot, factor)[0]!);
    }
  }

  #rotateGesture(gesture: RotateGesture, current: StagePoint, event: PointerEvent): void {
    const currentAngle = Math.atan2(current[1] - gesture.pivot[1], current[0] - gesture.pivot[0]);
    let degrees = ((currentAngle - gesture.startAngle) * 180) / Math.PI;
    if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
    gesture.angle = degrees;
    gesture.moved ||= Math.abs(degrees) >= 0.25;
    this.#preview(
      gesture.snapshots.map((snapshot) => rotatePoints(snapshot.polygon, gesture.pivot, degrees))
    );
    if (gesture.snapshots.length === 1) {
      this.#placeAnchor(rotatePoint(gesture.snapshots[0]!.origin, gesture.pivot, degrees));
    }
  }

  #anchorGesture(gesture: AnchorGesture, current: StagePoint, event: PointerEvent): void {
    let delta: StagePoint = [current[0] - gesture.start[0], current[1] - gesture.start[1]];
    if (event.shiftKey) {
      delta = Math.abs(delta[0]) >= Math.abs(delta[1]) ? [delta[0], 0] : [0, delta[1]];
    }
    gesture.delta = delta;
    gesture.moved ||= vectorLength(delta) >= 2;
    this.#placeAnchor([
      gesture.snapshot.origin[0] + delta[0],
      gesture.snapshot.origin[1] + delta[1]
    ]);
  }

  async #pointerUp(event: PointerEvent): Promise<void> {
    this.#pressedPointers.delete(event.pointerId);
    const gesture = this.#gesture;
    if (gesture === undefined || gesture.pointerId !== event.pointerId) {
      this.#releasePointer(event.pointerId);
      await this.#flushDeferredPresentation();
      return;
    }
    if (gesture.kind === "marquee") {
      this.#gesture = undefined;
      this.#releasePointer(event.pointerId);
      this.#marquee.style.display = "none";
      if (!gesture.moved) this.#callbacks.onSelect(undefined, gesture.mode);
      else if (this.#graph !== undefined) {
        this.#callbacks.onMarqueeSelect(
          nodesInsideStageRect(this.#graph, this.#surfaceSize(), gesture.start, gesture.current),
          gesture.mode
        );
      }
      this.#updateSelection();
      await this.#flushDeferredPresentation();
      return;
    }
    if (!gesture.moved) {
      this.#gesture = undefined;
      this.#releasePointer(event.pointerId);
      this.#hideGuides();
      this.#updateSelection();
      await this.#flushDeferredPresentation();
      return;
    }
    try {
      const edits = this.#gestureEdits(gesture);
      if (edits.length > 0) {
        const message =
          gesture.kind === "move"
            ? "Moved selection"
            : gesture.kind === "scale"
              ? "Scaled selection"
              : gesture.kind === "rotate"
                ? "Rotated selection"
                : "Moved anchor";
        await this.#callbacks.onTransform(edits, message);
      }
    } catch (error) {
      this.#callbacks.onError(error);
    } finally {
      this.#gesture = undefined;
      this.#releasePointer(event.pointerId);
      this.#hideGuides();
      this.#updateSelection();
      await this.#flushDeferredPresentation();
    }
  }

  #gestureEdits(gesture: Exclude<Gesture, MarqueeGesture>): readonly StagePropertyEdit[] {
    const graph = this.#graph;
    if (graph === undefined) return [];
    const surface = this.#surfaceSize();
    if (gesture.kind === "move") {
      return gesture.snapshots.flatMap((snapshot) => {
        const parentDelta = surfaceDeltaToParentDelta(
          graph,
          snapshot.nodeId,
          surface,
          gesture.delta
        );
        return parentDelta === undefined
          ? []
          : [
              {
                nodeId: snapshot.nodeId,
                property: "position",
                value: [
                  roundCompositionCoordinate(snapshot.position[0] + parentDelta[0]),
                  roundCompositionCoordinate(snapshot.position[1] + parentDelta[1])
                ]
              }
            ];
      });
    }
    if (gesture.kind === "scale") {
      return gesture.snapshots.flatMap((snapshot) => {
        const nextOrigin: StagePoint = [
          gesture.pivot[0] + (snapshot.origin[0] - gesture.pivot[0]) * gesture.factor,
          gesture.pivot[1] + (snapshot.origin[1] - gesture.pivot[1]) * gesture.factor
        ];
        const parentDelta = surfaceDeltaToParentDelta(graph, snapshot.nodeId, surface, [
          nextOrigin[0] - snapshot.origin[0],
          nextOrigin[1] - snapshot.origin[1]
        ]);
        if (parentDelta === undefined) return [];
        return [
          {
            nodeId: snapshot.nodeId,
            property: "position",
            value: [
              roundCompositionCoordinate(snapshot.position[0] + parentDelta[0]),
              roundCompositionCoordinate(snapshot.position[1] + parentDelta[1])
            ]
          },
          {
            nodeId: snapshot.nodeId,
            property: "scale",
            value: [
              roundCompositionCoordinate(snapshot.scale[0] * gesture.factor),
              roundCompositionCoordinate(snapshot.scale[1] * gesture.factor)
            ]
          }
        ];
      });
    }
    if (gesture.kind === "rotate") {
      return gesture.snapshots.flatMap((snapshot) => {
        const nextOrigin = rotatePoint(snapshot.origin, gesture.pivot, gesture.angle);
        const parentDelta = surfaceDeltaToParentDelta(graph, snapshot.nodeId, surface, [
          nextOrigin[0] - snapshot.origin[0],
          nextOrigin[1] - snapshot.origin[1]
        ]);
        if (parentDelta === undefined || snapshot.rotationDirection === undefined) return [];
        return [
          {
            nodeId: snapshot.nodeId,
            property: "position",
            value: [
              roundCompositionCoordinate(snapshot.position[0] + parentDelta[0]),
              roundCompositionCoordinate(snapshot.position[1] + parentDelta[1])
            ]
          },
          {
            nodeId: snapshot.nodeId,
            property: "rotation",
            value: roundCompositionCoordinate(
              snapshot.rotation + gesture.angle * snapshot.rotationDirection
            )
          }
        ];
      });
    }
    const parentDelta = surfaceDeltaToParentDelta(
      graph,
      gesture.snapshot.nodeId,
      surface,
      gesture.delta
    );
    const localDelta = surfaceDeltaToLocalDelta(
      graph,
      gesture.snapshot.nodeId,
      surface,
      gesture.delta
    );
    if (parentDelta === undefined || localDelta === undefined) return [];
    return [
      {
        nodeId: gesture.snapshot.nodeId,
        property: "position",
        value: [
          roundCompositionCoordinate(gesture.snapshot.position[0] + parentDelta[0]),
          roundCompositionCoordinate(gesture.snapshot.position[1] + parentDelta[1])
        ]
      },
      {
        nodeId: gesture.snapshot.nodeId,
        property: "anchor",
        value: [
          roundCompositionCoordinate(gesture.snapshot.anchor[0] + localDelta[0]),
          roundCompositionCoordinate(gesture.snapshot.anchor[1] + localDelta[1])
        ]
      }
    ];
  }

  #snapshots(): readonly TransformSnapshot[] {
    const graph = this.#graph;
    if (graph === undefined) return [];
    const surface = this.#surfaceSize();
    return this.#selectedNodeIds.flatMap((nodeId) => {
      const node = graph.nodes[nodeId];
      const polygon = selectionPolygon(graph, nodeId, surface);
      const origin = nodeAnchorSurfacePoint(graph, nodeId, surface);
      if (node === undefined || polygon === undefined || origin === undefined) return [];
      return [
        {
          nodeId,
          position: [node.transform.translation[0] ?? 0, node.transform.translation[1] ?? 0],
          scale: [node.transform.scale[0] ?? 1, node.transform.scale[1] ?? 1],
          rotation: node.transform.rotation,
          rotationDirection: stageRotationDirection(graph, nodeId),
          anchor: [node.transform.anchor[0] ?? 0, node.transform.anchor[1] ?? 0],
          origin,
          polygon
        }
      ];
    });
  }

  #snapMove(
    bounds: NonNullable<ReturnType<typeof selectionBounds>>,
    requested: StagePoint,
    disabled: boolean
  ): SnapResult {
    const graph = this.#graph;
    if (disabled || graph === undefined) return { delta: requested };
    const surface = this.#surfaceSize();
    const targetsX: number[] = [];
    const targetsY: number[] = [];
    const canvas = compositionSurfaceBounds(graph, surface);
    targetsX.push(canvas.minimumX, canvas.center[0], canvas.maximumX);
    targetsY.push(canvas.minimumY, canvas.center[1], canvas.maximumY);
    for (const node of Object.values(graph.nodes)) {
      if (
        this.#selectedNodeIds.includes(node.presentationId) ||
        node.primitive === STANDARD_PRESENTATION_PRIMITIVES.group ||
        !node.visible
      ) {
        continue;
      }
      const candidate = selectionBounds(graph, [node.presentationId], surface);
      if (candidate === undefined) continue;
      targetsX.push(candidate.minimumX, candidate.center[0], candidate.maximumX);
      targetsY.push(candidate.minimumY, candidate.center[1], candidate.maximumY);
    }
    const sourcesX = [bounds.minimumX, bounds.center[0], bounds.maximumX].map(
      (value) => value + requested[0]
    );
    const sourcesY = [bounds.minimumY, bounds.center[1], bounds.maximumY].map(
      (value) => value + requested[1]
    );
    const closest = (sources: readonly number[], targets: readonly number[]) => {
      let result: { offset: number; target: number } | undefined;
      for (const source of sources) {
        for (const target of targets) {
          const offset = target - source;
          if (
            Math.abs(offset) <= 6 &&
            (result === undefined || Math.abs(offset) < Math.abs(result.offset))
          ) {
            result = { offset, target };
          }
        }
      }
      return result;
    };
    const x = closest(sourcesX, targetsX);
    const y = closest(sourcesY, targetsY);
    return {
      delta: [requested[0] + (x?.offset ?? 0), requested[1] + (y?.offset ?? 0)],
      ...(x === undefined ? {} : { guideX: x.target }),
      ...(y === undefined ? {} : { guideY: y.target })
    };
  }

  #preview(polygons: readonly (readonly StagePoint[])[]): void {
    this.#members.replaceChildren();
    for (const polygon of polygons) {
      const member = svgElement("polygon");
      member.classList.add("selection-member");
      member.setAttribute("points", pointsAttribute(polygon));
      this.#members.append(member);
    }
    const active =
      polygons.length === 1
        ? polygons[0]
        : polygons.length > 1
          ? (() => {
              const bounds = pointBounds(polygons.flat());
              return [
                [bounds.minimumX, bounds.minimumY],
                [bounds.maximumX, bounds.minimumY],
                [bounds.maximumX, bounds.maximumY],
                [bounds.minimumX, bounds.maximumY]
              ] as const;
            })()
          : undefined;
    this.#selection.setAttribute("points", active === undefined ? "" : pointsAttribute(active));
    if (active !== undefined) this.#placeHandles(active);
  }

  #updateSelection(): void {
    if (this.#gesture !== undefined) return;
    const graph = this.#graph;
    const surface = this.#surfaceSize();
    if (graph === undefined || this.#selectedNodeIds.length === 0) {
      this.#clearSelection();
      return;
    }
    const polygons = this.#selectedNodeIds.flatMap((nodeId) => {
      const polygon = selectionPolygon(graph, nodeId, surface);
      return polygon === undefined ? [] : [polygon];
    });
    if (polygons.length === 0) {
      this.#clearSelection();
      return;
    }
    this.#members.replaceChildren();
    if (polygons.length > 1) {
      for (const polygon of polygons) {
        const member = svgElement("polygon");
        member.classList.add("selection-member");
        member.setAttribute("points", pointsAttribute(polygon));
        this.#members.append(member);
      }
    }
    const active =
      polygons.length === 1
        ? polygons[0]!
        : selectionBounds(graph, this.#selectedNodeIds, surface)?.polygon;
    if (active === undefined) {
      this.#clearSelection();
      return;
    }
    this.#selection.setAttribute("points", pointsAttribute(active));
    this.#placeHandles(active);
    const anchor =
      this.#selectedNodeIds.length === 1
        ? nodeAnchorSurfacePoint(graph, this.#selectedNodeIds[0]!, surface)
        : undefined;
    if (anchor === undefined) this.#hideAnchor();
    else this.#placeAnchor(anchor);
  }

  #placeHandles(polygon: readonly StagePoint[]): void {
    polygon.slice(0, 4).forEach((point, index) => {
      const handle = this.#scaleHandles[index]!;
      handle.setAttribute("cx", String(point[0]));
      handle.setAttribute("cy", String(point[1]));
      handle.style.display = "";
    });
    if (!this.#rotationAvailable()) {
      this.#rotationStem.style.display = "none";
      this.#rotationHandle.style.display = "none";
      return;
    }
    const topCenter: StagePoint = [
      (polygon[0]![0] + polygon[1]![0]) / 2,
      (polygon[0]![1] + polygon[1]![1]) / 2
    ];
    const center = pointBounds(polygon).center;
    const outward: StagePoint = [topCenter[0] - center[0], topCenter[1] - center[1]];
    const length = Math.max(1, vectorLength(outward));
    const rotate: StagePoint = [
      topCenter[0] + (outward[0] / length) * 24,
      topCenter[1] + (outward[1] / length) * 24
    ];
    this.#rotationStem.setAttribute("x1", String(topCenter[0]));
    this.#rotationStem.setAttribute("y1", String(topCenter[1]));
    this.#rotationStem.setAttribute("x2", String(rotate[0]));
    this.#rotationStem.setAttribute("y2", String(rotate[1]));
    this.#rotationHandle.setAttribute("cx", String(rotate[0]));
    this.#rotationHandle.setAttribute("cy", String(rotate[1]));
    this.#rotationStem.style.display = "";
    this.#rotationHandle.style.display = "";
  }

  #rotationAvailable(): boolean {
    const graph = this.#graph;
    return (
      graph !== undefined &&
      this.#selectedNodeIds.length > 0 &&
      this.#selectedNodeIds.every((nodeId) => stageRotationDirection(graph, nodeId) !== undefined)
    );
  }

  #placeAnchor(anchor: StagePoint): void {
    const radius = 7;
    this.#anchorHorizontal.setAttribute("x1", String(anchor[0] - radius));
    this.#anchorHorizontal.setAttribute("y1", String(anchor[1]));
    this.#anchorHorizontal.setAttribute("x2", String(anchor[0] + radius));
    this.#anchorHorizontal.setAttribute("y2", String(anchor[1]));
    this.#anchorVertical.setAttribute("x1", String(anchor[0]));
    this.#anchorVertical.setAttribute("y1", String(anchor[1] - radius));
    this.#anchorVertical.setAttribute("x2", String(anchor[0]));
    this.#anchorVertical.setAttribute("y2", String(anchor[1] + radius));
    this.#anchorHandle.setAttribute("cx", String(anchor[0]));
    this.#anchorHandle.setAttribute("cy", String(anchor[1]));
    this.#anchorHorizontal.style.display = "";
    this.#anchorVertical.style.display = "";
    this.#anchorHandle.style.display = "";
  }

  #hideAnchor(): void {
    this.#anchorHorizontal.style.display = "none";
    this.#anchorVertical.style.display = "none";
    this.#anchorHandle.style.display = "none";
  }

  #activePolygon(): readonly StagePoint[] | undefined {
    const points = this.#selection.getAttribute("points")?.trim();
    if (!points) return undefined;
    const parsed = points.split(/\s+/).map((pair) => pair.split(",").map(Number));
    return parsed.length === 4 &&
      parsed.every((pair) => pair.length === 2 && pair.every(Number.isFinite))
      ? parsed.map((pair) => [pair[0]!, pair[1]!] as const)
      : undefined;
  }

  #showGuides(x: number | undefined, y: number | undefined): void {
    const surface = this.#surfaceSize();
    if (x === undefined) this.#guideX.style.display = "none";
    else {
      this.#guideX.setAttribute("x1", String(x));
      this.#guideX.setAttribute("y1", "0");
      this.#guideX.setAttribute("x2", String(x));
      this.#guideX.setAttribute("y2", String(surface.height));
      this.#guideX.style.display = "";
    }
    if (y === undefined) this.#guideY.style.display = "none";
    else {
      this.#guideY.setAttribute("x1", "0");
      this.#guideY.setAttribute("y1", String(y));
      this.#guideY.setAttribute("x2", String(surface.width));
      this.#guideY.setAttribute("y2", String(y));
      this.#guideY.style.display = "";
    }
  }

  #hideGuides(): void {
    this.#guideX.style.display = "none";
    this.#guideY.style.display = "none";
  }

  #updateMarquee(start: StagePoint, current: StagePoint): void {
    this.#marquee.setAttribute("x", String(Math.min(start[0], current[0])));
    this.#marquee.setAttribute("y", String(Math.min(start[1], current[1])));
    this.#marquee.setAttribute("width", String(Math.abs(current[0] - start[0])));
    this.#marquee.setAttribute("height", String(Math.abs(current[1] - start[1])));
    this.#marquee.style.display = "";
  }

  async #cancelPointer(event: PointerEvent): Promise<void> {
    const pointerId = event.pointerId;
    this.#pressedPointers.delete(pointerId);
    if (this.#pendingPointerId === pointerId) {
      this.#hitTestGeneration += 1;
      this.#pendingPointerId = undefined;
    }
    if (this.#gesture?.pointerId === pointerId) this.#gesture = undefined;
    this.#releasePointer(pointerId);
    this.#marquee.style.display = "none";
    this.#hideGuides();
    this.#updateSelection();
    await this.#flushDeferredPresentation();
  }

  #releasePointer(pointerId: number): void {
    if (this.#canvas.hasPointerCapture(pointerId)) this.#canvas.releasePointerCapture(pointerId);
    if (this.#overlay.hasPointerCapture(pointerId)) this.#overlay.releasePointerCapture(pointerId);
  }

  #interactionActive(): boolean {
    return this.#gesture !== undefined || this.#pendingPointerId !== undefined;
  }

  async #flushDeferredPresentation(): Promise<void> {
    if (this.#interactionActive()) return;
    try {
      while (!this.#interactionActive() && this.#deferredPresentation !== undefined) {
        await this.#applyDeferredPresentation();
      }
    } catch {
      // The Stage operation queue has already reported the rendering failure.
    }
  }

  async #applyDeferredPresentation(): Promise<void> {
    const presentation = this.#deferredPresentation;
    if (presentation === undefined) return;
    this.#deferredPresentation = undefined;
    await this.#applyPresentation(presentation.project, presentation.graph);
  }

  #clearSelection(): void {
    this.#members.replaceChildren();
    this.#selection.setAttribute("points", "");
    for (const handle of this.#scaleHandles) handle.style.display = "none";
    this.#rotationStem.style.display = "none";
    this.#rotationHandle.style.display = "none";
    this.#hideAnchor();
  }

  #clearOverlay(): void {
    this.#clearSelection();
    this.#hideGuides();
    this.#marquee.style.display = "none";
  }

  #surface(): InteractiveRenderSurface {
    const size = this.#surfaceSize();
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);
    const backingWidth = Math.max(1, Math.round(size.width * pixelRatio));
    const backingHeight = Math.max(1, Math.round(size.height * pixelRatio));
    if (this.#canvas.width !== backingWidth || this.#canvas.height !== backingHeight) {
      this.#canvas.width = backingWidth;
      this.#canvas.height = backingHeight;
    }
    const context = this.#canvas.getContext("2d");
    if (context === null) throw new Error("Canvas2D is unavailable in this host");
    const resource: Canvas2DSurfaceResource = {
      context: context as unknown as Canvas2DContextLike,
      createPath2D: (pathData) => new Path2D(pathData) as unknown as Canvas2DPathLike
    };
    return {
      surfaceType: CANVAS2D_SURFACE_TYPE,
      width: size.width,
      height: size.height,
      pixelRatio,
      resource
    };
  }

  #surfaceSize(): { readonly width: number; readonly height: number } {
    const bounds = this.#canvas.getBoundingClientRect();
    return {
      width: Math.max(1, bounds.width),
      height: Math.max(1, bounds.height)
    };
  }

  #eventPoint(event: PointerEvent): StagePoint {
    const bounds = this.#canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  async #enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.#operation.then(action);
    this.#operation = operation.catch((error) => {
      this.#callbacks.onError(error);
    });
    return operation;
  }
}
