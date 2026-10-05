"use client";
import { useEffect, useRef, useState } from "react";
import { ApiClient, ApiClientError, type ModelCapabilities, type ModelConfiguration } from "../lib/api";

export function ModelSettingsPanel({ api, onClose }: { api: ApiClient; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), keyInput = useRef<HTMLInputElement>(null);
  const [capabilities, setCapabilities] = useState<ModelCapabilities | null>(null);
  const [configuration, setConfiguration] = useState<ModelConfiguration | null>(null);
  const [providerId, setProviderId] = useState("");
  const [busy, setBusy] = useState(true), [notice, setNotice] = useState("读取工作室权限…");
  const [allowOverseas, setAllowOverseas] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    void (async () => {
      try {
        const access = await api.modelCapabilities();
        const saved = access.advanced ? (await api.modelConfiguration()).configuration : null;
        if (!active) return;
        setCapabilities(access); setConfiguration(saved);
        setProviderId(saved?.providerId ?? access.providers.find(p => p.available)?.id ?? "");
        setNotice(access.advanced ? "共享配置由工作室负责人管理。" : "BYOK 需要有效的高级工作室订阅。");
      } catch (error) { if (active) setNotice(describe(error)); }
      finally { if (active) setBusy(false); }
    })();
    return () => { active = false; };
  }, [api]);
  const provider = capabilities?.providers.find(p => p.id === providerId);
  function close() { dialog.current?.close(); onClose(); }
  async function save() {
    const apiKey = keyInput.current?.value ?? "";
    if (keyInput.current) keyInput.current.value = "";
    if (!apiKey.trim()) { setNotice("请输入新的 API Key。"); return; }
    setBusy(true);
    try {
      const saved = await api.saveModelKey({ expectedVersionId: configuration?.id ?? null, providerId, apiKey });
      setConfiguration(saved); setAllowOverseas(false); setNotice("已加密保存，尚未测试连接。原始 Key 不可回看。");
    } catch (error) { setNotice(describe(error)); }
    finally { setBusy(false); }
  }
  async function testConnection() {
    if (!configuration) return;
    setBusy(true);
    try { setConfiguration(await api.testModelConnection(configuration.id, allowOverseas)); setNotice("连接测试完成。模型目录不代表生成能力已验证。"); }
    catch (error) { setNotice(describe(error)); }
    finally { setBusy(false); }
  }
  return <dialog className="model-panel" ref={dialog} aria-labelledby="model-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header><div><span className="eyebrow">工作室 · 共用凭据</span><h2 id="model-title">模型设置</h2></div><button type="button" className="text-button" aria-label="关闭模型设置" onClick={close}>关闭 ×</button></header>
    <p className="model-notice" role="status">{notice}</p>
    {capabilities && <>
      <label className="model-field">厂商 / 平台<select value={providerId} disabled={busy || !capabilities.canManage} onChange={e => { setProviderId(e.target.value); setAllowOverseas(false); if (keyInput.current) keyInput.current.value = ""; }}>
        {capabilities.providers.map(p => <option key={p.id} value={p.id} disabled={!p.available}>{p.name}{p.available ? "" : " · 暂不可用"}</option>)}
      </select></label>
      <p>{provider?.kind === "aggregator" ? "聚合平台，下游路由需另行核验。" : "厂商直连"} · {provider?.processingRegion === "mainland" ? "中国大陆处理" : provider?.processingRegion === "overseas" ? "境外处理" : "处理区域未确认"}</p>
      {configuration && <div className="model-snapshot"><span className="eyebrow">当前共享配置</span><p>{capabilities.providers.find(p => p.id === configuration.providerId)?.name} · {configuration.keyMask}</p><small>{configuration.tested ? "连接已测试" : "连接未测试"} · 版本 {configuration.id}</small></div>}
      {capabilities.canManage && <>
        <label className="model-field">新的 API Key<input ref={keyInput} type="password" autoComplete="off" spellCheck={false} maxLength={8192} disabled={busy || !provider?.available} placeholder="仅负责人可更新，不回显原 Key" /></label>
        <p className="model-help">保存会替换工作室当前配置并重置测试状态。输入在提交时清空，不保存到浏览器存储。</p>
        <button type="button" className="button primary" disabled={busy || !provider?.available} onClick={save}>加密保存 Key</button>
        {configuration && configuration.providerId === providerId && provider?.available && <div className="model-test">
          {provider.processingRegion === "overseas" && <label><input type="checkbox" checked={allowOverseas} disabled={busy} onChange={e => setAllowOverseas(e.target.checked)} />我同意将连接测试请求及凭据发送至该境外厂商</label>}
          <button type="button" className="button secondary" disabled={busy || (provider.processingRegion === "overseas" && !allowOverseas)} onClick={testConnection}>测试连接并读取模型</button>
        </div>}
      </>}
      {capabilities.advanced && !capabilities.canManage && <p>你可查看脱敏配置，但无权更新或测试工作室共享 Key。</p>}
      {configuration?.tested && <section><h3>可见模型目录</h3><ul className="model-list">{configuration.availableModelIds.map(id => <li key={id}>{id}</li>)}</ul><p className="model-help">本版仅展示目录，暂不接入生成任务中的模型切换。</p></section>}
    </>}
    <footer>作品数据存放于大陆，不代表模型请求也在大陆处理。</footer>
  </dialog>;
}
function describe(error: unknown) {
  if (!(error instanceof ApiClientError)) return "无法连接服务，请稍后重试。";
  if (error.status === 429) return `请求过于频繁，请在 ${Number.isFinite(error.retryAfterSeconds) ? error.retryAfterSeconds : 60} 秒后重试。`;
  if (error.status === 409) return "配置已由其他操作更新。请关闭并重新打开设置，读取最新版本后再提交。";
  if (error.status === 401) return "登录已失效，请重新登录。";
  if (error.status === 403) return "工作室权限或订阅已变化，请联系负责人。";
  if (error.status === 404) return "当前服务尚未启用工作室 BYOK。";
  return "操作未完成，请稍后重试；测试失败时仍保留已保存配置。";
}
