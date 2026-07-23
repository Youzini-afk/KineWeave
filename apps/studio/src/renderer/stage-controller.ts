import {
  CANVAS2D_SURFACE_TYPE,
  type Canvas2DContextLike,
  type Canvas2DPathLike,
  type Canvas2DSurfaceResource
} from "@kineweave/canvas2d-renderer";
import type { ProjectSession } from "@kineweave/project-session";
import type { ResolvedPresentationGraph } from "@kineweave/protocol";
import type { InteractiveRenderSession, InteractiveRenderSurface } from "@kineweave/render-engine";
import { roundCompositionCoordinate, selectionPolygon } from "./studio-model.js";

export interface StageControllerCallbacks {
  readonly onSelect: (nodeId: string | undefined) => void;
  readonly movablePosition: (nodeId: string) => readonly [number, number] | undefined;
  readonly onMove: (nodeId: string, position: readonly [number, number]) => void | Promise<void>;
  readonly onError: (error: unknown) => void;
}

interface DragState {
  readonly pointerId: number;
  readonly nodeId: string;
  readonly startX: number;
  readonly startY: number;
  readonly startPosition: readonly [number, number];
  readonly startPolygon: readonly (readonly [number, number])[];
  moved: boolean;
}

export class StageController {
  readonly #canvas: HTMLCanvasElement;
  readonly #selection: SVGPolygonElement;
  readonly #callbacks: StageControllerCallbacks;
  readonly #resizeObserver: ResizeObserver;
  readonly #handlePointerDown = (event: PointerEvent): void => {
    void this.#pointerDown(event);
  };
  readonly #handlePointerMove = (event: PointerEvent): void => this.#pointerMove(event);
  readonly #handlePointerUp = (event: PointerEvent): void => {
    void this.#pointerUp(event);
  };
  readonly #handlePointerCancel = (event: PointerEvent): void => this.#cancelDrag(event);
  #project: ProjectSession | undefined;
  #interactive: InteractiveRenderSession | undefined;
  #graph: ResolvedPresentationGraph | undefined;
  #selectedNodeId: string | undefined;
  #drag: DragState | undefined;
  #operation = Promise.resolve();
  #disposed = false;

  constructor(
    canvas: HTMLCanvasElement,
    selection: SVGPolygonElement,
    callbacks: StageControllerCallbacks
  ) {
    this.#canvas = canvas;
    this.#selection = selection;
    this.#callbacks = callbacks;
    this.#resizeObserver = new ResizeObserver(() => {
      void this.#enqueue(async () => {
        if (this.#interactive === undefined) return;
        await this.#interactive.resize(this.#surface());
        this.#updateSelection();
      }).catch(() => {});
    });
    this.#resizeObserver.observe(canvas);
    canvas.addEventListener("pointerdown", this.#handlePointerDown);
    canvas.addEventListener("pointermove", this.#handlePointerMove);
    canvas.addEventListener("pointerup", this.#handlePointerUp);
    canvas.addEventListener("pointercancel", this.#handlePointerCancel);
  }

  async present(project: ProjectSession, graph: ResolvedPresentationGraph): Promise<void> {
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

  select(nodeId: string | undefined): void {
    this.#selectedNodeId = nodeId;
    this.#updateSelection();
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
    await this.#enqueue(async () => {
      const interactive = this.#interactive;
      this.#interactive = undefined;
      this.#project = undefined;
      this.#graph = undefined;
      this.#selectedNodeId = undefined;
      try {
        await interactive?.dispose();
      } finally {
        this.#selection.setAttribute("points", "");
        const context = this.#canvas.getContext("2d");
        context?.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
      }
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#resizeObserver.disconnect();
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener("pointercancel", this.#handlePointerCancel);
    await this.reset();
  }

  async #pointerDown(event: PointerEvent): Promise<void> {
    if (event.button !== 0 || this.#interactive === undefined) return;
    const point = this.#eventPoint(event);
    try {
      const hits = await this.#interactive.hitTest({
        x: point[0],
        y: point[1],
        mode: "topmost"
      });
      const nodeId = hits[0]?.presentationId;
      this.#callbacks.onSelect(nodeId);
      if (nodeId === undefined) return;
      const position = this.#callbacks.movablePosition(nodeId);
      const graph = this.#graph;
      if (position === undefined || graph === undefined) return;
      const polygon = selectionPolygon(graph, nodeId, this.#surfaceSize());
      if (polygon === undefined) return;
      this.#canvas.setPointerCapture(event.pointerId);
      this.#drag = {
        pointerId: event.pointerId,
        nodeId,
        startX: point[0],
        startY: point[1],
        startPosition: position,
        startPolygon: polygon,
        moved: false
      };
    } catch (error) {
      this.#callbacks.onError(error);
    }
  }

  #pointerMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const current = this.#eventPoint(event);
    const deltaX = current[0] - drag.startX;
    const deltaY = current[1] - drag.startY;
    drag.moved ||= Math.hypot(deltaX, deltaY) >= 2;
    this.#selection.setAttribute(
      "points",
      drag.startPolygon.map((value) => `${value[0] + deltaX},${value[1] + deltaY}`).join(" ")
    );
  }

  async #pointerUp(event: PointerEvent): Promise<void> {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    this.#drag = undefined;
    if (this.#canvas.hasPointerCapture(event.pointerId)) {
      this.#canvas.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) {
      this.#updateSelection();
      return;
    }
    const current = this.#eventPoint(event);
    const scale = this.#viewScale();
    try {
      await this.#callbacks.onMove(drag.nodeId, [
        roundCompositionCoordinate(drag.startPosition[0] + (current[0] - drag.startX) / scale),
        roundCompositionCoordinate(drag.startPosition[1] + (current[1] - drag.startY) / scale)
      ]);
    } catch (error) {
      this.#callbacks.onError(error);
      this.#updateSelection();
    }
  }

  #cancelDrag(event: PointerEvent): void {
    if (this.#drag?.pointerId !== event.pointerId) return;
    this.#drag = undefined;
    this.#updateSelection();
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

  #eventPoint(event: PointerEvent): readonly [number, number] {
    const bounds = this.#canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  #viewScale(): number {
    const graph = this.#graph;
    if (graph === undefined) return 1;
    const canvas = graph.metadata?.compositionCanvas;
    const width =
      canvas !== null && typeof canvas === "object" && !Array.isArray(canvas)
        ? canvas.width
        : undefined;
    const height =
      canvas !== null && typeof canvas === "object" && !Array.isArray(canvas)
        ? canvas.height
        : undefined;
    const compositionWidth = typeof width === "number" && width > 0 ? width : graph.viewport.width;
    const compositionHeight =
      typeof height === "number" && height > 0 ? height : graph.viewport.height;
    const surface = this.#surfaceSize();
    return Math.min(surface.width / compositionWidth, surface.height / compositionHeight);
  }

  #updateSelection(): void {
    if (this.#drag !== undefined) return;
    const graph = this.#graph;
    const nodeId = this.#selectedNodeId;
    const polygon =
      graph === undefined || nodeId === undefined
        ? undefined
        : selectionPolygon(graph, nodeId, this.#surfaceSize());
    this.#selection.setAttribute(
      "points",
      polygon?.map((value) => `${value[0]},${value[1]}`).join(" ") ?? ""
    );
  }

  async #enqueue(action: () => Promise<void>): Promise<void> {
    const operation = this.#operation.then(action);
    this.#operation = operation.catch((error) => {
      this.#callbacks.onError(error);
    });
    return operation;
  }
}
