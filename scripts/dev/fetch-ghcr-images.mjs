// Fetch container images from ghcr.io with many parallel range requests (GitHub's CDN is throttled
// per connection on this network), write them as one OCI image layout, then `docker load` it.
// Usage: node fetch_ghcr_images.mjs <cacheDir> ghcr.io/<repo>:<tag> [...]
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, statSync, createReadStream, appendFileSync, rmSync, renameSync, writeFileSync, readFileSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const [cacheDir, ...refs] = process.argv.slice(2);
if (!cacheDir || refs.length === 0) { console.error("usage: node fetch_ghcr_images.mjs <cacheDir> <ref>..."); process.exit(2); }

const CONNECTIONS = 24;
const CHUNK = 4 * 1024 * 1024;
const layoutDir = join(cacheDir, "oci");
const blobDir = join(layoutDir, "blobs", "sha256");
const partDir = join(cacheDir, "parts");
mkdirSync(blobDir, { recursive: true });
mkdirSync(partDir, { recursive: true });

const ACCEPT_INDEX = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const ACCEPT_MANIFEST = "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";

function parseRef(ref) {
  const m = /^ghcr\.io\/(.+):([^:/]+)$/.exec(ref);
  if (!m) throw new Error(`not a ghcr.io/<repo>:<tag> ref: ${ref}`);
  return { repo: m[1], tag: m[2] };
}

async function token(repo) {
  const r = await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`);
  if (!r.ok) throw new Error(`token ${repo}: HTTP ${r.status}`);
  return (await r.json()).token;
}

async function getManifest(repo, reference, tok, accept) {
  const r = await fetch(`https://ghcr.io/v2/${repo}/manifests/${reference}`, { headers: { authorization: `Bearer ${tok}`, accept } });
  if (!r.ok) throw new Error(`manifest ${repo}@${reference}: HTTP ${r.status}`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return { bytes, mediaType: r.headers.get("content-type").split(";")[0], json: JSON.parse(bytes.toString("utf8")) };
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
function sha256File(path) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(path).on("data", (d) => h.update(d)).on("end", () => res(h.digest("hex"))).on("error", rej);
  });
}

// Signed CDN URL for a blob (refreshed when it expires).
async function blobUrl(repo, digest, tok) {
  const r = await fetch(`https://ghcr.io/v2/${repo}/blobs/${digest}`, { headers: { authorization: `Bearer ${tok}` }, redirect: "manual" });
  const loc = r.headers.get("location");
  if (r.status >= 300 && r.status < 400 && loc) return loc;
  if (r.ok) return `https://ghcr.io/v2/${repo}/blobs/${digest}`; // served directly
  throw new Error(`blob ${digest}: HTTP ${r.status}`);
}

let downloaded = 0;
let totalNeeded = 0;

async function fetchChunk(job) {
  // job: { blob, index, start, end, file }
  const want = job.end - job.start + 1;
  for (let attempt = 1; attempt <= 80; attempt++) {
    const have = existsSync(job.file) ? statSync(job.file).size : 0;
    if (have >= want) return;
    try {
      const url = await job.blob.url();
      const headers = { range: `bytes=${job.start + have}-${job.end}` };
      if (url.startsWith("https://ghcr.io/")) headers.authorization = `Bearer ${job.blob.tok}`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 300_000);
      const r = await fetch(url, { headers, signal: ctl.signal });
      if (r.status === 403 || r.status === 401) { job.blob.expire(); clearTimeout(timer); continue; }
      if (r.status !== 206) { clearTimeout(timer); await new Promise((s) => setTimeout(s, 2000)); continue; }
      const reader = r.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          appendFileSync(job.file, value);
          downloaded += value.length;
        }
      } finally { clearTimeout(timer); }
    } catch {
      await new Promise((s) => setTimeout(s, 2000));
    }
  }
  throw new Error(`chunk ${job.index} of ${job.blob.digest} kept failing`);
}

async function run() {
  const images = [];
  const blobs = new Map(); // digest -> { repo, tok, size, digest }
  for (const ref of refs) {
    const { repo, tag } = parseRef(ref);
    const tok = await token(repo);
    let top = await getManifest(repo, tag, tok, ACCEPT_INDEX);
    if (top.json.manifests) {
      const m = top.json.manifests.find((x) => x.platform?.os === "linux" && x.platform?.architecture === "amd64");
      if (!m) throw new Error(`${ref}: no linux/amd64 manifest`);
      top = await getManifest(repo, m.digest, tok, ACCEPT_MANIFEST);
    }
    const manifestDigest = sha256(top.bytes);
    writeFileSync(join(blobDir, manifestDigest), top.bytes);
    images.push({ ref, tag, mediaType: top.mediaType, digest: `sha256:${manifestDigest}`, size: top.bytes.length });
    for (const d of [top.json.config, ...top.json.layers]) {
      if (!blobs.has(d.digest)) blobs.set(d.digest, { repo, tok, size: d.size, digest: d.digest });
    }
    console.log(`${ref}: ${top.json.layers.length} layers, ${(top.json.layers.reduce((a, l) => a + l.size, 0) / 1048576).toFixed(0)} MB`);
  }

  // Build chunk jobs for blobs not already cached and verified.
  const jobs = [];
  for (const b of blobs.values()) {
    const hex = b.digest.slice(7);
    const final = join(blobDir, hex);
    if (existsSync(final) && statSync(final).size === b.size) continue;
    let cached = null;
    b.expire = () => { cached = null; };
    b.url = async () => (cached ??= await blobUrl(b.repo, b.digest, b.tok));
    b.parts = [];
    for (let i = 0, start = 0; start < b.size; i++, start += CHUNK) {
      const end = Math.min(start + CHUNK, b.size) - 1;
      const file = join(partDir, `${hex}.${String(i).padStart(5, "0")}`);
      b.parts.push(file);
      jobs.push({ blob: b, index: i, start, end, file });
      totalNeeded += end - start + 1;
    }
  }
  for (const j of jobs) if (existsSync(j.file)) downloaded += statSync(j.file).size;
  console.log(`to download: ${(totalNeeded / 1048576).toFixed(0)} MB in ${jobs.length} chunks over ${CONNECTIONS} connections`);

  const progress = setInterval(() => {
    console.log(`${new Date().toISOString().slice(11, 19)} ${(downloaded / 1048576).toFixed(0)} / ${(totalNeeded / 1048576).toFixed(0)} MB`);
  }, 30_000);
  let next = 0;
  await Promise.all(Array.from({ length: CONNECTIONS }, async () => {
    while (next < jobs.length) await fetchChunk(jobs[next++]);
  }));
  clearInterval(progress);

  // Join and verify each blob.
  for (const b of blobs.values()) {
    if (!b.parts) continue;
    const hex = b.digest.slice(7);
    const tmp = join(cacheDir, `${hex}.joining`);
    const fd = openSync(tmp, "w"); closeSync(fd);
    for (const p of b.parts) appendFileSync(tmp, readFileSync(p));
    const got = await sha256File(tmp);
    if (got !== hex) throw new Error(`hash mismatch for ${b.digest}`);
    renameSync(tmp, join(blobDir, hex));
    for (const p of b.parts) rmSync(p);
  }

  writeFileSync(join(layoutDir, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(join(layoutDir, "index.json"), JSON.stringify({
    schemaVersion: 2,
    manifests: images.map((im) => ({
      mediaType: im.mediaType, digest: im.digest, size: im.size,
      annotations: { "io.containerd.image.name": im.ref, "org.opencontainers.image.ref.name": im.tag },
    })),
  }));
  const tarPath = join(cacheDir, "images.tar");
  execFileSync("tar", ["-cf", tarPath, "-C", layoutDir, "."], { stdio: "inherit" });
  console.log("verified all blobs; loading into Docker...");
  execFileSync("docker", ["load", "-i", tarPath], { stdio: "inherit" });
  console.log("IMAGES LOADED");
}

run().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
