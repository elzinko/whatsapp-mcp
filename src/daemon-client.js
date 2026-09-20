// Client léger du démon (ADR-0008 action 3). Deux exports :
//   - request(socketPath, req)     : une requête NDJSON, une réponse (ou null).
//   - ensureDaemonRunning(options) : ping -> spawn détaché -> polling borné -> log en
//     append. Patron « ensure-broker-running » transféré de google-mcp-multi-account
//     (nom de symbole adapté, cf. notes de la fiche 20260917211902097).
//
// Effets injectables (ping/spawn/sleep) pour rester testable sans jamais lancer un
// vrai process ni ouvrir une vraie socket (test/daemon-ensure.js).

import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn as spawnDefault } from "node:child_process";

// Envoie une requête NDJSON et attend UNE ligne de réponse. Résout `null` si personne
// n'écoute, si la connexion échoue, ou si rien n'arrive avant `timeoutMs` — jamais une
// exception : l'appelant (ensureDaemonRunning) traite "pas de réponse" comme un signal,
// pas comme une panne.
export function request(socketPath, req, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const socket = net.createConnection(socketPath);
    socket.once("error", () => finish(null));
    socket.once("connect", () => socket.write(JSON.stringify(req) + "\n"));
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx === -1) return;
      try {
        finish(JSON.parse(buf.slice(0, idx)));
      } catch {
        finish(null);
      }
    });
  });
}

function appendLog(logFile, line) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* best-effort : le log n'est jamais une condition d'échec pour l'appelant */
  }
}

// ping -> si personne ne répond, spawn DÉTACHÉ (le démon survit à ce process) ->
// polling borné jusqu'à réponse -> log en append. DANS UN MÊME APPEL, spawnFn n'est
// appelé qu'une fois. Mais deux appelants CONCURRENTS à froid peuvent chacun spawner :
// la garantie « un seul démon » vient alors du VERROU côté démon (authlock.js), qui
// fait sortir le perdant en exit(1) sans toucher auth/. Le ping-avant-spawn réduit les
// spawns inutiles, il ne remplace pas le verrou (revue P2, ADR-0008 §4).
export async function ensureDaemonRunning({
  socketPath,
  secret,
  logFile,
  daemonScript,
  ping = (sock, sec) => request(sock, { verb: "status", secret: sec }),
  spawnFn = spawnDefault,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollAttempts = 20,
  pollIntervalMs = 100,
} = {}) {
  const already = await ping(socketPath, secret);
  if (already?.ok) {
    appendLog(logFile, "ping : démon déjà présent, rien à faire.");
    return { started: false, spawned: false };
  }

  appendLog(logFile, "ping sans réponse : spawn du démon (détaché).");
  const child = spawnFn(process.execPath, [daemonScript], { detached: true, stdio: "ignore" });
  child.unref?.();

  for (let attempt = 0; attempt < pollAttempts; attempt++) {
    const res = await ping(socketPath, secret);
    if (res?.ok) {
      appendLog(logFile, `démon prêt après ${attempt + 1} tentative(s) de polling.`);
      return { started: true, spawned: true, pid: child.pid };
    }
    await sleep(pollIntervalMs);
  }

  appendLog(logFile, "démon spawné mais jamais répondu (polling épuisé).");
  throw new Error("Le démon n'a jamais répondu après son démarrage (polling épuisé).");
}
