/**
 * Tiny zero-dependency dev server for the Maestro Run Viewer.
 * Serves viewer assets + exposes a manifest of all score/run files.
 *
 * Usage:  yarn tsx tools/maestro/serve.ts
 *         PORT=8080 yarn tsx tools/maestro/serve.ts
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, extname } from "node:path";

const PORT = Number(process.env.PORT) || 3000;

// ─── Paths ─────────────────────────────────────────────────────────
const ROOT = resolve(__dirname, "../..");
const VIEWER_DIR = __dirname;
const SCORES_DIR = resolve(ROOT, "tools/scores");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// ─── Manifest builder ─────────────────────────────────────────────
interface ManifestEntry {
  path: string;       // fetch URL relative to server root
  filename: string;
  category: "run" | "baseline" | "fixture";
  pattern?: string;   // subfolder name for runs
  timestamp?: string; // extracted from filename for runs
  prompt?: string;    // human-readable description from context
  outcome?: string;   // performance outcome
  beatCount?: number; // number of performed beats
}

async function dirExists(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

async function readRunMeta(filePath: string): Promise<{ prompt?: string; outcome?: string; beatCount?: number }> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw);
    const meta: { prompt?: string; outcome?: string; beatCount?: number } = {};
    if (data.performance) {
      meta.outcome = data.performance.outcome;
      meta.beatCount = data.performance.beats?.length;
    }
    const ctx = data.executableScore?.context;
    if (ctx) {
      const promptSrc = ctx.problem ?? ctx.target ?? ctx.scope ?? ctx.question;
      if (typeof promptSrc === "string") {
        meta.prompt = promptSrc;
      }
    }
    return meta;
  } catch {
    return {};
  }
}

async function buildManifest(): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];

  // Saved runs: tools/scores/store/<pattern>/*.json
  const storeDir = join(SCORES_DIR, "store");
  if (await dirExists(storeDir)) {
    const patterns = await readdir(storeDir);
    for (const pattern of patterns) {
      const patternDir = join(storeDir, pattern);
      if (!(await dirExists(patternDir))) { continue; }
      const files = await readdir(patternDir);
      for (const f of files) {
        if (!f.endsWith(".json")) { continue; }
        // Extract timestamp from filename: <hash>-<ISO-timestamp>.json
        // Filename encodes colons as dashes and dot as dash:
        //   2026-05-08T23-33-03-051Z → 2026-05-08T23:33:03.051Z
        const dashIdx = f.indexOf("-");
        const ts = dashIdx > 0
          ? f.slice(dashIdx + 1, -5).replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z")
          : undefined;

        const entry: ManifestEntry = {
          path: `/scores/store/${pattern}/${f}`,
          filename: f,
          category: "run",
          pattern,
          timestamp: ts,
        };

        const meta = await readRunMeta(join(patternDir, f));
        entry.prompt = meta.prompt;
        entry.outcome = meta.outcome;
        entry.beatCount = meta.beatCount;

        entries.push(entry);
      }
    }
  }

  // Baselines: tools/scores/baselines/*.json
  const baselinesDir = join(SCORES_DIR, "baselines");
  if (await dirExists(baselinesDir)) {
    const files = await readdir(baselinesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) { continue; }
      entries.push({
        path: `/scores/baselines/${f}`,
        filename: f,
        category: "baseline",
        pattern: f.replace(".json", ""),
      });
    }
  }

  // Fixtures: tools/scores/fixtures/*.json
  const fixturesDir = join(SCORES_DIR, "fixtures");
  if (await dirExists(fixturesDir)) {
    const files = await readdir(fixturesDir);
    for (const f of files) {
      if (!f.endsWith(".json")) { continue; }
      entries.push({
        path: `/scores/fixtures/${f}`,
        filename: f,
        category: "fixture",
        pattern: f.replace(".json", ""),
      });
    }
  }

  // Sort runs newest-first by timestamp
  entries.sort((a, b) => {
    if (a.category !== b.category) {
      const order = { run: 0, baseline: 1, fixture: 2 };
      return order[a.category] - order[b.category];
    }
    if (a.timestamp && b.timestamp) { return b.timestamp.localeCompare(a.timestamp); }
    return a.filename.localeCompare(b.filename);
  });

  return entries;
}

// ─── Safe file serving ─────────────────────────────────────────────
function safePath(base: string, requested: string): string | undefined {
  const resolved = resolve(base, requested);
  if (!resolved.startsWith(base)) { return undefined; } // path traversal blocked
  return resolved;
}

async function serveFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ─── Request handler ───────────────────────────────────────────────
async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");

  // API: manifest
  if (pathname === "/api/manifest") {
    const manifest = await buildManifest();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(manifest));
    return;
  }

  // Scores files: /scores/store/..., /scores/baselines/..., /scores/fixtures/...
  if (pathname.startsWith("/scores/")) {
    const rel = pathname.slice("/scores/".length);
    const filePath = safePath(SCORES_DIR, rel);
    if (!filePath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    await serveFile(res, filePath);
    return;
  }

  // Viewer assets: /, /viewer.html, /viewer.css, /viewer.js
  let assetPath: string;
  if (pathname === "/" || pathname === "/viewer.html") {
    assetPath = join(VIEWER_DIR, "viewer.html");
  } else {
    const rel = pathname.slice(1); // strip leading /
    const resolved = safePath(VIEWER_DIR, rel);
    if (!resolved) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    assetPath = resolved;
  }
  await serveFile(res, assetPath);
}

// ─── Start ─────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    console.error(err);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal Server Error");
  });
});

server.listen(PORT, () => {
  console.log(`\n  🎼 Maestro Viewer → http://localhost:${PORT}\n`);
});
