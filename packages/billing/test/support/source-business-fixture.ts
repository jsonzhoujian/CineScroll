import type { SourceBusinessFixture, FixtureTaskRevision } from "../../src/index.ts";

export function sourceBusinessFixture(): SourceBusinessFixture & { tasks: [FixtureTaskRevision, ...FixtureTaskRevision[]] } {
  const binding = { workspaceId: "studio", taskId: "task", unitId: "unit", projectId: "project", chapterId: "chapter", sourceVersionId: "source", upstreamVersionIds: ["knowledge", "outline"] };
  const common = { version: "v1", binding, producerServiceId: "producer", recordedAt: "2026-10-08T00:00:00.000Z" };
  const taskAnchorReference = { id: "task", version: "v1" }, snapshotReference = { id: "snapshot", version: "v1" }, executionReference = { id: "execution", version: "v1" };
  const pricing = { responsibility: "platform" as const, quoteId: "quote", priceVersion: "price-v1", reserved: 7 };
  return {
    tasks: [{ ...common, id: "task", revision: 1, predecessorVersion: null, scopeKeys: ["unit"], snapshotReference, executionReference }],
    snapshot: { ...common, id: "snapshot", ...pricing, quoteReference: { id: "quote-record", version: "v1" }, taskAnchorReference, executionReference },
    execution: { ...common, id: "execution", taskAnchorReference, snapshotReference },
    quote: { ...common, id: "quote-record", ...pricing, pricingRuleVersion: "rule-v1", taskAnchorReference, executionReference },
  };
}
