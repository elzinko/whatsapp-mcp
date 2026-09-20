#!/usr/bin/env node
// Le démon (ADR-0008) : le SEUL process qui ouvre auth/ et la socket Baileys. Il
// prend le verrou `auth/` (authlock.js, config.authLockFile — le MÊME fichier que le
// serveur legacy src/index.js, pour qu'ils restent mutuellement exclusifs pendant la
// transition), compose le backend réel (WhatsAppClient + SessionRegistry + Allowlist +
// Settings), ouvre la socket Unix locale et sert le protocole NDJSON
// (daemon-protocol.js). Il tourne SANS TÊTE : la capture continue même sans aucun
// client connecté (`node src/daemon.js` le lance et le laisse tourner).
//
// Le frontend (src/index.js) n'est PAS touché ici (fiche 20260917211902097 = child A ;
// le rewire du frontend est la fiche 20260917211902225, child B).

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { Settings } from "./settings.js";
import { Allowlist } from "./allowlist.js";
import { Profiles } from "./profiles.js";
import { WhatsAppClient, log } from "./whatsapp.js";
import { SessionRegistry } from "./sessions.js";
import { handleRequest } from "./daemon-protocol.js";
import { readOrCreateSecret } from "./daemon-secret.js";

// Une ligne d'audit par refus de secret (ADR-0008 §5 : "le refus est journalisé").
// Best-effort : un audit qu'on n'arrive pas à écrire ne doit jamais faire tomber le
// démon, mais on le signale sur stderr pour ne pas échouer en silence.
export function appendAudit(logFile, entry) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
  } catch (e) {
    log("Audit non journalisé (I/O) :", e?.message);
  }
}

// Backend RÉEL du protocole (ADR-0008 action 1/5) : héberge le SessionRegistry
// (migré depuis la couche application) et applique le périmètre session ∩ grant ∩
// plafond DANS `recent` et `sessionOpen` — c'est ça, "vérifié côté démon".
export function buildBackend(wa, sessions) {
  return {
    status() {
      return { ...wa.status(), activeSessions: sessions.list().length };
    },
    async listGroups() {
      return wa.listGroups();
    },
    // Périmètre : le jeton doit résoudre une session, et le canal demandé doit être
    // DANS cette session (pas seulement autorisé ailleurs) ET dans le grant ∩ plafond
    // couru par recentFor (whatsapp.js#_inScope, ADR-0002 §6).
    recent(token, jid, limit) {
      const session = sessions.resolve(token);
      if (!session) throw new Error("Session invalide, expirée ou fermée. Ouvre une session avec session_open.");
      const targetJid = jid || (session.channels.length === 1 ? session.channels[0] : null);
      if (!targetJid) throw new Error("Plusieurs canaux dans cette session : précise 'jid'.");
      if (!session.channels.includes(targetJid)) {
        throw new Error(`Canal hors périmètre de la session : ${targetJid}.`);
      }
      return wa.recentFor(targetJid, limit);
    },
    // Périmètre vérifié AVANT toute création de session : chaque canal demandé doit
    // être à la fois autorisé (settings.has, un grant existant) ET dans le plafond ∩
    // profil actif (wa._inScope) — même garde que l'ingestion (whatsapp.js#_ingest).
    sessionOpen(channels, ttlMs) {
      const jids = (channels || []).map((c) => wa._resolveToJid(c));
      const denied = jids.filter((jid) => !(wa.settings.has(jid) && wa._inScope(jid)));
      if (denied.length > 0) {
        throw new Error(`Canal hors grants ∩ plafond, refusé : ${denied.join(", ")}.`);
      }
      const session = sessions.create(jids, ttlMs);
      return { session: session.id, expiresAt: session.expiresAt, channels: session.channels };
    },
    sessionClose(token) {
      return { closed: sessions.close(token) };
    },
  };
}

// Sert le protocole NDJSON sur une socket Unix locale (ADR-0008 §2/§4) : fichier
// 0600, permissions posées APRÈS listen (le umask du process s'applique au bind).
// Chaque connexion est traitée indépendamment, une ligne = une requête = une réponse ;
// aucun état de session n'est porté par la connexion elle-même.
export function serveDaemon(backend, { socketPath, secret, logFile }) {
  try {
    fs.unlinkSync(socketPath);
  } catch (e) {
    if (e.code !== "ENOENT") throw e; // un vrai fichier bloquant : on ne l'écrase pas en silence
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });

  async function handleLine(conn, line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      conn.write(JSON.stringify({ ok: false, verb: null, error: "JSON invalide" }) + "\n");
      return;
    }
    const res = await handleRequest(backend, req, {
      secret,
      audit: (entry) => appendAudit(logFile, entry),
    });
    conn.write(JSON.stringify(res) + "\n");
  }

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) handleLine(conn, line);
      }
    });
    conn.on("error", () => {}); // client parti brutalement : rien à faire côté démon
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.chmodSync(socketPath, 0o600);
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

// Deps Baileys FACTICES, réservées aux tests hermétiques (test/daemon-singleton.js) :
// gardées par une variable d'environnement dédiée, jamais posée en usage réel. Le
// principe (ADR-0008 action 7) est qu'AUCUN test ne doit ouvrir une vraie connexion
// WhatsApp ; le comportement testé ici (exclusivité du verrou) ne dépend pas de
// Baileys, donc on l'élimine plutôt que de le simuler finement.
const FAKE_BAILEYS_ENV = "WHATSAPP_DAEMON_TEST_FAKE_BAILEYS";
function testFakeDeps() {
  return {
    useMultiFileAuthState: async () => ({
      state: { creds: { registered: true } },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    makeWASocket: () => ({
      authState: { creds: { registered: true } },
      ev: { on: () => {} },
      groupFetchAllParticipating: async () => ({}),
    }),
  };
}

export async function main() {
  const settings = new Settings(config.settingsFile).load();
  const allowlist = new Allowlist(config.allowlistFile).bootstrap(settings);
  const profile = new Profiles(config.profilesFile).load();
  const deps = process.env[FAKE_BAILEYS_ENV] === "1" ? testFakeDeps() : undefined;
  const wa = new WhatsAppClient(config, settings, allowlist, profile, deps);
  const sessions = new SessionRegistry(config.sessionsDir, { defaultTtlMs: config.sessionTtlMs });

  // Verrou `auth/` AVANT tout (fiche 0009, partagé avec src/index.js). Un second
  // démon (ou un serveur legacy encore vivant) le trouve tenu et SORT ici, sans
  // ouvrir de socket ni toucher auth/ (ADR-0008 §4).
  try {
    wa.acquireLock();
  } catch (e) {
    if (e?.code === "ELOCKED") {
      log(e.message);
      process.exit(1);
    }
    throw e;
  }

  // Démarre WhatsApp sans attendre la connexion : la socket doit répondre tout de
  // suite (ex. `status` pendant l'état "qr"/"connecting"). La capture continue tant
  // que ce process tourne, client ouvert ou non (critère de la fiche).
  wa.start().catch((e) => log("Echec démarrage WhatsApp:", e?.message));

  const backend = buildBackend(wa, sessions);
  const secret = readOrCreateSecret(config.daemonSecretFile);
  await serveDaemon(backend, {
    socketPath: config.daemonSocket,
    secret,
    logFile: config.daemonLogFile,
  });
  log(`Démon prêt, socket ${config.daemonSocket} — sans tête, la capture continue sans client.`);
}

const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    log("Erreur fatale démon:", e?.message);
    process.exit(1);
  });
}
