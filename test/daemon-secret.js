// Tests de src/daemon-secret.js (revue P1/P2c) : read-or-create, permissions 0600,
// idempotence, et convergence sous COURSE DE CRÉATION À FROID (deux vrais process,
// fichier absent) — le point que le fix `link` atomique ferme (rename écrasait).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readOrCreateSecret } from "../src/daemon-secret.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const secretModule = path.join(here, "../src/daemon-secret.js");

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-secret-"));
}

// 1. Absent -> crée un secret 64 hex, fichier 0600, contenu == valeur renvoyée.
{
  const dir = tmpdir();
  const file = path.join(dir, "sub", "daemon.secret"); // sous-dossier créé au passage
  const secret = readOrCreateSecret(file);
  check("absent -> secret 64 hex", /^[0-9a-f]{64}$/.test(secret));
  check("absent -> fichier écrit", fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  check(`absent -> fichier en 0600 (obtenu ${mode.toString(8)})`, mode === 0o600);
  check("absent -> contenu == valeur renvoyée", fs.readFileSync(file, "utf8").trim() === secret);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. Présent -> renvoie l'existant, sans écraser.
{
  const dir = tmpdir();
  const file = path.join(dir, "daemon.secret");
  fs.writeFileSync(file, "DEADBEEF\n", { mode: 0o600 });
  const secret = readOrCreateSecret(file);
  check("présent -> renvoie l'existant", secret === "DEADBEEF");
  check("présent -> pas d'écrasement", fs.readFileSync(file, "utf8").trim() === "DEADBEEF");
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3. Idempotent (même process) -> deux appels séquentiels convergent.
{
  const dir = tmpdir();
  const file = path.join(dir, "daemon.secret");
  const a = readOrCreateSecret(file);
  const b = readOrCreateSecret(file);
  check("idempotent -> même valeur", a === b);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4. Course À FROID : deux VRAIS process concurrents sur un fichier absent convergent
//    vers LA MÊME valeur (fix P1 : link atomique gagne-ou-lit, pas rename qui écrase).
{
  const dir = tmpdir();
  const file = path.join(dir, "daemon.secret");
  const prog =
    `import { readOrCreateSecret } from ${JSON.stringify(secretModule)};` +
    `process.stdout.write(readOrCreateSecret(${JSON.stringify(file)}));`;

  const run = () =>
    new Promise((resolve) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e", prog], {
        stdio: ["ignore", "pipe", "ignore"],
      });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.on("close", () => resolve(out.trim()));
    });

  const [a, b] = await Promise.all([run(), run()]);
  check("course à froid -> les deux process renvoient un secret 64 hex", /^[0-9a-f]{64}$/.test(a) && /^[0-9a-f]{64}$/.test(b));
  check("course à froid -> convergence (même valeur)", a === b);
  check("course à froid -> fichier == valeur convergée", fs.readFileSync(file, "utf8").trim() === a);
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.log("=== RÉSULTAT: ÉCHEC ===");
  process.exit(1);
}
console.log("=== RÉSULTAT: SUCCÈS ===");
