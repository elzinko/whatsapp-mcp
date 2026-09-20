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
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { Settings } from "./settings.js";
import { Allowlist } from "./allowlist.js";
import { WhatsAppClient, log } from "./whatsapp.js";
import { SessionRegistry } from "./sessions.js";
import { handleRequest } from "./daemon-protocol.js";
import { readOrCreateSecret } from "./daemon-secret.js";

// Cap d'une ligne de requête NDJSON (revue P2) : une requête status/recent tient très
// largement sous 1 MiB. Au-delà sans '\n', on refuse et on coupe plutôt que de laisser
// le buffer par-connexion gonfler sans borne.
const MAX_LINE_BYTES = 1 << 20;

// Une ligne d'audit par refus de secret (ADR-0008 §5 : "le refus est journalisé").
// ASYNCHRONE et best-effort (revue #8) : un refus de secret peut survenir à haute
// fréquence sur le hot path (un parasite qui martèle la socket) — bloquer la boucle
// d'événements avec un appendFileSync à CHAQUE refus serait une porte de déni de
// service. Le dossier du log est créé UNE FOIS, à l'appel de serveDaemon (pas ici,
// pas de mkdirSync récursif par appel). Une erreur d'écriture n'a jamais fait tomber
// le démon ; elle est simplement signalée sur stderr, jamais avalée en silence.
export function appendAudit(logFile, entry) {
  fs.appendFile(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 }, (e) => {
    if (e) log("Audit non journalisé (I/O) :", e?.message);
  });
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
      wa.allowlist.refresh(); // fraîcheur AVANT les vérifs _inScope (comme index.js:379)
      const session = sessions.resolve(token);
      if (!session) throw new Error("Session invalide, expirée ou fermée. Ouvre une session avec session_open.");
      // NOTE (finding #6, décision de contrat SKIPPED volontairement) : le démon
      // attend un JID exact dans `jid`, pas un nom de groupe — la résolution nom->JID
      // (wa._resolveToJid) reste du ressort du frontend (fiche child B,
      // 20260917211902225). Refuser ici un nom serait un changement de comportement
      // hors scope de cette fiche.
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
      wa.allowlist.refresh(); // fraîcheur AVANT les vérifs _inScope (comme index.js:379)
      const jids = (channels || []).map((c) => wa._resolveToJid(c));
      const denied = jids.filter((jid) => !(wa.settings.has(jid) && wa._inScope(jid)));
      if (denied.length > 0) {
        throw new Error(`Canal hors grants ∩ plafond, refusé : ${denied.join(", ")}.`);
      }
      // Coercition comme index.js:393 : un ttlMs non entier ou <= 0 (chaîne, négatif,
      // absent) retombe sur le défaut du registre plutôt que de créer une session déjà
      // expirée, ou de faire lever un RangeError plus loin (Date invalide).
      const ttl = Number.isInteger(ttlMs) && ttlMs > 0 ? ttlMs : undefined;
      const session = sessions.create(jids, ttl);
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
  // Dossier du log d'audit créé UNE FOIS ici (fix #8) — pas à chaque appendAudit().
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });

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
    // Un caractère multi-octets (UTF-8) peut être coupé entre deux chunks TCP/Unix ;
    // StringDecoder recolle les octets incomplets au chunk suivant au lieu de
    // corrompre le caractère (fix #7) — un .toString("utf8") par chunk ne le fait pas.
    const decoder = new StringDecoder("utf8");
    conn.on("data", (chunk) => {
      buf += decoder.write(chunk);
      // Draine D'ABORD toutes les lignes complètes déjà reçues (fix #5) : un lot de
      // petites requêtes valides, dont la taille CUMULÉE dépasse MAX_LINE_BYTES,
      // n'est jamais rejeté — seul un reste NON TERMINÉ (sans '\n') trop long l'est.
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        // .catch : une exception inattendue HORS dispatch (le protocole avale déjà les
        // erreurs métier) ne doit jamais devenir une unhandled rejection (revue P2).
        if (line) {
          handleLine(conn, line).catch(() => {
            try {
              conn.write(JSON.stringify({ ok: false, verb: null, error: "erreur interne" }) + "\n");
            } catch { /* connexion déjà partie */ }
          });
        }
      }
      // Cap anti-flux-anormal (revue P2) : au-delà de MAX_LINE_BYTES SANS '\n' dans ce
      // qu'il reste à drainer, on refuse et on coupe — pas de buffer non borné.
      if (buf.length > MAX_LINE_BYTES) {
        try {
          conn.write(JSON.stringify({ ok: false, verb: null, error: "ligne trop longue" }) + "\n");
        } catch { /* connexion déjà partie */ }
        conn.destroy();
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
  const deps = process.env[FAKE_BAILEYS_ENV] === "1" ? testFakeDeps() : undefined;
  // Le démon est PARTAGÉ par tous les frontends/projets (revue Codex #3) : il ne doit
  // PAS appliquer un profil de projet à la capture. Sinon il ne capterait QUE le projet
  // du frontend qui l'a spawné (ensureDaemonRunning hérite de son env WHATSAPP_PROFILE),
  // voire rien du tout. Le démon capte donc grant ∩ plafond ; le profil par frontend
  // s'appliquera à la frontière session/lecture (fiche child B, 20260917211902225).
  // profile:"" + stub inerte (4e arg null) => _profileHas toujours vrai, sans jamais
  // appeler match() (le stub inerte n'en a pas).
  const wa = new WhatsAppClient({ ...config, profile: "" }, settings, allowlist, null, deps);
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
