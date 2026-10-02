import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { synchronizeChecklist } from "./winget-checklist.mjs";

const [candidateDirectory, evidenceDirectory] = process.argv.slice(2);
assert.ok(candidateDirectory && evidenceDirectory, "Expected candidate and evidence directories");
assert.equal(process.env.GITHUB_REPOSITORY, "quitepicky/considered");
assert.equal(process.env.GITHUB_WORKFLOW, "Release");
const context = { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
assert.match(context.runId, /^\d+$/);
assert.match(context.attempt, /^\d+$/);
const readJSON = async (path) => JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
const candidate = await readJSON(join(candidateDirectory, "candidate.json"));
assert.equal(candidate.tag, process.env.RELEASE_TAG);
const results = await Promise.all(["amd64", "arm64"].map((arch) => readJSON(
  join(evidenceDirectory, `windows-evidence-${arch}-${context.attempt}`, "result.json"),
)));
async function request(path, method = "GET", body) {
  assert.ok(process.env.WINGET_TOKEN, "Missing WINGET_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { authorization: `Bearer ${process.env.WINGET_TOKEN}`, accept: "application/vnd.github+json",
      "content-type": "application/json", "X-GitHub-Api-Version": "2026-03-10" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}`);
  return response.json();
}
console.log(JSON.stringify(await synchronizeChecklist(candidate, results, context, request)));
