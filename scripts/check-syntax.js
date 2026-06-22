import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const roots = ["api", "lib", "scripts", "test"];
const files = ["server.js", "worker.js"];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
}

for (const root of roots) {
  collect(root);
}

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });
}

console.log(`Syntax OK: ${files.length} files`);
