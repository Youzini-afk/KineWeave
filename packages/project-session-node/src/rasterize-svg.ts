import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { OutputFrameSequenceResult } from "@kineweave/project-session";
import {
  type ResolvedPresentationGraph,
  rationalToNumberLossy,
  STANDARD_PRESENTATION_PRIMITIVES
} from "@kineweave/protocol";
import { type ResvgRenderOptions, renderAsync } from "@resvg/resvg-js";

const require = createRequire(import.meta.url);
const FONT_FAMILY = "Noto Sans SC Variable";
const DEFAULT_MAX_PIXELS = 67_108_864;

interface FontSubset {
  readonly name: string;
  readonly ranges: readonly (readonly [number, number])[];
  readonly filePath: string;
}

interface FontCatalog {
  readonly fontVersion: string;
  readonly rasterizerVersion: string;
  readonly subsets: readonly FontSubset[];
}

interface ResvgOptionsWithFontBuffers extends ResvgRenderOptions {
  readonly font: NonNullable<ResvgRenderOptions["font"]> & {
    readonly fontBuffers: readonly Buffer[];
  };
}

export interface RasterizeSvgOptions {
  readonly background?: string;
  readonly maxPixels?: number;
  readonly signal?: AbortSignal;
}

let fontCatalogPromise: Promise<FontCatalog> | undefined;
const fontBufferPromises = new Map<string, Promise<Buffer>>();

function packageVersion(packageJsonPath: string): Promise<string> {
  return readFile(packageJsonPath, "utf8").then((text) => {
    const version = (JSON.parse(text) as { readonly version?: unknown }).version;
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`Package metadata has no version: ${packageJsonPath}`);
    }
    return version;
  });
}

function parseRanges(value: string): readonly (readonly [number, number])[] {
  return value.split(",").map((rawRange) => {
    const match = /^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i.exec(rawRange.trim());
    if (match === null) throw new Error(`Invalid Fontsource Unicode range ${rawRange}`);
    const start = Number.parseInt(match[1]!, 16);
    const end = Number.parseInt(match[2] ?? match[1]!, 16);
    return [start, end] as const;
  });
}

async function loadFontCatalog(): Promise<FontCatalog> {
  const fontPackageJson = require.resolve("@fontsource-variable/noto-sans-sc/package.json");
  const rasterizerPackageJson = require.resolve("@resvg/resvg-js/package.json");
  const fontDirectory = path.dirname(fontPackageJson);
  const unicode = JSON.parse(
    await readFile(path.join(fontDirectory, "unicode.json"), "utf8")
  ) as Record<string, string>;
  const subsets = Object.entries(unicode)
    .map(([name, ranges]) => ({
      name,
      ranges: parseRanges(ranges),
      filePath: path.join(
        fontDirectory,
        "files",
        `noto-sans-sc-${name.replaceAll("[", "").replaceAll("]", "")}-wght-normal.woff2`
      )
    }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const [fontVersion, rasterizerVersion] = await Promise.all([
    packageVersion(fontPackageJson),
    packageVersion(rasterizerPackageJson)
  ]);
  return { fontVersion, rasterizerVersion, subsets };
}

function fontCatalog(): Promise<FontCatalog> {
  if (fontCatalogPromise === undefined) fontCatalogPromise = loadFontCatalog();
  return fontCatalogPromise;
}

function textCodePoints(graph: ResolvedPresentationGraph): ReadonlySet<number> {
  const codePoints = new Set<number>();
  for (const node of Object.values(graph.nodes)) {
    if (node.primitive !== STANDARD_PRESENTATION_PRIMITIVES.text) continue;
    const text = node.data.text;
    if (typeof text !== "string") continue;
    for (const character of text) codePoints.add(character.codePointAt(0)!);
  }
  return codePoints;
}

function subsetContains(subset: FontSubset, codePoint: number): boolean {
  return subset.ranges.some(([start, end]) => codePoint >= start && codePoint <= end);
}

async function fontBuffersFor(
  graph: ResolvedPresentationGraph,
  catalog: FontCatalog
): Promise<readonly Buffer[]> {
  const codePoints = textCodePoints(graph);
  if (codePoints.size === 0) return [];
  const points = [...codePoints];
  const subsets = catalog.subsets.filter((subset) =>
    points.some((codePoint) => subsetContains(subset, codePoint))
  );
  const uncovered = points.filter(
    (codePoint) => !subsets.some((subset) => subsetContains(subset, codePoint))
  );
  if (uncovered.length > 0) {
    throw new TypeError(
      `Bundled Noto Sans SC cannot render ${uncovered.map((value) => `U+${value.toString(16).toUpperCase()}`).join(", ")}`
    );
  }
  return Promise.all(
    subsets.map((subset) => {
      let pending = fontBufferPromises.get(subset.filePath);
      if (pending === undefined) {
        pending = readFile(subset.filePath);
        fontBufferPromises.set(subset.filePath, pending);
      }
      return pending;
    })
  );
}

function validateRasterSize(
  graph: ResolvedPresentationGraph,
  pixelRatio: number,
  maxPixels: number
): void {
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new TypeError("Raster pixel ratio must be positive and finite");
  }
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0) {
    throw new TypeError("Raster pixel limit must be a positive safe integer");
  }
  const width = Math.ceil(graph.viewport.width * pixelRatio);
  const height = Math.ceil(graph.viewport.height * pixelRatio);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width * height > maxPixels) {
    throw new RangeError(
      `Raster output ${width}x${height} exceeds the ${maxPixels}-pixel safety limit`
    );
  }
}

export async function rasterizeSvgOutputFrame(
  frame: OutputFrameSequenceResult,
  options: RasterizeSvgOptions = {}
): Promise<OutputFrameSequenceResult> {
  options.signal?.throwIfAborted();
  const source = frame.rendering.artifact;
  if (
    source.kind !== "text" ||
    source.mediaType !== "image/svg+xml" ||
    source.fileExtension.toLowerCase() !== ".svg"
  ) {
    throw new TypeError("SVG rasterization requires a text image/svg+xml .svg artifact");
  }
  const pixelRatio = rationalToNumberLossy(frame.evaluation.graph.viewport.pixelRatio);
  validateRasterSize(frame.evaluation.graph, pixelRatio, options.maxPixels ?? DEFAULT_MAX_PIXELS);
  const catalog = await fontCatalog();
  const fontBuffers = await fontBuffersFor(frame.evaluation.graph, catalog);
  options.signal?.throwIfAborted();
  const renderOptions: ResvgOptionsWithFontBuffers = {
    dpi: 96,
    fitTo: { mode: "zoom", value: pixelRatio },
    shapeRendering: 2,
    textRendering: 2,
    imageRendering: 0,
    logLevel: "off",
    ...(options.background === undefined ? {} : { background: options.background }),
    font: {
      loadSystemFonts: false,
      defaultFontFamily: FONT_FAMILY,
      serifFamily: FONT_FAMILY,
      sansSerifFamily: FONT_FAMILY,
      cursiveFamily: FONT_FAMILY,
      fantasyFamily: FONT_FAMILY,
      monospaceFamily: FONT_FAMILY,
      fontBuffers
    }
  };
  const renderSignal = options.signal === undefined ? undefined : AbortSignal.any([options.signal]);
  const image = await renderAsync(source.text, renderOptions as ResvgRenderOptions, renderSignal);
  options.signal?.throwIfAborted();
  return {
    ...frame,
    rendering: {
      ...frame.rendering,
      artifact: {
        kind: "binary",
        mediaType: "image/png",
        fileExtension: ".png",
        bytes: image.asPng(),
        metadata: {
          rasterizer: "@resvg/resvg-js",
          rasterizerVersion: catalog.rasterizerVersion,
          fontPackage: "@fontsource-variable/noto-sans-sc",
          fontVersion: catalog.fontVersion,
          width: image.width,
          height: image.height,
          ...(options.background === undefined ? {} : { background: options.background })
        }
      }
    }
  };
}

export async function* rasterizeSvgOutputFrames(
  frames: AsyncIterable<OutputFrameSequenceResult>,
  options: RasterizeSvgOptions = {}
): AsyncGenerator<OutputFrameSequenceResult> {
  for await (const frame of frames) {
    yield await rasterizeSvgOutputFrame(frame, options);
  }
}
