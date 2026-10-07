/** Internal bounded JSON copy for memory rule fixtures, not a production schema or authenticity check. */
export function copySourceFixtureJson(input: unknown): unknown {
  let nodes = 0;
  function check(value: unknown, depth: number): void {
    if (++nodes > 60_000 || depth > 24) throw new Error();
    if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "string") { if (value.length > 4096) throw new Error(); return; }
    if (!value || typeof value !== "object") throw new Error();
    const array = Array.isArray(value), keys = Reflect.ownKeys(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)
      || (array ? value.length > 1024 || keys.length !== value.length + 1 : keys.length > 64)) throw new Error();
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || key.length > 256 || array && !/^(0|[1-9]\d*)$/.test(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new Error();
      check(descriptor.value, depth + 1);
    }
  }
  check(input, 0);
  const copy = structuredClone(input);
  if (Buffer.byteLength(JSON.stringify(copy), "utf8") > 2 * 1024 * 1024) throw new Error();
  return copy;
}
