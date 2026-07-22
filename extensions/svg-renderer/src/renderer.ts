import {
  STANDARD_PRESENTATION_PRIMITIVES,
  type JsonObject,
  type PresentationNode,
  type ResolvedPresentationGraph
} from "@kineweave/protocol";
import {
  type OutputRendererProvider
} from "@kineweave/render-engine";
import { SVG_RENDERER_PROVIDER_ID, svgRendererDescriptor } from "./descriptor.js";

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function number(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError("SVG numbers must be finite");
  return Object.is(value, -0) ? "0" : String(value);
}

function stringData(data: JsonObject, key: string, fallback?: string): string {
  const value = data[key];
  if (typeof value === "string") return value;
  if (fallback !== undefined) return fallback;
  throw new TypeError(`SVG text primitive requires string ${key}`);
}

function numberData(data: JsonObject, key: string, fallback?: number): number {
  const value = data[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`SVG primitive requires numeric ${key}`);
  }
  return value;
}

function shapeStyle(data: JsonObject): string {
  const fill = stringData(data, "fill", "#00000000");
  const stroke = stringData(data, "stroke", "#00000000");
  const strokeWidth = numberData(data, "strokeWidth", 0);
  return [
    `fill="${escapeAttribute(fill)}"`,
    `stroke="${escapeAttribute(stroke)}"`,
    `stroke-width="${number(strokeWidth)}"`
  ].join(" ");
}

function transform(node: PresentationNode): string {
  const { translation, scale, rotation, anchor } = node.transform;
  return [
    `translate(${number(translation[0]!)} ${number(translation[1]!)})`,
    `rotate(${number(rotation)})`,
    `scale(${number(scale[0]!)} ${number(scale[1]!)})`,
    `translate(${number(-anchor[0]!)} ${number(-anchor[1]!)})`
  ].join(" ");
}

function nodeAttributes(node: PresentationNode): string {
  const attributes = [
    `id="${escapeAttribute(node.presentationId)}"`,
    `transform="${transform(node)}"`
  ];
  if (!node.visible) attributes.push('display="none"');
  if (node.opacity !== 1) attributes.push(`opacity="${number(node.opacity)}"`);
  if (node.sourceResourceUri !== undefined) {
    attributes.push(
      `data-kineweave-source="${escapeAttribute(node.sourceResourceUri)}"`
    );
  }
  return attributes.join(" ");
}

function renderNode(
  graph: ResolvedPresentationGraph,
  nodeId: string,
  indentation: string
): string {
  const node = graph.nodes[nodeId];
  if (node === undefined) throw new Error(`Missing presentation node ${nodeId}`);
  const children = node.children
    .map((childId) => renderNode(graph, childId, `${indentation}  `))
    .join("\n");
  if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.group) {
    return children.length === 0
      ? `${indentation}<g ${nodeAttributes(node)} />`
      : `${indentation}<g ${nodeAttributes(node)}>\n${children}\n${indentation}</g>`;
  }
  if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.text) {
    if (children.length > 0) {
      throw new Error(`SVG text node ${nodeId} cannot contain child nodes`);
    }
    const text = stringData(node.data, "text");
    const fill = stringData(node.data, "fill", "#000000");
    const fontSize = numberData(node.data, "fontSize");
    const fontFamily = stringData(node.data, "fontFamily", "sans-serif");
    const textAnchor = stringData(node.data, "textAnchor", "middle");
    const dominantBaseline = stringData(
      node.data,
      "dominantBaseline",
      "middle"
    );
    return `${indentation}<text ${nodeAttributes(node)} x="0" y="0" fill="${escapeAttribute(fill)}" font-family="${escapeAttribute(fontFamily)}" font-size="${number(fontSize)}" text-anchor="${escapeAttribute(textAnchor)}" dominant-baseline="${escapeAttribute(dominantBaseline)}">${escapeText(text)}</text>`;
  }
  if (children.length > 0) {
    throw new Error(`SVG leaf node ${nodeId} cannot contain child nodes`);
  }
  if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.rectangle) {
    const width = numberData(node.data, "width");
    const height = numberData(node.data, "height");
    const cornerRadius = numberData(node.data, "cornerRadius", 0);
    return `${indentation}<rect ${nodeAttributes(node)} x="${number(-width / 2)}" y="${number(-height / 2)}" width="${number(width)}" height="${number(height)}" rx="${number(cornerRadius)}" ${shapeStyle(node.data)} />`;
  }
  if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.ellipse) {
    const radiusX = numberData(node.data, "radiusX");
    const radiusY = numberData(node.data, "radiusY");
    return `${indentation}<ellipse ${nodeAttributes(node)} cx="0" cy="0" rx="${number(radiusX)}" ry="${number(radiusY)}" ${shapeStyle(node.data)} />`;
  }
  if (node.primitive === STANDARD_PRESENTATION_PRIMITIVES.path) {
    const path = stringData(node.data, "path");
    return `${indentation}<path ${nodeAttributes(node)} d="${escapeAttribute(path)}" ${shapeStyle(node.data)} />`;
  }
  throw new Error(`SVG renderer does not support primitive ${node.primitive}`);
}

function canvasSize(graph: ResolvedPresentationGraph): {
  readonly width: number;
  readonly height: number;
} {
  const canvas = graph.metadata?.compositionCanvas;
  if (canvas !== null && typeof canvas === "object" && !Array.isArray(canvas)) {
    const width = (canvas as JsonObject).width;
    const height = (canvas as JsonObject).height;
    if (
      typeof width === "number" &&
      Number.isFinite(width) &&
      width > 0 &&
      typeof height === "number" &&
      Number.isFinite(height) &&
      height > 0
    ) {
      return { width, height };
    }
  }
  return { width: graph.viewport.width, height: graph.viewport.height };
}

function background(
  value: string | null,
  width: number,
  height: number
): string | undefined {
  if (value === null) return undefined;
  return `  <rect width="${number(width)}" height="${number(height)}" fill="${escapeAttribute(value)}" />`;
}

export const svgRendererProvider: OutputRendererProvider = {
  descriptor: svgRendererDescriptor,
  renderOutput({ graph }) {
    const canvas = canvasSize(graph);
    const body = [
      background(graph.background, canvas.width, canvas.height),
      ...graph.rootNodeIds.map((nodeId) => renderNode(graph, nodeId, "  "))
    ].filter((line): line is string => line !== undefined);
    const svg = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<svg xmlns="http://www.w3.org/2000/svg" width="${number(graph.viewport.width)}" height="${number(graph.viewport.height)}" viewBox="0 0 ${number(canvas.width)} ${number(canvas.height)}" data-kineweave-document="${escapeAttribute(graph.documentId)}">`,
      ...body,
      "</svg>",
      ""
    ].join("\n");
    return {
      kind: "text",
      mediaType: "image/svg+xml",
      fileExtension: ".svg",
      text: svg,
      metadata: {
        rendererProviderId: SVG_RENDERER_PROVIDER_ID,
        presentationGraphVersion: graph.presentationGraphVersion
      }
    };
  }
};
