import { Pool } from "pg";
import { createEpisodeFeishuAlertSender } from "./episode-feishu-alert.ts";
import { assertEpisodeFeishuAlertDatabase,createEpisodeFeishuAlertWorker } from "./episode-feishu-alert-worker.ts";

async function main() {
  const {EPISODE_FEISHU_DATABASE_URL:databaseUrl,EPISODE_FEISHU_WORKSPACE_ID:workspaceId,
    EPISODE_FEISHU_WEBHOOK:webhook}=process.env;
  if (!workspaceId || !/^[^\s,\0]{1,256}$/.test(workspaceId)) throw new Error("INVALID_EPISODE_FEISHU_WORKSPACE_ID");
  let url:URL;
  try {
    url=new URL(databaseUrl ?? "");
    const socket=url.searchParams.get("host");
    const port=url.searchParams.get("port");
    if (!["postgres:","postgresql:"].includes(url.protocol)
      || !["localhost","127.0.0.1","[::1]"].includes(url.hostname) || !url.username || url.pathname.length<2 || url.hash
      || [...url.searchParams.keys()].some(name=>name!=="host" && name!=="port")
      || url.searchParams.getAll("host").length>1 || url.searchParams.getAll("port").length>1
      || (socket!==null && !/^\/[^,\r\n\0]*$/.test(socket))
      || (port!==null && (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port)>65535))) throw new Error();
  } catch { throw new Error("INVALID_EPISODE_FEISHU_DATABASE_URL"); }
  const send=createEpisodeFeishuAlertSender(webhook ?? "");
  const pool=new Pool({connectionString:url.href,max:2,options:"-c role=novel_episode_alert_delivery",
    connectionTimeoutMillis:5000});
  const worker=createEpisodeFeishuAlertWorker({pool,workspaceIds:[workspaceId],enabled:true,send});
  let stopping=false;
  const stop=()=>{
    stopping=true;
    void worker.stop().catch(()=>{});
  };
  process.once("SIGINT",stop);
  process.once("SIGTERM",stop);
  try {
    await assertEpisodeFeishuAlertDatabase(pool);
    if (stopping) return;
    console.log("EPISODE_FEISHU_WORKER_STARTED",workspaceId);
    await worker.start();
  } finally {
    for (const signal of ["SIGINT","SIGTERM"] as const) {
      process.removeListener(signal,stop);
    }
    await pool.end();
  }
}

main().catch((error:unknown)=>{
  console.error(error instanceof Error && [
    "INVALID_EPISODE_FEISHU_WORKSPACE_ID","INVALID_EPISODE_FEISHU_DATABASE_URL",
    "INVALID_FEISHU_WEBHOOK","EPISODE_FEISHU_DATABASE_NOT_READY",
  ].includes(error.message) ? error.message : "EPISODE_FEISHU_WORKER_FAILED");
  process.exitCode=1;
});
