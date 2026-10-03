/** Internal transport seam: cap decoded bytes and reject invalid UTF-8/JSON. */
export async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
    await response.body?.cancel().catch(() => {}); throw new Error("Invalid provider response");
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length; if (total > limit) throw new Error("Provider response too large"); chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
