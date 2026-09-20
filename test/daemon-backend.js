// Le backend RÉEL du démon (ADR-0008 action 1/5, revue #11) : buildBackend()
// (src/daemon.js) branché sur un FAUX `wa` (aucun import Baileys) + un VRAI
// SessionRegistry sur tmpdir. Les tests existants (daemon-protocol.js,
// daemon-socket.js) branchent un backend FACTICE qui réimplémente la règle de
// périmètre à la main — ils prouvent le protocole, pas que buildBackend()
// applique correctement la règle. C'est ce que ce fichier prouve :
//   - recent refuse un canal hors session ;
//   - recent refuse un jeton inconnu ;
//   - sessionOpen refuse un canal hors (settings.has ∩ _inScope) AVANT toute
//     création de session ;
//   - sessionOpen ET recent rafraîchissent le plafond (wa.allowlist.refresh(),
//     fix #4) avant de vérifier quoi que ce soit.
//
// Couvre aussi (revue #13) le critère central de la fiche : la capture continue
// SANS AUCUN client socket connecté — on ingère directement via le faux `wa`,
// jamais via serveDaemon()/une socket, et on lit le résultat par le backend.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildBackend } from "../src/daemon.js";
import { SessionRegistry } from "../src/sessions.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

// Faux `wa` : assez de surface pour buildBackend(), rien de plus. `_ingest` imite
// la vraie garde de whatsapp.js#_ingest (grant ET plafond exigés) sans Baileys ni
// disque — juste un Map en mémoire, pour prouver le CIRCUIT, pas le stockage.
function fakeWa({ hasGrant = () => true, inScope = () => true } = {}) {
  const messagesByJid = new Map();
  const allowlistRefreshCalls = { count: 0 };
  const wa = {
    knownGroups: new Map([
      ["a@g.us", "Groupe A"],
      ["b@g.us", "Groupe B"],
    ]),
    settings: { has: (jid) => hasGrant(jid) },
    allowlist: {
      refresh: () => {
        allowlistRefreshCalls.count += 1;
      },
    },
    _inScope: (jid) => inScope(jid),
    // Le démon attend un JID exact (finding #6, skipped) : le frontend résout déjà
    // les noms. Identité ici, comme le contrat le prévoit pour ce backend.
    _resolveToJid: (channel) => channel,
    recentFor(jid, limit = 50) {
      const all = messagesByJid.get(jid) || [];
      return { jid, subject: wa.knownGroups.get(jid), messages: all.slice(-limit), buffered: all.length };
    },
    // API d'ingestion factice (équivalent de whatsapp.js#_ingest) : SANS AUCUN
    // client socket connecté, un message entrant est capturé s'il passe grant ∩
    // plafond — exactement la garde vérifiée ailleurs par sessionOpen/recent.
    _ingest(jid, text) {
      if (!wa.settings.has(jid) || !wa._inScope(jid)) return;
      const all = messagesByJid.get(jid) || [];
      all.push({ id: String(all.length + 1), text });
      messagesByJid.set(jid, all);
    },
  };
  return { wa, allowlistRefreshCalls };
}

function tmpSessionsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-backend-"));
}

async function main() {
  // 1. recent() refuse un canal hors session (session ouverte sur "a@g.us" seul,
  //    demande "b@g.us").
  {
    const { wa } = fakeWa();
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);
    const { session } = await backend.sessionOpen(["a@g.us"]);

    let threw = null;
    try {
      backend.recent(session, "b@g.us", 10);
    } catch (e) {
      threw = e;
    }
    check("recent(canal hors session) -> refuse", threw !== null && /hors périmètre/.test(threw.message));
  }

  // 2. recent() refuse un jeton inconnu.
  {
    const { wa } = fakeWa();
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    let threw = null;
    try {
      backend.recent("0".repeat(32), "a@g.us", 10);
    } catch (e) {
      threw = e;
    }
    check("recent(jeton inconnu) -> refuse", threw !== null && /session invalide/i.test(threw.message));
  }

  // 3. sessionOpen() refuse un canal hors (settings.has ∩ _inScope) AVANT toute
  //    création de session -> aucune session n'existe après le refus.
  {
    const { wa } = fakeWa({ hasGrant: (jid) => jid !== "c@g.us" }); // "c@g.us" jamais grant
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    let threw = null;
    try {
      await backend.sessionOpen(["c@g.us"]);
    } catch (e) {
      threw = e;
    }
    check("sessionOpen(canal hors grants) -> refuse", threw !== null && /hors grants/.test(threw.message));
    check("sessionOpen(canal hors grants) -> AUCUNE session créée", sessions.list().length === 0);
  }

  // 3bis. Même refus quand le canal est grant mais HORS PLAFOND (_inScope false).
  {
    const { wa } = fakeWa({ inScope: (jid) => jid !== "a@g.us" });
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    let threw = null;
    try {
      await backend.sessionOpen(["a@g.us"]);
    } catch (e) {
      threw = e;
    }
    check("sessionOpen(canal hors plafond) -> refuse", threw !== null && /hors grants/.test(threw.message));
    check("sessionOpen(canal hors plafond) -> AUCUNE session créée", sessions.list().length === 0);
  }

  // 4. sessionOpen ET recent rafraîchissent le plafond AVANT de vérifier quoi que
  //    ce soit (fix #4) — un canal retiré d'allowlist.json à la main ne doit pas
  //    rester ouvrable/lisible via un backend qui vérifierait un plafond périmé.
  {
    const { wa, allowlistRefreshCalls } = fakeWa();
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    check("avant tout appel -> allowlist.refresh() jamais appelé", allowlistRefreshCalls.count === 0);
    const { session } = await backend.sessionOpen(["a@g.us"]);
    check("sessionOpen -> a appelé allowlist.refresh()", allowlistRefreshCalls.count === 1);
    backend.recent(session, "a@g.us", 10);
    check("recent -> a de nouveau appelé allowlist.refresh()", allowlistRefreshCalls.count === 2);
  }

  // 5. Critère central de la fiche (revue #13) : la capture continue SANS AUCUN
  //    client socket connecté. On n'appelle ni serveDaemon() ni aucune socket ici
  //    — on ingère directement via le faux `wa`, puis on relit par le backend.
  {
    const { wa } = fakeWa({ hasGrant: (jid) => jid === "a@g.us" }); // "b@g.us" jamais grant
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);
    const { session } = await backend.sessionOpen(["a@g.us"]);

    // Ingestion "sans tête" : aucun client n'a jamais ouvert de connexion socket.
    wa._ingest("a@g.us", "capturé sans client");

    const { messages } = backend.recent(session, "a@g.us", 10);
    check(
      "message ingéré SANS client socket -> retrouvé via recent()",
      messages.length === 1 && messages[0].text === "capturé sans client"
    );

    // Un message hors grant/plafond, lui, n'entre jamais (même garde qu'ailleurs).
    wa._ingest("b@g.us", "jamais autorisé");
    check("message hors grant/plafond -> jamais capturé", wa.recentFor("b@g.us").messages.length === 0);
  }

  console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Erreur test:", e);
  process.exit(1);
});
