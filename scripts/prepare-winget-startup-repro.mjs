// Immutable input from microsoft/winget-pkgs#433927. No release or upstream writes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkManifests } from "./windows-candidate.mjs";

const target = process.argv[2];
assert.ok(target, "Expected candidate output directory");
const tag = "v0.1.12";
const manifestCommit = "ba2fcb48b343914c0ce4424f5efe185815666781";
const base = `https://raw.githubusercontent.com/microsoft/winget-pkgs/${manifestCommit}`;
const directory = `${base}/manifests/q/QuitePicky/Considered/0.1.12`;
async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
await mkdir(join(target, "manifest"), { recursive: true });
const manifests = {};
for (const suffix of ["yaml", "installer.yaml", "locale.en-US.yaml"]) {
  const name = `QuitePicky.Considered.${suffix}`;
  manifests[name] = (await download(`${directory}/${name}`)).toString("utf8").replaceAll("\r\n", "\n");
  await writeFile(join(target, "manifest", name), manifests[name]);
}
const archives = checkManifests(manifests, tag);
for (const archive of archives) {
  const bytes = await download(archive.url);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), archive.sha256, "Released archive hash mismatch");
  await writeFile(join(target, archive.name), bytes);
}
await writeFile(join(target, "candidate.json"), JSON.stringify({ tag, manifestCommit, manifests, archives }, null, 2));
console.log(JSON.stringify({ tag, manifestCommit, archives }, null, 2));
