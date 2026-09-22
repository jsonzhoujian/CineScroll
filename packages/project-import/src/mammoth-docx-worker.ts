import { parentPort } from "node:worker_threads";

import * as mammoth from "mammoth";

import { validateDocxArchive } from "./docx-security.ts";

if (!parentPort) throw new Error("DOCX worker must run in a worker thread");

parentPort.once("message", async (bytes: Uint8Array) => {
  try {
    const buffer = Buffer.from(bytes);
    await validateDocxArchive(buffer);
    const result = await mammoth.extractRawText({ buffer });
    if (Buffer.byteLength(result.value, "utf8") > 5 * 1024 * 1024) {
      throw new Error("Extracted DOCX text exceeds the output limit");
    }
    parentPort!.postMessage({ ok: true, text: result.value });
  } catch (error) {
    parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : "DOCX extraction failed" });
  }
});
