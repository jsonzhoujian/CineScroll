import { createHash } from "node:crypto";

const horizontalSpace = "[^\\S\\r\\n]*";
const chapterHeading = new RegExp(
  `^${horizontalSpace}(?:第${horizontalSpace}[0-9一二三四五六七八九十百千万零〇两]+${horizontalSpace}[章节回卷]|chapter${horizontalSpace}\\d+)${horizontalSpace}[^\\n]*$`,
  "gimu",
);

export type Actor = Readonly<{ userId: string; workspaceId: string }>;
export type AspectRatio = "9:16" | "16:9";
export type NarrativeMode = "narration" | "dialogue";
export type TargetDurationSeconds = 60 | 180 | 300;

export interface CreateProjectInput {
  title: string;
  rightsDeclared: boolean;
  aspectRatio: AspectRatio;
  targetDurationSeconds: TargetDurationSeconds;
  narrativeMode: NarrativeMode;
}

export interface TextImportInput {
  fileName: string;
  text: string;
  selectedChapterIndex: number;
}

export type DocumentInput =
  | Readonly<{ kind: "paste"; fileName: string; text: string }>
  | Readonly<{ kind: "txt"; fileName: string; bytes: Uint8Array; encoding?: string }>
  | Readonly<{ kind: "docx"; fileName: string; bytes: Uint8Array }>;

export interface DocumentTextExtractor {
  extractDocx(fileName: string, bytes: Uint8Array): Promise<string>;
}

export interface ComplianceScanner {
  scan(text: string): Promise<ComplianceResult>;
}

export interface ComplianceResult {
  allowed: boolean;
  reason?: string;
  providerRequestId?: string;
}

export type ProjectImportErrorCode =
  | "RIGHTS_DECLARATION_REQUIRED"
  | "INVALID_PROJECT_OPTIONS"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_WRITE_FORBIDDEN"
  | "CHAPTER_NOT_FOUND"
  | "CHAPTER_SELECTION_REQUIRED"
  | "EMPTY_CHAPTER"
  | "CHAPTER_TOO_LARGE"
  | "DOCX_EXTRACTOR_UNAVAILABLE"
  | "UNSUPPORTED_DOCUMENT_TYPE"
  | "MALFORMED_DOCUMENT"
  | "COMPLIANCE_RESTRICTED"
  | "COMPLIANCE_UNAVAILABLE";

export interface SourceFragment {
  id: string;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  text: string;
  contentHash: string;
}

export interface SourceVersion {
  id: string;
  ordinal: number;
  createdAt: string;
  createdBy: string;
  characterCount: number;
  text: string;
  fragments: SourceFragment[];
}

export interface Chapter {
  id: string;
  title: string;
  activeSourceVersionId: string;
  versions: SourceVersion[];
}

export type ChapterHead = Pick<Chapter, "id" | "title" | "activeSourceVersionId">;

export interface Project {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  members: Array<{ userId: string; role: "owner" | "editor" | "reviewer" }>;
  title: string;
  aspectRatio: AspectRatio;
  targetDurationSeconds: TargetDurationSeconds;
  narrativeMode: NarrativeMode;
  dataRegion: "CN";
  createdAt: string;
  chapters: Chapter[];
}

export interface ProjectAccess {
  role: "owner" | "editor" | "reviewer";
}

export interface ProjectImportRepository {
  saveProject(actor: Actor, project: Project): Promise<Project>;
  findProject(actor: Actor, projectId: string): Promise<Project | null>;
  findProjectAccess(actor: Actor, projectId: string): Promise<ProjectAccess | null>;
  findChapter(actor: Actor, projectId: string, chapterId: string): Promise<Chapter | null>;
  createChapter(actor: Actor, projectId: string, chapter: Chapter): Promise<Chapter>;
  appendSourceVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    mutation: (latestVersion: SourceVersion) => { title: string; sourceVersion: SourceVersion },
  ): Promise<{ chapter: ChapterHead; previousVersion: SourceVersion; sourceVersion: SourceVersion }>;
}

export class ProjectImportError extends Error {
  readonly code: ProjectImportErrorCode;
  readonly providerRequestId: string | undefined;

  constructor(
    code: ProjectImportErrorCode,
    message: string,
    options?: { cause?: unknown; providerRequestId?: string },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProjectImportError";
    this.code = code;
    this.providerRequestId = options?.providerRequestId;
  }
}

export class InMemoryProjectImportRepository implements ProjectImportRepository {
  readonly #projects = new Map<string, Project>();

  async saveProject(_actor: Actor, project: Project): Promise<Project> {
    this.#projects.set(project.id, structuredClone(project));
    return structuredClone(project);
  }

  async findProject(_actor: Actor, projectId: string): Promise<Project | null> {
    const project = this.#projects.get(projectId);
    return project ? structuredClone(project) : null;
  }

  async findProjectAccess(actor: Actor, projectId: string): Promise<ProjectAccess | null> {
    const project = this.#projects.get(projectId);
    if (!project || project.workspaceId !== actor.workspaceId) return null;
    const member = project.members.find(({ userId }) => userId === actor.userId);
    return member ? { role: member.role } : null;
  }

  async findChapter(actor: Actor, projectId: string, chapterId: string): Promise<Chapter | null> {
    const project = await this.findProject(actor, projectId);
    return project?.chapters.find(({ id }) => id === chapterId) ?? null;
  }

  async createChapter(actor: Actor, projectId: string, chapter: Chapter): Promise<Chapter> {
    const project = await this.findProject(actor, projectId);
    if (!project) throw new ProjectImportError("PROJECT_NOT_FOUND", "项目不存在或无权访问");
    project.chapters.push(structuredClone(chapter));
    await this.saveProject(actor, project);
    return structuredClone(chapter);
  }

  async appendSourceVersion(
    actor: Actor,
    projectId: string,
    chapterId: string,
    mutation: (latestVersion: SourceVersion) => { title: string; sourceVersion: SourceVersion },
  ): Promise<{ chapter: ChapterHead; previousVersion: SourceVersion; sourceVersion: SourceVersion }> {
    const project = await this.findProject(actor, projectId);
    if (!project) throw new ProjectImportError("PROJECT_NOT_FOUND", "项目不存在或无权访问");
    const chapter = findChapter(project, chapterId);
    const previousVersion = structuredClone(chapter.versions.at(-1)!);
    const change = mutation(structuredClone(previousVersion));
    chapter.title = change.title;
    chapter.versions.push(structuredClone(change.sourceVersion));
    chapter.activeSourceVersionId = change.sourceVersion.id;
    await this.saveProject(actor, project);
    return {
      chapter: {
        id: chapter.id,
        title: chapter.title,
        activeSourceVersionId: chapter.activeSourceVersionId,
      },
      previousVersion,
      sourceVersion: structuredClone(change.sourceVersion),
    };
  }
}

interface ProjectImportServiceDependencies {
  repository: ProjectImportRepository;
  idGenerator: (prefix: string) => string;
  clock: () => Date;
  documentTextExtractor?: DocumentTextExtractor;
  complianceScanner: ComplianceScanner;
}

export class ProjectImportService {
  private readonly dependencies: ProjectImportServiceDependencies;

  constructor(dependencies: ProjectImportServiceDependencies) {
    this.dependencies = dependencies;
  }

  async createProject(actor: Actor, input: CreateProjectInput): Promise<Project> {
    if (!input.rightsDeclared) {
      throw new ProjectImportError("RIGHTS_DECLARATION_REQUIRED", "导入作品前必须确认拥有作品或合法改编权");
    }
    if (!isProjectInputValid(input)) {
      throw new ProjectImportError("INVALID_PROJECT_OPTIONS", "项目名称、画幅、单集时长或叙事类型无效");
    }

    const { idGenerator, clock, repository } = this.dependencies;
    const project: Project = {
      id: idGenerator("prj"),
      workspaceId: actor.workspaceId,
      ownerUserId: actor.userId,
      members: [{ userId: actor.userId, role: "owner" }],
      title: input.title,
      aspectRatio: input.aspectRatio,
      targetDurationSeconds: input.targetDurationSeconds,
      narrativeMode: input.narrativeMode,
      dataRegion: "CN",
      createdAt: clock().toISOString(),
      chapters: [],
    };

    return repository.saveProject(actor, project);
  }

  async inspectDocument(actor: Actor, projectId: string, input: DocumentInput) {
    await this.authorizedProject(actor, projectId, false);
    const text = await extractDocumentText(input, this.dependencies.documentTextExtractor);
    const compliance = await this.assertCompliant(text);
    const chapters = parseChapters(text);
    if (chapters.length === 0 || chapters.every(({ text: chapterText }) => chapterText.length === 0)) {
      throw new ProjectImportError("MALFORMED_DOCUMENT", "文档中没有可导入的正文");
    }
    return {
      fileName: input.fileName,
      complianceProviderRequestId: compliance.providerRequestId,
      chapters: chapters.map((chapter, index) => ({
        index,
        title: chapter.title,
        characterCount: chapter.text.length,
        selectable: chapter.text.length > 0 && chapter.text.length <= 20_000,
      })),
    };
  }

  async importDocument(
    actor: Actor,
    projectId: string,
    input: DocumentInput,
    selectedChapterIndex: number,
  ) {
    await this.authorizedProject(actor, projectId, true);
    const text = await extractDocumentText(input, this.dependencies.documentTextExtractor);
    return this.importText(actor, projectId, { fileName: input.fileName, text, selectedChapterIndex });
  }

  async importText(actor: Actor, projectId: string, input: TextImportInput) {
    await this.authorizedProject(actor, projectId, true);
    const compliance = await this.assertCompliant(input.text);
    const selected = selectImportChapter(input);
    const { idGenerator, clock, repository } = this.dependencies;
    const chapterId = idGenerator("chp");
    const sourceVersion = createSourceVersion({
      chapterId,
      chapterText: selected.text,
      createdBy: actor.userId,
      createdAt: clock().toISOString(),
      idGenerator,
      ordinal: 1,
    });
    const chapter = await repository.createChapter(actor, projectId, {
      id: chapterId,
      title: selected.title,
      versions: [sourceVersion],
      activeSourceVersionId: sourceVersion.id,
    });
    return {
      chapter,
      sourceVersion,
      complianceProviderRequestId: compliance.providerRequestId,
      availableChapters: parseChapters(input.text).map(({ title }) => ({ title })),
    };
  }

  async reimportText(actor: Actor, projectId: string, chapterId: string, input: TextImportInput) {
    await this.authorizedProject(actor, projectId, true);
    const compliance = await this.assertCompliant(input.text);
    const selected = selectImportChapter(input);
    const { idGenerator, clock, repository } = this.dependencies;
    const appended = await repository.appendSourceVersion(actor, projectId, chapterId, (previous) => {
      const sourceVersion = createSourceVersion({
        chapterId,
        chapterText: selected.text,
        createdBy: actor.userId,
        createdAt: clock().toISOString(),
        idGenerator,
        ordinal: previous.ordinal + 1,
      });
      return { title: selected.title, sourceVersion };
    });
    return {
      chapter: appended.chapter,
      sourceVersion: appended.sourceVersion,
      complianceProviderRequestId: compliance.providerRequestId,
      diff: compareFragments(appended.previousVersion.fragments, appended.sourceVersion.fragments),
    };
  }

  async getChapter(actor: Actor, projectId: string, chapterId: string): Promise<Chapter> {
    await this.authorizedProject(actor, projectId, false);
    const chapter = await this.dependencies.repository.findChapter(actor, projectId, chapterId);
    if (!chapter) throw new ProjectImportError("CHAPTER_NOT_FOUND", "章节不存在或无权访问");
    return chapter;
  }

  private async authorizedProject(actor: Actor, projectId: string, requireWrite: boolean): Promise<void> {
    const access = await this.dependencies.repository.findProjectAccess(actor, projectId);
    if (!access) throw new ProjectImportError("PROJECT_NOT_FOUND", "项目不存在或无权访问");
    if (requireWrite && access.role === "reviewer") {
      throw new ProjectImportError("PROJECT_WRITE_FORBIDDEN", "审核人只能查看和审核，不能修改原文");
    }
  }

  private async assertCompliant(text: string): Promise<ComplianceResult> {
    let compliance: ComplianceResult;
    try {
      compliance = await this.dependencies.complianceScanner.scan(text);
    } catch (cause) {
      throw new ProjectImportError(
        "COMPLIANCE_UNAVAILABLE",
        "内容合规服务暂不可用，请稍后重试",
        { cause },
      );
    }
    if (!compliance.allowed) {
      throw new ProjectImportError(
        "COMPLIANCE_RESTRICTED",
        compliance.reason ?? "内容不符合平台规范",
        compliance.providerRequestId ? { providerRequestId: compliance.providerRequestId } : undefined,
      );
    }
    return compliance;
  }
}

export function parseChapters(text: string): Array<{ title: string; text: string }> {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  const matches = [...normalized.matchAll(chapterHeading)];
  if (matches.length === 0) {
    return [{ title: "未命名章节", text: normalized }];
  }

  return matches.map((match, index) => {
    const contentStart = match.index + match[0].length;
    const contentEnd = matches[index + 1]?.index ?? normalized.length;
    return { title: match[0].trim(), text: normalized.slice(contentStart, contentEnd).trim() };
  });
}

function isProjectInputValid(input: CreateProjectInput): boolean {
  return input.title.trim().length > 0
    && (["9:16", "16:9"] as const).includes(input.aspectRatio)
    && ([60, 180, 300] as const).includes(input.targetDurationSeconds)
    && (["narration", "dialogue"] as const).includes(input.narrativeMode);
}

async function extractDocumentText(
  input: DocumentInput,
  extractor?: DocumentTextExtractor,
): Promise<string> {
  try {
    if (input.kind === "paste") return input.text;
    if (input.kind === "txt") return new TextDecoder(input.encoding ?? "utf-8", { fatal: true }).decode(input.bytes);
    if (input.kind === "docx") {
      if (!extractor) {
        throw new ProjectImportError("DOCX_EXTRACTOR_UNAVAILABLE", "DOCX 提取服务暂不可用，请稍后重试");
      }
      return await extractor.extractDocx(input.fileName, input.bytes);
    }
    throw new ProjectImportError("UNSUPPORTED_DOCUMENT_TYPE", "仅支持粘贴文本、TXT 和 DOCX 文件");
  } catch (error) {
    if (error instanceof ProjectImportError) throw error;
    throw new ProjectImportError("MALFORMED_DOCUMENT", "文件无法解析，请检查文件是否损坏或编码是否正确");
  }
}

function selectImportChapter(input: TextImportInput) {
  const selected = parseChapters(input.text)[input.selectedChapterIndex];
  if (!selected) {
    throw new ProjectImportError("CHAPTER_SELECTION_REQUIRED", "请选择需要处理的章节");
  }
  if (selected.text.length === 0) {
    throw new ProjectImportError("EMPTY_CHAPTER", "章节正文不能为空");
  }
  if (selected.text.length > 20_000) {
    throw new ProjectImportError("CHAPTER_TOO_LARGE", "单次处理的章节不能超过 20,000 字符");
  }
  return selected;
}

function findChapter(project: Project, chapterId: string): Chapter {
  const chapter = project.chapters.find(({ id }) => id === chapterId);
  if (!chapter) {
    throw new ProjectImportError("CHAPTER_NOT_FOUND", "章节不存在或无权访问");
  }
  return chapter;
}

function createSourceVersion(input: {
  chapterId: string;
  chapterText: string;
  createdBy: string;
  createdAt: string;
  idGenerator: (prefix: string) => string;
  ordinal: number;
}): SourceVersion {
  const paragraphs = input.chapterText.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean);
  const occurrences = new Map<string, number>();
  let searchOffset = 0;
  const fragments = paragraphs.map((text, index) => {
    const startOffset = input.chapterText.indexOf(text, searchOffset);
    const endOffset = startOffset + text.length;
    searchOffset = endOffset;
    const occurrence = (occurrences.get(text) ?? 0) + 1;
    occurrences.set(text, occurrence);
    const contentHash = hash(text);
    return {
      id: `frag_${hash(`${input.chapterId}\0${contentHash}\0${occurrence}`).slice(0, 24)}`,
      ordinal: index + 1,
      startOffset,
      endOffset,
      text,
      contentHash,
    };
  });

  return {
    id: input.idGenerator("srcv"),
    ordinal: input.ordinal,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    characterCount: input.chapterText.length,
    text: input.chapterText,
    fragments,
  };
}

function compareFragments(previous: SourceFragment[], next: SourceFragment[]) {
  const before = previous.map(({ text }) => text);
  const after = next.map(({ text }) => text);
  const common = longestCommonSubsequence(before, after);
  const remainingCommon = frequencies(common);
  const consumeCommon = (text: string) => {
    const count = remainingCommon.get(text) ?? 0;
    if (count === 0) return false;
    remainingCommon.set(text, count - 1);
    return true;
  };
  const unchanged = after.filter(consumeCommon);
  const commonForRemoval = frequencies(common);
  const removed = before.filter((text) => {
    const count = commonForRemoval.get(text) ?? 0;
    if (count === 0) return true;
    commonForRemoval.set(text, count - 1);
    return false;
  });
  const commonForAddition = frequencies(common);
  const added = after.filter((text) => {
    const count = commonForAddition.get(text) ?? 0;
    if (count === 0) return true;
    commonForAddition.set(text, count - 1);
    return false;
  });
  return { unchanged, removed, added };
}

function longestCommonSubsequence(left: string[], right: string[]): string[] {
  const table = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const result: string[] = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) {
      result.push(left[i]!); i += 1; j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  return result;
}

function frequencies(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
