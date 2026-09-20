// Contrat NDJSON du démon (ADR-0008, action 2) — PUR : AUCUN import Baileys ici, le
// backend est injecté. C'est ce qui rend le protocole testable À FROID
// (test/daemon-protocol.js), sans jamais toucher WhatsApp.
//
// Transport : une ligne = un objet JSON. Une requête : { verb, secret, ...args }.
// Une réponse : { ok: true, verb, data } ou { ok: false, verb, error }.
//
// Le secret (src/daemon-secret.js) est un garde-fou ANTI-PARASITE, pas une
// authentification (ADR-0008 §5) : toute requête sans le bon secret est refusée ET
// journalisée (`audit`), AVANT tout dispatch vers le backend.
//
// Interface backend attendue (composée par src/daemon.js en réel ; un backend
// factice suffit à ce module et à ses tests) :
//   status()                     -> objet de statut (voir WhatsAppClient#status)
//   listGroups()                 -> objet de liste (voir WhatsAppClient#listGroups)
//   recent(session, jid, limit)  -> { jid, subject, messages, buffered }
//   sessionOpen(channels, ttlMs) -> { session, expiresAt, channels }
//   sessionClose(token)          -> { closed: boolean }
//
// Le périmètre (session ∩ grant ∩ plafond) est vérifié PAR LE BACKEND, à l'intérieur
// de `recent` et `sessionOpen` — ce module ne fait que dispatcher et mettre en forme
// la réponse/l'erreur. C'est ce qui permet de le prouver hermétiquement avec un
// backend factice (test/daemon-protocol.js), comme avec le backend réel (daemon.js).

const VERBS = new Set(["status", "list_groups", "recent", "session_open", "session_close"]);

// `secret` : la valeur attendue. `undefined` désarme la vérification (utile pour un
// appel direct au protocole, ex. tests qui ne veulent pas exercer cette couche).
// `audit(entry)` : appelé UNE fois par refus de secret, jamais pour un verbe inconnu
// ou une erreur métier (ce ne sont pas des tentatives d'accès parasite).
export async function handleRequest(backend, req, { secret, audit } = {}) {
  const verb = req && typeof req === "object" ? req.verb : undefined;

  if (secret !== undefined && req?.secret !== secret) {
    audit?.({
      at: new Date().toISOString(),
      verb: verb ?? null,
      reason: "secret invalide ou absent",
    });
    return { ok: false, verb: verb ?? null, error: "secret invalide ou absent" };
  }

  if (!VERBS.has(verb)) {
    return { ok: false, verb: verb ?? null, error: `verbe inconnu : ${verb}` };
  }

  try {
    const data = await dispatch(backend, verb, req);
    return { ok: true, verb, data };
  } catch (e) {
    return { ok: false, verb, error: e?.message || String(e) };
  }
}

function dispatch(backend, verb, req) {
  switch (verb) {
    case "status":
      return backend.status();
    case "list_groups":
      return backend.listGroups();
    case "recent":
      return backend.recent(req.session, req.jid, req.limit);
    case "session_open":
      return backend.sessionOpen(req.channels, req.ttlMs);
    case "session_close":
      return backend.sessionClose(req.session);
    default:
      // Inatteignable (filtré par VERBS plus haut) — garde-fou de complétude.
      throw new Error(`verbe inconnu : ${verb}`);
  }
}
