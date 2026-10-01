"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ApiClient, type Chapter, type ChapterInspection, type ImportedDocumentSummary, type SourceVersionDiff } from "../lib/api";
import { buildDocumentRequest, type DocumentRequest, type ProjectDraft, validateProjectDraft } from "../lib/workflow";
import { describeWorkbenchMode, type StageReadiness, switchWorkbenchMode, type WorkbenchMode, workbenchModes } from "../lib/workbench-mode";
import { expectedWechatLoginMessage, isTrustedWechatAuthorizationUrl } from "../lib/wechat-flow";
import type { ReviewFilter } from "../lib/story-knowledge-review";
import { StoryKnowledgeWorkbench } from "./story-knowledge-workbench";

type Step = "login" | "project" | "source" | "chapter" | "version";
type MobileTab = "progress" | "review" | "decisions" | "notifications";
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
  const [navigation, setNavigation] = useState<{ step: Step; mode: WorkbenchMode }>({ step: "login", mode: "trace" });
  const { step, mode } = navigation;
  const setStep = (nextStep: Step) => setNavigation((current) => ({ ...current, step: nextStep }));
  const setMode = (nextMode: WorkbenchMode) => setNavigation((current) => switchWorkbenchMode(current, nextMode));
  const [phone, setPhone] = useState("13800138000");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [projectDraft, setProjectDraft] = useState<ProjectDraft>(initialProject);
  const [project, setProject] = useState<{ id: string; title: string; role: "owner" | "editor" | "reviewer" } | null>(null);
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
  const [confirmedStoryKnowledgeChapterId, setConfirmedStoryKnowledgeChapterId] = useState<string | null>(null);
  const [reviewCursor, setReviewCursor] = useState<{ filter: ReviewFilter; selectedId: string | null }>({ filter: "all", selectedId: null });
  const syncStoryKnowledgeConfirmation = useCallback((chapterId: string, confirmed: boolean) => {
    setConfirmedStoryKnowledgeChapterId((current) => confirmed ? chapterId : current === chapterId ? null : current);
  }, []);
  const [mobileTab, setMobileTab] = useState<MobileTab>("progress");
  const expectedWechatState = useRef<string | null>(null);
  const wechatPopup = useRef<Window | null>(null);

  useEffect(() => {
    const receiveWechatLogin = (event: MessageEvent<unknown>) => {
      const message = expectedWechatLoginMessage(event, {
        origin: window.location.origin,
        source: wechatPopup.current,
        state: expectedWechatState.current,
      });
      if (!message) return;
      expectedWechatState.current = null;
      wechatPopup.current = null;
      api.acceptSession(message.sessionToken);
      setStep("project");
      setNotice("微信登录成功");
    };
    window.addEventListener("message", receiveWechatLogin);
    const popupMonitor = window.setInterval(() => {
      if (wechatPopup.current?.closed && expectedWechatState.current) {
        wechatPopup.current = null;
        expectedWechatState.current = null;
        setNotice("微信登录已取消，可重新发起扫码");
      }
    }, 500);
    return () => {
      window.removeEventListener("message", receiveWechatLogin);
      window.clearInterval(popupMonitor);
    };
  }, [api]);

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
  const startWechatLogin = () => {
    const popup = window.open("", "wechat-login", "popup,width=720,height=760");
    if (!popup) { setNotice("浏览器阻止了登录窗口，请允许弹窗后重试"); return; }
    wechatPopup.current = popup;
    void run(async () => {
      try {
        const result = await api.beginWechatLogin();
        if (!isTrustedWechatAuthorizationUrl(result.authorizationUrl)) {
          throw new Error("微信授权地址无效，请稍后重试");
        }
        expectedWechatState.current = result.state;
        popup.location.href = result.authorizationUrl;
      } catch (error) {
        popup.close();
        wechatPopup.current = null;
        throw error;
      }
    });
  };
  const createProject = () => run(async () => {
    const validation = validateProjectDraft(projectDraft);
    if (!validation.ok) throw new Error(validation.message);
    const created = await api.createProject(validation.value);
    setProject({ ...created, role: "owner" }); setStep("source");
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

  return <main className={`app-shell mode-${mode} step-${step}`}>
    <header className="topbar">
      <a className="brand" href="#"><span className="seal">映</span><span><b>映卷</b><small>小说动态漫改编工作台</small></span></a>
      <nav className="modes" aria-label="工作模式">
        {workbenchModes.map((item) => <button key={item.id} type="button" className={mode === item.id ? "active" : ""} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}
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
        <MobileCompanion tab={mobileTab} onTabChange={setMobileTab} step={step} project={project} chapter={chapter} />
        {mode === "trace" && step === "login" && <Panel eyebrow="身份验证" title="进入你的工作室" description="首版支持中国大陆手机号验证码与微信扫码。">
          <div className="form-grid compact"><Field label="手机号"><input value={phone} onChange={(event) => setPhone(event.target.value)} inputMode="tel" /></Field>
            <button className="button secondary align-end" onClick={sendCode} disabled={busy}>获取验证码</button>
            <Field label="验证码"><input value={code} onChange={(event) => setCode(event.target.value)} placeholder="6 位验证码" inputMode="numeric" /></Field>
            <button className="button primary align-end" onClick={login} disabled={busy}>验证并进入</button></div>
          <div className="divider"><span>或</span></div><button className="wechat-button" onClick={startWechatLogin} disabled={busy}>微信扫码登录 <small>在新窗口打开微信官方二维码</small></button>
        </Panel>}

        {mode === "trace" && step === "project" && <Panel eyebrow="项目立项" title="定义这一卷如何被改编" description="这些约束会跟随章节进入后续故事知识、剧本、设定和分镜。">
          <div className="form-grid"><Field label="项目名称" wide><input value={projectDraft.title} onChange={(event) => setProjectDraft({ ...projectDraft, title: event.target.value })} placeholder="例如：人间剑令" /></Field>
            <Choice label="画面比例" value={projectDraft.aspectRatio} options={[['9:16','竖屏'],['16:9','横屏']]} onChange={(value) => setProjectDraft({ ...projectDraft, aspectRatio: value as ProjectDraft['aspectRatio'] })} />
            <Choice label="单集时长" value={String(projectDraft.targetDurationSeconds)} options={[['60','1 分钟'],['180','3 分钟'],['300','5 分钟']]} onChange={(value) => setProjectDraft({ ...projectDraft, targetDurationSeconds: Number(value) as ProjectDraft['targetDurationSeconds'] })} />
            <Choice label="叙事形式" value={projectDraft.narrativeMode} options={[['narration','旁白型'],['dialogue','对白型']]} onChange={(value) => setProjectDraft({ ...projectDraft, narrativeMode: value as ProjectDraft['narrativeMode'] })} />
          </div>
          <label className="rights"><input type="checkbox" checked={projectDraft.rightsDeclared} onChange={(event) => setProjectDraft({ ...projectDraft, rightsDeclared: event.target.checked })} /><span><b>我确认拥有该作品或合法改编权</b><small>平台默认不会将上传作品用于模型训练。</small></span></label>
          <Action onClick={createProject} busy={busy}>创建项目，继续导入</Action>
        </Panel>}

        {mode === "trace" && step === "source" && <Panel eyebrow="原文导入" title="先预检，再决定收入哪一章" description="包含多章的文件不会被整本处理；未选章节会保留在本次文件中，不创建正式原文版本。">
          <div className="source-tabs"><button className={inputMode === "paste" ? "active" : ""} onClick={() => setInputMode("paste")}>粘贴文本</button><button className={inputMode === "file" ? "active" : ""} onClick={() => setInputMode("file")}>TXT / DOCX</button></div>
          {inputMode === "paste" ? <textarea className="source-input" value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder={'第1章 青芽微澜\n在雨后的咸阳城……'} />
            : <label className="dropzone"><input type="file" accept=".txt,.docx" onChange={(event) => setFile(event.target.files?.[0] ?? null)} /><span className="drop-icon">文</span><b>{file?.name || "选择 TXT 或 DOCX 文件"}</b><small>单个文件不超过 20 MB，本次最多处理一章 20,000 字</small></label>}
          <Action onClick={inspect} busy={busy}>预检章节</Action>
        </Panel>}

        {mode === "trace" && step === "chapter" && <Panel eyebrow="章节预检" title={`识别到 ${chapters.length} 个章节`} description="请选择本次处理的一章。超出 20,000 字的章节会保留，但暂不可选择。">
          <div className="chapter-list">{chapters.map((item) => <button key={item.index} disabled={!item.selectable} className={selectedChapter === item.index ? "selected" : ""} onClick={() => setSelectedChapter(item.index)}>
            <span className="chapter-index">{String(item.index + 1).padStart(2, '0')}</span><span><b>{item.title}</b><small>{item.characterCount.toLocaleString('zh-CN')} 字 · {item.selectable ? '可导入' : '超出限制'}</small></span><span className="radio" /></button>)}</div>
          <div className="inline-actions"><button className="text-button" onClick={() => setStep("source")}>返回修改原文</button><Action onClick={importChapter} busy={busy}>确认并创建原文版本</Action></div>
        </Panel>}

        {mode === "trace" && step === "version" && chapter && <VersionDesk chapter={chapter} importedDocument={importedDocument} importSavedChapter={importSavedChapter} reimportText={reimportText} setReimportText={setReimportText} reimport={reimport} busy={busy} diff={diff} />}
        {mode !== "trace" && <ModeWorkspace mode={mode} project={project} chapter={chapter} api={api} storyKnowledgeConfirmed={confirmedStoryKnowledgeChapterId === chapter?.id} reviewCursor={reviewCursor} onReviewCursorChange={setReviewCursor} onStoryKnowledgeConfirmationChange={syncStoryKnowledgeConfirmation} onNotice={setNotice} onReturnToTrace={() => setMode("trace")} />}
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
  return <div className="version-desk"><div className="version-head"><div><span className="eyebrow">原文版本 {String(version.ordinal).padStart(2,'0')}</span><h2>{chapter.title}</h2></div><span className="version-badge" aria-label="当前原文版本状态">已入卷 · {version.characterCount} 字</span></div>
    <div className="version-grid"><section className="manuscript"><div className="paper-head"><span>原文片段</span><small>{version.id}</small></div>{version.fragments.map((fragment) => <article key={fragment.id}><small>{fragment.id}</small><p>{fragment.text}</p></article>)}</section>
      <aside className="reimport" aria-label="重新导入">{importedDocument && <div className="saved-directory" role="region" aria-label="已保存章节目录"><span className="eyebrow">已保存章节目录</span>{importedDocument.chapters.map((item) => <p key={item.index}><span><b>{item.title}</b><small>{item.status === "imported" ? "已入卷" : "待后续处理"} · {item.characterCount} 字</small></span>{item.status === "pending" && <button onClick={() => importSavedChapter(item.index)} disabled={busy}>现在处理</button>}</p>)}</div>}<span className="eyebrow">重新导入</span><h3>比较新版本</h3><p>原版本不会被覆盖。修改正文后创建版本 {version.ordinal + 1}。</p><textarea aria-label="新版本正文" value={reimportText} onChange={(event) => setReimportText(event.target.value)} /><button className="button secondary" onClick={reimport} disabled={busy}>生成差异</button>
        {diff && <div className="diff"><Diff title="新增" tone="add" items={diff.added} /><Diff title="删除" tone="remove" items={diff.removed} /><Diff title="未变化" tone="same" items={diff.unchanged} /></div>}</aside></div></div>;
}
function Diff({ title, tone, items }: { title: string; tone: string; items: string[] }) { return <div className={`diff-group ${tone}`} role="group" aria-label={`${title}内容`}><b>{title} · {items.length}</b>{items.map((item, index) => <p key={`${tone}-${index}`}>{item}</p>)}</div>; }

function MobileCompanion({ tab, onTabChange, step, project, chapter }: { tab: MobileTab; onTabChange(tab: MobileTab): void; step: Step; project: { id: string; title: string } | null; chapter: Chapter | null }) {
  const version = chapter?.versions.at(-1);
  const tabs: ReadonlyArray<{ id: MobileTab; label: string }> = [
    { id: "progress", label: "进度" },
    { id: "review", label: "审核" },
    { id: "decisions", label: "建议" },
    { id: "notifications", label: "通知" },
  ];

  return <section className="mobile-companion" role="region" aria-label="移动端工作区">
    <header><span className="eyebrow">随身审阅</span><h2>{project?.title || "尚未立项"}</h2><p>{chapter ? chapter.title : "项目编辑与原文导入请在桌面端完成"}</p></header>
    <nav aria-label="移动端功能">{tabs.map((item) => <button type="button" key={item.id} className={tab === item.id ? "active" : ""} aria-pressed={tab === item.id} onClick={() => onTabChange(item.id)}>{item.label}</button>)}</nav>
    {tab === "progress" && <div className="mobile-pane mobile-progress">
      <div className="mobile-stage"><span className={chapter ? "done" : "current"}>01</span><p><b>原文入卷</b><small>{chapter ? "已完成" : step === "version" ? "读取中" : "等待桌面端处理"}</small></p></div>
      <div className="mobile-stage"><span>02</span><p><b>故事知识</b><small>{chapter ? "等待生成" : "等待原文"}</small></p></div>
      <div className="mobile-stage"><span>03</span><p><b>剧本与设定</b><small>等待前置确认</small></p></div>
      <div className="mobile-stage"><span>04</span><p><b>分镜</b><small>等待前置确认</small></p></div>
      {version && <section className="mobile-result" aria-label="只读结果"><div><span className="eyebrow">只读结果</span><b>版本 {String(version.ordinal).padStart(2, "0")} · {version.characterCount} 字</b></div>{version.fragments.map((fragment) => <p key={fragment.id}>{fragment.text}</p>)}</section>}
    </div>}
    {tab === "review" && <MobileEmpty mark="审" title="暂无待审核内容" note={chapter ? "原文已就绪；故事知识生成后，将在这里逐项审核。" : "完成原文入卷后，审核任务会出现在这里。"} />}
    {tab === "decisions" && <MobileEmpty mark="议" title="暂无修改建议" note="成员提交建议后，可在此查看理由并接受或拒绝；移动端不直接编辑正文。" />}
    {tab === "notifications" && <MobileEmpty mark="铃" title="暂无新通知" note="阶段完成、审核请求和建议处理结果会集中出现在这里。" />}
    <footer><i />移动端为审阅席，不提供立项、导入或重新生成</footer>
  </section>;
}

function MobileEmpty({ mark, title, note }: { mark: string; title: string; note: string }) {
  return <div className="mobile-pane mobile-empty"><span>{mark}</span><h3>{title}</h3><p>{note}</p></div>;
}

function ModeWorkspace({ mode, project, chapter, api, storyKnowledgeConfirmed, reviewCursor, onReviewCursorChange, onStoryKnowledgeConfirmationChange, onNotice, onReturnToTrace }: { mode: Exclude<WorkbenchMode, "trace">; project: { id: string; title: string; role: "owner" | "editor" | "reviewer" } | null; chapter: Chapter | null; api: ApiClient; storyKnowledgeConfirmed: boolean; reviewCursor: { filter: ReviewFilter; selectedId: string | null }; onReviewCursorChange(cursor: { filter: ReviewFilter; selectedId: string | null }): void; onStoryKnowledgeConfirmationChange(chapterId: string, confirmed: boolean): void; onNotice(message: string): void; onReturnToTrace(): void }) {
  const readiness: StageReadiness = {
    sourceImported: Boolean(chapter),
    storyKnowledgeConfirmed,
    scriptConfirmed: false,
    settingsConfirmed: false,
  };
  const policy = describeWorkbenchMode(mode, readiness);
  const isReview = mode === "review";
  const stages = [
    { label: "原文版本", requirement: "原文", ready: readiness.sourceImported },
    { label: "故事知识", requirement: "故事知识", ready: readiness.storyKnowledgeConfirmed },
    ...(!isReview ? [{ label: "剧本", requirement: "剧本", ready: readiness.scriptConfirmed }, { label: "设定", requirement: "设定", ready: readiness.settingsConfirmed }] : []),
  ];

  if (isReview && project && chapter) return <StoryKnowledgeWorkbench api={api} project={project} chapter={chapter} canManageStage={project.role === "owner" || project.role === "reviewer"} cursor={reviewCursor} onCursorChange={onReviewCursorChange} onNotice={onNotice} onConfirmationChange={(confirmed) => onStoryKnowledgeConfirmationChange(chapter.id, confirmed)} />;

  return <div className={`mode-workspace ${mode}`}>
    <div className="mode-heading"><div><span className="eyebrow">{isReview ? "审核工作台" : "分镜工作台"}</span><h2>{isReview ? "逐项确认，保留每次判断" : "先看全局，再落到每个镜头"}</h2><p>{isReview ? "这里将承载修改建议、原文证据与接受或拒绝记录。" : "这里将承载镜头列表、镜头详情与资产引用。"}</p></div><span className="mode-index">{isReview ? "审" : "镜"}</span></div>
    <div className="mode-sheet">
      <section className="mode-status"><span className="eyebrow">当前上下文</span><h3>{project?.title || "尚未立项"}</h3><p>{chapter ? `已选章节：${chapter.title}` : "尚未导入可追溯的原文章节。"}</p><div className="gate-message"><i /> <span><b>正式内容尚未解锁</b><small>{policy.status}</small></span></div></section>
      <section className="mode-gates"><span className="eyebrow">确认链</span>{stages.map((stage, index) => <div className={stage.ready ? "complete" : "pending"} key={stage.label}><span>{String(index + 1).padStart(2, "0")}</span><b>{stage.label}</b><small>{stage.ready ? "已就绪" : stage.requirement === policy.requiredConfirmation ? "下一项" : "等待前置确认"}</small></div>)}</section>
    </div>
    <div className="mode-actions"><p>切换工作台只改变查看方式，不会生成、修改或复制项目内容。</p><button type="button" className="button secondary" onClick={onReturnToTrace}>返回追溯，完成前置步骤</button></div>
  </div>;
}
