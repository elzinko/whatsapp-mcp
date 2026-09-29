// Garde-fou (fiche 20260917211902225) : le serveur MCP est un FRONTEND MINCE. Il
// n'instancie JAMAIS WhatsAppClient — donc n'ouvre jamais de connexion WhatsApp ni ne prend
// le verrou auth/ (c'est le démon qui les tient, ADR-0008). Il ne connaît que la socket du
// démon. Vérification STATIQUE de la source (l'invariant structurel de la fiche), sans spawn.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

check("index.js n'instancie jamais WhatsAppClient (aucune connexion WhatsApp)", !/new\s+WhatsAppClient/.test(src));
check(
  "index.js n'importe pas la classe WhatsAppClient",
  !/import[^;]*\bWhatsAppClient\b[^;]*from/.test(src)
);
check("index.js parle au démon (daemon-client)", /daemon-client\.js/.test(src));
check("index.js ne prend pas le verrou auth/ (acquireLock absent)", !/acquireLock/.test(src));
check("index.js garde le consentement au frontend (buildSessionConsent)", /buildSessionConsent/.test(src));

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
