import {
  CUBIC_BEZIER_GRAPH,
  type CubicBezierCoordinate,
  type CubicBezierCurve,
  type CubicBezierViewport,
  cubicBezierControlAtPlotPoint,
  cubicBezierPlotPoint,
  cubicBezierViewport,
  LINEAR_CUBIC_BEZIER,
  sameCubicBezierCurve,
  withCubicBezierCoordinate
} from "./easing-curve.js";

interface CurveDragState {
  readonly pointerId: number;
  readonly coordinateX: "x1" | "x2";
  readonly coordinateY: "y1" | "y2";
  readonly persistedCurve: CubicBezierCurve;
  readonly viewport: CubicBezierViewport;
  moved: boolean;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const COORDINATES = ["x1", "y1", "x2", "y2"] as const;

function required<T extends Element>(root: ParentNode, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (value === null) throw new Error(`Easing curve element is missing: ${selector}`);
  return value;
}

function svgElement<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NAMESPACE, name);
}

function pathCoordinate(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export class EasingCurveEditor {
  readonly #root: HTMLElement;
  readonly #graph: SVGSVGElement;
  readonly #inputs: ReadonlyMap<CubicBezierCoordinate, HTMLInputElement>;
  readonly #onCommit: (curve: CubicBezierCurve) => void;
  #curve: CubicBezierCurve = LINEAR_CUBIC_BEZIER;
  #owner: string | undefined;
  #drag: CurveDragState | undefined;

  constructor(root: HTMLElement, onCommit: (curve: CubicBezierCurve) => void) {
    this.#root = root;
    this.#graph = required<SVGSVGElement>(root, "#easing-curve-graph");
    this.#inputs = new Map(
      COORDINATES.map((coordinate) => [
        coordinate,
        required<HTMLInputElement>(root, `#easing-${coordinate}`)
      ])
    );
    this.#onCommit = onCommit;
    for (const [coordinate, input] of this.#inputs) {
      input.addEventListener("change", () => this.#commitInput(coordinate, input));
    }
    this.#graph.addEventListener("pointermove", (event) => this.#dragMove(event));
    this.#graph.addEventListener("pointerup", (event) => this.#dragEnd(event));
    this.#graph.addEventListener("pointercancel", (event) => this.#dragCancel(event));
  }

  get dragging(): boolean {
    return this.#drag !== undefined;
  }

  show(owner: string, curve: CubicBezierCurve): void {
    const ownerChanged = this.#owner !== owner;
    if (ownerChanged) this.cancelGesture();
    this.#owner = owner;
    this.#root.hidden = false;
    this.#root.setAttribute("aria-hidden", "false");
    if (this.#drag === undefined) this.#render(curve, !ownerChanged);
  }

  hide(): void {
    this.cancelGesture();
    this.#owner = undefined;
    this.#root.hidden = true;
    this.#root.setAttribute("aria-hidden", "true");
    this.#graph.replaceChildren();
  }

  cancelGesture(): void {
    const drag = this.#drag;
    if (drag === undefined) return;
    this.#drag = undefined;
    this.#releasePointer(drag.pointerId);
    this.#render(drag.persistedCurve, false);
  }

  #render(
    curve: CubicBezierCurve,
    preserveFocusedInput: boolean,
    viewport = cubicBezierViewport(curve)
  ): void {
    this.#curve = curve;
    for (const [coordinate, input] of this.#inputs) {
      if (!preserveFocusedInput || document.activeElement !== input) {
        input.value = String(curve[coordinate]);
      }
    }
    this.#graph.replaceChildren();
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

    this.#graph.append(
      grid,
      handles,
      curvePath,
      startPoint,
      endPoint,
      this.#handle("p1", "x1", "y1", first, viewport),
      this.#handle("p2", "x2", "y2", second, viewport)
    );
  }

  #handle(
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
    handle.setAttribute(
      "class",
      `easing-curve-handle${this.#drag?.coordinateX === coordinateX ? " dragging" : ""}`
    );
    handle.dataset.handle = name;
    handle.setAttribute("aria-hidden", "true");
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || this.#owner === undefined || this.#drag !== undefined) return;
      event.preventDefault();
      this.#drag = {
        pointerId: event.pointerId,
        coordinateX,
        coordinateY,
        persistedCurve: this.#curve,
        viewport,
        moved: false
      };
      this.#graph.setPointerCapture(event.pointerId);
      handle.classList.add("dragging");
    });
    return handle;
  }

  #dragMove(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const point = this.#clientPoint(event, drag.viewport);
    const next = withCubicBezierCoordinate(
      withCubicBezierCoordinate(this.#curve, drag.coordinateX, point.x),
      drag.coordinateY,
      point.y
    );
    drag.moved ||= !sameCubicBezierCurve(next, drag.persistedCurve);
    this.#render(next, false, drag.viewport);
  }

  #clientPoint(
    event: PointerEvent,
    viewport: CubicBezierViewport
  ): { readonly x: number; readonly y: number } {
    const transform = this.#graph.getScreenCTM();
    if (transform !== null) {
      const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(transform.inverse());
      return cubicBezierControlAtPlotPoint(point.x, point.y, viewport);
    }
    const bounds = this.#graph.getBoundingClientRect();
    return cubicBezierControlAtPlotPoint(
      ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * CUBIC_BEZIER_GRAPH.width,
      ((event.clientY - bounds.top) / Math.max(1, bounds.height)) * CUBIC_BEZIER_GRAPH.height,
      viewport
    );
  }

  #dragEnd(event: PointerEvent): void {
    const drag = this.#drag;
    if (drag === undefined || drag.pointerId !== event.pointerId) return;
    const next = this.#curve;
    this.#drag = undefined;
    this.#releasePointer(event.pointerId);
    if (!drag.moved || sameCubicBezierCurve(next, drag.persistedCurve)) {
      this.#render(drag.persistedCurve, false);
      return;
    }
    this.#render(next, false);
    this.#onCommit(next);
  }

  #dragCancel(event: PointerEvent): void {
    if (this.#drag?.pointerId === event.pointerId) this.cancelGesture();
  }

  #releasePointer(pointerId: number): void {
    if (this.#graph.hasPointerCapture(pointerId)) this.#graph.releasePointerCapture(pointerId);
  }

  #commitInput(coordinate: CubicBezierCoordinate, input: HTMLInputElement): void {
    if (this.#owner === undefined) return;
    const rawValue = input.value.trim();
    const value = input.valueAsNumber;
    if (rawValue.length === 0 || !Number.isFinite(value)) {
      input.setCustomValidity("Enter a finite number.");
      input.reportValidity();
      input.value = String(this.#curve[coordinate]);
      input.setCustomValidity("");
      return;
    }
    const next = withCubicBezierCoordinate(this.#curve, coordinate, value);
    input.value = String(next[coordinate]);
    input.setCustomValidity("");
    if (sameCubicBezierCurve(next, this.#curve)) return;
    this.#render(next, true);
    this.#onCommit(next);
  }
}
