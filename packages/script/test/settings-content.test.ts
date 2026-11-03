import assert from "node:assert/strict";
import test from "node:test";
import { validateSettingAsset } from "../src/settings-content.ts";
const asset = { id: "character-1",assetType: "character",name: "少年",visibleDefinition: { clothing: "青衣" },state: "常态",stateChanges: [],restrictions: ["不改变身份"],provenance: [{ type: "source_fragment",sourceVersionId: "source",fragmentId: "fragment",transformation: "visualized" }] };
test("setting assets retain canonical fields and reject unauthorized evidence or malformed values",() => {
  const context = { sourceVersionId: "source",fragmentIds: ["fragment"],approvedAdditionIds: [] };
  assert.deepEqual(validateSettingAsset(asset,context),asset);
  assert.equal(validateSettingAsset({ ...asset,visibleDefinition: {} },context),null);
  assert.equal(validateSettingAsset({ ...asset,assetType: "image" },context),null);
  assert.equal(validateSettingAsset({ ...asset,provenance: [{ ...asset.provenance[0],fragmentId: "other" }] },context),null);
  assert.equal(validateSettingAsset({ ...asset,provenance: [{ type: "approved_addition",additionId: "unapproved" }] },context),null);
  assert.equal(validateSettingAsset({ ...asset,apiKey: "must-not-be-accepted" },context),null);
});

import { validateSettingsResponse } from "../src/settings-content.ts";
test("settings response binds task/upstream identity and quarantines invalid items while preserving valid assets",() => {
  const identity = { jobId: "job",projectId: "p",chapterId: "c",sourceVersionId: "source",upstreamConfirmedVersionIds: ["formal-script"] };
  const context = { sourceVersionId: "source",fragmentIds: ["fragment"],approvedAdditionIds: [] };
  const response = { contractVersion: "0.1.0",stage: "settings",...identity,status: "succeeded",items: [{ scopeKey: "character",status: "succeeded",value: asset },{ scopeKey: "location",status: "succeeded",value: { ...asset,id: "location",provenance: [] } }] };
  const result = validateSettingsResponse(response,identity,context);
  assert.equal(result.generationStatus,"partially_succeeded");assert.deepEqual(result.assets,[asset]);assert.deepEqual(result.failures,[{ scopeKey: "location",code: "INVALID_ASSET",retryable: true }]);
  assert.throws(() => validateSettingsResponse({ ...response,jobId: "other" },identity,context),{ code: "INVALID_RESPONSE" });
  assert.throws(() => validateSettingsResponse({ ...response,upstreamConfirmedVersionIds: ["candidate"] },identity,context),{ code: "INVALID_RESPONSE" });
  assert.throws(() => validateSettingsResponse({ ...response,items: [response.items[0],response.items[0]] },identity,context),{ code: "INVALID_RESPONSE" });
});
