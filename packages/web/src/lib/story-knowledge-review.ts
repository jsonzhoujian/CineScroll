import type { Chapter, StoryFact, StoryKnowledgeVersion } from "./api";

export type ReviewFilter = "all" | "pending" | "explicit" | "inferred";
export type FactAction = "edit" | "accept" | "reject" | "resolve" | "lock" | "unlock";

const factTypeLabels: Record<StoryFact["factType"], string> = {
  character: "人物", relationship: "关系", event: "事件", location: "场景", prop: "道具", worldRule: "世界规则",
};

const resolutionLabels: Record<StoryFact["resolutionStatus"], string> = {
  resolved: "可审核", pending_identity: "待确认身份", conflicting: "待解决冲突",
};

export type ReviewRow = StoryFact & {
  typeLabel: string;
  provenance: "原文明示" | "AI 推断" | "用户确认";
  state: string;
};

export function storyFactTypeLabel(type: StoryFact["factType"]): string {
  return factTypeLabels[type];
}

export function buildReviewRows(version: StoryKnowledgeVersion, filter: ReviewFilter): ReviewRow[] {
  return version.facts
    .filter((fact) => filter === "all"
      || (filter === "pending" && fact.resolutionStatus !== "resolved")
      || (filter === "explicit" && fact.assertionKind === "explicit")
      || (filter === "inferred" && fact.assertionKind === "inferred"))
    .map((fact): ReviewRow => ({
      ...fact,
      typeLabel: storyFactTypeLabel(fact.factType),
      provenance: fact.assertionKind === "explicit" ? "原文明示" : fact.assertionKind === "inferred" ? "AI 推断" : "用户确认",
      state: fact.decision ? (fact.decision.outcome === "accepted" ? "已接受" : "已拒绝") : resolutionLabels[fact.resolutionStatus],
    }))
    .sort((left, right) => Number(left.resolutionStatus === "resolved") - Number(right.resolutionStatus === "resolved"));
}

export function selectVisibleFact(rows: readonly ReviewRow[], selectedId: string | null): ReviewRow | null {
  return rows.find(({ id }) => id === selectedId) ?? rows[0] ?? null;
}

export function canConfirmStoryKnowledge(version: StoryKnowledgeVersion): { allowed: boolean; reason: string | null } {
  if (version.failures.length > 0) return { allowed: false, reason: `仍有 ${version.failures.length} 项局部失败需要处理` };
  const unresolved = version.facts.filter(({ resolutionStatus }) => resolutionStatus !== "resolved").length;
  if (unresolved > 0) return { allowed: false, reason: `仍有 ${unresolved} 条故事事实需要裁决` };
  if (!version.facts.some(({ decision }) => decision?.outcome === "accepted")) {
    return { allowed: false, reason: "至少需要接受一条故事事实" };
  }
  return { allowed: true, reason: null };
}

export function selectFactEvidence(version: StoryKnowledgeVersion, chapter: Chapter, factId: string) {
  const fact = version.facts.find(({ id }) => id === factId);
  const source = chapter.versions.find(({ id }) => id === version.sourceVersionId);
  if (!fact || !source) return [];
  const cited = new Set(fact.evidence
    .filter(({ sourceVersionId }) => sourceVersionId === source.id)
    .map(({ fragmentId }) => fragmentId));
  return source.fragments.filter(({ id }) => cited.has(id)).map((fragment) => ({ ...fragment, cited: true as const }));
}

export function resolutionGroupCandidates(version: StoryKnowledgeVersion, chapter: Chapter, factId: string) {
  const selected = version.facts.find(({ id }) => id === factId);
  if (!selected?.resolutionGroupId) return [];
  return version.facts
    .filter(({ resolutionGroupId, resolutionStatus }) => resolutionGroupId === selected.resolutionGroupId && resolutionStatus !== "resolved")
    .map((fact) => ({ ...fact, evidence: selectFactEvidence(version, chapter, fact.id) }));
}

export function availableFactActions(fact: StoryFact, versionStatus: StoryKnowledgeVersion["status"]): FactAction[] {
  if (versionStatus === "confirmed") return fact.decision?.outcome === "accepted" ? [fact.locked ? "unlock" : "lock"] : [];
  if (fact.resolutionStatus !== "resolved") return ["resolve"];
  if (fact.decision) return [];
  return ["edit", "accept", "reject"];
}
