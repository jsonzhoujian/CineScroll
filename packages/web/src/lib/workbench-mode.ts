export type WorkbenchMode = "trace" | "review" | "storyboard";

export type WorkbenchNavigation<TStep extends string> = {
  mode: WorkbenchMode;
  step: TStep;
};

export type StageReadiness = {
  sourceImported: boolean;
  storyKnowledgeConfirmed: boolean;
  scriptConfirmed: boolean;
  settingsConfirmed: boolean;
};

export const workbenchModes: ReadonlyArray<{
  id: WorkbenchMode;
  label: string;
}> = [
  { id: "trace", label: "追溯" },
  { id: "review", label: "审核" },
  { id: "storyboard", label: "分镜" },
];

export function switchWorkbenchMode<TStep extends string>(navigation: WorkbenchNavigation<TStep>, mode: WorkbenchMode): WorkbenchNavigation<TStep> {
  return { ...navigation, mode };
}

export function describeWorkbenchMode(mode: WorkbenchMode, readiness: StageReadiness): {
  generationEnabled: boolean;
  status: string;
  requiredConfirmation: "原文" | "故事知识" | "剧本" | "设定" | null;
} {
  if (!readiness.sourceImported) {
    return {
      generationEnabled: false,
      status: "尚未形成原文版本，请先完成单章入卷",
      requiredConfirmation: "原文",
    };
  }
  if (!readiness.storyKnowledgeConfirmed) {
    return {
      generationEnabled: false,
      status: mode === "storyboard"
        ? "仍需依次确认故事知识、剧本和设定"
        : "原文已就绪，等待故事知识生成并确认",
      requiredConfirmation: "故事知识",
    };
  }
  if (mode === "review") {
    return {
      generationEnabled: true,
      status: "故事知识已确认，可以进入正式审核",
      requiredConfirmation: null,
    };
  }
  if (mode === "storyboard" && !readiness.scriptConfirmed) {
    return {
      generationEnabled: false,
      status: "故事知识已确认，等待剧本确认",
      requiredConfirmation: "剧本",
    };
  }
  if (mode === "storyboard" && !readiness.settingsConfirmed) {
    return {
      generationEnabled: false,
      status: "剧本已确认，等待角色、场景和道具设定确认",
      requiredConfirmation: "设定",
    };
  }
  if (mode === "storyboard") {
    return {
      generationEnabled: true,
      status: "前置阶段已确认，可以生成正式分镜",
      requiredConfirmation: null,
    };
  }
  return {
    generationEnabled: false,
    status: "追溯模式用于核对原文与版本，不触发正式内容生成",
    requiredConfirmation: null,
  };
}
