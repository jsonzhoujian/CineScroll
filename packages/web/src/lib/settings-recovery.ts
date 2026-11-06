type RecoveryKind = "settings-reconciliation" | "settings-regeneration";

export function findSettingsRecovery(kind: RecoveryKind, context: string) {
  const key = JSON.stringify([kind,context]);
  const raw = sessionStorage.getItem(key);
  if (raw !== null) return { key,context,raw };

  const [projectId,chapterId] = JSON.parse(context);
  const matches: { key: string;context: string;raw: string }[] = [];
  for (let i=0;i<sessionStorage.length;i++) {
    const candidate = sessionStorage.key(i);
    if (!candidate) continue;
    try {
      const parts = JSON.parse(candidate);
      if (!Array.isArray(parts) || parts.length !== 2) continue;
      const [prefix,savedContext] = parts;
      if (prefix !== kind || typeof savedContext !== "string") continue;
      const scope = JSON.parse(savedContext);
      if (!Array.isArray(scope) || scope.length !== 6 || !scope.every(id => typeof id === "string" && id)
        || scope[0] !== projectId || scope[1] !== chapterId) continue;
      const value = sessionStorage.getItem(candidate);
      if (value !== null) matches.push({ key:candidate,context:savedContext,raw:value });
    } catch (error) {
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    }
  }
  return matches.sort((a,b) => a.key.localeCompare(b.key))[0] ?? null;
}


export function archiveSettingsRecovery(key: string) {
  const raw = sessionStorage.getItem(key);
  if (raw === null) throw new Error("MISSING_RECOVERY");
  sessionStorage.setItem(JSON.stringify([...JSON.parse(key),"archived"]),raw);
}
