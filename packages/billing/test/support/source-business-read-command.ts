import { prepareSourceIngestIdentity, SourceIngestProtocolError } from "../../src/index.ts";

/** Strictly snapshot references before any asynchronous readiness check. */
export function prepareBusinessReadCommand(input: unknown, workspaceId: string) {
  const keys = ["taskReference", "snapshotReference", "executionReference"];
  let references: Record<string, unknown>;
  try {
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 3) throw new Error();
    references = Object.fromEntries(keys.map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      return [key, descriptor.value];
    }));
  } catch { throw new SourceIngestProtocolError(); }
  const identity = prepareSourceIngestIdentity("fixture-reader", "initialize", {
    ...references, protocolVersion: "source-ingest-v1", workspaceId, unitId: "fixture-reader", ingestId: "fixture-reader",
  }).identity;
  if (identity.operation !== "initialize") throw new SourceIngestProtocolError();
  const values = [workspaceId, ...[identity.taskReference,identity.snapshotReference,identity.executionReference].flatMap(ref => [ref.id,ref.version])];
  if (values.some(value => /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value))) throw new SourceIngestProtocolError();
  return identity;
}
