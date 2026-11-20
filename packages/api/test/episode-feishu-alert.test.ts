import assert from "node:assert/strict";
import test from "node:test";
import { createEpisodeFeishuAlertSender } from "../src/episode-feishu-alert.ts";

test("飞书告警只发送必要字段，并区分确认送达、限流和未知结果",async()=>{
  const url="https://open.feishu.cn/open-apis/bot/v2/hook/00000000-0000-0000-0000-000000000000";
  const alert={workspaceId:"studio",taskId:"task-1",code:"EXECUTION_UNKNOWN"};
  for (const [reply,expected] of [
    [Response.json({code:0}),"delivered"],[Response.json({code:11232}),"retryable"],
    [Response.json({code:19024}),"rejected"],[Response.json({}),"unknown"],
    [new Response("",{status:502}),"unknown"],[new Response("",{status:429}),"retryable"],[null,"unknown"],
  ] as const) {
    const send=createEpisodeFeishuAlertSender(url,async (_url,init)=>{
      assert.equal(init?.method,"POST");
      assert.equal(init?.redirect,"error");
      assert.deepEqual(JSON.parse(String(init?.body)),{msg_type:"text",content:{
        text:"拆集对账告警\n工作室 studio\n任务 task-1\n状态 EXECUTION_UNKNOWN",
      }});
      if (!reply) throw new Error("simulated connection loss");
      return reply;
    });
    assert.equal(await send(alert),expected);
  }
  assert.throws(()=>createEpisodeFeishuAlertSender(url.replace("open.feishu.cn","example.com")),{message:"INVALID_FEISHU_WEBHOOK"});
});
