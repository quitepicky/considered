import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function probe(executable, args, cwd, spawn = spawnSync) {
  const result = spawn(executable, args, { cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  return { executable, args, cwd, exitCode: result.status, signal: result.signal,
    error: result.error?.message ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function expectExit(result, expected) {
  assert.equal(result.error, null, `Could not execute: ${JSON.stringify(result)}`);
  assert.equal(result.signal, null, `Process terminated: ${JSON.stringify(result)}`);
  assert.equal(result.exitCode, expected, `Unexpected exit: ${JSON.stringify(result)}`);
}

export function testStartup(binaryDirectory, evidenceDirectory, tag) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const fixture = resolve(evidenceDirectory, "startup fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "example.go"), "package example\n\nfunc Example() {}\n");
  const results = [];
  function run(name, args, expected) {
    const result = probe(resolve(binaryDirectory, name + suffix), args, fixture);
    results.push(result);
    // Preserve the failing probe as well, before asserting anything.
    writeFileSync(join(evidenceDirectory, "cli-startup.json"), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(result));
    expectExit(result, expected);
    return result;
  }
  const cliUsage = run("considered", [], 2);
  assert.equal(cliUsage.stdout, "");
  assert.match(cliUsage.stderr, /^usage: considered <command> \[flags\]/);
  const providerUsage = run("considered-scc", [], 2);
  assert.equal(providerUsage.stdout, "");
  assert.equal(providerUsage.stderr.trim(), "--json is required");
  const version = run("considered", ["--version"], 0);
  assert.equal(version.stdout.trim(), tag);
  assert.equal(version.stderr, "");
  const help = run("considered", ["--help"], 0);
  assert.match(help.stdout, /^usage: considered/);
  assert.equal(help.stderr, "");
  const provider = run("considered-scc", ["--json", "--root", fixture], 0);
  assert.equal(provider.stderr, "");
  const payload = JSON.parse(provider.stdout);
  assert.equal(payload.metrics.length, 1);
  assert.equal(payload.metrics[0].subject, "example.go");
  assert.ok(payload.metrics[0].values["scc.code_lines"] > 0);
  writeFileSync(join(evidenceDirectory, "provider.json"), provider.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [binaryDirectory, evidenceDirectory, tag] = process.argv.slice(2);
  assert.ok(binaryDirectory && evidenceDirectory && tag, "Expected binary directory, evidence directory, and tag");
  testStartup(binaryDirectory, evidenceDirectory, tag);
}
