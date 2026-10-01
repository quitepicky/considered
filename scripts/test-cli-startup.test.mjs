import assert from "node:assert/strict";
import test from "node:test";
import { expectExit, probe } from "./test-cli-startup.mjs";

test("captures expected nonzero CLI usage exits, with a timeout and without a shell", () => {
  const result = probe("considered.exe", [], "fixture", (file, args, options) => {
    assert.equal(file, "considered.exe");
    assert.deepEqual(args, []);
    assert.equal(options.cwd, "fixture");
    assert.equal(options.timeout, 30_000);
    assert.equal(options.shell, undefined);
    return { status: 2, signal: null, stdout: "", stderr: "usage" };
  });
  expectExit(result, 2);
  assert.equal(result.stderr, "usage");
  assert.throws(() => expectExit(result, 0));
});

test("missing executable and timeout cannot masquerade as a usage exit", () => {
  for (const error of ["ENOENT", "ETIMEDOUT"]) {
    const result = probe("missing.exe", [], ".", () => ({ status: null, signal: null, error: new Error(error) }));
    assert.throws(() => expectExit(result, 2), /Could not execute/);
  }
  assert.throws(() => expectExit({ error: null, signal: "SIGTERM", exitCode: 2 }, 2), /Process terminated/);
});
