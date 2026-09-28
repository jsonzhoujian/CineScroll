"use client";

import { useMemo, useState } from "react";

import { ApiClient, type Chapter, type ChapterInspection, type ImportedDocumentSummary, type SourceVersionDiff } from "../lib/api";
import { buildDocumentRequest, type DocumentRequest, type ProjectDraft, validateProjectDraft } from "../lib/workflow";

type Step = "login" | "project" | "source" | "chapter" | "version";
const steps: Array<{ id: Step; number: string; label: string; note: string }> = [
  { id: "login", number: "壹", label: "身份", note: "进入工作室" },
  { id: "project", number: "贰", label: "立项", note: "声明与约束" },
  { id: "source", number: "叁", label: "原文", note: "粘贴或上传" },
  { id: "chapter", number: "肆", label: "选章", note: "预检后确认" },
  { id: "version", number: "伍", label: "入卷", note: "版本与追溯" },
];

const initialProject: ProjectDraft = {
  title: "", rightsDeclared: false, aspectRatio: "9:16",
  targetDurationSeconds: 180, narrativeMode: "narration",
};

export function ImportWorkbench() {
  const api = useMemo(() => new ApiClient(), []);
  const [step, setStep] = useState<Step>("login");
  const [phone, setPhone] = useState("13800138000");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(initialProject);
  const [project, setProject] = useState<{ id: string; title: string } | null>(null);
  const [inputMode, setInputMode] = useState<"paste" | "file">("paste");
  const [sourceText, setSourceText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [document, setDocument] = useState<DocumentRequest | null>(null);
  const [chapters, setChapters] = useState<ChapterInspection[]>([]);
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [importedDocument, setImportedDocument] = useState<ImportedDocumentSummary | null>(null);
  const [reimportText, setReimportText] = useState("");
  const [diff, setDiff] = useState<SourceVersionDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true); setNotice(null);
    try { await operation(); } catch (error) { setNotice(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  };

  const sendCode = () => run(async () => {
    const result = await api.requestPhoneCode(phone);
    setChallengeId(result.challengeId);
    setNotice("验证码已发送，请在五分钟内完成验证");
  });
  const login = () => run(async () => {
    if (!challengeId) throw new Error("请先获取验证码");
    await api.verifyPhoneCode({ challengeId, phone, code });
    setStep("project"); setNotice(null);
  });
  const createProject = () => run(async () => {
    const validation = validateProjectDraft(projectDraft);
    if (!validation.ok) throw new Error(validation.message);
    const created = await api.createProject(validation.value);
    setProject(created); setStep("source");
  });
  const inspect = () => run(async () => {
    if (!project) throw new Error("请先创建项目");
    const prepared = await buildDocumentRequest(inputMode === "paste"
      ? { kind: "paste", text: sourceText }
      : file ? { kind: "file", file } : { kind: "paste", text: "" });
    const result = await api.inspect(project.id, prepared);
    setDocument(prepared); setChapters(result.chapters);
    setSelectedChapter(result.chapters.find((item) => item.selectable)?.index ?? null);
    setStep("chapter");
  });
  const importChapter = () => run(async () => {
    if (!project || !document || selectedChapter === null) throw new Error("请选择一个可导入章节");
    const result = await api.importChapter(project.id, document, selectedChapter);
    setChapter(result.chapter); setImportedDocument(result.document); setReimportText(result.chapter.versions.at(-1)?.text ?? "");
    setStep("version");
  });
  const reimport = () => run(async () => {
    if (!project || !chapter) return;
    const result = await api.reimportChapter(project.id, chapter.id, reimportText);
    setChapter({ ...chapter, activeSourceVersionId: result.sourceVersion.id, versions: [...chapter.versions, result.sourceVersion] });
    setDiff(result.diff);
  });
  const importSavedChapter = (chapterIndex: number) => run(async () => {
    if (!project || !importedDocument) return;
    const result = await api.importPendingChapter(project.id, importedDocument.id, chapterIndex);
    setChapter(result.chapter);
    setImportedDocument(result.document);
    setReimportText(result.chapter.versions.at(-1)?.text ?? "");
    setDiff(null);
  });

  return <main className="app-shell">
    <header className="topbar">
      <a className="brand" href="#"><span className="seal">映</span><span><b>映卷</b><small>小说动态漫改编工作台</small></span></a>
      <nav className="modes" aria-label="工作模式">
        <button className="active">追溯</button><button disabled>审核</button><button disabled>分镜</button>
      </nav>
      <div className="top-meta"><span>中国大陆区</span><i /> <span>{project?.title || "未命名项目"}</span></div>
    </header>

    <div className="body-grid">
      <aside className="step-rail">
        <div className="rail-intro"><span className="eyebrow">卷首流程</span><h1>把原文<br />收入项目</h1><p>先建立可信原文，再进入故事知识与改编。</p></div>
        <ol>{steps.map((item, index) => {
          const current = steps.findIndex(({ id }) => id === step);
          return <li key={item.id} className={index === current ? "current" : index < current ? "done" : ""}>
            <span className="step-number">{item.number}</span><span><b>{item.label}</b><small>{item.note}</small></span>
          </li>;
        })}</ol>
        <div className="rail-foot"><span className="pulse" />原文版本不会被静默覆盖</div>
      </aside>

      <section className="work-area">
        <div className="ambient-mark" aria-hidden="true">卷</div>
        <div className="mobile-gate">
          <span className="eyebrow">移动端范围</span>
          <h2>请在桌面端导入原文</h2>
          <p>移动端首版仅用于查看进度、审核内容、处理修改建议与接收通知。</p>
        </div>
        {step === "login" && <Panel eyebrow="身份验证" title="进入你的工作室" description="首版支持中国大陆手机号验证码与微信扫码。">
          <div className="form-grid compact"><Field label="手机号"><input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" /></Field>
            <button className="button secondary align-end" onClick={sendCode} disabled={busy}>获取验证码</button>
            <Field label="验证码"><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 位验证码" inputMode="numeric" /></Field>
            <button className="button primary align-end" onClick={login} disabled={busy}>验证并进入</button></div>
          <div className="divider"><span>或</span></div><button className="wechat-button" disabled>微信扫码登录 <small>将在微信开放平台配置后启用二维码展示</small></button>
        </Panel>}

        {step === "project" && <Panel eyebrow="项目立项" title="定义这一卷如何被改编" description="这些约束会跟随章节进入后续故事知识、剧本、设定和分镜。">
          <div className="form-grid"><Field label="项目名称" wide><input value={projectDraft.title} onChange={(event) => setProjectDraft({ ...projectDraft, title: event.target.value })} placeholder="例如：人间剑令" /></Field>
            <Choice label="画面比例" value={projectDraft.aspectRatio} options={[['9:16','竖屏'],['16:9','横屏']]} onChange={(value) => setProjectDraft({ ...projectDraft, aspectRatio: value as ProjectDraft['aspectRatio'] })} />
            <Choice label="单集时长" value={String(projectDraft.targetDurationSeconds)} options={[['60','1 分钟'],['180','3 分钟'],['300','5 分钟']]} onChange={(value) => setProjectDraft({ ...projectDraft, targetDurationSeconds: Number(value) as ProjectDraft['targetDurationSeconds'] })} />
            <Choice label="叙事形式" value={projectDraft.narrativeMode} options={[['narration','旁白型'],['dialogue','对白型']]} onChange={(value) => setProjectDraft({ ...projectDraft, narrativeMode: value as ProjectDraft['narrativeMode'] })} />
          </div>
          <label className="rights"><input type="checkbox" checked={projectDraft.rightsDeclared} onChange={(event) => setProjectDraft({ ...projectDraft, rightsDeclared: event.target.checked })} /><span><b>我确认拥有该作品或合法改编权</b><small>平台默认不会将上传作品用于模型训练。</small></span></label>
          <Action onClick={createProject} busy={busy}>创建项目，继续导入</Action>
        </Panel>}

        {step === "source" && <Panel eyebrow="原文导入" title="先预检，再决定收入哪一章" description="包含多章的文件不会被整本处理；未选章节会保留在本次文件中，不创建正式原文版本。">
          <div className="source-tabs"><button className={inputMode === "paste" ? "active" : ""} onClick={() => setInputMode("paste")}>粘贴文本</button><button className={inputMode === "file" ? "active" : ""} onClick={() => setInputMode("file")}>TXT / DOCX</button></div>
          {inputMode === "paste" ? <textarea className="source-input" value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder={'第1章 青芽微澜\n在雨后的咸阳城……'} />
            : <label className="dropzone"><input type="file" accept=".txt,.docx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span className="drop-icon">文</span><b>{file?.name || "选择 TXT 或 DOCX 文件"}</b><small>单个文件不超过 20 MB，本次最多处理一章 20,000 字</small></label>}
          <Action onClick={inspect} busy={busy}>预检章节</Action>
        </Panel>}

        {step === "chapter" && <Panel eyebrow="章节预检" title={`识别到 ${chapters.length} 个章节`} description="请选择本次处理的一章。超出 20,000 字的章节会保留，但暂不可选择。">
          <div className="chapter-list">{chapters.map((item) => <button key={item.index} disabled={!item.selectable} className={selectedChapter === item.index ? "selected" : ""} onClick={() => setSelectedChapter(item.index)}>
            <span className="chapter-index">{String(item.index + 1).padStart(2, '0')}</span><span><b>{item.title}</b><small>{item.characterCount.toLocaleString('zh-CN')} 字 · {item.selectable ? '可导入' : '超出限制'}</small></span><span className="radio" /></button>)}</div>
          <div className="inline-actions"><button className="text-button" onClick={() => setStep("source")}>返回修改原文</button><Action onClick={importChapter} busy={busy}>确认并创建原文版本</Action></div>
        </Panel>}

        {step === "version" && chapter && <VersionDesk chapter={chapter} importedDocument={importedDocument} importSavedChapter={importSavedChapter} reimportText={reimportText} setReimportText={setReimportText} reimport={reimport} busy={busy} diff={diff} />}
        {notice && <div className="notice" role="status"><span>!</span>{notice}<button onClick={() => setNotice(null)}>×</button></div>}
      </section>

      <aside className="context-panel">
        <span className="eyebrow">项目约束</span><h2>{project?.title || "尚未立项"}</h2>
        <dl><div><dt>画幅</dt><dd>{projectDraft.aspectRatio}</dd></div><div><dt>单集</dt><dd>{projectDraft.targetDurationSeconds / 60} 分钟</dd></div><div><dt>叙事</dt><dd>{projectDraft.narrativeMode === "narration" ? "旁白型" : "对白型"}</dd></div><div><dt>区域</dt><dd>中国大陆</dd></div></dl>
        <div className="rule-card"><b>当前门禁</b><p>{step === "version" ? "原文已形成不可变版本，可以进入故事知识提取。" : "完成单章导入后，才会解锁故事知识阶段。"}</p></div>
        <div className="stage-stack"><span className={step === "version" ? "ready" : "locked"}>01 · 故事知识</span><span className="locked">02 · 剧本</span><span className="locked">03 · 设定</span><span className="locked">04 · 分镜</span></div>
      </aside>
    </div>
  </main>;
}

function Panel({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return <div className="panel"><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p className="lead">{description}</p>{children}</div>;
}
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={`field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>; }
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<readonly [T, string]>; onChange(value: T): void }) { return <fieldset className="choice"><legend>{label}</legend><div>{options.map(([id, name]) => <button type="button" key={id} className={value === id ? "active" : ""} onClick={() => onChange(id)}>{name}</button>)}</div></fieldset>; }
function Action({ children, onClick, busy }: { children: React.ReactNode; onClick(): void; busy: boolean }) { return <button className="button primary action" onClick={onClick} disabled={busy}>{busy ? "处理中…" : children}<span>→</span></button>; }

function VersionDesk({ chapter, importedDocument, importSavedChapter, reimportText, setReimportText, reimport, busy, diff }: { chapter: Chapter; importedDocument: ImportedDocumentSummary | null; importSavedChapter(index: number): void; reimportText: string; setReimportText(value: string): void; reimport(): void; busy: boolean; diff: SourceVersionDiff | null }) {
  const version = chapter.versions.at(-1)!;
  return <div className="version-desk"><div className="version-head"><div><span className="eyebrow">原文版本 {String(version.ordinal).padStart(2,'0')}</span><h2>{chapter.title}</h2></div><span className="version-badge">已入卷 · {version.characterCount} 字</span></div>
    <div className="version-grid"><section className="manuscript"><div className="paper-head"><span>原文片段</span><small>{version.id}</small></div>{version.fragments.map((fragment) => <article key={fragment.id}><small>{fragment.id}</small><p>{fragment.text}</p></article>)}</section>
      <aside className="reimport">{importedDocument && <div className="saved-directory"><span className="eyebrow">已保存章节目录</span>{importedDocument.chapters.map((item) => <p key={item.index}><span><b>{item.title}</b><small>{item.status === "imported" ? "已入卷" : "待后续处理"} · {item.characterCount} 字</small></span>{item.status === "pending" && <button onClick={() => importSavedChapter(item.index)} disabled={busy}>现在处理</button>}</p>)}</div>}<span className="eyebrow">重新导入</span><h3>比较新版本</h3><p>原版本不会被覆盖。修改正文后创建版本 {version.ordinal + 1}。</p><textarea value={reimportText} onChange={(event) => setReimportText(event.target.value)} /><button className="button secondary" onClick={reimport} disabled={busy}>生成差异</button>
        {diff && <div className="diff"><Diff title="新增" tone="add" items={diff.added} /><Diff title="删除" tone="remove" items={diff.removed} /><Diff title="未变化" tone="same" items={diff.unchanged} /></div>}</aside></div></div>;
}
function Diff({ title, tone, items }: { title: string; tone: string; items: string[] }) { return <div className={`diff-group ${tone}`}><b>{title} · {items.length}</b>{items.map((item, index) => <p key={`${tone}-${index}`}>{item}</p>)}</div>; }
