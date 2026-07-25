import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CliIo, runCli } from "./cli.js";

let temporaryDirectory: string;
let projectPath: string;

function captureIo() {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  };
  return { io, stdout: () => stdout, stderr: () => stderr };
}

async function exportVideo(format: "mp4" | "webm", fileName: string) {
  const outputPath = path.join(temporaryDirectory, fileName);
  const capture = captureIo();
  const exitCode = await runCli(
    [
      "export",
      projectPath,
      "document_main",
      outputPath,
      "--format",
      format,
      "--to",
      "1",
      "--fps",
      "15",
      "--width",
      "320",
      "--height",
      "180",
      "--quality",
      "compact",
      "--json"
    ],
    capture.io
  );
  expect({ exitCode, stderr: capture.stderr() }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(capture.stdout()) as {
    readonly outputPath: string;
    readonly contentHash: string;
    readonly codec: string;
    readonly width: number;
    readonly height: number;
  };
}

function probe(filePath: string) {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=format_name:stream=codec_name,width,height,r_frame_rate",
        "-of",
        "json",
        filePath
      ],
      { encoding: "utf8" }
    )
  ) as {
    readonly streams: Array<{
      readonly codec_name: string;
      readonly width: number;
      readonly height: number;
      readonly r_frame_rate: string;
    }>;
    readonly format: { readonly format_name: string };
  };
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "kineweave-output-media-"));
  projectPath = path.join(temporaryDirectory, "project");
  expect(await runCli(["init", projectPath], captureIo().io)).toBe(0);
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("CLI encoded media output", () => {
  it("produces deterministic H.264 MP4 and valid VP9 WebM files", async () => {
    const firstMp4 = await exportVideo("mp4", "first.mp4");
    const secondMp4 = await exportVideo("mp4", "second.mp4");
    const webm = await exportVideo("webm", "output.webm");

    expect(secondMp4.contentHash).toBe(firstMp4.contentHash);
    expect(firstMp4).toMatchObject({ codec: "h264", width: 320, height: 180 });
    expect(webm).toMatchObject({ codec: "vp9", width: 320, height: 180 });

    const mp4Probe = probe(firstMp4.outputPath);
    expect(mp4Probe.format.format_name).toContain("mp4");
    expect(mp4Probe.streams[0]).toMatchObject({
      codec_name: "h264",
      width: 320,
      height: 180,
      r_frame_rate: "15/1"
    });
    const webmProbe = probe(webm.outputPath);
    expect(webmProbe.format.format_name).toContain("webm");
    expect(webmProbe.streams[0]).toMatchObject({
      codec_name: "vp9",
      width: 320,
      height: 180,
      r_frame_rate: "15/1"
    });
  });
});
