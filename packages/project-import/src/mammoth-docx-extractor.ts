import { Worker } from "node:worker_threads";

import type { DocumentTextExtractor } from "./index.ts";

const MAX_DOCX_BYTES = 20 * 1024 * 1024;
const EXTRACTION_TIMEOUT_MS = 10_000;

export class MammothDocxTextExtractor implements DocumentTextExtractor {
  async extractDocx(_fileName: string, bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > MAX_DOCX_BYTES) throw new Error("DOCX exceeds the 20 MB upload limit");
    if (!hasZipSignature(bytes)) throw new Error("DOCX content does not have a ZIP signature");

    return new Promise<string>((resolve, reject) => {
      const worker = new Worker(new URL("./mammoth-docx-worker.ts", import.meta.url));
      const timeout = setTimeout(() => {
        void worker.terminate();
        reject(new Error("DOCX extraction timed out"));
      }, EXTRACTION_TIMEOUT_MS);
      const finish = (callback: () => void) => {
        clearTimeout(timeout);
        void worker.terminate();
        callback();
      };
      worker.once("message", (message: { ok: true; text: string } | { ok: false; error: string }) => {
        if (message.ok) finish(() => resolve(message.text));
        else finish(() => reject(new Error(message.error)));
      });
      worker.once("error", (error) => finish(() => reject(error)));
      worker.postMessage(Buffer.from(bytes));
    });
  }
}

function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
