import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Loopback only: WinGet cannot download a not-yet-published GitHub release.
// Serve only the two known ZIPs, retaining WinGet's original SHA256 checks.
const [root, readyFile] = process.argv.slice(2);
const candidate = JSON.parse(await readFile(join(root, "candidate.json"), "utf8"));
const names = new Set(candidate.archives.map((archive) => `/${archive.name}`));
const server = createServer(async (request, response) => {
  if (!names.has(request.url) || !["GET", "HEAD"].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const path = join(root, request.url.slice(1));
    const { size } = await stat(path);
    response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": size });
    if (request.method === "HEAD") response.end();
    else createReadStream(path).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(500).end();
  }
});
server.listen(0, "127.0.0.1", async () => {
  await writeFile(`${readyFile}.tmp`, `http://127.0.0.1:${server.address().port}`);
  await rename(`${readyFile}.tmp`, readyFile);
});
