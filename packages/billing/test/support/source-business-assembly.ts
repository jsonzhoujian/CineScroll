// Owned test-only pools, one immutable socket/database endpoint. No production export.
import { Pool } from "pg";
import { assertIsolatedBusinessFixtureDatabase } from "./source-business-readiness.ts";
import { createIsolatedSourceBusinessReader } from "./source-business-reader.ts";
import { prepareBusinessReadCommand } from "./source-business-read-command.ts";
type Config = { connectionString: string; inspectorLogin: string; workspaceId: string; allowedProducerServiceIds: string[] };
export class SourceBusinessAssemblyError extends Error {
  readonly code: "INVALID_CONFIG" | "NOT_READY" | "CLOSED" | "UNAVAILABLE";
  constructor(code: SourceBusinessAssemblyError["code"]) { super(code); this.code = code; }
}
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\r\n\u0000*?]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) && !value.includes("://");
function prepareConfig(input: unknown): Config {
  try {
    const keys = ["connectionString","inspectorLogin","workspaceId","allowedProducerServiceIds"];
    if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== 4) throw new Error();
    const config = Object.fromEntries(keys.map(key => {
      const d = Object.getOwnPropertyDescriptor(input,key);
      if (!d?.enumerable || !Object.hasOwn(d,"value")) throw new Error();
      return [key,d.value];
    })) as Config;
    const producers = config.allowedProducerServiceIds;
    if (!id(config.workspaceId) || typeof config.inspectorLogin !== "string" || !/^d1b_login_inspector_[a-f0-9]{32}$/.test(config.inspectorLogin)
      || !Array.isArray(producers) || Object.getPrototypeOf(producers) !== Array.prototype || producers.length < 1 || producers.length > 100
      || Reflect.ownKeys(producers).length !== producers.length + 1) throw new Error();
    for (let i=0;i<producers.length;i++) {
      const d = Object.getOwnPropertyDescriptor(producers,String(i));
      if (!d?.enumerable || !Object.hasOwn(d,"value") || !id(d.value)) throw new Error();
    }
    if (new Set(producers).size !== producers.length || typeof config.connectionString !== "string") throw new Error();
    const url = new URL(config.connectionString);
    if (url.protocol !== "postgresql:" || url.hostname !== "localhost" || url.port || url.password || url.hash
      || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(url.username) || url.username === config.inspectorLogin
      || !/^\/d1b_[a-f0-9]{32}$/.test(url.pathname)
      || !/^\/private\/tmp\/source-d1b\.[A-Za-z0-9]{6}$/.test(url.searchParams.get("host") ?? "")
      || !/^[1-9][0-9]{0,4}$/.test(url.searchParams.get("port") ?? "") || Number(url.searchParams.get("port")) > 65535
      || [...url.searchParams.keys()].sort().join(",") !== "host,port") throw new Error();
    return structuredClone(config);
  } catch { throw new SourceBusinessAssemblyError("INVALID_CONFIG"); }
}

export function createIsolatedSourceBusinessAssembly(input: unknown) {
  const config = prepareConfig(input), inspectorUrl = new URL(config.connectionString);
  inspectorUrl.username = config.inspectorLogin;
  const inspector = new Pool({ connectionString: inspectorUrl.toString(), options: "-c role=novel_d1b_inspector", max: 1, connectionTimeoutMillis: 2000 });
  const administrator = new Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 2000 });
  const reader = createIsolatedSourceBusinessReader(administrator, config);
  let closing: Promise<void> | undefined;
  return {
    async read(input: unknown) {
      if (closing) throw new SourceBusinessAssemblyError("CLOSED");
      const command = prepareBusinessReadCommand(input, config.workspaceId);
      try { await assertIsolatedBusinessFixtureDatabase(inspector); }
      catch { throw new SourceBusinessAssemblyError("NOT_READY"); }
      if (closing) throw new SourceBusinessAssemblyError("CLOSED");
      return reader.read({ taskReference: command.taskReference, snapshotReference: command.snapshotReference, executionReference: command.executionReference });
    },
    close(): Promise<void> {
      closing ??= Promise.allSettled([Promise.resolve().then(() => inspector.end()),Promise.resolve().then(() => administrator.end())]).then(results => {
        if (results.some(result => result.status === "rejected")) throw new SourceBusinessAssemblyError("UNAVAILABLE");
      });
      return closing;
    },
  };
}
