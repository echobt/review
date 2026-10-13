// Render-check every ```mermaid block in docs/**/*.md with @mermaid-js/mermaid-cli (mmdc).
// Usage: node scripts/check-mermaid.mjs  (requires network for npx on first run, or mmdc on PATH; uses system Chrome via PUPPETEER_EXECUTABLE_PATH)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : []; });
const out = ".mermaid-out"; mkdirSync(out, { recursive: true });
writeFileSync(join(out, "puppeteer.json"), JSON.stringify({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] }));
let ok = 0, fail = 0;
for (const file of walk("docs")) {
  const blocks = [...readFileSync(file, "utf8").matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  blocks.forEach((src, i) => {
    const base = join(out, file.replace(/[\/]/g, "_") + "-" + i);
    writeFileSync(base + ".mmd", src);
    try {
      execFileSync("npx", ["-y", "@mermaid-js/mermaid-cli@11", "-q", "-p", join(out, "puppeteer.json"), "-i", base + ".mmd", "-o", base + ".svg"], { stdio: "pipe" });
      ok++; console.log("OK  ", file, "#" + i);
    } catch (e) { fail++; console.log("FAIL", file, "#" + i, String(e.stderr ?? e).split("\n").slice(0, 6).join(" | ")); }
  });
}
console.log(`mermaid: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
