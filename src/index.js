#!/usr/bin/env node
// Serveur MCP (stdio) — FRONTEND MINCE (fiche 20260917211902225, ADR-0008).
//
// Il n'ouvre JAMAIS WhatsApp : il parle au DÉMON (src/daemon.js) par une socket Unix
// locale (contrat NDJSON, src/daemon-protocol.js). Le démon détient Baileys, la capture,
// le plafond, les grants et le registre de sessions. ICI vivent : le protocole MCP, le
// CONSENTEMENT humain (Touch ID / élicitation — au plus près du client), la mise en forme
// des réponses. Aucune connexion WhatsApp, aucun verrou auth/ (le démon le tient).
//
// Lecture seule (ADR-0001) : aucun outil d'envoi n'existe.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { buildConfirmGrant, buildGrantConsent, buildSessionConsent } from "./consent.js";
import { buildGuidedPairingRefusal, buildPairingFlow } from "./pairing.js";
import { readStrongAuthEnabled } from "./strongauth.js";
import { checkPresence } from "./touchid.js";
import { toRecentMessage, log } from "./whatsapp.js";
import { deployedStateRoot } from "./setup.js";
import { request, ensureDaemonRunning } from "./daemon-client.js";
import { readOrCreateSecret } from "./daemon-secret.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, "daemon.js");

// Secret partagé local (ADR-0008 §5) : le frontend et le démon lisent le MÊME fichier
// 0600 au state root (dérivé du même config). Garde-fou anti-parasite, PAS une auth.
const secret = readOrCreateSecret(config.daemonSecretFile);

// ensureDaemonRunning PARESSEUX : on ne réveille le démon qu'au PREMIER appel qui en a
// besoin. Un outil purement local (whatsapp_help) n'en spawn aucun. Mémoïsé — une seule
// garantie par process de frontend.
let daemonReady = null;
function ensureDaemon() {
  if (!daemonReady) {
    daemonReady = ensureDaemonRunning({
      socketPath: config.daemonSocket,
      secret,
      logFile: config.daemonLogFile,
      daemonScript: DAEMON_SCRIPT,
    });
  }
  return daemonReady;
}

// Un appel au démon : garantit qu'il tourne, envoie la requête NDJSON, déballe la réponse
// { ok, data, error }. Une erreur métier du démon (hors périmètre, session invalide…)
// remonte comme une exception, rattrapée par le handler d'outil (fail()).
async function callDaemon(verb, args = {}) {
  await ensureDaemon();
  const res = await request(config.daemonSocket, { verb, secret, ...args });
  if (!res) throw new Error("Le démon ne répond pas (socket locale injoignable).");
  if (!res.ok) throw new Error(res.error || `Échec du verbe « ${verb} ».`);
  return res.data;
}

// « Rien n'est appairé » : le démon dit s'il a des identifiants WhatsApp (registered).
async function nothingPairedYet() {
  const d = await callDaemon("status");
  return d?.registered !== true;
}

function humanDuration(ms) {
  if (ms % 3600000 === 0) return `${ms / 3600000} h`;
  if (ms % 60000 === 0) return `${ms / 60000} min`;
  return `${Math.round(ms / 1000)} s`;
}

// Aide concise (fiche 0011) — MODÈLE MENTAL + indirection vers le README. Rendue localement,
// aucun appel démon. (Texte inchangé depuis le monolithe.)
const HELP_TEXT = `whatsapp-mcp — aide

CE QUE C'EST
Serveur MCP en LECTURE SEULE sur tes groupes WhatsApp. Il n'envoie jamais de message :
aucun outil d'envoi n'existe (propriété du code, pas un réglage). But : minimisation de
données — seuls les groupes que tu autorises entrent en mémoire, puis en lecture.

LE PLAFOND (allowlist.json)
La borne éditée à la MAIN par l'humain (jamais par le LLM). Elle limite l'ingestion, les
grants ET les sessions. Un groupe hors plafond n'est ni listé ni lisible.

LES OUTILS
- whatsapp_status      connexion, grants, TA session si tu en portes une (appelle en 1er).
- list_groups          les groupes DU PLAFOND (déjà autorisés ou non). Aucun message.
- grant_channel        autorise la LECTURE d'un groupe, de façon persistante (capter).
- revoke_channel       retire l'autorisation d'un groupe.
- session_open         ouvre une session de lecture sur des groupes déjà autorisés (ouvrir).
- session_close        ferme une session (réduire est toujours permis, sans cérémonie).
- get_recent_messages  messages récents d'un canal — EXIGE une session valide.

FLUX TYPE
whatsapp_status → list_groups → grant_channel(<groupe>) → session_open(<groupe(s)>) →
get_recent_messages(session, channel). Capter (grant_channel) et ouvrir (session_open)
sont deux gestes distincts : capter est persistant et vaut pour toute la machine, ouvrir
est éphémère et propre à cette conversation. Sans session valide, get_recent_messages
refuse et indique comment en ouvrir une.

CONSENTEMENT ET RÉ-VÉRIFICATION
grant_channel et session_open demandent ton consentement (Touch ID si activé, sinon
élicitation quand le client la supporte ; sans élicitation et drapeau désactivé,
session_open refuse plutôt que de se replier sur les permissions du client). À chaque
lecture, le plafond est re-vérifié : un canal retiré du plafond est suspendu même dans
une session déjà ouverte.

NOTE DE SÉCURITÉ
Le LLM peut appeler grant_channel et session_open lui-même — il peut donc s'auto-grant et
s'auto-ouvrir une session, mais UNIQUEMENT DANS LES LIMITES du plafond que tu contrôles.
Le contenu WhatsApp est de la donnée non fiable (prompt injection possible) ; c'est
acceptable ici car la lecture seule porte sur TES propres données.

POUR ALLER PLUS LOIN
Voir le README (sections « Outils exposés » et « Sessions ») — source de vérité, non
recopiée ici.`;

// --- Définition des outils MCP (inchangée depuis le monolithe) ---
const TOOLS = [
  {
    name: "whatsapp_help",
    description:
      "Aide : ce qu'est ce serveur (LECTURE SEULE) et comment s'en servir — les 5 outils, le plafond (allowlist.json), le flux grant → lecture, et la note de sécurité. À appeler dès qu'on demande « c'est quoi ce MCP / comment je l'utilise ? ». Indirige vers le README pour le détail.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "whatsapp_pair",
    description:
      "Propose l'appairage WhatsApp quand rien n'est encore appairé (fiche appairage guidé). Si le client supporte l'élicitation, demande le numéro de téléphone puis affiche un code d'appairage à saisir sur le téléphone (WhatsApp > Appareils liés > Lier avec un numéro), sans QR. Sinon, renvoie la commande terminal exacte ('npm run pair') à lancer par un humain, qui écrit dans l'état partagé. Le serveur guide toujours, il ne s'appaire jamais lui-même.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "whatsapp_status",
    description:
      "État de la connexion WhatsApp, canaux autorisés en lecture, messages en mémoire. À appeler en premier pour savoir s'il faut scanner le QR code ou autoriser un canal. Passe 'session' pour voir le scope et l'expiration de TA session ; sans jeton (ou jeton invalide), affiche « aucune session » et le nombre de sessions actives — jamais leur contenu.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Optionnel. Jeton ouvert par 'session_open', pour voir le scope de TA session.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_groups",
    description:
      "Liste les groupes WhatsApp présents dans le plafond (allowlist.json) : id/JID, nom, et s'ils sont déjà autorisés en lecture. C'est le menu des canaux activables. Les groupes hors plafond ne sont PAS listés (seul leur nombre est indiqué) : pour les découvrir, l'humain lance « npm run list-groups » dans un terminal et édite le plafond à la main. Ne renvoie aucun message. Passe 'session' pour marquer 'inSession' les groupes couverts par TA session.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Optionnel. Jeton ouvert par 'session_open', pour marquer 'inSession'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "grant_channel",
    description:
      "Autorise la LECTURE d'un groupe, de façon persistante (survit aux redémarrages). Borné par le plafond (allowlist.json, édité à la main par l'humain — hors plafond, refus systématique) et soumis au consentement de l'humain (formulaire d'élicitation si le client le supporte). N'accorde jamais le droit d'écrire : ce serveur ne peut pas envoyer de message. Utilise 'list_groups' avant pour connaître les noms/JID exacts et le champ 'inAllowlist'.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          minLength: 1,
          description: "JID du groupe (…@g.us) ou son nom exact.",
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "revoke_channel",
    description:
      "Retire l'autorisation de lecture d'un groupe. Les messages déjà archivés sur disque ne sont pas supprimés.",
    inputSchema: {
      type: "object",
      properties: {
        channel: {
          type: "string",
          minLength: 1,
          description: "JID du groupe (…@g.us) ou son nom exact.",
        },
      },
      required: ["channel"],
      additionalProperties: false,
    },
  },
  {
    name: "get_recent_messages",
    description:
      "Messages récents d'UN canal, du plus ancien au plus récent. EXIGE une session valide ('session', ouverte par 'session_open') : sans jeton, ou jeton hors périmètre pour ce canal, refus qui explique comment ouvrir une session. Si la session ne porte qu'un seul canal, 'channel' est optionnel. Pour analyser plusieurs canaux, appeler cet outil une fois par canal.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          minLength: 1,
          description: "Jeton ouvert par 'session_open'. Obligatoire.",
        },
        channel: {
          type: "string",
          description: "JID (…@g.us) ou nom exact, DANS le périmètre de la session. Optionnel si la session ne porte qu'un seul canal.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Nombre max de messages à renvoyer (défaut 50).",
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "session_open",
    description:
      "Ouvre une session de lecture : un jeton porté à chaque appel de 'get_recent_messages', qui isole cette conversation des autres. Les canaux doivent DÉJÀ être autorisés (grant_channel) et dans le plafond — sinon refus, AVANT toute demande de consentement. Demande ensuite ton consentement (Touch ID si activé, sinon élicitation ; sans élicitation et drapeau désactivé, refus). Capter (grant_channel) et ouvrir (session_open) sont deux gestes distincts.",
    inputSchema: {
      type: "object",
      properties: {
        channels: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          description: "JID(s) (…@g.us) ou nom(s) exact(s) de groupe(s) déjà autorisés.",
        },
        ttlMs: {
          type: "integer",
          minimum: 1000,
          description: "Durée de vie en millisecondes (défaut : 8h, surchargeable par WHATSAPP_SESSION_TTL_MS).",
        },
      },
      required: ["channels"],
      additionalProperties: false,
    },
  },
  {
    name: "session_close",
    description:
      "Ferme une session (révocation du jeton présenté). Réduire est toujours permis : pas de consentement supplémentaire.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", minLength: 1, description: "Jeton à fermer." },
      },
      required: ["session"],
      additionalProperties: false,
    },
  },
];

// Racine d'état à PORTER dans le repli terminal d'appairage (voie 2) : renseignée seulement
// si le connecteur demandeur n'est PAS sur la racine par défaut (rail dev). undefined = défaut.
const pairStateRoot = deployedStateRoot() === deployedStateRoot({}) ? undefined : deployedStateRoot();

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message) {
  return { content: [{ type: "text", text: `Erreur : ${message}` }], isError: true };
}

const server = new Server(
  { name: "whatsapp-mcp", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// Le client supporte-t-il l'élicitation ? Négocié à l'initialisation MCP.
let clientSupportsElicitation = false;

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "whatsapp_help":
        return { content: [{ type: "text", text: HELP_TEXT }] };

      case "whatsapp_pair": {
        // Un grant persisté prouve un appairage passé : en reconnexion, on ne re-sollicite pas.
        if (!(await nothingPairedYet())) {
          return ok({ route: "already-paired", message: "WhatsApp est déjà appairé. Rien à faire." });
        }
        const result = await pairingFlow();
        if (result.route === "declined") {
          return fail(`Appairage refusé par l'humain (${result.reason}).`);
        }
        // Interim (fiche 225) : le verbe d'appairage démon n'est pas encore câblé. La voie
        // terminal (repli) guide toujours ; la voie élicitation lèvera si tentée.
        return ok(result);
      }

      case "whatsapp_status": {
        const d = await callDaemon("status", args.session ? { session: args.session } : {});
        const grantConsent = readStrongAuthEnabled(config.strongAuthFile)
          ? "Touch ID (présence physique — hiérarchie ADR-0003)"
          : clientSupportsElicitation
            ? "élicitation (formulaire rédigé par le serveur, hors de portée du LLM)"
            : "permissions du client MCP (le client ne supporte pas l'élicitation)";
        // Le démon calcule déjà `session` (scope ou null) et `activeSessions` (omis si un
        // jeton valide est porté — jamais le compte global à une conversation identifiée).
        const { session: daemonSession, registered, ...rest } = d;
        return ok({
          version: config.deployedVersion,
          ...rest,
          grantConsent,
          session: daemonSession ? daemonSession : "aucune session",
        });
      }

      case "list_groups": {
        if (await nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        const d = await callDaemon("list_groups", { profile: config.profile });
        let groups = d.groups;
        // Marquage inSession : le registre vit côté démon — on relit le scope du jeton via
        // status(session) plutôt que de tenir un registre local.
        if (args.session) {
          const st = await callDaemon("status", { session: args.session });
          const inSession = new Set((st.session?.channels || []).map((c) => c.jid));
          groups = groups.map((g) => ({ ...g, inSession: inSession.has(g.id) }));
        }
        const notes = [];
        if (d.hiddenOutsideAllowlist > 0)
          notes.push(
            `${d.hiddenOutsideAllowlist} autre(s) groupe(s) existent mais sont hors du plafond : ils ne ` +
              `sont pas listables ici. Pour les voir et relever leur JID, l'humain lance ` +
              `« npm run list-groups » dans un terminal, puis ajoute l'entrée à la main dans ${config.allowlistFile}.`
          );
        if (d.hiddenOutsideProfile > 0)
          notes.push(
            `${d.hiddenOutsideProfile} groupe(s) sont AU plafond mais hors du profil actif` +
              (config.profile ? ` « ${config.profile} »` : "") +
              ` : pour les voir dans ce projet, ajoute-les à ce profil dans ${config.profilesFile} ` +
              `(inutile de toucher au plafond, ils y sont déjà).`
          );
        return ok({
          count: groups.length,
          groups,
          hiddenOutsideAllowlist: d.hiddenOutsideAllowlist,
          hiddenOutsideProfile: d.hiddenOutsideProfile,
          note: notes.length ? notes.join(" ") : undefined,
        });
      }

      case "grant_channel": {
        if (await nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        // Consentement AU FRONTEND (le prompt nomme l'entrée fournie ; le démon connaît et
        // applique le nom réel + le plafond). Puis le verbe `grant`, déjà consenti (ADR-0008 §5).
        const consent = await grantConsent({ jid: args.channel, subject: args.channel });
        if (!consent?.accepted) {
          return fail(
            `Autorisation refusée par l'humain pour « ${args.channel} »` +
              (consent?.reason ? ` (${consent.reason})` : "") +
              ". Le grant n'a pas été accordé."
          );
        }
        return ok(await callDaemon("grant", { channel: args.channel, profile: config.profile }));
      }

      case "revoke_channel":
        return ok(await callDaemon("revoke", { channel: args.channel }));

      case "session_open": {
        if (await nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        const requested = Array.isArray(args.channels) ? args.channels : [];
        if (requested.length === 0) return fail("Fournis au moins un canal ('channels').");

        // 1. Valide le périmètre AVANT tout prompt (le démon refuse hors grants ∩ plafond,
        //    en réécho des entrées fournies — anti-oracle). Refus ici = zéro consentement.
        let checked;
        try {
          checked = await callDaemon("session_check", { channels: requested, profile: config.profile });
        } catch (e) {
          return fail(e?.message || String(e));
        }

        // 2. Consentement (Touch ID / élicitation) — le geste humain vit au frontend.
        const ttlMs = Number.isInteger(args.ttlMs) && args.ttlMs > 0 ? args.ttlMs : config.sessionTtlMs;
        const consent = await sessionConsent({ subjects: checked.channels.map((c) => c.subject), ttlMs });
        if (!consent?.accepted) {
          return fail(`Session refusée par l'humain` + (consent?.reason ? ` (${consent.reason})` : "") + ".");
        }

        // 3. Création côté démon (déjà consentie) : le jeton et son TTL viennent du registre.
        const d = await callDaemon("session_open", { channels: requested, ttlMs, profile: config.profile });
        log(`Session ouverte (${String(d.session).slice(0, 8)}…) : ${checked.channels.map((c) => c.subject).join(", ")} — expire ${d.expiresAt}`);
        return ok({ session: d.session, expiresAt: d.expiresAt, channels: checked.channels });
      }

      case "session_close": {
        if (!args.session) return fail("Fournis le jeton 'session' à fermer.");
        const d = await callDaemon("session_close", { session: args.session });
        return ok({ session: args.session, closed: d.closed });
      }

      case "get_recent_messages": {
        if (await nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        if (!args.session) {
          return fail(
            "Aucune session : cet outil exige un jeton de session. Ouvre-en une avec " +
              "'session_open' (canal déjà autorisé par 'grant_channel'), puis représente son " +
              "jeton dans 'session'."
          );
        }
        const limit = Number.isInteger(args.limit) ? args.limit : 50;
        const d = await callDaemon("recent", { session: args.session, jid: args.channel, limit, profile: config.profile });
        return ok({
          channel: { jid: d.jid, subject: d.subject },
          returned: d.messages.length,
          buffered: d.buffered,
          note:
            d.messages.length === 0
              ? "Aucun message en mémoire pour ce canal. Le tampon se remplit avec l'historique reçu à la connexion et les nouveaux messages."
              : undefined,
          messages: d.messages.map(toRecentMessage),
        });
      }

      default:
        return fail(`Outil inconnu : ${name}`);
    }
  } catch (err) {
    return fail(err?.message || String(err));
  }
});

// L'élicitation est la seule façon d'afficher une question RÉDIGÉE PAR LE SERVEUR, dont la
// réponse ne transite jamais par le LLM (ADR-0002). Le consentement vit ICI, au frontend
// (ADR-0008 §3) — au plus près de la personne. Le démon ne présente jamais de prompt.
server.oninitialized = () => {
  const caps = server.getClientCapabilities() || {};
  clientSupportsElicitation = !!caps.elicitation;
  log("Client MCP connecté. Capabilities:", JSON.stringify(caps));
  log("Elicitation supportée par ce client :", clientSupportsElicitation ? "OUI" : "non");
};

const elicitationConsent = buildConfirmGrant(server, () => clientSupportsElicitation, log);
const grantConsent = buildGrantConsent({
  isStrongAuthEnabled: () => readStrongAuthEnabled(config.strongAuthFile),
  checkPresence,
  elicitationConsent,
  log,
});

// Flux d'appairage guidé (fiche 20260916130039008). INTERIM (fiche 225) : le verbe
// d'appairage démon n'est pas encore câblé — la voie 1 (élicitation, code) lève un message
// clair ; la voie 2 (repli terminal) guide comme avant, sans toucher WhatsApp.
const pairingFlow = buildPairingFlow({
  isElicitationSupported: () => clientSupportsElicitation,
  elicitInput: (params) => server.elicitInput(params),
  requestPairingCode: async () => {
    throw new Error(
      "L'appairage par code via le démon n'est pas encore câblé (fiche 225) — utilise le repli terminal 'npm run pair'."
    );
  },
  currentQrArt: () => null,
  stateRoot: pairStateRoot,
  log,
});

// Consentement de session_open (fiche 20260902223310499) : pas de repli « permissions
// client » (voir consent.js). Le geste humain vit au frontend.
const sessionConsent = buildSessionConsent({
  isStrongAuthEnabled: () => readStrongAuthEnabled(config.strongAuthFile),
  checkPresence,
  isElicitationSupported: () => clientSupportsElicitation,
  server,
  humanDuration,
  log,
});

async function main() {
  // Pas de verrou auth/ ici : le DÉMON le tient (ADR-0008 §4). Le frontend ne touche jamais
  // WhatsApp ni Baileys. On sert le MCP tout de suite ; le démon est réveillé PARESSEUSEMENT
  // au premier appel qui en a besoin (ensureDaemon), pas au démarrage.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Frontend MCP mince prêt (stdio, LECTURE SEULE) — parle au démon:", config.daemonSocket);
}

main().catch((e) => {
  log("Erreur fatale:", e?.message);
  process.exit(1);
});
