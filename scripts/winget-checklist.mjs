import assert from "node:assert/strict";
import { compareCandidates, checkManifests } from "./windows-candidate.mjs";

const repo = "/repos/microsoft/winget-pkgs";
const marker = "<!-- considered-windows-evidence -->";
const endMarker = "<!-- /considered-windows-evidence -->";

export function validateEvidence(candidate, results) {
  assert.deepEqual(candidate.archives, checkManifests(candidate.manifests, candidate.tag));
  assert.equal(results.length, 2, "Both native Windows results are required");
  for (const architecture of ["amd64", "arm64"]) {
    const result = results.find((item) => item.architecture === architecture);
    assert.ok(result, `Missing ${architecture} result`);
    assert.equal(result.result, "passed");
    assert.equal(result.tag, candidate.tag);
    assert.equal(result.originalManifestValidated, true);
    assert.ok(["loopback", "published-https"].includes(result.installationTransport));
    assert.deepEqual(result.archives, candidate.archives, "Evidence archive hashes differ from candidate");
  }
}

export function updateBody(body, { tag, head, runId, attempt, results, cla, noDuplicate }) {
  assert.equal(typeof body, "string");
  assert.match(head, /^[a-f0-9]{40}$/);
  assert.match(runId, /^\d+$/);
  assert.match(attempt, /^\d+$/);
  const required = ["This PR only modifies one (1) manifest", "Validated manifest locally with ",
    "Tested manifest locally with ", "Manifest conforms to the "];
  if (cla) required.push("Signed the ");
  if (noDuplicate) required.push("Checked that there aren't other open ");
  for (const prefix of required) {
    const lines = body.split("\n");
    const matches = lines.flatMap((line, index) => /^- \[[ x]\] /.test(line) && line.slice(6).startsWith(prefix) ? [index] : []);
    assert.equal(matches.length, 1, `Unrecognized or duplicate checklist item: ${prefix}`);
    const index = matches[0];
    lines[index] = lines[index].replace("- [ ] ", "- [x] ");
    body = lines.join("\n");
  }
  const transport = results.every((item) => item.installationTransport === "published-https")
    ? "Installation used the original public HTTPS URLs."
    : "Installation used loopback URLs serving the exact candidate archives; hashes and nested paths were unchanged. " +
      "This does not claim the public download URLs were tested by these jobs.";
  const notes = [marker, `## Automated Windows validation evidence for ${tag}`, "",
    "We develop on a Mac (macOS). Here, local validation and installation mean local manifest files tested on " +
      "native Windows x64 and ARM64 GitHub Actions runners controlled by this repository, not our Mac.", "",
    `- [Windows package gate](https://github.com/quitepicky/considered/actions/runs/${runId}/attempts/${attempt}) passed ` +
      "on both architectures; its per-architecture artifacts contain the command logs and success records.",
    `- Evidence matches submitted manifest head \`${head}\`, one package/version manifest set, schema 1.12.0, ` +
      "and both archive SHA256 values. Only GoReleaser's build-date field may differ from the tested manifest.",
    "- The gate validated original manifests, installed them, verified registration/version and both aliases, " +
      "ran real provider collection, listed the package, and uninstalled it. " + transport,
    "- No-argument exit status 2 is expected CLI usage behavior, not a missing-file assertion. " +
      "Version/help and provider collection must succeed. This is not a comprehensive Defender assessment.",
    cla ? "- Microsoft's CLA check passes for this submission head." :
      "- The CLA checkbox was not changed: a successful CLA check on this head was not yet observed.",
    noDuplicate ? "- An open-PR search found no other submission modifying this package/version's manifest directory." :
      "- Duplicate-search checkbox unchanged: uniqueness was not established (another submission or delayed search indexing).",
    "- Issue-link assertions are left for the submitter; this automation does not invent an associated issue.", endMarker].join("\n");
  if (body.includes(marker) || body.includes(endMarker)) {
    assert.equal(body.split(marker).length, 2, "Ambiguous evidence block");
    assert.equal(body.split(endMarker).length, 2, "Ambiguous evidence block");
    const start = body.indexOf(marker);
    const end = body.indexOf(endMarker);
    assert.ok(end > start, "Malformed evidence block");
    return body.slice(0, start) + notes + body.slice(end + endMarker.length);
  }
  return body + "\n\n" + notes + "\n";
}

export async function synchronizeChecklist(candidate, results, context, request) {
  validateEvidence(candidate, results);
  if (candidate.tag.includes("-")) return { skipped: "Prereleases do not submit to WinGet" };
  const version = candidate.tag.slice(1);
  const prefix = `manifests/q/QuitePicky/Considered/${version}/`;
  const pulls = await request(`${repo}/pulls?head=quitepicky:considered-${version}&base=master&state=open&per_page=100`);
  const matches = pulls.filter((pr) => pr.head?.repo?.full_name === "quitepicky/winget-pkgs" &&
    pr.head.ref === `considered-${version}` && pr.base?.repo?.full_name === "microsoft/winget-pkgs");
  assert.equal(matches.length, 1, "Expected one open release submission");
  const pull = await request(`${repo}/pulls/${matches[0].number}`);
  assert.equal(pull.state, "open");
  assert.equal(pull.changed_files, 3, "Expected exactly three changed files");
  const files = await request(`${repo}/pulls/${pull.number}/files?per_page=100`);
  const names = Object.keys(candidate.manifests);
  assert.equal(files.length, 3, "Expected exactly three manifest files");
  assert.deepEqual(files.map((file) => file.filename).sort(), names.map((name) => prefix + name).sort());
  assert.ok(files.every((file) => ["added", "modified"].includes(file.status)), "Unexpected manifest change type");
  const manifests = {};
  for (const name of names) {
    const file = await request(`/repos/quitepicky/winget-pkgs/contents/${prefix}${name}?ref=${pull.head.sha}`);
    assert.equal(file.encoding, "base64");
    manifests[name] = Buffer.from(file.content, "base64").toString("utf8").replaceAll("\r\n", "\n");
  }
  compareCandidates(candidate, { tag: candidate.tag, manifests, archives: checkManifests(manifests, candidate.tag) });
  const query = encodeURIComponent(`repo:microsoft/winget-pkgs is:pr is:open "QuitePicky.Considered" "${version}"`);
  const search = await request(`/search/issues?q=${query}&per_page=100`);
  assert.equal(search.incomplete_results, false, "Duplicate search was incomplete");
  assert.equal(search.total_count, search.items.length, "Duplicate search needs pagination");
  // Do not claim a complete search before GitHub has indexed even our own PR.
  let noDuplicate = search.items.some((item) => item.number === pull.number);
  for (const match of search.items.filter((item) => item.number !== pull.number)) {
    // All changed paths are needed before claiming that a search hit is unrelated.
    const other = await request(`${repo}/pulls/${match.number}`);
    assert.ok(other.changed_files <= 100, "Duplicate candidate needs paginated inspection");
    const changed = await request(`${repo}/pulls/${match.number}/files?per_page=100`);
    assert.equal(changed.length, other.changed_files);
    if (changed.some((file) => file.filename.startsWith(prefix))) noDuplicate = false;
  }
  const checks = await request(`${repo}/commits/${pull.head.sha}/check-runs?filter=latest&per_page=100`);
  const claChecks = checks.check_runs.filter((check) => check.name === "license/cla");
  const cla = claChecks.length > 0 && claChecks.every((check) => check.conclusion === "success");
  const body = updateBody(pull.body, { ...context, tag: candidate.tag, head: pull.head.sha, results, cla, noDuplicate });
  // Never overwrite a concurrent maintainer edit or attest to a different PR head.
  const fresh = await request(`${repo}/pulls/${pull.number}`);
  assert.equal(fresh.state, "open");
  assert.equal(fresh.head.sha, pull.head.sha, "Submission head changed during verification");
  assert.equal(fresh.body, pull.body, "Description changed during verification");
  if (body !== pull.body) await request(`${repo}/pulls/${pull.number}`, "PATCH", { body });
  return { number: pull.number, updated: body !== pull.body, cla, noDuplicate };
}
