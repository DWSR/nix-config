import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const shopifyPi = fs.readFileSync(
  path.join(repoRoot, "configurations/shopify/home-manager/pi.nix"),
  "utf8",
);
const shopifyDefault = fs.readFileSync(
  path.join(repoRoot, "configurations/shopify/default.nix"),
  "utf8",
);

test("Shopify Pi wires only the Aquifer extension with the requested defaults", () => {
  assert.match(shopifyDefault, /shop-pi-fy\.git/);
  assert.match(shopifyDefault, /39d16f0e53b7c3e38699b5f33e95bd2c21f40d02/);
  assert.match(shopifyPi, /scripts\/pi-aquifer\.nix/);
  assert.match(shopifyPi, /extensions = \[/);
  assert.match(shopifyPi, /\$\{aquifer\}\/index\.ts/);
  assert.doesNotMatch(shopifyPi, /shop-pi-fy.*index\.ts/);
  assert.match(shopifyPi, /gateway = "https:\/\/aquifer\.shopify\.io"/);
  assert.match(shopifyPi, /profile = "riverbed"/);
});
