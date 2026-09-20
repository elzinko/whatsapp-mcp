// Singleton du démon (ADR-0008 §4, action 1) : deux démarrages sur le MÊME verrou ->
// le 2e refuse. Hermétique : deps Baileys FACTICES côté démon
// (WHATSAPP_DAEMON_TEST_FAKE_BAILEYS=1) — seule l'exclusivité du verrou (authlock.js,
// partagé avec src/index.js) est en jeu ici, aucune vraie connexion WhatsApp, comme
// test/authlock.js#9 le fait déjà pour src/index.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const daemonEntry = path.join(__dirname, "..", "src", "daemon.js");

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout"));
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

let first;
try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-singleton-"));
  const env = {
    ...process.env,
    WHATSAPP_DAEMON_TEST_FAKE_BAILEYS: "1",
    WHATSAPP_AUTH_DIR: path.join(tmp, "auth"),
    WHATSAPP_AUTH_LOCK: path.join(tmp, "auth.lock"),
    WHATSAPP_SETTINGS_FILE: path.join(tmp, "settings.json"),
    WHATSAPP_ALLOWLIST_FILE: path.join(tmp, "allowlist.json"),
    WHATSAPP_SESSIONS_DIR: path.join(tmp, "sessions"),
    WHATSAPP_DAEMON_SOCKET: path.join(tmp, "daemon.sock"),
    WHATSAPP_DAEMON_SECRET_FILE: path.join(tmp, "daemon.secret"),
    WHATSAPP_DAEMON_LOG_FILE: path.join(tmp, "daemon.log"),
    WHATSAPP_PERSIST: "false",
  };

  first = spawn(process.execPath, [daemonEntry], { env, stdio: "ignore" });
  let firstExited = false;
  first.on("exit", () => (firstExited = true));

  // Attend que le premier démon ait effectivement pris le verrou.
  await waitFor(() => fs.existsSync(env.WHATSAPP_AUTH_LOCK));
  check("le premier démon prend le verrou", fs.existsSync(env.WHATSAPP_AUTH_LOCK));

  const second = spawnSync(process.execPath, [daemonEntry], { env, timeout: 10000 });
  check("le 2e démon sur le même verrou SORT en échec (exit != 0)", second.status !== 0 && second.status !== null);
  check("le premier démon tourne toujours (le 2e ne l'a pas perturbé)", !firstExited);

  // Bonus (revue) : le stderr du perdant NOMME le conflit de verrou, pas seulement
  // un code de sortie non-zéro — un exit != 0 pourrait tout aussi bien venir d'un
  // crash sans rapport (Baileys, config...).
  const secondStderr = second.stderr?.toString("utf8") || "";
  check("le stderr du 2e démon mentionne le conflit de verrou (PID détenteur)", /auth\//.test(secondStderr) && /PID/.test(secondStderr));

  first.kill();
  await waitFor(() => firstExited, { timeoutMs: 3000 }).catch(() => {});

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
  try {
    first?.kill();
  } catch {
    /* déjà mort */
  }
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
