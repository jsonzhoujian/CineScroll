import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { canonicalEvidenceValue } from "../src/evidence-material-repository.ts";
import { buildInitializeVectors } from "./support/source-initialize-vectors.ts";

test("approved offline initialization matches fixed canonical bytes, hashes and budgets", () => {
  const golden = JSON.parse(readFileSync(new URL("../../../docs/fixtures/source-initialize-vectors-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(buildInitializeVectors(), golden);
});

test("every fixed byte sequence independently matches OpenSSL SHA256 and UTF8 length", () => {
  const golden = JSON.parse(readFileSync(new URL("../../../docs/fixtures/source-initialize-vectors-v1.json", import.meta.url), "utf8"));
  for (const v of golden.vectors) {
    const result = spawnSync("openssl", ["dgst", "-sha256"], { input: v.canonical, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split(/\s+/).at(-1), v.sha256, v.name);
    assert.equal(Buffer.byteLength(v.canonical, "utf8"), v.bytes, v.name);
    assert.equal(canonicalEvidenceValue(JSON.parse(v.canonical)), v.canonical, v.name);
  }
});

test("source projection bytes match independently handwritten ordered fields", () => {
  const vectors = buildInitializeVectors().vectors;
  const binding = '"binding":{"chapterId":"chapter","projectId":"project","sourceVersionId":"source","taskId":"task","unitId":"unit","upstreamVersionIds":["knowledge","outline"],"workspaceId":"studio"}';
  assert.equal(vectors.find(v => v.name === "taskPayload")?.canonical,
    `{${binding},"scopeKeys":["unit"],"taskRevision":1}`);
  assert.equal(vectors.find(v => v.name === "snapshotPayload")?.canonical,
    `{${binding},"priceVersion":"price-v1","quoteId":"quote","reserved":7,"responsibility":"platform"}`);
});

test("row vectors include every current SQL column except their explicit self-accounting field", () => {
  const sql = readFileSync(new URL("../../../docs/sql-drafts/evidence-source-d1b.sql", import.meta.url), "utf8");
  const mappings: [string, string, string | null][] = [
    ["collection", "collectionBase", "package_bytes"], ["source_version", "taskSource", null],
    ["source_version", "snapshotSource", null], ["task_source_link", "taskLink", null],
    ["snapshot_source_link", "snapshotLink", null], ["ingest_receipt", "receiptBase", "accounted_bytes"],
    ["receipt_source_member", "member0", null], ["receipt_source_member", "member1", null],
  ];
  for (const [table, name, excluded] of mappings) {
    const body = sql.split(`create table source_ingest_d1b_fixture_v1.${table} (`)[1]?.split("\n);")[0];
    assert.ok(body, `missing table ${table}`);
    // Static draft check only, not a SQL parser/catalog proof. Match declared supported column types.
    const declared = [...body.matchAll(/\b([a-z_]+)\s+(?:source_ingest_d1b_fixture_v1\.(?:identifier|fingerprint|safe_positive)|text\b|bigint\b|integer\b|jsonb\b|bytea\b|timestamptz\b)/g)].map(m => m[1]!);
    const added = [...sql.matchAll(new RegExp(`alter table source_ingest_d1b_fixture_v1\\.${table} add column ([a-z_]+)`, "g"))].map(m => m[1]!);
    const vector = buildInitializeVectors().vectors.find(v => v.name === name);
    assert.ok(vector);
    assert.deepEqual(Object.keys(JSON.parse(vector.canonical)).sort(), [...declared, ...added].filter(k => k !== excluded).sort(), table);
  }
});

test("fixed canonical codec keeps Unicode distinctions, escapes and safe-integer decimal spelling", () => {
  assert.equal(canonicalEvidenceValue({ z: "中文😀", a: '\"\\\n\t\u0001/' }), '{"a":"\\\"\\\\\\n\\t\\u0001/","z":"中文😀"}');
  assert.notEqual(canonicalEvidenceValue("é"), canonicalEvidenceValue("e\u0301"));
  assert.equal(canonicalEvidenceValue([9007199254740991, -0, true, null]), "[9007199254740991,0,true,null]");
});
