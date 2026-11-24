import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const allowlist = JSON.parse(
  readFileSync(join(root, "audit-allowlist.json"), "utf8")
);

if (new Date() > new Date(allowlist.reviewBy)) {
  console.error(
    `Allowlist audit kedaluwarsa (reviewBy ${allowlist.reviewBy}). Tinjau ulang sebelum lanjut.`
  );
  process.exit(1);
}

// Saat dipanggil lewat `npm run`, jalankan npm-cli.js dengan Node langsung:
// menghindari spawn .cmd lewat shell (dan deprecation warning-nya) di Windows.
const npmCli = process.env.npm_execpath;
const command = npmCli ? process.execPath : "npm";
const args = npmCli
  ? [npmCli, "audit", "--omit=dev", "--json"]
  : ["audit", "--omit=dev", "--json"];
const result = spawnSync(command, args, {
  cwd: root,
  encoding: "utf8",
  shell: !npmCli && process.platform === "win32",
});

if (result.error) {
  console.error("Gagal menjalankan npm audit:", result.error.message);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error(result.stderr || result.stdout || "npm audit tidak menghasilkan JSON");
  process.exit(1);
}

const found = new Map();
for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vulnerability.via ?? []) {
    if (
      typeof via === "object" &&
      ["high", "critical"].includes(via.severity) &&
      via.url
    ) {
      found.set(via.url, {
        name,
        severity: via.severity,
        title: via.title,
      });
    }
  }
}

const unexpected = [...found.entries()].filter(
  ([url]) => !Object.hasOwn(allowlist.accepted, url)
);

console.log(
  `npm audit (production): ${found.size} advisory high/critical, ${unexpected.length} di luar allowlist.`
);

if (unexpected.length > 0) {
  for (const [url, detail] of unexpected) {
    console.error(`  [${detail.severity}] ${detail.name}: ${detail.title}\n    ${url}`);
  }
  console.error(
    "Advisory baru harus diperbaiki atau ditambahkan ke audit-allowlist.json dengan alasan."
  );
  process.exit(1);
}

for (const [url, detail] of found) {
  console.log(`  accepted [${detail.severity}] ${detail.name}: ${url}`);
}
