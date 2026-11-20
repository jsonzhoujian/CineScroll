import { readBoundedJson } from "@novel-adaptation/script/bounded-json";
import { isEpisodeReconciliationAlertCode } from "./episode-reconciliation-alerts.ts";

type Delivery = "delivered" | "retryable" | "rejected" | "unknown";

/** Bind to a server-owned secret. A lost response has unknown delivery status. */
export function createEpisodeFeishuAlertSender(webhook:string, transport:typeof fetch=fetch) {
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]{36}$/i.test(webhook)) {
    throw new Error("INVALID_FEISHU_WEBHOOK");
  }
  return async (alert:{workspaceId:string;taskId:string;code:string}):Promise<Delivery>=>{
    if (!isEpisodeReconciliationAlertCode(alert.code) || ![alert.workspaceId,alert.taskId]
      .every(id=>typeof id==="string" && id.length>0 && id.length<=256 && !/[\r\n\0]/.test(id))) {
      throw new Error("INVALID_EPISODE_ALERT");
    }
    try {
      const response=await transport(webhook,{method:"POST",redirect:"error",signal:AbortSignal.timeout(5000),
        headers:{"content-type":"application/json"},body:JSON.stringify({
          msg_type:"text",content:{text:[
            "拆集对账告警",`工作室 ${alert.workspaceId}`,`任务 ${alert.taskId}`,`状态 ${alert.code}`,
          ].join("\n")},
        })});
      if (response.status===429) return "retryable";
      if (!response.ok) return response.status>=500 ? "unknown" : "rejected";
      const result=await readBoundedJson(response,8192);
      if (!result || typeof result!=="object" || !("code" in result) || !Number.isInteger(result.code)) return "unknown";
      if (result.code===0) return "delivered";
      if (result.code===11232) return "retryable";
      return "rejected";
    } catch { return "unknown"; }
  };
}
