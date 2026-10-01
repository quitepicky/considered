import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkManifests } from "./windows-candidate.mjs";
import { synchronizeChecklist, updateBody, validateEvidence } from "./winget-checklist.mjs";

const template = ["## Description", "Human commentary that must survive.", "",
  "- [ ] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)",
  "- [ ] Linked to an issue (if applicable)", "  - Resolves #[Issue Number]",
  "- [ ] Checked that there aren't other open pull requests for the same manifest update/change",
  "- [ ] This PR only modifies one (1) manifest",
  "- [ ] Validated manifest locally with `winget validate --manifest <path>` (validation guide)",
  "- [ ] Tested manifest locally with `winget install --manifest <path>`",
  "- [ ] Manifest conforms to the 1.12 schema", "", "Footer"].join("\n");
const context = { runId: "123", attempt: "2" };

function fixture() {
  const tag = "v1.2.3";
  const identity = "PackageIdentifier: QuitePicky.Considered\nPackageVersion: 1.2.3\n";
  const manifests = {
    "QuitePicky.Considered.yaml": `${identity}ManifestType: version\nManifestVersion: 1.12.0\n`,
    "QuitePicky.Considered.locale.en-US.yaml": `${identity}ManifestType: defaultLocale\nManifestVersion: 1.12.0\n`,
    "QuitePicky.Considered.installer.yaml": `${identity}Installers:\n` + ["amd64", "arm64"].map((arch) => {
      const stem = `considered_${tag}_windows_${arch}`;
      return `  - Architecture: ${arch === "amd64" ? "x64" : arch}\n` +
        "    NestedInstallerType: portable\n    NestedInstallerFiles:\n" +
        ["considered", "considered-scc"].map((name) =>
          `      - RelativeFilePath: ${stem}\\${name}.exe\n        PortableCommandAlias: ${name}\n`).join("") +
        `    InstallerUrl: https://github.com/quitepicky/considered/releases/download/${tag}/${stem}.zip\n` +
        `    InstallerSha256: ${"a".repeat(64)}\n`;
    }).join("") + "ManifestType: installer\nManifestVersion: 1.12.0\n",
  };
  const candidate = { tag, manifests, archives: checkManifests(manifests, tag) };
  const results = ["amd64", "arm64"].map((architecture) => ({ architecture, tag, result: "passed",
    originalManifestValidated: true, installationTransport: "loopback", archives: structuredClone(candidate.archives) }));
  return { candidate, results };
}

function service(candidate, options = {}) {
  const prefix = "manifests/q/QuitePicky/Considered/1.2.3/";
  const pull = { number: 42, state: "open", changed_files: 3, body: options.body ?? template,
    head: { sha: "b".repeat(40), ref: "considered-1.2.3", repo: { full_name: "quitepicky/winget-pkgs" } },
    base: { repo: { full_name: "microsoft/winget-pkgs" } } };
  const writes = [];
  let reads = 0;
  const request = async (path, method = "GET", payload) => {
    if (method === "PATCH") { writes.push({ path, payload }); return {}; }
    if (path.includes("/pulls?")) return [structuredClone(pull)];
    if (path.endsWith("/pulls/42")) {
      reads++;
      return { ...structuredClone(pull), ...(reads > 1 ? options.fresh : {}) };
    }
    if (path.includes("/pulls/42/files")) return options.files ?? Object.keys(candidate.manifests).map((name) => ({
      filename: prefix + name, status: "added",
    }));
    if (path.includes("/contents/")) {
      const name = path.split("?")[0].split("/").at(-1);
      const text = candidate.manifests[name] + (options.modifiedManifest ? "Extra: changed\n" : "");
      return { encoding: "base64", content: Buffer.from(text).toString("base64") };
    }
    if (path.includes("/search/issues")) return options.search ?? {
      incomplete_results: false, total_count: 1, items: [{ number: 42 }],
    };
    if (path.includes("check-runs")) return { check_runs: [{ name: "license/cla", conclusion: options.cla ?? "success" }] };
    if (path.endsWith("/pulls/99")) return { changed_files: 1 };
    if (path.includes("/pulls/99/files")) return [{ filename: options.otherPath ?? prefix + "QuitePicky.Considered.yaml" }];
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { request, writes };
}

test("matches both native success records, tag and archive hashes", () => {
  const { candidate, results } = fixture();
  validateEvidence(candidate, results);
  assert.throws(() => validateEvidence(candidate, results.slice(0, 1)));
  for (const change of [{ result: "failed" }, { tag: "v1.2.4" }, { architecture: "amd64" },
    { originalManifestValidated: false }, { installationTransport: "unknown" }, { archives: [] }]) {
    const changed = structuredClone(results);
    Object.assign(changed[1], change);
    assert.throws(() => validateEvidence(candidate, changed));
  }
});

test("checks six supported items, preserves wording and the issue placeholder, and is idempotent", () => {
  const { candidate, results } = fixture();
  const evidence = { ...context, tag: candidate.tag, head: "b".repeat(40), results, cla: true, noDuplicate: true };
  const body = updateBody(template, evidence);
  const beforeNotes = body.split("\n\n<!-- considered-windows-evidence -->")[0];
  assert.equal(beforeNotes.replaceAll("- [x]", "- [ ]"), template);
  assert.equal((body.match(/^- \[x\]/gm) ?? []).length, 6);
  assert.match(body, /- \[ \] Linked to an issue/);
  assert.match(body, /Mac \(macOS\)/);
  assert.match(body, /Installation used loopback URLs/);
  assert.equal(updateBody(body, evidence), body);
  assert.throws(() => updateBody(template.replace("Validated manifest locally", "Unrecognized template"), evidence));
  assert.throws(() => updateBody(template + "\n<!-- considered-windows-evidence -->", evidence));
});

test("synchronizes only after verifying submitted manifests and a fresh PR read", async () => {
  const { candidate, results } = fixture();
  const { request, writes } = service(candidate);
  const outcome = await synchronizeChecklist(candidate, results, context, request);
  assert.deepEqual(outcome, { number: 42, updated: true, cla: true, noDuplicate: true });
  assert.equal(writes.length, 1);
  const again = service(candidate, { body: writes[0].payload.body });
  assert.equal((await synchronizeChecklist(candidate, results, context, again.request)).updated, false);
  assert.equal(again.writes.length, 0);
});

test("fails closed without writes on changed head/body, mismatched manifests/files, and incomplete searches", async () => {
  const { candidate, results } = fixture();
  for (const options of [
    { fresh: { head: { sha: "c".repeat(40) } } }, { fresh: { body: "Maintainer edits" } },
    { fresh: { state: "closed" } }, { files: [] }, { modifiedManifest: true },
    { search: { incomplete_results: true, total_count: 1, items: [{ number: 42 }] } },
    { search: { incomplete_results: false, total_count: 101, items: [{ number: 42 }] } },
  ]) {
    const { request, writes } = service(candidate, options);
    await assert.rejects(() => synchronizeChecklist(candidate, results, context, request));
    assert.equal(writes.length, 0);
  }
});

test("pending CLA, delayed search indexing and genuine duplicates do not get new checkmarks", async () => {
  const { candidate, results } = fixture();
  for (const search of [
    { incomplete_results: false, total_count: 0, items: [] },
    { incomplete_results: false, total_count: 2, items: [{ number: 42 }, { number: 99 }] },
  ]) {
    const { request, writes } = service(candidate, { search, cla: null });
    // Supply a non-success conclusion explicitly (null uses the fixture default).
    const wrapped = (path, ...args) => path.includes("check-runs")
      ? { check_runs: [{ name: "license/cla", conclusion: null }] } : request(path, ...args);
    const result = await synchronizeChecklist(candidate, results, context, wrapped);
    assert.equal(result.cla, false);
    assert.equal(result.noDuplicate, false);
    assert.equal((writes[0].payload.body.match(/^- \[x\]/gm) ?? []).length, 4);
  }
});

test("older versions in search results are not duplicate updates", async () => {
  const { candidate, results } = fixture();
  const { request } = service(candidate, {
    search: { incomplete_results: false, total_count: 2, items: [{ number: 42 }, { number: 99 }] },
    otherPath: "manifests/q/QuitePicky/Considered/1.2.2/QuitePicky.Considered.yaml",
  });
  assert.equal((await synchronizeChecklist(candidate, results, context, request)).noDuplicate, true);
});

test("workflow runs checklist only after candidate equality and before exposing the draft", async () => {
  const path = process.env.PUBLICATION_WORKFLOW_DIRECTORY
    ? join(process.env.PUBLICATION_WORKFLOW_DIRECTORY, "release.yml") : new URL("../.github/workflows/release.yml", import.meta.url);
  const workflow = await readFile(path, "utf8");
  const update = workflow.indexOf("update-winget-checklist.mjs");
  assert.ok(update > workflow.indexOf("verify dist"));
  assert.ok(update < workflow.indexOf("--draft=false"));
  assert.match(workflow, /pattern: windows-evidence-\*-\$\{\{ github.run_attempt }}/);
});
