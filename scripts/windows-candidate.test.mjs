import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkManifests, compareCandidates, readCandidate, verifyUploadedArchives } from "./windows-candidate.mjs";

const tag = "v1.2.3";
const bytes = Buffer.from("candidate ZIP fixture");
const hash = createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const identity = "PackageIdentifier: QuitePicky.Considered\nPackageVersion: 1.2.3\n";
  const manifests = {
    "QuitePicky.Considered.yaml": `${identity}ManifestType: version\nManifestVersion: 1.12.0\n`,
    "QuitePicky.Considered.locale.en-US.yaml": `${identity}ManifestType: defaultLocale\nManifestVersion: 1.12.0\n`,
    "QuitePicky.Considered.installer.yaml": `${identity}InstallerType: zip\nReleaseDate: "2026-09-12"\nInstallers:\n` +
      ["amd64", "arm64"].map((arch) => {
        const stem = `considered_${tag}_windows_${arch}`;
        return `  - Architecture: ${arch === "amd64" ? "x64" : "arm64"}\n` +
          "    NestedInstallerType: portable\n    NestedInstallerFiles:\n" +
          ["considered", "considered-scc"].map((command) =>
            `      - RelativeFilePath: ${stem}\\${command}.exe\n        PortableCommandAlias: ${command}\n`).join("") +
          `    InstallerUrl: https://github.com/quitepicky/considered/releases/download/${tag}/${stem}.zip\n` +
          `    InstallerSha256: ${hash}\n`;
      }).join("") + "ManifestType: installer\nManifestVersion: 1.12.0\n",
  };
  return { tag, manifests, archives: checkManifests(manifests, tag) };
}

test("requires both architectures, two aliases, schema identity and original release URLs", () => {
  const { manifests } = fixture();
  assert.deepEqual(checkManifests(manifests, tag).map((a) => a.arch), ["amd64", "arm64"]);
  for (const [from, to] of [
    ["Architecture: arm64", "Architecture: x64"], ["PortableCommandAlias: considered-scc", "PortableCommandAlias: scc"],
    ["considered.exe", "wrong.exe"], ["releases/download/v1.2.3", "releases/download/v9.9.9"],
    ["ManifestVersion: 1.12.0", "ManifestVersion: 1.1.0"], ["PackageVersion: 1.2.3", "PackageVersion: 1.2.4"],
    ["NestedInstallerType: portable", "NestedInstallerType: exe"],
  ]) {
    const changed = structuredClone(manifests);
    changed["QuitePicky.Considered.installer.yaml"] = changed["QuitePicky.Considered.installer.yaml"].replace(from, to);
    assert.throws(() => checkManifests(changed, tag));
  }
  assert.throws(() => checkManifests({}, tag));
  assert.throws(() => checkManifests(manifests, "not-a-tag"));
});

test("publication must match tested archives and manifests; only ReleaseDate may differ", () => {
  const expected = fixture();
  const actual = structuredClone(expected);
  actual.manifests["QuitePicky.Considered.installer.yaml"] =
    actual.manifests["QuitePicky.Considered.installer.yaml"].replace("2026-09-12", "2026-09-13");
  compareCandidates(expected, actual);
  actual.archives[0].sha256 = "0".repeat(64);
  assert.throws(() => compareCandidates(expected, actual), /archives differ/);
  actual.archives = structuredClone(expected.archives);
  actual.manifests["QuitePicky.Considered.yaml"] += "ExtraField: changed\n";
  assert.throws(() => compareCandidates(expected, actual), /manifest differs/);
});

test("checks both actual uploaded draft-asset digests, not just the local build", async () => {
  const candidate = fixture();
  const release = { tag_name: tag, draft: true, assets: candidate.archives.map((a) => ({
    name: a.name, state: "uploaded", digest: `sha256:${a.sha256}`,
  })) };
  await verifyUploadedArchives(candidate, async () => release);
  release.assets[1].digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(() => verifyUploadedArchives(candidate, async () => release), /Uploaded Windows archive differs/);
  release.draft = false;
  await assert.rejects(() => verifyUploadedArchives(candidate, async () => release), /unpublished draft/);
});

test("rejects missing/extra manifests and mismatched archive bytes or checksum files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "considered-candidate-test-"));
  try {
    const candidate = fixture();
    await mkdir(join(dir, "winget"));
    for (const [name, text] of Object.entries(candidate.manifests)) await writeFile(join(dir, "winget", name), text);
    for (const archive of candidate.archives) await writeFile(join(dir, archive.name), bytes);
    const checksums = candidate.archives.map((a) => `${a.sha256}  ${a.name}\n`).join("");
    await writeFile(join(dir, "checksums.txt"), checksums);
    assert.deepEqual(await readCandidate(dir, tag), candidate);
    await writeFile(join(dir, candidate.archives[0].name), "tampered");
    await assert.rejects(() => readCandidate(dir, tag), /checksum mismatch/);
    await writeFile(join(dir, candidate.archives[0].name), bytes);
    await writeFile(join(dir, "checksums.txt"), "");
    await assert.rejects(() => readCandidate(dir, tag), /checksum mismatch/);
    await writeFile(join(dir, "winget", "QuitePicky.Considered.extra.yaml"), "extra");
    await assert.rejects(() => readCandidate(dir, tag), /exactly one/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CI and every release use the Windows gate; publication has no bypass condition", async () => {
  const workflow = (name) => process.env.PUBLICATION_WORKFLOW_DIRECTORY
    ? join(process.env.PUBLICATION_WORKFLOW_DIRECTORY, name) : new URL(`../.github/workflows/${name}`, import.meta.url);
  const release = await readFile(workflow("release.yml"), "utf8");
  const ci = await readFile(workflow("ci.yml"), "utf8");
  const gate = await readFile(workflow("windows-package.yml"), "utf8");
  assert.match(ci, /uses: \.\/\.github\/workflows\/windows-package.yml/);
  assert.match(release, /  release:\n    needs: windows-package\n/);
  assert.match(release, /TESTED_SHA: \$\{\{ needs.windows-package.outputs.source-sha }}/);
  const publishJob = release.split("  release:\n")[1].split("  report-failure:")[0];
  assert.doesNotMatch(publishJob, /if:|continue-on-error:/);
  assert.ok(publishJob.indexOf("verify dist") < publishJob.indexOf("--draft=false"));
  assert.match(gate, /args: release --clean --skip=publish/);
  assert.match(gate, /runner: windows-2025/);
  assert.match(gate, /runner: windows-11-arm/);
  assert.doesNotMatch(gate, /continue-on-error:|secrets\./);
});
