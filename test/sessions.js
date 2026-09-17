// Tests de la fiche 20260902223310499 — droits par session.
//
// Trois étages :
//   1. src/sessions.js#SessionRegistry en isolation, sur un tmpdir (comme
//      test/grants.js pour Settings) : création, résolution, purge paresseuse,
//      TTL, révocation, fichier corrompu.
//   2. src/consent.js#buildSessionConsent en isolation (checkPresence injecté,
//      comme test/consent-strongauth.js) : fail-closed Touch ID, fail-closed
//      "pas d'élicitation + drapeau OFF" (SANS repli permissions client, à la
//      différence de buildGrantConsent).
//   3. Le VRAI protocole MCP (spawn du serveur, comme test/mcp-smoke.js) :
//      refus sans session, refus AVANT tout prompt hors grants ∩ plafond, deux
//      jetons deux scopes, canal retiré du plafond suspendu même en session,
//      whatsapp_status(session), session_close.
//
// Le dernier mètre — le prompt Touch ID nommant groupes+durée, constaté depuis
// Code ET Desktop — est non-automatisable par construction (voir
// test/elicitation.js) : relevé humain, DÉFÉRÉ de ce test.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";

import { SessionRegistry, DEFAULT_TTL_MS } from "../src/sessions.js";
import { buildSessionConsent } from "../src/consent.js";
import { TOUCHID } from "../src/touchid.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(__dirname, "..", "src", "index.js");

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

const CHAN = { jid: "120363000000000000@g.us", subject: "Copro Reine Blanche" };

try {
  // ============================================================
  // 1) SessionRegistry — logique pure, tmpdir
  // ============================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-sessions-"));
    const reg = new SessionRegistry(dir, { defaultTtlMs: DEFAULT_TTL_MS });

    check("aucune session au départ", reg.list().length === 0);

    const s1 = reg.create(["a@g.us", "b@g.us"]);
    check("create() renvoie un id 128 bits en hex (32 car.)", /^[a-f0-9]{32}$/.test(s1.id));
    check("create() persiste channels/createdAt/expiresAt/lastSeenAt", Array.isArray(s1.channels) && !!s1.createdAt && !!s1.expiresAt && !!s1.lastSeenAt);
    check("le fichier existe sur disque, 0600", fs.existsSync(path.join(dir, `${s1.id}.json`)));
    const mode = fs.statSync(path.join(dir, `${s1.id}.json`)).mode & 0o777;
    check("fichier de session en mode 0600", mode === 0o600);
    const dirMode = fs.statSync(dir).mode & 0o777;
    check("dossier sessions en mode 0700", dirMode === 0o700);

    const resolved = reg.resolve(s1.id);
    check("resolve() renvoie la session pour un jeton valide", resolved?.id === s1.id);
    check("resolve() renvoie le bon scope", JSON.stringify(resolved.channels) === JSON.stringify(["a@g.us", "b@g.us"]));

    // lastSeenAt avance à chaque résolution réussie.
    const seenAt1 = resolved.lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    const resolved2 = reg.resolve(s1.id);
    check("lastSeenAt avance à chaque résolution", new Date(resolved2.lastSeenAt).getTime() >= new Date(seenAt1).getTime());

    // resolve() est LECTURE SEULE sur disque : il ne réécrit PAS le fichier (revue Codex #25).
    // Réécrire pouvait ressusciter une session fermée entre-temps par un autre process (CLI/
    // MCP) dans la fenêtre lecture→écriture. Preuve : le contenu du fichier ne change pas
    // après un resolve (l'ancien code, qui persistait lastSeenAt, faisait échouer ce test).
    const s1file = path.join(dir, `${s1.id}.json`);
    const contentBeforeResolve = fs.readFileSync(s1file, "utf8");
    reg.resolve(s1.id);
    check(
      "resolve() ne réécrit pas le fichier (lecture seule, anti-résurrection)",
      fs.readFileSync(s1file, "utf8") === contentBeforeResolve
    );

    check("resolve() d'un jeton inconnu -> null (fail-closed)", reg.resolve("f".repeat(32)) === null);
    check("resolve() d'un jeton mal formé -> null (fail-closed)", reg.resolve("../../etc/passwd") === null);
    check("resolve() d'un jeton vide/undefined -> null", reg.resolve() === null && reg.resolve("") === null);

    // Jeton expiré : purge paresseuse à la résolution.
    const shortLived = reg.create(["c@g.us"], 5); // 5ms
    await new Promise((r) => setTimeout(r, 30));
    check("jeton expiré -> resolve() refuse", reg.resolve(shortLived.id) === null);
    check("jeton expiré -> purgé du disque (purge paresseuse)", !fs.existsSync(path.join(dir, `${shortLived.id}.json`)));

    // close() : révocation, sans cérémonie.
    const s2 = reg.create(["d@g.us"]);
    check("close() d'un jeton existant -> true", reg.close(s2.id) === true);
    check("après close(), resolve() refuse", reg.resolve(s2.id) === null);
    check("close() d'un jeton déjà fermé -> false", reg.close(s2.id) === false);
    check("close() d'un jeton mal formé -> false", reg.close("nope") === false);

    // Fichier corrompu -> refus, fail-closed, et purgé.
    const s3 = reg.create(["e@g.us"]);
    fs.writeFileSync(path.join(dir, `${s3.id}.json`), "{ceci n'est pas du json");
    check("fichier corrompu -> resolve() refuse (fail-closed)", reg.resolve(s3.id) === null);
    check("fichier corrompu -> supprimé après tentative de résolution", !fs.existsSync(path.join(dir, `${s3.id}.json`)));

    // list() : purge opportuniste + tri.
    reg.create(["f@g.us"], 5);
    await new Promise((r) => setTimeout(r, 30));
    const before = reg._ids().length; // inclut l'expirée pas encore balayée
    reg.list();
    const after = reg._ids().length;
    check("list() balaie les sessions expirées (purge opportuniste)", after < before);

    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ============================================================
  // 2) buildSessionConsent — isolation, checkPresence injecté
  // ============================================================
  {
    const build = ({ strongAuth, checkPresence, elicitationSupported, elicitInput }) =>
      buildSessionConsent({
        isStrongAuthEnabled: () => strongAuth,
        checkPresence,
        isElicitationSupported: () => elicitationSupported,
        server: { elicitInput },
      });

    // --- Touch ID ON, succès ---
    let seenReason = null;
    let confirm = build({
      strongAuth: true,
      checkPresence: async ({ reason }) => {
        seenReason = reason;
        return { ok: true, status: TOUCHID.AUTHENTICATED, code: 0 };
      },
      elicitationSupported: false,
    });
    let r = await confirm({ subjects: [CHAN.subject], ttlMs: 8 * 3600000 });
    check("Touch ID ON + succès -> {accepted:true, via:'touchid'}", r.accepted === true && r.via === "touchid");
    check("le motif nomme le groupe ET la durée", seenReason?.includes(CHAN.subject) && /8 h/.test(seenReason));

    // --- Touch ID ON, refusé/absent/timeout -> fail-closed ---
    for (const status of [TOUCHID.REFUSED, TOUCHID.UNAVAILABLE, TOUCHID.ERROR]) {
      confirm = build({
        strongAuth: true,
        checkPresence: async () => ({ ok: false, status }),
        elicitationSupported: false,
      });
      r = await confirm({ subjects: [CHAN.subject], ttlMs: 3600000 });
      check(`Touch ID ON + ${status} -> refus (fail-closed)`, r.accepted === false);
    }

    confirm = build({
      strongAuth: true,
      checkPresence: async () => {
        throw new Error("timeout");
      },
      elicitationSupported: false,
    });
    r = await confirm({ subjects: [CHAN.subject], ttlMs: 3600000 });
    check("Touch ID ON + exception (timeout) -> refus (fail-closed)", r.accepted === false);

    // --- Drapeau OFF, client SANS élicitation -> FAIL-CLOSED (pas de repli permissions) ---
    let elicitCalled = false;
    confirm = build({
      strongAuth: false,
      checkPresence: async () => ({ ok: true, status: TOUCHID.AUTHENTICATED }),
      elicitationSupported: false,
      elicitInput: async () => {
        elicitCalled = true;
        return { action: "accept" };
      },
    });
    r = await confirm({ subjects: [CHAN.subject], ttlMs: 3600000 });
    check(
      "drapeau OFF + client sans élicitation -> refus (FAIL-CLOSED, pas de repli permissions)",
      r.accepted === false && elicitCalled === false
    );

    // --- Drapeau OFF, client AVEC élicitation : accept/decline ---
    confirm = build({ strongAuth: false, elicitationSupported: true, elicitInput: async () => ({ action: "accept" }) });
    r = await confirm({ subjects: [CHAN.subject], ttlMs: 3600000 });
    check("drapeau OFF + élicitation accept -> consenti", r.accepted === true && r.via === "elicitation");

    confirm = build({ strongAuth: false, elicitationSupported: true, elicitInput: async () => ({ action: "decline" }) });
    r = await confirm({ subjects: [CHAN.subject], ttlMs: 3600000 });
    check("drapeau OFF + élicitation decline -> refusé", r.accepted === false);
  }

  // ============================================================
  // 3) Le vrai protocole MCP — serveur spawné, réglages jetables
  // ============================================================
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-sessions-mcp-"));
    const settingsFile = path.join(tmpDir, "settings.json");
    const allowlistFile = path.join(tmpDir, "allowlist.json");
    const strongAuthFile = path.join(tmpDir, "strong-auth.json");
    const sessionsDir = path.join(tmpDir, "sessions");

    // Serveur "appairé" pour tester la couche SESSION : on sème des identifiants Baileys
    // valides marqués registered:true. isRegistered() lit ces creds, PAS les grants (un
    // logout 401 efface auth/ mais garde settings.json — revue Codex #40) : sans ces
    // creds, la garde d'appairage guiderait vers l'appairage avant la logique de session.
    const authDir = path.join(tmpDir, "auth");
    fs.mkdirSync(authDir, { recursive: true });
    const seededCreds = initAuthCreds();
    seededCreds.registered = true;
    fs.writeFileSync(path.join(authDir, "creds.json"), JSON.stringify(seededCreds, BufferJSON.replacer, 2));

    const CHAN_A = "111111111111111111@g.us";
    const CHAN_B = "222222222222222222@g.us";
    const CHAN_UNGRANTED = "333333333333333333@g.us"; // ni grant ni plafond

    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        version: 1,
        grants: [
          { jid: CHAN_A, scope: "read", subject: "Groupe A", grantedAt: new Date().toISOString() },
          { jid: CHAN_B, scope: "read", subject: "Groupe B", grantedAt: new Date().toISOString() },
        ],
      })
    );
    fs.writeFileSync(allowlistFile, JSON.stringify({ version: 1, channels: [CHAN_A, CHAN_B] }));
    fs.writeFileSync(strongAuthFile, JSON.stringify({ enabled: false })); // OFF -> élicitation

    function spawnServer({ declareElicitation }) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        stderr: "ignore",
        env: {
          ...process.env,
          WHATSAPP_AUTH_DIR: authDir,
          WHATSAPP_SETTINGS_FILE: settingsFile,
          WHATSAPP_ALLOWLIST_FILE: allowlistFile,
          WHATSAPP_STRONG_AUTH_FILE: strongAuthFile,
          WHATSAPP_SESSIONS_DIR: sessionsDir,
          WHATSAPP_GROUP_ID: "",
          WHATSAPP_GROUP_NAME: "",
          WHATSAPP_PERSIST: "false",
        },
      });
      const client = new Client(
        { name: "sessions-test", version: "0.0.0" },
        { capabilities: declareElicitation ? { elicitation: {} } : {} }
      );
      let elicitCount = 0;
      if (declareElicitation) {
        client.setRequestHandler(ElicitRequestSchema, async () => {
          elicitCount += 1;
          return { action: "accept", content: {} };
        });
      }
      return { client, transport, elicitCount: () => elicitCount };
    }

    async function call(client, name, args = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = res.content?.[0]?.text || "";
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* message d'erreur brut */
      }
      return { isError: res.isError === true, text, data };
    }

    const { client, transport, elicitCount } = spawnServer({ declareElicitation: true });
    try {
      await client.connect(transport);

      // --- Sans session, get_recent_messages refuse et guide vers session_open ---
      let res = await call(client, "get_recent_messages", { channel: CHAN_A, limit: 5 });
      check(
        "get_recent_messages SANS session -> refus guidant vers session_open",
        res.isError && /session_open/.test(res.text) && /session/i.test(res.text)
      );

      // --- session_open refuse hors grants ∩ plafond, AVANT tout prompt ---
      const beforeElicit = elicitCount();
      res = await call(client, "session_open", { channels: [CHAN_UNGRANTED] });
      check("session_open hors grants ∩ plafond -> refus", res.isError === true);
      check(
        "session_open hors grants ∩ plafond -> AUCUN prompt déclenché (vérifié AVANT le consentement)",
        elicitCount() === beforeElicit
      );
      // Anti-oracle (revue Codex #25) : le refus ne renvoie QUE l'entrée fournie par
      // l'appelant, jamais un JID résolu via knownGroups. Ici l'entrée EST un JID (l'appelant
      // le connaît déjà) → il peut apparaître ; la scène nom→JID masqué exige un knownGroups
      // peuplé (connexion réelle), non simulable hermétiquement — garantie par construction
      // (on n'écho jamais `_resolveToJid(input)`, seulement `input`).
      check(
        "session_open refusé -> réécho l'entrée fournie (pas d'autre identifiant divulgué)",
        res.text.includes(CHAN_UNGRANTED)
      );

      // --- session_open réussit (élicitation, drapeau OFF) : deux jetons, deux scopes ---
      res = await call(client, "session_open", { channels: [CHAN_A] });
      check("session_open(A) réussit via élicitation", !res.isError && !!res.data?.session);
      const sessionA = res.data.session;
      check("session_open(A) renvoie expiresAt et channels", !!res.data.expiresAt && Array.isArray(res.data.channels));

      res = await call(client, "session_open", { channels: [CHAN_B] });
      check("session_open(B) réussit via élicitation", !res.isError && !!res.data?.session);
      const sessionB = res.data.session;
      check("deux session_open successifs -> deux jetons DIFFÉRENTS", sessionA !== sessionB);

      // Lecture croisée refusée.
      res = await call(client, "get_recent_messages", { session: sessionA, channel: CHAN_B });
      check(
        "jeton A + canal B -> lecture croisée REFUSÉE",
        res.isError && /périmètre/i.test(res.text)
      );

      // Chaque jeton lit dans SON scope (canal omis, un seul canal dans la session).
      res = await call(client, "get_recent_messages", { session: sessionA });
      check("jeton A, canal omis -> lit A (session mono-canal)", !res.isError && res.data?.channel?.jid === CHAN_A);
      res = await call(client, "get_recent_messages", { session: sessionB });
      check("jeton B, canal omis -> lit B (session mono-canal)", !res.isError && res.data?.channel?.jid === CHAN_B);

      // --- whatsapp_status(session) : scope + expiration ; sans jeton : compte, jamais le contenu ---
      res = await call(client, "whatsapp_status", { session: sessionA });
      check(
        "whatsapp_status(sessionA) montre le scope + expiration",
        !res.isError && typeof res.data?.session === "object" && res.data.session.channels.some((c) => c.jid === CHAN_A)
      );

      res = await call(client, "whatsapp_status", {});
      check(
        "whatsapp_status() SANS jeton -> « aucune session » + nombre de sessions actives",
        !res.isError && res.data?.session === "aucune session" && res.data.activeSessions === 2
      );

      res = await call(client, "whatsapp_status", { session: "f".repeat(32) });
      check(
        "whatsapp_status(jeton invalide) -> même comportement que sans jeton (jamais le contenu d'autrui)",
        !res.isError && res.data?.session === "aucune session" && typeof res.data.activeSessions === "number"
      );

      // Note : `list_groups` exige une connexion WhatsApp active (groupFetchAllParticipating)
      // même sans le paramètre `session` — non exerçable dans ce test hermétique sans
      // appairage réel (comme test/mcp-smoke.js, qui ne le teste pas non plus). Le marquage
      // `inSession` qu'il ajoute est un branchement direct, à même le code de test 3 :
      // `sessionChannels.has(g.id)` sur un Set construit depuis `sessions.resolve(...)`.

      // --- Canal retiré du plafond -> suspendu même en session (relecture à chaud) ---
      fs.writeFileSync(allowlistFile, JSON.stringify({ version: 1, channels: [CHAN_B] })); // A retiré
      res = await call(client, "get_recent_messages", { session: sessionA });
      check(
        "canal A retiré du plafond -> lecture SUSPENDUE même avec une session valide dessus",
        res.isError && /suspendu/i.test(res.text)
      );
      fs.writeFileSync(allowlistFile, JSON.stringify({ version: 1, channels: [CHAN_A, CHAN_B] })); // restauré

      // --- session_close : révocation effective immédiatement (même connexion) ---
      res = await call(client, "session_close", { session: sessionB });
      check("session_close(B) -> closed:true", !res.isError && res.data?.closed === true);
      res = await call(client, "get_recent_messages", { session: sessionB });
      check("après session_close(B), lire avec B -> refus (expirée/close)", res.isError && /fermée|expirée|invalide/i.test(res.text));

      // A est resté valide entre-temps (isolation : fermer B n'affecte pas A).
      res = await call(client, "get_recent_messages", { session: sessionA });
      check("session_close(B) n'affecte pas la session A", !res.isError);
    } finally {
      try {
        await client.close();
      } catch {}
    }

    // --- Client SANS élicitation, drapeau OFF -> FAIL-CLOSED (aucune session ouverte) ---
    const { client: client2, transport: transport2 } = spawnServer({ declareElicitation: false });
    try {
      await client2.connect(transport2);
      const res = await call(client2, "session_open", { channels: [CHAN_A] });
      check(
        "client SANS élicitation + drapeau OFF -> session_open FAIL-CLOSED",
        res.isError === true && !res.data?.session
      );
    } finally {
      try {
        await client2.close();
      } catch {}
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
