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
