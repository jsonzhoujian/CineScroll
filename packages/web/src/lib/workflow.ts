export type ProjectDraft = {
  title: string;
  rightsDeclared: boolean;
  aspectRatio: "9:16" | "16:9";
  targetDurationSeconds: 60 | 180 | 300;
  narrativeMode: "narration" | "dialogue";
};

export type BrowserFile = {
  name: string;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type SourceDraft =
  | { kind: "paste"; text: string }
  | { kind: "file"; file: BrowserFile };

export type DocumentRequest =
  | { kind: "paste"; fileName: string; text: string }
  | { kind: "txt" | "docx"; fileName: string; contentBase64: string };

export function validateProjectDraft(value: ProjectDraft):
  | { ok: true; value: ProjectDraft }
  | { ok: false; message: string } {
  if (!value.rightsDeclared) return { ok: false, message: "请先确认拥有作品或合法改编权" };
  if (!value.title.trim()) return { ok: false, message: "请输入项目名称" };
  if (!(["9:16", "16:9"] as const).includes(value.aspectRatio)
    || !([60, 180, 300] as const).includes(value.targetDurationSeconds)
    || !(["narration", "dialogue"] as const).includes(value.narrativeMode)) {
    return { ok: false, message: "项目选项无效" };
  }
  return { ok: true, value };
}

export async function buildDocumentRequest(source: SourceDraft): Promise<DocumentRequest> {
  if (source.kind === "paste") {
    if (!source.text.trim()) throw new Error("请粘贴小说正文");
    return { kind: "paste", fileName: "粘贴文本.txt", text: source.text };
  }
  const extension = source.file.name.split(".").at(-1)?.toLowerCase();
  const kind = extension === "txt" ? "txt" : extension === "docx" ? "docx" : null;
  if (!kind) throw new Error("仅支持 TXT 或 DOCX 文件");
  const bytes = new Uint8Array(await source.file.arrayBuffer());
  return { kind, fileName: source.file.name, contentBase64: bytesToBase64(bytes) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
