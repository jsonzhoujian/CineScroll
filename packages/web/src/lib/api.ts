import type { DocumentRequest, ProjectDraft } from "./workflow";

type ApiErrorBody = { code?: string; message?: string; retryAfterSeconds?: number };

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

export type ModelConfiguration = { id: string; providerId: string; keyMask: string; tested: boolean; availableModelIds: string[]; processingRegion: "mainland" | "overseas" | "unknown" };
export type ModelCapabilities = { advanced: boolean; canManage: boolean; providers: Array<{ id: string; name: string; kind: string; available: boolean; processingRegion: "mainland" | "overseas" | "unknown" }> };
export type StoryKnowledgeTask = { id: string; projectId: string; chapterId: string;
  input: { stage: string; sourceVersionId: string }; state: string; reason: string | null;
  result: { candidateVersionId: string; extractionStatus: string } | null };

export class ApiClient {
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
