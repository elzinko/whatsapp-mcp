// Tests du contrat NDJSON du démon (ADR-0008, action 2), fiche 20260917211902097.
// PUR : aucune connexion Baileys, aucune socket — juste handleRequest(backend, req)
// avec un BACKEND FACTICE qui reproduit le périmètre (session ∩ grant ∩ plafond)
// exactement comme le fera le backend réel (daemon.js). Couvre :
//   - les 5 verbes du contrat ;
//   - secret requis, refus journalisé sans secret / avec un mauvais secret ;
//   - enforcement session ∩ grant ∩ plafond dans `recent` et `session_open`.

import { handleRequest } from "../src/daemon-protocol.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

// Backend factice : réimplémente en mémoire grants ∩ plafond ∩ sessions, sans aucune
// dépendance à sessions.js/whatsapp.js — juste assez pour prouver que le protocole
// applique bien le périmètre attendu par l'ADR, verbe par verbe.
function fakeBackend({ grants = [], ceiling = grants } = {}) {
  const grantSet = new Set(grants);
  const ceilingSet = new Set(ceiling);
  const messages = new Map(); // jid -> messages[]
  const sessions = new Map(); // token -> { channels, expiresAt }
  let nextTokenId = 1;

  function inScope(jid) {
    return grantSet.has(jid) && ceilingSet.has(jid);
  }

  return {
    status() {
      return { state: "open", connected: true, grantedChannels: [...grantSet] };
    },
    listGroups() {
      return { groups: [...ceilingSet].map((jid) => ({ id: jid })) };
    },
    recent(token, jid, limit) {
      const session = sessions.get(token);
      if (!session) throw new Error("session invalide, expirée ou fermée");
      const targetJid = jid || (session.channels.length === 1 ? session.channels[0] : null);
      if (!targetJid) throw new Error("plusieurs canaux dans la session : précise 'jid'");
      if (!session.channels.includes(targetJid)) throw new Error("hors périmètre de la session");
      if (!inScope(targetJid)) throw new Error("canal suspendu : hors grants ∩ plafond");
      return { jid: targetJid, messages: (messages.get(targetJid) || []).slice(0, limit ?? 50) };
    },
    sessionOpen(channels, ttlMs) {
      const denied = (channels || []).filter((jid) => !inScope(jid));
      if (denied.length > 0) throw new Error(`hors grants ∩ plafond : ${denied.join(", ")}`);
      const token = `tok${nextTokenId++}`;
      const expiresAt = new Date(Date.now() + (ttlMs ?? 3600000)).toISOString();
      sessions.set(token, { channels: [...channels], expiresAt });
      return { session: token, expiresAt, channels: [...channels] };
    },
    sessionClose(token) {
      return { closed: sessions.delete(token) };
    },
    // Aides de test, hors contrat.
    _seedMessages: (jid, msgs) => messages.set(jid, msgs),
  };
}

try {
  // ============================================================
  // 1) Les 5 verbes, sans secret (couche désarmée) — heureux chemin
  // ============================================================
  {
    const backend = fakeBackend({ grants: ["a@g.us"] });
    backend._seedMessages("a@g.us", [{ id: "1", text: "hello" }]);

    let res = await handleRequest(backend, { verb: "status" });
    check("status -> ok:true", res.ok === true && res.verb === "status");
    check("status -> renvoie les données du backend", res.data.state === "open");

    res = await handleRequest(backend, { verb: "list_groups" });
    check("list_groups -> ok:true", res.ok === true);
    check("list_groups -> renvoie les groupes du backend", res.data.groups.length === 1);

    res = await handleRequest(backend, { verb: "session_open", channels: ["a@g.us"] });
    check("session_open -> ok:true", res.ok === true && !!res.data.session);
    const token = res.data.session;

    res = await handleRequest(backend, { verb: "recent", session: token, jid: "a@g.us" });
    check("recent -> ok:true, messages du canal en session", res.ok === true && res.data.messages.length === 1);

    res = await handleRequest(backend, { verb: "session_close", session: token });
    check("session_close -> ok:true, closed:true", res.ok === true && res.data.closed === true);

    res = await handleRequest(backend, { verb: "recent", session: token, jid: "a@g.us" });
    check("recent après session_close -> refus (session invalide)", res.ok === false && /session/.test(res.error));
  }

  // ============================================================
  // 2) Verbe inconnu -> refus explicite, sans toucher le backend
  // ============================================================
  {
    const backend = fakeBackend();
    const res = await handleRequest(backend, { verb: "send_message" });
    check("verbe inconnu -> ok:false", res.ok === false);
    check("verbe inconnu -> message explicite", /verbe inconnu/.test(res.error));
  }

  // ============================================================
  // 3) Secret requis : absent / faux -> refus + audit ; correct -> passe
  // ============================================================
  {
    const backend = fakeBackend();
    const audits = [];
    const audit = (entry) => audits.push(entry);
    const secret = "s3cr3t";

    let res = await handleRequest(backend, { verb: "status" }, { secret, audit });
    check("secret absent -> refus", res.ok === false && /secret/.test(res.error));
    check("secret absent -> une ligne d'audit journalisée", audits.length === 1);
    check("l'audit porte le verbe demandé", audits[0].verb === "status");

    res = await handleRequest(backend, { verb: "status", secret: "faux" }, { secret, audit });
    check("mauvais secret -> refus", res.ok === false && /secret/.test(res.error));
    check("mauvais secret -> une 2e ligne d'audit", audits.length === 2);

    res = await handleRequest(backend, { verb: "status", secret }, { secret, audit });
    check("bon secret -> accepté", res.ok === true);
    check("bon secret -> aucun audit supplémentaire", audits.length === 2);
  }

  // ============================================================
  // 4) Enforcement session ∩ grant ∩ plafond, appliqué DANS `recent`
  // ============================================================
  {
    // Canal A : grant + plafond (dans le périmètre). Canal B : grant seul, retiré du
    // plafond (suspendu, cf. ADR-0002 §6 / whatsapp.js#_inScope).
    const backend = fakeBackend({ grants: ["a@g.us", "b@g.us"], ceiling: ["a@g.us"] });
    backend._seedMessages("a@g.us", [{ id: "1" }]);
    backend._seedMessages("b@g.us", [{ id: "2" }]);

    let res = await handleRequest(backend, { verb: "session_open", channels: ["a@g.us"] });
    const tokenA = res.data.session;

    res = await handleRequest(backend, { verb: "session_open", channels: ["b@g.us"] });
    check("session_open sur un canal suspendu (hors plafond) -> refus", res.ok === false);

    // Une session ouverte de force sur A pour prouver l'isolation croisée : on ne peut
    // PAS lire un canal hors du périmètre de LA SESSION, même s'il est par ailleurs
    // autorisé ailleurs.
    res = await handleRequest(backend, { verb: "recent", session: tokenA, jid: "b@g.us" });
    check("recent(tokenA, canal B) -> refus, hors périmètre de la session", res.ok === false && /périmètre/.test(res.error));

    res = await handleRequest(backend, { verb: "recent", session: tokenA, jid: "a@g.us" });
    check("recent(tokenA, canal A) -> autorisé (dans la session ∩ grant ∩ plafond)", res.ok === true);

    res = await handleRequest(backend, { verb: "recent", session: "jeton-inconnu", jid: "a@g.us" });
    check("recent avec un jeton inconnu -> refus", res.ok === false);
  }
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
