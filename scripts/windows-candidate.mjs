import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { github, releaseForTag } from "./verify-publication.mjs";

const suffixes = ["yaml", "installer.yaml", "locale.en-US.yaml"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function checkManifests(manifests, tag) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) throw new Error("Invalid candidate tag");
  for (const suffix of suffixes) {
    const text = manifests[`QuitePicky.Considered.${suffix}`];
    if (!text?.includes(`PackageIdentifier: QuitePicky.Considered\n`) ||
        !text.includes(`PackageVersion: ${tag.slice(1)}\n`) ||
        !text.includes("ManifestVersion: 1.12.0")) throw new Error("Manifest identity/schema mismatch");
  }
  const installer = manifests["QuitePicky.Considered.installer.yaml"];
  const blocks = [...installer.matchAll(/^  - Architecture: (\S+)\n([\s\S]*?)(?=^  - Architecture:|^ManifestType:)/gm)];
  if (blocks.length !== 2) throw new Error("Expected two Windows architectures");
  return ["amd64", "arm64"].map((arch) => {
    const architecture = arch === "amd64" ? "x64" : "arm64";
    const block = blocks.find((match) => match[1] === architecture)?.[2];
    if (!block) throw new Error(`Missing ${architecture}`);
    const stem = `considered_${tag}_windows_${arch}`;
    const name = `${stem}.zip`;
    const url = `https://github.com/quitepicky/considered/releases/download/${tag}/${name}`;
    const urls = [...block.matchAll(/^\s+InstallerUrl: (.+)$/gm)];
    const hashes = [...block.matchAll(/^\s+InstallerSha256: ([a-fA-F0-9]{64})$/gm)];
    if (urls.length !== 1 || urls[0][1] !== url || hashes.length !== 1) throw new Error("Installer URL/hash mismatch");
    const nested = [...block.matchAll(/^\s+- RelativeFilePath: (.+)\n\s+PortableCommandAlias: (.+)$/gm)];
    if (nested.length !== 2 || !block.includes("NestedInstallerType: portable")) throw new Error("Expected portable pair");
    for (const command of ["considered", "considered-scc"]) {
      if (!nested.some(([, path, alias]) => path === `${stem}\\${command}.exe` && alias === command)) {
        throw new Error(`Missing installed alias/path for ${command}`);
      }
    }
    return { arch, name, url, sha256: hashes[0][1].toLowerCase() };
  });
}

async function manifestFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await manifestFiles(path));
    else if (/^QuitePicky\.Considered\..*yaml$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function readCandidate(dist, tag) {
  const paths = await manifestFiles(dist);
  if (paths.length !== 3) throw new Error("Expected exactly one three-file manifest set");
  const manifests = Object.fromEntries(await Promise.all(paths.map(async (path) => [
    basename(path), (await readFile(path, "utf8")).replaceAll("\r\n", "\n"),
  ])));
  const archives = checkManifests(manifests, tag);
  const checksums = await readFile(join(dist, "checksums.txt"), "utf8");
  for (const archive of archives) {
    const hash = digest(await readFile(join(dist, archive.name)));
    if (hash !== archive.sha256 || !checksums.split(/\r?\n/).some((line) =>
      line.trim().split(/\s+/).join(" ") === `${hash} ${archive.name}`)) throw new Error("Archive checksum mismatch");
  }
  return { tag, manifests, archives };
}

export function compareCandidates(expected, actual) {
  if (expected.tag !== actual.tag || JSON.stringify(expected.archives) !== JSON.stringify(actual.archives)) {
    throw new Error("Windows release archives differ from the tested candidate");
  }
  for (const suffix of suffixes) {
    const name = `QuitePicky.Considered.${suffix}`;
    // GoReleaser uses the build date here; a run may cross UTC midnight.
    const normalize = (text) => text.replace(/^ReleaseDate: .*\n/gm, "");
    if (normalize(expected.manifests[name]) !== normalize(actual.manifests[name])) {
      throw new Error(`Release manifest differs from tested candidate: ${name}`);
    }
  }
}

export async function verifyUploadedArchives(candidate, request = github) {
  const release = await releaseForTag(candidate.tag, request);
  if (release.tag_name !== candidate.tag || !release.draft) throw new Error("Expected an unpublished draft");
  for (const archive of candidate.archives) {
    const uploaded = release.assets?.find((asset) => asset.name === archive.name);
    if (uploaded?.state !== "uploaded" || uploaded.digest !== `sha256:${archive.sha256}`) {
      throw new Error(`Uploaded Windows archive differs from tested candidate: ${archive.name}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, dist, target, tag] = process.argv.slice(2);
  if (mode === "prepare") {
    const candidate = await readCandidate(dist, tag);
    await mkdir(join(target, "manifest"), { recursive: true });
    for (const [name, text] of Object.entries(candidate.manifests)) await writeFile(join(target, "manifest", name), text);
    for (const archive of candidate.archives) await cp(join(dist, archive.name), join(target, archive.name));
    await writeFile(join(target, "candidate.json"), JSON.stringify(candidate, null, 2));
  } else if (mode === "verify") {
    const candidate = JSON.parse(await readFile(join(target, "candidate.json"), "utf8"));
    compareCandidates(candidate, await readCandidate(dist, tag));
    await verifyUploadedArchives(candidate);
    console.log("Published Windows artifacts match the tested candidate byte for byte.");
  } else throw new Error("Expected prepare or verify");
}
