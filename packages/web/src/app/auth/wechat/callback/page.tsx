import { WechatCallback } from "../../../../components/wechat-callback";

type Query = { code?: string | string[]; state?: string | string[] };

export default async function WechatCallbackPage({ searchParams }: { searchParams: Promise<Query> }) {
  const query = await searchParams;
  return <WechatCallback code={single(query.code)} state={single(query.state)} />;
}

function single(value?: string | string[]): string | undefined {
  return typeof value === "string" ? value : undefined;
}
