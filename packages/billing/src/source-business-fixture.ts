import { createHash } from "node:crypto";
import { canonicalEvidenceValue } from "./evidence-material-repository.ts";
import type { SourceIngestReference } from "./evidence-source-ingest.ts";

type Binding = { workspaceId: string; taskId: string; unitId: string; projectId: string; chapterId: string; sourceVersionId: string; upstreamVersionIds: string[] };
type Common = { id: string; version: string; binding: Binding; producerServiceId: string; recordedAt: string };
type Pricing = { responsibility: "platform" | "byok"; quoteId: string; priceVersion: string; reserved: number };
export type FixtureTaskRevision = Common & { revision: number; predecessorVersion: string | null; scopeKeys: string[]; snapshotReference: SourceIngestReference; executionReference: SourceIngestReference };
export type FixtureSnapshot = Common & Pricing & { quoteReference: SourceIngestReference; taskAnchorReference: SourceIngestReference; executionReference: SourceIngestReference };
export type FixtureExecutionIdentity = Common & { taskAnchorReference: SourceIngestReference; snapshotReference: SourceIngestReference };
export type FixtureQuote = Common & Pricing & { pricingRuleVersion: string; taskAnchorReference: SourceIngestReference; executionReference: SourceIngestReference };
export type SourceBusinessFixture = { tasks: FixtureTaskRevision[]; snapshot: FixtureSnapshot; execution: FixtureExecutionIdentity; quote: FixtureQuote };
type BusinessDocument = FixtureTaskRevision | FixtureSnapshot | FixtureExecutionIdentity | FixtureQuote;
export type PreparedFixtureRecord = { kind: "task" | "snapshot" | "execution" | "quote"; workspaceId: string; id: string; version: string; document: BusinessDocument; canonical: string; businessFingerprint: string; byteLength: number };
export class SourceBusinessFixtureError extends Error {
  readonly code = "INVALID_BUSINESS_FIXTURE";
  constructor() { super("INVALID_BUSINESS_FIXTURE"); }
}
const commonKeys = ["id", "version", "binding", "producerServiceId", "recordedAt"];
const pricingKeys = ["responsibility", "quoteId", "priceVersion", "reserved"];
const wellFormed = (value: string): boolean => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && wellFormed(value) && !/[\r\n\u0000*?]/.test(value) && !value.includes("://");
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0;
const same = (left: unknown, right: unknown): boolean => canonicalEvidenceValue(left) === canonicalEvidenceValue(right);
function requireValid(condition: unknown): asserts condition { if (!condition) throw new SourceBusinessFixtureError(); }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(id) && new Set(value).size === value.length;
}
function reference(value: unknown): boolean { return exact(value, ["id", "version"]) && id(value.id) && id(value.version); }
function common(value: unknown, extra: string[]): value is Record<string, unknown> {
  if (!exact(value, [...commonKeys, ...extra]) || ![value.id, value.version, value.producerServiceId].every(id)
    || typeof value.recordedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.recordedAt)
    || !Number.isFinite(Date.parse(value.recordedAt)) || new Date(value.recordedAt).toISOString() !== value.recordedAt) return false;
  const binding = value.binding;
  return exact(binding, ["workspaceId", "taskId", "unitId", "projectId", "chapterId", "sourceVersionId", "upstreamVersionIds"])
    && [binding.workspaceId, binding.taskId, binding.unitId, binding.projectId, binding.chapterId, binding.sourceVersionId].every(id)
    && ids(binding.upstreamVersionIds);
}
function pricing(value: Record<string, unknown>): boolean {
  return id(value.quoteId) && id(value.priceVersion) && (value.responsibility === "platform" ? positive(value.reserved)
    : value.responsibility === "byok" && value.reserved === 0);
}
// Check data descriptors before cloning: never run getters/toJSON or normalize unsupported JSON.
function inspectTree(input: unknown): void {
  let nodes = 0, bytes = 0;
  const path = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    requireValid(++nodes <= 50000 && depth <= 8);
    if (typeof value === "string") { bytes += Buffer.byteLength(value, "utf8"); requireValid(wellFormed(value) && !value.includes("\u0000") && bytes <= 16777216); return; }
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isSafeInteger(value)) return;
    requireValid(value && typeof value === "object" && !path.has(value));
    const array = Array.isArray(value);
    requireValid(array ? Object.getPrototypeOf(value) === Array.prototype && value.length <= 4096
      : Object.getPrototypeOf(value) === Object.prototype);
    const keys = Reflect.ownKeys(value);
    requireValid(keys.length <= 4097);
    if (array) requireValid(keys.length === value.length + 1 && keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length));
    path.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      requireValid(typeof key === "string" && descriptor?.enumerable && Object.hasOwn(descriptor, "value"));
      visit(descriptor.value, depth + 1);
    }
    path.delete(value);
  };
  visit(input, 0);
}

/** Pure test-data preparation. Does not authenticate, persist, register or charge. */
export function prepareSourceBusinessFixture(input: unknown): { records: PreparedFixtureRecord[] } {
  try {
  inspectTree(input);
  requireValid(exact(input, ["tasks", "snapshot", "execution", "quote"]));
  requireValid(Array.isArray(input.tasks) && input.tasks.length > 0 && input.tasks.length <= 4093);
  for (const task of input.tasks) {
    requireValid(common(task, ["revision", "predecessorVersion", "scopeKeys", "snapshotReference", "executionReference"]));
    requireValid(positive(task.revision) && (task.predecessorVersion === null || id(task.predecessorVersion))
      && ids(task.scopeKeys) && reference(task.snapshotReference) && reference(task.executionReference));
  }
  requireValid(common(input.snapshot, [...pricingKeys, "quoteReference", "taskAnchorReference", "executionReference"])
    && pricing(input.snapshot) && reference(input.snapshot.quoteReference) && reference(input.snapshot.taskAnchorReference) && reference(input.snapshot.executionReference));
  requireValid(common(input.execution, ["taskAnchorReference", "snapshotReference"])
    && reference(input.execution.taskAnchorReference) && reference(input.execution.snapshotReference));
  requireValid(common(input.quote, [...pricingKeys, "pricingRuleVersion", "taskAnchorReference", "executionReference"])
    && pricing(input.quote) && id(input.quote.pricingRuleVersion) && reference(input.quote.taskAnchorReference) && reference(input.quote.executionReference));
  const fixture = structuredClone(input) as SourceBusinessFixture;
  const anchor = fixture.tasks[0]!, snapshot = fixture.snapshot, execution = fixture.execution, quote = fixture.quote;
  const ref = (document: Common) => ({ id: document.id, version: document.version });
  for (const document of [...fixture.tasks, snapshot, execution, quote]) requireValid(same(document.binding, anchor.binding));
  for (const task of fixture.tasks) requireValid(task.id === anchor.binding.taskId && same(task.scopeKeys, [anchor.binding.unitId])
    && same(task.snapshotReference, ref(snapshot)) && same(task.executionReference, ref(execution)));
  requireValid(same(snapshot.quoteReference, ref(quote)) && same(snapshot.executionReference, ref(execution))
    && same(execution.snapshotReference, ref(snapshot)) && same(quote.executionReference, ref(execution)));
  for (const document of [snapshot, execution, quote]) requireValid(same(document.taskAnchorReference, ref(anchor)));
  for (const key of pricingKeys) requireValid(same(snapshot[key as keyof Pricing], quote[key as keyof Pricing]));
  requireValid(anchor.revision === 1 && anchor.predecessorVersion === null);
  const versions = new Set<string>();
  fixture.tasks.forEach((task, index) => {
    requireValid(!versions.has(task.version) && task.revision === index + 1 && task.producerServiceId === anchor.producerServiceId);
    versions.add(task.version);
    if (index > 0) requireValid(task.predecessorVersion === fixture.tasks[index - 1]!.version
      && task.recordedAt >= fixture.tasks[index - 1]!.recordedAt);
  });
  const row = (kind: PreparedFixtureRecord["kind"], document: BusinessDocument): PreparedFixtureRecord => {
    const canonical = canonicalEvidenceValue(document);
    requireValid(Buffer.byteLength(canonical, "utf8") <= 2097152);
    return { kind, workspaceId: document.binding.workspaceId, id: document.id, version: document.version,
      document: structuredClone(document), canonical, businessFingerprint: createHash("sha256").update(canonical, "utf8").digest("hex"), byteLength: Buffer.byteLength(canonical, "utf8") };
  };
  const records = [...fixture.tasks.map(task => row("task", task)), row("snapshot", fixture.snapshot), row("execution", fixture.execution), row("quote", fixture.quote)];
  requireValid(records.reduce((total, record) => total + record.byteLength, 0) <= 16777216);
  return { records };
  } catch { throw new SourceBusinessFixtureError(); }
}
