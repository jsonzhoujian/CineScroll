import { createHash } from "node:crypto";

const chapterHeading = /^\s*(?:第\s*[0-9一二三四五六七八九十百千万零〇两]+\s*[章节回卷]|chapter\s+\d+)\s*[^\n]*$/gimu;

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

export interface ProjectImportRepository {
  saveProject(project: Project): Promise<Project>;
  findProject(projectId: string): Promise<Project | null>;
}

export class ProjectImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectImportError";
    this.code = code;
  }
}

export class InMemoryProjectImportRepository implements ProjectImportRepository {
  readonly #projects = new Map<string, Project>();

  async saveProject(project: Project): Promise<Project> {
    this.#projects.set(project.id, structuredClone(project));
    return structuredClone(project);
  }

  async findProject(projectId: string): Promise<Project | null> {
    const project = this.#projects.get(projectId);
    return project ? structuredClone(project) : null;
  }
}

interface ProjectImportServiceDependencies {
  repository: ProjectImportRepository;
  idGenerator: (prefix: string) => string;
  clock: () => Date;
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

    return repository.saveProject(project);
  }

  async importText(actor: Actor, projectId: string, input: TextImportInput) {
    const project = await this.authorizedProject(actor, projectId);
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
    const chapter: Chapter = {
      id: chapterId,
      title: selected.title,
      versions: [sourceVersion],
      activeSourceVersionId: sourceVersion.id,
    };
    project.chapters.push(chapter);
    await repository.saveProject(project);

    return { chapter, sourceVersion, availableChapters: parseChapters(input.text).map(({ title }) => ({ title })) };
  }

  async reimportText(actor: Actor, projectId: string, chapterId: string, input: TextImportInput) {
    const project = await this.authorizedProject(actor, projectId);
    const chapter = findChapter(project, chapterId);
    const selected = selectImportChapter(input);
    const previous = chapter.versions.at(-1)!;
    const { idGenerator, clock, repository } = this.dependencies;
    const sourceVersion = createSourceVersion({
      chapterId,
      chapterText: selected.text,
      createdBy: actor.userId,
      createdAt: clock().toISOString(),
      idGenerator,
      ordinal: previous.ordinal + 1,
    });
    const diff = compareFragments(previous.fragments, sourceVersion.fragments);
    chapter.title = selected.title;
    chapter.versions.push(sourceVersion);
    chapter.activeSourceVersionId = sourceVersion.id;
    await repository.saveProject(project);

    return { chapter, sourceVersion, diff };
  }

  async getChapter(actor: Actor, projectId: string, chapterId: string): Promise<Chapter> {
    const project = await this.authorizedProject(actor, projectId);
    return findChapter(project, chapterId);
  }

  private async authorizedProject(actor: Actor, projectId: string): Promise<Project> {
    const project = await this.dependencies.repository.findProject(projectId);
    const isMember = project?.workspaceId === actor.workspaceId
      && project.members.some(({ userId }) => userId === actor.userId);
    if (!project || !isMember) {
      throw new ProjectImportError("PROJECT_NOT_FOUND", "项目不存在或无权访问");
    }
    return project;
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
      table[i][j] = left[i] === right[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const result: string[] = [];
  for (let i = 0, j = 0; i < left.length && j < right.length;) {
    if (left[i] === right[j]) {
      result.push(left[i]); i += 1; j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
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
