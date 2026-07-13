import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const marketplace = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));

assert.equal(typeof manifest.repository, "string", "plugin repository must be a URL string");
assert.equal("bugs" in manifest, false, "plugin manifest must not contain unsupported npm fields");
assert.equal(marketplace.plugins[0].version, manifest.version, "marketplace and plugin versions must match");

console.log("PASS: Claude plugin manifest uses the supported schema.");
