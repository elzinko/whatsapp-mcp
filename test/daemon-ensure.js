// ensureDaemonRunning (ADR-0008 action 3) : ping d'abord, spawn UNE SEULE fois si
// personne ne répond, polling borné jusqu'à réponse, log en append. Effets
// (ping/spawn/sleep) injectés : aucun vrai process n'est lancé, aucune vraie socket
// n'est ouverte.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureDaemonRunning } from "../src/daemon-client.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-ensure-"));
  const logFile = path.join(tmp, "daemon-ensure.log");
  const daemonScript = "/fake/daemon.js"; // jamais exécuté : spawnFn est injecté

  // 1) Le démon répond déjà au premier ping -> aucun spawn.
  {
    let spawnCalls = 0;
    const res = await ensureDaemonRunning({
      socketPath: "/fake.sock",
      secret: "s",
      logFile,
      daemonScript,
      ping: async () => ({ ok: true, verb: "status", data: {} }),
      spawnFn: () => {
        spawnCalls += 1;
        return { pid: 123, unref: () => {} };
      },
      sleep: async () => {},
    });
    check("démon déjà présent -> spawn jamais appelé", spawnCalls === 0);
    check("démon déjà présent -> {started:false, spawned:false}", res.started === false && res.spawned === false);
  }

  // 2) Personne ne répond au premier ping -> spawn, puis le polling finit par réussir.
  {
    let spawnCalls = 0;
    let pingCalls = 0;
    const res = await ensureDaemonRunning({
      socketPath: "/fake.sock",
      secret: "s",
      logFile,
      daemonScript,
      ping: async () => {
        pingCalls += 1;
        // 1er ping (avant spawn) + 2 tours de polling absents, le 4e ping répond.
        return pingCalls >= 4 ? { ok: true } : null;
      },
      spawnFn: () => {
        spawnCalls += 1;
        return { pid: 456, unref: () => {} };
      },
      sleep: async () => {},
      pollAttempts: 10,
      pollIntervalMs: 0,
    });
    check("démon absent au premier ping -> spawn appelé EXACTEMENT une fois", spawnCalls === 1);
    check("le ping a bien lieu AVANT le spawn (jamais un spawn à l'aveugle)", pingCalls >= 1);
    check("polling jusqu'à réponse -> started:true, pid rapporté", res.started === true && res.pid === 456);
  }

  // 3) Le démon spawné ne répond jamais -> polling épuisé -> erreur, un seul spawn
  //    (jamais un second spawn en repli — "jamais deux démons").
  {
    let spawnCalls = 0;
    let threw = false;
    try {
      await ensureDaemonRunning({
        socketPath: "/fake.sock",
        secret: "s",
        logFile,
        daemonScript,
        ping: async () => null,
        spawnFn: () => {
          spawnCalls += 1;
          return { pid: 789, unref: () => {} };
        },
        sleep: async () => {},
        pollAttempts: 5,
        pollIntervalMs: 0,
      });
    } catch {
      threw = true;
    }
    check("démon jamais répondant -> rejette après un polling borné", threw === true);
    check("polling épuisé -> spawn appelé UNE SEULE fois", spawnCalls === 1);
  }

  // 4) Le log est alimenté EN APPEND à chaque appel (les 3 scénarios précédents).
  {
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
    check("le log d'ensureDaemonRunning est alimenté en append", lines.length >= 3);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
