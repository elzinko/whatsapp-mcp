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

  // 6. grant/revoke : le backend délègue à wa.grantChannel/revokeChannel, et le démon
  //    ne demande JAMAIS de consentement (wa.confirmGrant est null — le geste humain vit
  //    au frontend, ADR-0008 §3/§5). On prouve la délégation ET l'absence de prompt.
  {
    const calls = [];
    const wa = {
      confirmGrant: null,
      allowlist: { refresh() {} },
      async grantChannel(channel) {
        calls.push(["grant", channel]);
        // Un démon qui présenterait un prompt serait un bug de frontière : ici
        // confirmGrant DOIT rester null (le consentement est au frontend).
        if (wa.confirmGrant) throw new Error("le démon ne doit jamais demander de consentement");
        return { jid: channel, subject: "Groupe A", scope: "read", granted: true };
      },
      revokeChannel(channel) {
        calls.push(["revoke", channel]);
        return { jid: channel, subject: "Groupe A", revoked: true };
      },
    };
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    const g = await backend.grant("a@g.us");
    check(
      "backend.grant délègue à wa.grantChannel (sans consentement)",
      calls[0]?.[0] === "grant" && calls[0]?.[1] === "a@g.us" && g.granted === true
    );

    const r = await backend.revoke("a@g.us");
    check(
      "backend.revoke délègue à wa.revokeChannel",
      calls[1]?.[0] === "revoke" && r.revoked === true
    );
  }

  // 7. status(session) : le démon résout le jeton (le registre y vit, #44) et expose
  //    `registered` — ce dont le frontend mince a besoin, faute de connexion et de registre.
  //    Sans jeton : le NOMBRE de sessions actives ; avec un jeton valide : SON scope seul.
  {
    const { wa } = fakeWa({ hasGrant: (jid) => jid === "a@g.us" });
    wa.status = () => ({ state: "open", readOnly: true, grantedChannels: [] });
    wa.isRegistered = () => true;
    wa.settings.grants = new Map([["a@g.us", { subject: "Groupe A" }]]);
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    const { session } = await backend.sessionOpen(["a@g.us"]);

    const withTok = backend.status(session);
    check("status(jeton valide) -> registered exposé", withTok.registered === true);
    check(
      "status(jeton valide) -> SON scope (channels résolus avec subject)",
      Array.isArray(withTok.session?.channels) &&
        withTok.session.channels[0].jid === "a@g.us" &&
        withTok.session.channels[0].subject === "Groupe A"
    );
    check("status(jeton valide) -> activeSessions OMIS (pas le compte global)", withTok.activeSessions === undefined);

    const noTok = backend.status();
    check("status() sans jeton -> session null + compte de sessions actives", noTok.session === null && noTok.activeSessions === 1);
    check("status() sans jeton -> registered exposé aussi", noTok.registered === true);
  }

  // 8. session_check : valide sans créer de session (le prompt suit, côté frontend).
  {
    const { wa } = fakeWa({ hasGrant: (jid) => jid === "a@g.us" });
    wa.settings.grants = new Map([["a@g.us", { subject: "Groupe A" }]]);
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);

    const okc = backend.sessionCheck(["a@g.us"]);
    check(
      "sessionCheck(ok) -> {jid,subject} résolu, AUCUNE session créée",
      okc.channels[0].jid === "a@g.us" && okc.channels[0].subject === "Groupe A" && sessions.list().length === 0
    );

    let threw = null;
    try {
      backend.sessionCheck(["b@g.us"]);
    } catch (e) {
      threw = e;
    }
    check("sessionCheck(hors périmètre) -> throw, AUCUNE session créée", threw !== null && sessions.list().length === 0);
  }

  // 9. Bornage par PROFIL (fiche 225) : le démon capte sans profil, mais applique le profil
  //    PASSÉ par le frontend, PAR REQUÊTE. Un canal grant ∩ plafond mais hors profil est refusé.
  {
    const { wa } = fakeWa(); // has & inScope true par défaut -> a et b sont grant ∩ plafond
    wa.settings.grants = new Map([
      ["a@g.us", { subject: "A" }],
      ["b@g.us", { subject: "B" }],
    ]);
    // Profil « copro » ne couvre que a@g.us.
    const profiles = { refresh() {}, permits: (name, jid) => name === "copro" && jid === "a@g.us" };
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions, profiles);

    // Sans profil (le frontend n'en déclare pas) : a ET b passent — INERTE.
    check("session_check sans profil -> tout passe (inerte)", backend.sessionCheck(["a@g.us", "b@g.us"]).channels.length === 2);

    // Avec profil copro : a couvert -> ok ; b hors profil -> refus.
    check("session_check(copro, canal du profil) -> ok", backend.sessionCheck(["a@g.us"], "copro").channels[0].jid === "a@g.us");
    let threw = null;
    try {
      backend.sessionCheck(["b@g.us"], "copro");
    } catch (e) {
      threw = e;
    }
    check("session_check(copro, canal HORS profil) -> refus", threw !== null);

    // sessionOpen respecte aussi le profil (aucune session créée sur un refus).
    let threw2 = null;
    try {
      await backend.sessionOpen(["b@g.us"], undefined, "copro");
    } catch (e) {
      threw2 = e;
    }
    check("sessionOpen(copro, hors profil) -> refus + aucune session", threw2 !== null && sessions.list().length === 0);

    const s = await backend.sessionOpen(["a@g.us"], undefined, "copro");
    check("sessionOpen(copro, canal du profil) -> session créée", !!s.session);
    check("recent(copro, canal du profil) -> lit le canal", backend.recent(s.session, "a@g.us", 10, "copro").jid === "a@g.us");
  }

  // 10. pair : le backend délègue à wa.requestPairingCode (le démon tient Baileys, fiche 225).
  //     Le frontend PROPOSE (élicite le numéro), le démon EXÉCUTE — jamais l'inverse (ADR-0005).
  {
    let seen = null;
    const wa = {
      requestPairingCode: async (phone) => {
        seen = phone;
        return "ABCD-1234";
      },
    };
    const sessions = new SessionRegistry(tmpSessionsDir());
    const backend = buildBackend(wa, sessions);
    const r = await backend.pair("+33612345678");
    check(
      "backend.pair délègue à wa.requestPairingCode et renvoie le code",
      seen === "+33612345678" && r.code === "ABCD-1234"
    );
  }

  console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("Erreur test:", e);
  process.exit(1);
});
