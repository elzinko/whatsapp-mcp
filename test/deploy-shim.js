// Test du shim bin/whatsapp-mcp (ADR-0007, fiche 20260911212530209).
//
// On ne lance PAS le vrai serveur (Baileys) : on monte une fausse version figée
// dont le src/index.js est un STUB qui recrache l'environnement WHATSAPP_* et le
// chemin par lequel il a été lancé. On vérifie alors les deux garanties du shim :
//   1. lancé via « current », il exécute le src/index.js de la version FIGÉE
//      (résolution du symlink) — jamais un checkout ;
//   2. il pose l'état HORS du code, sous la racine d'état, sans variable à la main
//      — et un override explicite (WHATSAPP_AUTH_DIR, WHATSAPP_MCP_STATE_ROOT) gagne.
//
// Tout se passe dans un dossier temporaire : aucun accès au vrai ~/.config.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHIM = path.resolve(__dirname, "..", "bin", "whatsapp-mcp");

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

// Stub qui remplace src/index.js dans la version figée : imprime en JSON ce que le
// shim lui a transmis, puis sort proprement (le vrai serveur, lui, tiendrait stdio).
const STUB = `import fs from "node:fs";
const keys = ["WHATSAPP_AUTH_DIR","WHATSAPP_AUTH_LOCK","WHATSAPP_DATA_DIR",
  "WHATSAPP_SETTINGS_FILE","WHATSAPP_ALLOWLIST_FILE","WHATSAPP_PROFILES_FILE",
  "WHATSAPP_STRONG_AUTH_FILE","WHATSAPP_SESSIONS_DIR"];
const env = {};
for (const k of keys) env[k] = process.env[k];
process.stdout.write(JSON.stringify({ entry: process.argv[1], env }));
`;

// Monte ~/.local/share/whatsapp-mcp/<v1>/ + lien current → v1, avec le shim et le stub.
function mountDeploy(root, version) {
  const vdir = path.join(root, version);
  fs.mkdirSync(path.join(vdir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(vdir, "src"), { recursive: true });
  fs.copyFileSync(SHIM, path.join(vdir, "bin", "whatsapp-mcp"));
  fs.chmodSync(path.join(vdir, "bin", "whatsapp-mcp"), 0o755);
  fs.writeFileSync(path.join(vdir, "src", "index.js"), STUB);
  const current = path.join(root, "current");
  fs.rmSync(current, { force: true });
  fs.symlinkSync(vdir, current); // current → v1
  return { vdir, current };
}

function runShim(currentLink, extraEnv) {
  const out = execFileSync(path.join(currentLink, "bin", "whatsapp-mcp"), [], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  return JSON.parse(out);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-shim-"));
try {
  const deployRoot = path.join(tmp, "share");
  const stateRoot = path.join(tmp, "state");
  const { current } = mountDeploy(deployRoot, "v1");

  // --- 1. Lancé via current : exécute le index.js de la version figée v1 ---
  const r1 = runShim(current, { WHATSAPP_MCP_STATE_ROOT: stateRoot });
  check("lance le src/index.js de la version figée (v1)", /\/v1\/src\/index\.js$/.test(r1.entry));
  check("a résolu le lien current (pas de /current/ dans le chemin lancé)", !r1.entry.includes("/current/"));

  // --- 2. État hors du code, sous la racine d'état, sans variable posée à la main ---
  // pwd -P peut canonicaliser (ex. /var → /private/var sur macOS) : on compare donc
  // sur le SUFFIXE stable, pas sur le chemin absolu brut.
  check("auth/ sous la racine d'état", r1.env.WHATSAPP_AUTH_DIR.endsWith("/state/auth"));
  check("data/ sous la racine d'état", r1.env.WHATSAPP_DATA_DIR.endsWith("/state/data"));
  check("settings.json sous la racine d'état", r1.env.WHATSAPP_SETTINGS_FILE.endsWith("/state/settings.json"));
  check("sessions/ sous la racine d'état", r1.env.WHATSAPP_SESSIONS_DIR.endsWith("/state/sessions"));
  check("aucun chemin d'état ne pointe dans la version déployée", !r1.env.WHATSAPP_AUTH_DIR.includes("/v1/"));

  // --- 3. Override explicite d'une variable : il gagne sur le défaut ---
  const forcedAuth = path.join(tmp, "ailleurs", "auth");
  const r2 = runShim(current, { WHATSAPP_MCP_STATE_ROOT: stateRoot, WHATSAPP_AUTH_DIR: forcedAuth });
  check("WHATSAPP_AUTH_DIR explicite l'emporte sur le défaut", r2.env.WHATSAPP_AUTH_DIR === forcedAuth);
  check("les autres chemins restent sous la racine d'état", r2.env.WHATSAPP_DATA_DIR.endsWith("/state/data"));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
