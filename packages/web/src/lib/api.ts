import type { DocumentRequest, ProjectDraft } from "./workflow";

type ApiErrorBody = { code?: string; message?: string; retryAfterSeconds?: number };

export type SettingsTask = StoryKnowledgeTask & { input: { stage: "settings";resultType: "settingsContent";sourceVersionId: string;upstreamConfirmedVersionIds: string[] } };
export type SettingsRegenerationSelection = { expectedActiveVersionId: string;assetIds: string[];failureScopeKeys: string[];reason: string };
export type SettingsRegenerationSubmission = { requestId: string;configurationVersionId: string;modelId: string;selection: SettingsRegenerationSelection };
export type SettingsRegenerationTask = StoryKnowledgeTask & { input: { stage: "settings";resultType: "settingsRegeneration";sourceVersionId: string;upstreamConfirmedVersionIds: string[];regeneration: SettingsRegenerationSelection } };
export type SettingsImpact = { confirmed_version_id: string;source_version_id: string;source_element_id: string;target_stage: string;target_version_id: string;target_item_id: string;status: string };
export type SettingsReconciliationCommand = { requestId: string;expectedActiveVersionId: string;expectedUpstreamConfirmedVersionIds: string[];reason: string } & ({ kind: "begin" } | { kind: "retain" | "unlock";assetId: string } | { kind: "repair";assetId: string;value: unknown });
export type SettingsReconciliationPreview = { baseVersionId: string;sourceVersionId: string;upstreamConfirmedVersionIds: string[];sameSource: boolean;requiresReconciliation: boolean;canBegin: boolean };
export type SettingsView = { impacts?: SettingsImpact[] | null; active?: boolean;permissions?: { canEdit: boolean;canSuggest: boolean;canDecide: boolean;canConfirm: boolean;canLock: boolean };current: boolean;sourceFragments: Array<{ id: string;text: string }>;scriptVersion: ScriptContentView["version"];version: {
  id: string;jobId: string;projectId: string;chapterId: string;sourceVersionId: string;scriptVersionId: string;upstreamConfirmedVersionIds: string[];status: "candidate" | "confirmed";generationStatus: string;
  assets: Array<{ id: string;assetType: string;name: string;visibleDefinition: Record<string,unknown>;state: string;stateChanges: string[];restrictions: string[];provenance: Array<{ type: string;sourceVersionId?: string;fragmentId?: string;transformation?: string;additionId?: string }> }>;
  locks?: Record<string,{ lockedBy: string;lockedAt: string }>;
  suggestions?: Array<{ id: string;assetId: string;value: SettingsView["version"]["assets"][number];reason: string;status: "pending" | "accepted" | "rejected";submittedBy: string }>;
  parentVersionId?: string | null;operation?: { requestId: string;kind: string;targetId: string;reason: string };
  reconciliation?: { originVersionId: string;pendingAssets: SettingsView["version"]["assets"];pendingFailureScopeKeys: string[] };
  regeneration?: { jobId: string;assetIds: string[];failureScopeKeys: string[];reason: string;outcome: string };
  failures: Array<{ scopeKey: string;assetId?: string;code: string;retryable: boolean }>;
} };
export type SettingsReviewCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & (
  { kind: "edit" | "suggest";assetId: string;value: SettingsView["version"]["assets"][number] } | { kind: "decide";suggestionId: string;decision: "accepted" | "rejected" }
  | { kind: "confirm" } | { kind: "lock" | "unlock";assetId: string });
export type ScriptContentTask = StoryKnowledgeTask & { input: { stage: "script";resultType: "scriptContent";sourceVersionId: string;upstreamConfirmedVersionIds: string[];retry?: { expectedActiveVersionId: string;retryOfJobId: string;scopeKeys: string[] } } };
export type ScriptContentView = { episodes?: Array<{ id: string;ordinal: number }>;permissions?: { canEdit: boolean;canSuggest: boolean;canDecide: boolean };current: boolean;sourceFragments: Array<{ id: string;text: string }>;version: {
  suggestions?: Array<{ id: string;elementId: string;text: string;reason: string;status: string;submittedBy: string;decidedBy?: string }>;
  reviewOperation?: { requestId: string;kind: string;reason: string };
  status?: "candidate" | "confirmed";qualityReportId?: string;confirmedBy?: string;confirmedAt?: string;
  id: string;jobId: string;projectId: string;chapterId: string;sourceVersionId: string;planVersionId: string;generationStatus: string;
  retry?: { scopeKeys: string[];expectedActiveVersionId: string;retryOfJobId: string };
  scenes: Array<{ id: string;title: string;episodeId?: string;ordinal?: number }>;elements: Array<{ id: string;sceneId: string;text: string;elementType: string;ordinal?: number;lockedBy?: string;lockedAt?: string;provenance: Array<{ type: string;fragmentId?: string;transformation?: string;additionId?: string }> }>;
  failures: Array<{ scopeKey: string;code: string;retryable: boolean }>;
} };
export type ScriptQualityView = { task: { id: string;state: string;reason: string | null;projectId: string;chapterId: string;input: { resultType: string;qualityTarget: { candidateVersionId: string } } };report: null | { id: string;candidateVersionId: string;ruleVersion: string;passed: boolean;coverage: number;reasons: string[];assessment?: { episodes: Array<{ episodeId: string;estimatedSeconds: number }> } } };
export type ScriptImpactLink = { confirmed_version_id: string;source_version_id: string;source_element_id: string;target_stage: string;target_version_id: string;target_item_id: string;status: string };
export type ScriptRevisionCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & ({ kind: "suggest";elementId: string;text: string } | { kind: "unlock";elementId: string } | { kind: "decide";suggestionId: string;decision: "accepted" | "rejected" });
export type ScriptPublicationCommand = { requestId: string;expectedActiveVersionId: string;reason: string } & ({ kind: "confirm";reportId: string } | { kind: "lock";elementIds: string[] });
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, code: string | undefined, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type ChapterInspection = {
  index: number;
  title: string;
  characterCount: number;
  selectable: boolean;
};

export type Chapter = {
  id: string;
  title: string;
  activeSourceVersionId: string;
  versions: Array<{
    id: string;
    ordinal: number;
    createdAt: string;
    characterCount: number;
    text: string;
    fragments: Array<{ id: string; ordinal: number; text: string }>;
  }>;
};

export type SourceVersionDiff = {
  unchanged: string[];
  removed: string[];
  added: string[];
};

export type ImportedDocumentSummary = {
  id: string;
  fileName: string;
  chapters: Array<{
    index: number;
    title: string;
    characterCount: number;
    status: "pending" | "imported";
    chapterId?: string;
  }>;
};

export type StoryFact = {
  id: string;
  factType: "character" | "relationship" | "event" | "location" | "prop" | "worldRule";
  statement: string;
  assertionKind: "explicit" | "inferred" | "user_confirmed";
  resolutionStatus: "resolved" | "pending_identity" | "conflicting";
  resolutionGroupId: string | null;
  evidence: Array<{ sourceVersionId: string; fragmentId: string }>;
  decision?: { outcome: "accepted" | "rejected"; conflictClassification?: "setting_change" | "character_misunderstanding" | "author_contradiction" | "other"; decidedBy: string; decidedAt: string; reason: string };
  lastEdit?: { editedBy: string; editedAt: string; reason: string };
  locked?: boolean;
  lockedBy?: string;
  lockedAt?: string;
};

export type StoryKnowledgeVersion = {
  id: string;
  parentVersionId: string | null;
  projectId: string;
  chapterId: string;
  sourceVersionId: string;
  extractionJobId: string;
  createdAt: string;
  createdBy: string;
  extractionStatus: "succeeded" | "partially_succeeded" | "failed";
  status: "candidate" | "needs_resolution" | "confirmed";
  confirmedBy?: string;
  confirmedAt?: string;
  facts: StoryFact[];
  failures: Array<{ scopeKey: string; originJobId: string; code: string; message: string; retryable: boolean }>;
};

type CredentialMode = "none" | "device" | "session";
export type EpisodePlanView = {
  plan: { id: string; generationJobId?: string; projectId: string; chapterId: string; sourceVersionId: string; storyBibleVersionId: string; status: "candidate" | "confirmed"; targetDurationSeconds: number; recommendationRationale?: string;
    episodes: Array<{ id: string; ordinal: number; title: string; sourceFragmentIds: string[]; coreEventFactIds: string[] }>;
    majorAdaptationProposals: Array<{ id: string; summary: string; rationale: string; affectedFactIds: string[]; decision?: { outcome: "approved" | "rejected"; reason?: string } }> };
  current: boolean; canReview: boolean; sourceFragments: Array<{ id: string; text: string }>; coreEvents: Array<{ id: string; statement: string }>;
};

export type ModelConfiguration = { id: string; providerId: string; keyMask: string; tested: boolean; availableModelIds: string[]; processingRegion: "mainland" | "overseas" | "unknown" };
export type ModelCapabilities = { advanced: boolean; canManage: boolean; providers: Array<{ id: string; name: string; kind: string; available: boolean; processingRegion: "mainland" | "overseas" | "unknown" }> };
export type StoryKnowledgeTask = { id: string; projectId: string; chapterId: string;
  input: { stage: string; sourceVersionId: string }; state: string; reason: string | null;
  result: { candidateVersionId: string; extractionStatus: string } | null };
export type EpisodeTask = StoryKnowledgeTask & { input: { stage: "script"; resultType: "episodePlan"; sourceVersionId: string; upstreamConfirmedVersionIds: string[] } };

export class ApiClient {
  previewSettingsReconciliation(p: string,c: string) { return this.request<SettingsReconciliationPreview>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/reconciliation`,{ method: "GET",cache: "no-store" },"session"); }
  reconcileSettings(p: string,c: string,input: SettingsReconciliationCommand) { return this.request<SettingsView["version"]>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/reconciliation`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  submitSettingsRegeneration(p: string,c: string,input: SettingsRegenerationSubmission) { return this.request<SettingsRegenerationTask>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings-regeneration-tasks`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  settingsRegenerationAvailability(p: string,c: string,input: Omit<SettingsRegenerationSubmission,"requestId">) { return this.request<{ available: boolean;reason: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings-regeneration-tasks/availability`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getSettingsRegenerationSubmission(p: string,c: string,id: string) { return this.request<SettingsRegenerationTask>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings-regeneration-tasks/submissions/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  getSettingsRegeneration(p: string,c: string,id: string) { return this.request<SettingsView>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/regenerations/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  reviewSettings(p: string,c: string,input: SettingsReviewCommand) { return this.request<SettingsView["version"]>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/review`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getSettings(p: string,c: string) { return this.request<SettingsView>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings`,{ method: "GET",cache: "no-store" },"session"); }
  getSettingsImpacts(p: string,c: string,id: string) { return this.request<{ versionId: string;impacts: SettingsImpact[] | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/versions/${encodeURIComponent(id)}/impacts`,{ method: "GET",cache: "no-store" },"session"); }
  getSettingsVersion(p: string,c: string,id: string) { return this.request<{ version: SettingsView["version"] }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/versions/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  getSettingsOperation(p: string,c: string,id: string) { return this.request<{ version: SettingsView["version"] }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/operations/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  submitSettingsTask(p: string,c: string,input: { configurationVersionId: string;modelId: string;requestId: string }) { return this.request<SettingsTask>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings-tasks`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getSettingsTask(id: string) { return this.request<SettingsTask>(`/settings-tasks/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  listSettingsTasks(p: string,c: string,cursor: string | null = null) { return this.request<{ tasks: SettingsTask[];nextCursor: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings-tasks${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,{ method: "GET",cache: "no-store" },"session"); }
  settingsAvailability(p: string,c: string,input: { configurationVersionId: string;modelId: string }) { return this.request<{ available: boolean;reason: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings-tasks/availability?${new URLSearchParams(input)}`,{ method: "GET",cache: "no-store" },"session"); }
  getSettingsGeneration(p: string,c: string,jobId: string) { return this.request<SettingsView>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/settings/generations/${encodeURIComponent(jobId)}`,{ method: "GET",cache: "no-store" },"session"); }
  getScriptImpacts(p: string,c: string,id: string) { return this.request<{ versionId: string;impacts: ScriptImpactLink[] }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/versions/${encodeURIComponent(id)}/impacts`,{ method: "GET",cache: "no-store" },"session"); }
  reviseScriptContent(p: string,c: string,input: ScriptRevisionCommand) { return this.request<ScriptContentView["version"]>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/revision`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getScriptVersion(p: string,c: string,id: string) { return this.request<{ version: ScriptContentView["version"] }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/versions/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  listScriptQuality(p: string,c: string,cursor: string | null = null) { return this.request<{ tasks: ScriptQualityView["task"][];nextCursor: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/quality${cursor ? `?${new URLSearchParams({ cursor })}` : ""}`,{ method: "GET",cache: "no-store" },"session"); }
  submitScriptQuality(p: string,c: string,input: { requestId: string;configurationVersionId: string;modelId: string;expectedActiveVersionId: string }) { return this.request<ScriptQualityView["task"]>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/quality`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getScriptQuality(p: string,c: string,id: string) { return this.request<ScriptQualityView>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/quality/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  publishScriptContent(p: string,c: string,input: ScriptPublicationCommand) { return this.request<ScriptContentView["version"]>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/publication`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  reviewScriptContent(p: string,c: string,input: { kind: "edit" | "suggest" | "decide";requestId: string;expectedActiveVersionId: string;reason: string;elementId?: string;text?: string;suggestionId?: string;decision?: "accepted" | "rejected" }) { return this.request<ScriptContentView["version"]>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content/review`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  submitScriptContentRetry(p: string,c: string,input: { configurationVersionId: string;modelId: string;requestId: string;expectedActiveVersionId: string;scopeKeys: string[] }) { return this.request<ScriptContentTask>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content-tasks/retries`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  submitScriptContentTask(p: string,c: string,input: { configurationVersionId: string;modelId: string;requestId: string }) { return this.request<ScriptContentTask>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content-tasks`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getScriptContentTask(id: string) { return this.request<ScriptContentTask>(`/script-content-tasks/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  listScriptContentTasks(p: string,c: string) { return this.request<{ tasks: ScriptContentTask[];nextCursor: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content-tasks`,{ method: "GET",cache: "no-store" },"session"); }
  scriptContentAvailability(p: string,c: string,input: { configurationVersionId: string;modelId: string }) { return this.request<{ available: boolean;reason: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content-tasks/availability?${new URLSearchParams(input)}`,{ method: "GET",cache: "no-store" },"session"); }
  getScriptContent(p: string,c: string) { return this.request<ScriptContentView>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/script-content`,{ method: "GET",cache: "no-store" },"session"); }

  submitEpisodeTask(p: string,c: string,input: { configurationVersionId: string; modelId: string; requestId: string }) { return this.request<EpisodeTask>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/episode-plan-tasks`,{ method: "POST",body: JSON.stringify(input) },"session"); }
  getEpisodeTask(id: string) { return this.request<EpisodeTask>(`/episode-plan-tasks/${encodeURIComponent(id)}`,{ method: "GET",cache: "no-store" },"session"); }
  listEpisodeTasks(p: string,c: string,cursor: string | null = null) {
    const query = new URLSearchParams({ limit: "20" }); if (cursor) query.set("cursor",cursor);
    return this.request<{ tasks: EpisodeTask[]; nextCursor: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/episode-plan-tasks?${query}`,{ method: "GET",cache: "no-store" },"session");
  }
  episodeAvailability(p: string,c: string,input: { configurationVersionId: string; modelId: string }) { return this.request<{ available: boolean; reason: string | null }>(`/projects/${encodeURIComponent(p)}/chapters/${encodeURIComponent(c)}/episode-plan-tasks/availability?${new URLSearchParams(input)}`,{ method: "GET",cache: "no-store" },"session"); }
  getEpisodePlan(projectId: string, chapterId: string) { return this.request<EpisodePlanView>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/episode-plan`, { method: "GET", cache: "no-store" }, "session"); }
  decideEpisodeAdaptation(projectId: string, chapterId: string, proposalId: string, input: { expectedActiveVersionId: string; decision: "approved" | "rejected"; reason: string }) {
    return this.request<EpisodePlanView["plan"]>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/episode-plan/proposals/${encodeURIComponent(proposalId)}/decision`, { method: "POST", body: JSON.stringify(input) }, "session");
  }
  confirmEpisodePlan(projectId: string, chapterId: string, expectedActiveVersionId: string) {
    return this.request<EpisodePlanView["plan"]>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/episode-plan/confirm`, { method: "POST", body: JSON.stringify({ expectedActiveVersionId }) }, "session");
  }
  getChapterContext(projectId: string, chapterId: string) {
    return this.request<{ project: { id: string; title: string; role: "owner" | "editor" | "reviewer" } & Pick<ProjectDraft, "aspectRatio" | "targetDurationSeconds" | "narrativeMode">; chapter: Chapter }>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/context`, { method: "GET", cache: "no-store" }, "session");
  }
  getChapter(projectId: string, chapterId: string) {
    return this.request<Chapter>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}`, { method: "GET", cache: "no-store" }, "session");
  }
  storyTaskAvailability(projectId: string, chapterId: string, input: { configurationVersionId: string; modelId: string }) {
    const query = new URLSearchParams(input);
    return this.request<{ available: boolean; reason: "WORKSPACE_TASK_DISABLED" | "TASK_PROVIDER_UNSUPPORTED" | null }>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/story-knowledge-tasks/availability?${query}`, { method: "GET", cache: "no-store" }, "session");
  }
  submitStoryKnowledgeTask(projectId: string, chapterId: string, input: { configurationVersionId: string; modelId: string }) {
    return this.request<StoryKnowledgeTask>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/story-knowledge-tasks`, { method: "POST", body: JSON.stringify(input) }, "session");
  }
  listStoryKnowledgeTasks(projectId: string, chapterId: string, cursor: string | null = null) {
    const query = new URLSearchParams({ limit: "20" }); if (cursor !== null) query.set("cursor", cursor);
    return this.request<{ tasks: StoryKnowledgeTask[]; nextCursor: string | null }>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/story-knowledge-tasks?${query}`, { method: "GET", cache: "no-store" }, "session");
  }
  getStoryKnowledgeTask(id: string) { return this.request<StoryKnowledgeTask>(`/story-knowledge-tasks/${encodeURIComponent(id)}`, { method: "GET", cache: "no-store" }, "session"); }
  submitStoryKnowledgeRetry(projectId: string, chapterId: string, input: { expectedActiveVersionId: string; scopeKeys: string[]; configurationVersionId: string; modelId: string; requestId: string }) {
    return this.request<StoryKnowledgeTask>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/story-knowledge-tasks/retries`, { method: "POST", body: JSON.stringify(input) }, "session");
  }
  resubmitStoryKnowledgeTask(id: string, input: { configurationVersionId: string; modelId: string }) {
    return this.request<StoryKnowledgeTask>(`/story-knowledge-tasks/${encodeURIComponent(id)}/resubmit`, { method: "POST", body: JSON.stringify(input) }, "session");
  }
  getStoryKnowledgeVersion(projectId: string, chapterId: string, versionId: string) {
    return this.request<StoryKnowledgeVersion>(`/projects/${encodeURIComponent(projectId)}/chapters/${encodeURIComponent(chapterId)}/story-knowledge/versions/${encodeURIComponent(versionId)}`, { method: "GET", cache: "no-store" }, "session");
  }
  modelCapabilities() { return this.request<ModelCapabilities>("/workspace/model-settings/capabilities", { method: "GET", cache: "no-store" }, "session"); }
  modelConfiguration() { return this.request<{ configuration: ModelConfiguration | null }>("/workspace/model-settings", { method: "GET", cache: "no-store" }, "session"); }
  saveModelKey(input: { expectedVersionId: string | null; providerId: string; apiKey: string }) { return this.request<ModelConfiguration>("/workspace/model-settings", { method: "POST", body: JSON.stringify(input) }, "session"); }
  testModelConnection(expectedVersionId: string, allowNonMainland: boolean) { return this.request<ModelConfiguration>("/workspace/model-settings/test", { method: "POST", body: JSON.stringify({ expectedVersionId, allowNonMainland }) }, "session"); }
  readonly #baseUrl: string;
  #sessionToken: string | null = null;
  #deviceToken: string | null = null;

  constructor(baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001") {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async issueDevice() {
    const result = await this.request<{ deviceToken: string }>("/auth/device", { method: "POST" });
    this.#deviceToken = result.deviceToken;
  }

  async requestPhoneCode(phone: string) {
    if (!this.#deviceToken) await this.issueDevice();
    return this.request<{ challengeId: string; expiresAt: string }>("/auth/phone/challenges", {
      method: "POST", body: JSON.stringify({ phone }),
    }, "device");
  }

  async verifyPhoneCode(input: { challengeId: string; phone: string; code: string }) {
    const result = await this.request<{ actor: { userId: string; workspaceId: string }; sessionToken: string }>("/auth/phone/verify", {
      method: "POST", body: JSON.stringify(input),
    }, "device");
    this.#sessionToken = result.sessionToken;
    return result;
  }

  beginWechatLogin() {
    return this.request<{ state: string; authorizationUrl: string }>("/auth/wechat/start", { method: "POST" });
  }

  completeWechatLogin(code: string, state: string) {
    const query = new URLSearchParams({ code, state });
    return this.request<{
      kind: "login";
      actor: { userId: string; workspaceId: string };
      sessionToken: string;
    }>(`/auth/wechat/callback?${query.toString()}`, { method: "GET" });
  }

  acceptSession(sessionToken: string) {
    if (!sessionToken) throw new Error("登录会话无效");
    this.#sessionToken = sessionToken;
  }

  createProject(input: ProjectDraft) {
    return this.request<{ id: string; title: string }>("/projects", {
      method: "POST", body: JSON.stringify(input),
    }, "session");
  }

  inspect(projectId: string, document: DocumentRequest) {
    return this.request<{ fileName: string; chapters: ChapterInspection[] }>(`/projects/${projectId}/imports/inspect`, {
      method: "POST", body: JSON.stringify(document),
    }, "session");
  }

  importChapter(projectId: string, document: DocumentRequest, selectedChapterIndex: number) {
    return this.request<{ chapter: Chapter; document: ImportedDocumentSummary }>(`/projects/${projectId}/chapters/import`, {
      method: "POST", body: JSON.stringify({ document, selectedChapterIndex }),
    }, "session");
  }

  importPendingChapter(projectId: string, documentId: string, chapterIndex: number) {
    return this.request<{ chapter: Chapter; document: ImportedDocumentSummary }>(
      `/projects/${projectId}/imported-documents/${documentId}/chapters/import`,
      { method: "POST", body: JSON.stringify({ chapterIndex }) },
      "session",
    );
  }

  reimportChapter(projectId: string, chapterId: string, text: string) {
    return this.request<{
      sourceVersion: Chapter["versions"][number];
      diff: SourceVersionDiff;
    }>(`/projects/${projectId}/chapters/${chapterId}/reimport`, {
      method: "POST",
      body: JSON.stringify({ fileName: "重新导入.txt", text, selectedChapterIndex: 0 }),
    }, "session");
  }

  getStoryKnowledge(projectId: string, chapterId: string) {
    return this.request<StoryKnowledgeVersion>(`/projects/${projectId}/chapters/${chapterId}/story-knowledge`, {
      method: "GET",
    }, "session");
  }

  editStoryFact(projectId: string, chapterId: string, factId: string, input: { expectedActiveVersionId: string; statement: string; reason: string }) {
    return this.storyFactCommand(projectId, chapterId, factId, "edit", input);
  }

  reviewStoryFact(projectId: string, chapterId: string, factId: string, input: { expectedActiveVersionId: string; outcome: "accepted" | "rejected"; reason: string }) {
    return this.storyFactCommand(projectId, chapterId, factId, "review", input);
  }

  resolveStoryFact(projectId: string, chapterId: string, factId: string, input: { expectedActiveVersionId: string; statement: string; reason: string; alternativeFactIds: string[]; conflictClassification?: "setting_change" | "character_misunderstanding" | "author_contradiction" | "other" }) {
    return this.storyFactCommand(projectId, chapterId, factId, "resolve", input);
  }

  setStoryFactLock(projectId: string, chapterId: string, factId: string, input: { expectedActiveVersionId: string; action: "lock" | "unlock"; reason: string }) {
    return this.storyFactCommand(projectId, chapterId, factId, "lock", input);
  }

  confirmStoryKnowledge(projectId: string, chapterId: string, input: { expectedActiveVersionId: string; reason: string }) {
    return this.request<{ version: StoryKnowledgeVersion }>(`/projects/${projectId}/chapters/${chapterId}/story-knowledge/confirm`, {
      method: "POST", body: JSON.stringify(input),
    }, "session");
  }

  private storyFactCommand(projectId: string, chapterId: string, factId: string, action: "edit" | "review" | "resolve" | "lock", input: unknown) {
    return this.request<StoryKnowledgeVersion>(`/projects/${projectId}/chapters/${chapterId}/story-knowledge/facts/${factId}/${action}`, {
      method: "POST", body: JSON.stringify(input),
    }, "session");
  }

  private async request<T>(path: string, options: RequestInit, credentials: CredentialMode = "none"): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("content-type", "application/json");
    if (credentials === "session" && this.#sessionToken) headers.set("authorization", `Bearer ${this.#sessionToken}`);
    if (credentials === "device" && this.#deviceToken) headers.set("x-device-token", this.#deviceToken);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, { ...options, headers });
    } catch {
      throw new Error("无法连接服务，请检查 API 是否已启动");
    }
    const body = await response.json().catch(() => ({})) as ApiErrorBody & T;
    if (!response.ok) throw new ApiClientError(response.status, body.code, body.message || `请求失败（${response.status}）`, body.retryAfterSeconds);
    return body;
  }
}
