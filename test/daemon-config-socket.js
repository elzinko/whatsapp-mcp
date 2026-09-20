// Chemin de socket du démon (revue #1) : le défaut doit rester COURT et STABLE,
// même depuis un worktree profond dont projectRoot dépasse déjà la limite macOS
// `sun_path` (~104 octets) une fois "/daemon.sock" ajouté. Sinon `bind` tronque
// silencieusement et chmod/unlink échouent en ENOENT au démarrage du démon.
//
// Process séparé (pas d'import direct) : config.js calcule projectRoot une seule
// fois à l'import, donc chaque scénario a besoin de son propre process pour
// repartir d'un état frais.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const configModule = path.join(here, "../src/config.js");

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

function runWithEnv(extraEnv) {
  const prog =
    `import { config } from ${JSON.stringify(configModule)};` +
    `process.stdout.write(JSON.stringify({ daemonSocket: config.daemonSocket, daemonSecretFile: config.daemonSecretFile, daemonLogFile: config.daemonLogFile }));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", prog], {
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
  });
  return res;
}

// 1. Défaut : chemin court (< 104 octets), hors du projectRoot (tmpdir, stable par
//    projet), et daemonSecretFile/daemonLogFile RESTENT dans le projet.
{
  const res = runWithEnv({});
  check("défaut -> process ne crashe pas", res.status === 0);
  const out = JSON.parse(res.stdout || "{}");
  check(
    "défaut -> daemonSocket < 104 octets",
    typeof out.daemonSocket === "string" && Buffer.byteLength(out.daemonSocket, "utf8") < 104
  );
  check("défaut -> daemonSocket hors du projet (tmpdir)", !out.daemonSocket?.includes("whatsapp-mcp/.claude/worktrees"));
  check("défaut -> daemonSecretFile reste un fichier normal (pas dans tmpdir)", out.daemonSecretFile?.endsWith("daemon.secret"));
  check("défaut -> daemonLogFile reste un fichier normal (pas dans tmpdir)", out.daemonLogFile?.endsWith("daemon.log"));
}

// 2. Stabilité : deux process successifs (même projectRoot) calculent LE MÊME
//    chemin par défaut -> démon et client s'accordent sans coordination.
{
  const a = JSON.parse(runWithEnv({}).stdout || "{}");
  const b = JSON.parse(runWithEnv({}).stdout || "{}");
  check("défaut -> stable d'un process à l'autre", a.daemonSocket === b.daemonSocket);
}

// 3. Surcharge env WHATSAPP_DAEMON_SOCKET : chemin absolu honoré tel quel.
{
  const res = runWithEnv({ WHATSAPP_DAEMON_SOCKET: "/tmp/custom-daemon.sock" });
  const out = JSON.parse(res.stdout || "{}");
  check("surcharge env -> chemin absolu honoré", out.daemonSocket === "/tmp/custom-daemon.sock");
}

// 4. Garde-fou : un chemin résolu >= 104 octets doit faire échouer tôt, avec un
//    message clair, plutôt que de laisser le démon crasher plus tard sur bind/chmod.
{
  const longPath = "/tmp/" + "x".repeat(110) + "/daemon.sock";
  const res = runWithEnv({ WHATSAPP_DAEMON_SOCKET: longPath });
  check("chemin de socket trop long -> le process échoue tôt", res.status !== 0);
  check("chemin de socket trop long -> message explicite", /socket/i.test(res.stderr) && /long|court|byte|octet/i.test(res.stderr));
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
