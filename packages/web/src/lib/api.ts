import type { DocumentRequest, ProjectDraft } from "./workflow";

type ApiErrorBody = { code?: string; message?: string };

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

type CredentialMode = "none" | "device" | "session";

export class ApiClient {
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
    return this.request<{ chapter: Chapter }>(`/projects/${projectId}/chapters/import`, {
      method: "POST", body: JSON.stringify({ document, selectedChapterIndex }),
    }, "session");
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
    if (!response.ok) throw new Error(body.message || `请求失败（${response.status}）`);
    return body;
  }
}
