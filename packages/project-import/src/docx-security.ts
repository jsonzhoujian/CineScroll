import type { Readable } from "node:stream";

import * as yauzl from "yauzl";

const MAX_ENTRIES = 2_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 50;
const MAX_RELATIONSHIP_BYTES = 1024 * 1024;

export function assertSafeDocxEntry(entry: Pick<yauzl.Entry, "fileName" | "compressedSize" | "uncompressedSize">): void {
  if (entry.fileName.includes("\\") || entry.fileName.startsWith("/") || /^[A-Za-z]:/.test(entry.fileName)
    || entry.fileName.split("/").includes("..")) {
    throw new Error("DOCX contains a path-traversal entry");
  }
  if (entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_COMPRESSION_RATIO) {
    throw new Error("DOCX contains a suspicious compression ratio");
  }
}

export async function validateDocxArchive(buffer: Buffer): Promise<void> {
  const zip = await openZip(buffer);
  let entries = 0;
  let totalUncompressed = 0;

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => { zip.close(); reject(error); };
    zip.on("error", fail);
    zip.on("end", resolve);
    zip.on("entry", (entry: yauzl.Entry) => {
      try {
        entries += 1;
        totalUncompressed += entry.uncompressedSize;
        if (entries > MAX_ENTRIES || totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
          throw new Error("DOCX archive exceeds resource limits");
        }
        if (entry.fileName.endsWith(".rels") && entry.uncompressedSize > MAX_RELATIONSHIP_BYTES) {
          throw new Error("DOCX relationship file exceeds the inspection limit");
        }
        assertSafeDocxEntry(entry);
      } catch (error) {
        fail(error as Error);
        return;
      }

      if (entry.fileName.endsWith(".rels")) {
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) { fail(error ?? new Error("Cannot read DOCX relationships")); return; }
          readStream(stream).then((xml) => {
            if (/TargetMode\s*=\s*["']External["']/i.test(xml)) {
              fail(new Error("DOCX contains an external relationship"));
              return;
            }
            zip.readEntry();
          }, fail);
        });
      } else {
        zip.readEntry();
      }
    });
    zip.readEntry();
  });
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error("Cannot open DOCX archive"));
      else resolve(zip);
    });
  });
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
