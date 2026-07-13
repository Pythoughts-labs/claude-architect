import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const marketplace = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

assert.equal(typeof manifest.repository, "string", "plugin repository must be a URL string");
assert.equal("bugs" in manifest, false, "plugin manifest must not contain unsupported npm fields");
assert.equal(marketplace.plugins[0].version, manifest.version, "marketplace and plugin versions must match");
assert.ok(readme.includes(`badge/version-${manifest.version}-`), "README badge must match the plugin version");
assert.ok(changelog.includes(`## [${manifest.version}] -`), "changelog must contain the plugin version");

console.log("PASS: Claude plugin manifest uses the supported schema.");
