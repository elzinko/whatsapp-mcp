#!/usr/bin/env node
// Serveur MCP (stdio) exposant en LECTURE SEULE les groupes WhatsApp explicitement
// autorisés. Voir docs/adr/0001-modele-d-acces-aux-canaux.md
//
// Deux barrières :
//   1. l'ingestion ne retient que les canaux autorisés (whatsapp.js#_ingest) ;
//   2. les outils ne lisent que dans ces mêmes canaux.
// Il n'existe aucun outil d'envoi : ce serveur ne peut pas écrire sur WhatsApp.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { config } from "./config.js";
import { Settings } from "./settings.js";
import { Allowlist } from "./allowlist.js";
import { Profiles } from "./profiles.js";
import { buildConfirmGrant, buildGrantConsent, buildSessionConsent } from "./consent.js";
import { buildGuidedPairingRefusal, buildPairingFlow } from "./pairing.js";
import { readStrongAuthEnabled } from "./strongauth.js";
import { checkPresence } from "./touchid.js";
import { WhatsAppClient, log, toRecentMessage } from "./whatsapp.js";
import { SessionRegistry } from "./sessions.js";
import { deployedStateRoot } from "./setup.js";

const settings = new Settings(config.settingsFile).load();
// Le plafond (ADR-0002). Au tout premier démarrage, il est généré depuis les grants
// existants (migration sans régression) ; ensuite seul l'humain l'édite, à la main.
const allowlist = new Allowlist(config.allowlistFile).bootstrap(settings);
// Le profil (fiche 0004, ADR-0006) : seconde borne, opt-in par projet. Absent
// (ni profiles.json ni WHATSAPP_PROFILE) -> couche inerte, comportement ADR-0002.
const profile = new Profiles(config.profilesFile).load();
const wa = new WhatsAppClient(config, settings, allowlist, profile);
// Registre des sessions de lecture (fiche 20260902223310499). Filtre appliqué en
// AMONT du domaine, dans cette couche application : whatsapp.js ne le connaît pas.
const sessions = new SessionRegistry(config.sessionsDir, { defaultTtlMs: config.sessionTtlMs });

function humanDuration(ms) {
  if (ms % 3600000 === 0) return `${ms / 3600000} h`;
  if (ms % 60000 === 0) return `${ms / 60000} min`;
  return `${Math.round(ms / 1000)} s`;
}

// Un jeton résolu et sa subject list, pour composer messages d'erreur et de
// consentement sans dupliquer la logique de résolution des noms.
function subjectFor(jid) {
  return wa.settings.grants.get(jid)?.subject || wa.knownGroups.get(jid) || jid;
}

// Aide concise, rendue par l'outil `whatsapp_help` (fiche 0011). Elle donne le MODÈLE
// MENTAL (lecture seule · plafond · grant→lecture · note de sécurité) et INDIRIGE vers le
// README (source de vérité) — elle ne recopie pas son détail volatil, qui périmerait.
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

// --- Définition des outils MCP ---
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

// Racine d'état à PORTER dans le repli terminal d'appairage (voie 2, revue Codex #40) :
// renseignée seulement si le connecteur demandeur n'est PAS sur la racine par défaut
// (ex. rail dev whatsapp-feat -> ~/.config/whatsapp-mcp-dev). Sinon `npm run pair`, lancé
// dans un autre shell, retomberait sur la prod. undefined = racine par défaut.
const pairStateRoot = deployedStateRoot() === deployedStateRoot({}) ? undefined : deployedStateRoot();

// « Rien n'est appairé » (fiche 20260916130039008) : le compte n'a PAS d'identifiants
// WhatsApp enregistrés (creds.registered). Signal AUTORITAIRE, pas les grants — un logout
// 401 efface auth/ mais conserve settings.json, donc un compte délié a grants>0 tout en
// devant ré-appairer (revue Codex #40). En reconnexion réseau (registered=true, pas encore
// « open »), registered reste vrai : on NE guide PAS, la reconnexion suffit.
function nothingPairedYet() {
  return !wa.isRegistered();
}

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

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    switch (name) {
      case "whatsapp_help":
        return { content: [{ type: "text", text: HELP_TEXT }] };

      case "whatsapp_pair": {
        // Garde alignée sur les 4 outils d'accès (nothingPairedYet) : un grant persisté
        // prouve un appairage passé, donc en reconnexion réseau on NE re-sollicite PAS
        // le numéro (sinon on demande une donnée perso pour rien — revue P1).
        if (!nothingPairedYet()) {
          return ok({
            route: "already-paired",
            message: "WhatsApp est déjà appairé. Rien à faire.",
          });
        }
        const result = await pairingFlow();
        if (result.route === "declined") {
          return fail(`Appairage refusé par l'humain (${result.reason}).`);
        }
        return ok(result);
      }

      case "whatsapp_status": {
        const grantConsent = readStrongAuthEnabled(config.strongAuthFile)
          ? "Touch ID (présence physique — hiérarchie ADR-0003)"
          : clientSupportsElicitation
            ? "élicitation (formulaire rédigé par le serveur, hors de portée du LLM)"
            : "permissions du client MCP (le client ne supporte pas l'élicitation)";
        // Balayage opportuniste (en plus de la purge paresseuse de resolve()).
        sessions.purgeExpired();
        const resolved = args.session ? sessions.resolve(args.session) : null;
        return ok({
          // Quelle build répond : « de985f3 » = version déployée figée, « dev » = lancée
          // depuis le checkout (ADR-0007). C'est le repère pour vérifier après un deploy.
          version: config.deployedVersion,
          ...wa.status(),
          grantConsent,
          session: resolved
            ? {
                expiresAt: resolved.expiresAt,
                channels: resolved.channels.map((jid) => ({ jid, subject: subjectFor(jid) })),
              }
            : "aucune session",
          // Jamais le CONTENU des autres sessions à une conversation qui n'en porte
          // pas le jeton — seulement leur nombre.
          activeSessions: resolved ? undefined : sessions.list().length,
        });
      }

      case "list_groups": {
        if (nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        const { groups, hiddenOutsideAllowlist, hiddenOutsideProfile } = await wa.listGroups();
        const resolvedSession = args.session ? sessions.resolve(args.session) : null;
        const inSession = resolvedSession ? new Set(resolvedSession.channels) : null;
        const notes = [];
        if (hiddenOutsideAllowlist > 0)
          notes.push(
            `${hiddenOutsideAllowlist} autre(s) groupe(s) existent mais sont hors du plafond : ils ne ` +
              `sont pas listables ici. Pour les voir et relever leur JID, l'humain lance ` +
              `« npm run list-groups » dans un terminal, puis ajoute l'entrée à la main dans ${config.allowlistFile}.`
          );
        if (hiddenOutsideProfile > 0)
          notes.push(
            `${hiddenOutsideProfile} groupe(s) sont AU plafond mais hors du profil actif` +
              (config.profile ? ` « ${config.profile} »` : "") +
              ` : pour les voir dans ce projet, ajoute-les à ce profil dans ${config.profilesFile} ` +
              `(inutile de toucher au plafond, ils y sont déjà).`
          );
        return ok({
          count: groups.length,
          groups: inSession ? groups.map((g) => ({ ...g, inSession: inSession.has(g.id) })) : groups,
          hiddenOutsideAllowlist,
          hiddenOutsideProfile,
          note: notes.length ? notes.join(" ") : undefined,
        });
      }

      case "grant_channel":
        if (nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        return ok(await wa.grantChannel(args.channel));

      case "revoke_channel":
        return ok(wa.revokeChannel(args.channel));

      case "session_open": {
        if (nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        const requested = Array.isArray(args.channels) ? args.channels : [];
        if (requested.length === 0) return fail("Fournis au moins un canal ('channels').");

        let pairs;
        try {
          // On garde l'ENTRÉE d'origine à côté du JID résolu, pour ne jamais divulguer un
          // JID que l'appelant n'aurait pas fourni lui-même (cf. le refus ci-dessous).
          pairs = requested.map((c) => ({ input: c, jid: wa._resolveToJid(c) }));
        } catch (e) {
          return fail(e?.message || String(e));
        }

        // Vérification ⊆ grants ∩ plafond ∩ profil AVANT tout prompt (décision 4 de la
        // fiche + profil ADR-0006) : le reçu du consentement doit dire exactement ce qu'il
        // accorde, et le profil borne session_open comme les autres chemins (Codex PR #34).
        wa.allowlist.refresh();
        const denied = pairs.filter(({ jid }) => !wa.settings.has(jid) || !wa._inScope(jid));
        if (denied.length > 0) {
          return fail(
            `Hors grants ∩ plafond, refusé avant toute demande de consentement : ` +
              // On réécho UNIQUEMENT l'entrée fournie par l'appelant, jamais le JID résolu :
              // `_resolveToJid` transforme un NOM en son JID (via knownGroups) même hors
              // plafond ; renvoyer ce JID ferait de session_open un oracle nom→JID pour des
              // groupes que list_groups masque volontairement (revue Codex #25). Réécho de
              // l'entrée telle quelle : l'appelant l'a déjà, ça ne divulgue rien de neuf.
              `${denied.map(({ input }) => `« ${input} »`).join(", ")}. ` +
              `Utilise 'grant_channel' (le canal doit aussi être dans le plafond, édité à la main) d'abord.`
          );
        }
        const jids = pairs.map((p) => p.jid);

        const ttlMs = Number.isInteger(args.ttlMs) && args.ttlMs > 0 ? args.ttlMs : config.sessionTtlMs;
        const subjects = jids.map(subjectFor);
        const consent = await sessionConsent({ subjects, ttlMs });
        if (!consent.accepted) {
          return fail(
            `Session refusée par l'humain` + (consent.reason ? ` (${consent.reason})` : "") + "."
          );
        }

        sessions.purgeExpired();
        const session = sessions.create(jids, ttlMs);
        log(`Session ouverte (${session.id.slice(0, 8)}…) : ${subjects.join(", ")} — expire ${session.expiresAt}`);
        return ok({
          session: session.id,
          expiresAt: session.expiresAt,
          channels: jids.map((jid) => ({ jid, subject: subjectFor(jid) })),
        });
      }

      case "session_close": {
        if (!args.session) return fail("Fournis le jeton 'session' à fermer.");
        const closed = sessions.close(args.session);
        return ok({ session: args.session, closed });
      }

      case "get_recent_messages": {
        if (nothingPairedYet()) return fail(buildGuidedPairingRefusal(clientSupportsElicitation, pairStateRoot));
        if (!args.session) {
          return fail(
            "Aucune session : cet outil exige un jeton de session. Ouvre-en une avec " +
              "'session_open' (canal déjà autorisé par 'grant_channel'), puis représente son " +
              "jeton dans 'session'."
          );
        }
        const session = sessions.resolve(args.session);
        if (!session) {
          return fail(
            "Session invalide, expirée ou déjà fermée. Ouvre-en une nouvelle avec 'session_open'."
          );
        }

        let jid;
        if (args.channel) {
          jid = wa._resolveToJid(args.channel);
          if (!session.channels.includes(jid)) {
            return fail(
              `Canal hors du périmètre de cette session (« ${subjectFor(jid)} »). ` +
                `Ouvre une nouvelle session avec 'session_open' incluant ce canal.`
            );
          }
        } else if (session.channels.length === 1) {
          jid = session.channels[0];
        } else if (session.channels.length === 0) {
          return fail("Cette session ne porte aucun canal.");
        } else {
          const noms = session.channels.map((j) => `« ${subjectFor(j)} »`).join(", ");
          return fail(`Plusieurs canaux dans cette session : précise 'channel' parmi ${noms}.`);
        }

        // Re-vérification grant ∩ plafond COURANT (défense en profondeur) : c'est
        // exactement ce que fait wa.recentFor, INCHANGÉ (domaine, ADR-0002).
        const limit = Number.isInteger(args.limit) ? args.limit : 50;
        const { jid: outJid, subject, messages, buffered } = wa.recentFor(jid, limit);
        return ok({
          channel: { jid: outJid, subject },
          returned: messages.length,
          buffered,
          note:
            messages.length === 0
              ? "Aucun message en mémoire pour ce canal. Le tampon se remplit avec l'historique reçu à la connexion et les nouveaux messages."
              : undefined,
          messages: messages.map(toRecentMessage),
        });
      }

      default:
        return fail(`Outil inconnu : ${name}`);
    }
  } catch (err) {
    return fail(err?.message || String(err));
  }
});

// L'élicitation est la seule façon d'afficher à l'humain une question RÉDIGÉE PAR LE
// SERVEUR, dont la réponse ne transite jamais par le LLM (ADR-0001, ADR-0002). Quand le
// client la supporte, chaque grant passe par ce consentement. Sinon, repli : le grant
// reste borné par le plafond, et la confirmation d'appel d'outil du client (quand elle
// existe) reste le garde-fou conversationnel.
let clientSupportsElicitation = false;

server.oninitialized = () => {
  const caps = server.getClientCapabilities() || {};
  clientSupportsElicitation = !!caps.elicitation;
  log("Client MCP connecté. Capabilities:", JSON.stringify(caps));
  log("Elicitation supportée par ce client :", clientSupportsElicitation ? "OUI" : "non");
};

const elicitationConsent = buildConfirmGrant(server, () => clientSupportsElicitation, log);
wa.confirmGrant = buildGrantConsent({
  isStrongAuthEnabled: () => readStrongAuthEnabled(config.strongAuthFile),
  checkPresence,
  elicitationConsent,
  log,
});

// Flux d'appairage guidé (fiche 20260916130039008), outil `whatsapp_pair` : demande
// le numéro par élicitation (voie 1) si le client le permet, sinon renvoie la
// procédure terminal (voie 2). Ne s'appaire jamais lui-même (ADR-0005).
const pairingFlow = buildPairingFlow({
  isElicitationSupported: () => clientSupportsElicitation,
  elicitInput: (params) => server.elicitInput(params),
  requestPairingCode: (phoneNumber) => wa.requestPairingCode(phoneNumber),
  stateRoot: pairStateRoot,
  log,
});

// Consentement de session_open (fiche 20260902223310499) : composé séparément de
// buildGrantConsent — pas de repli « permissions client », voir consent.js.
const sessionConsent = buildSessionConsent({
  isStrongAuthEnabled: () => readStrongAuthEnabled(config.strongAuthFile),
  checkPresence,
  isElicitationSupported: () => clientSupportsElicitation,
  server,
  humanDuration,
  log,
});

async function main() {
  // 0) Verrou auth/ AVANT tout (fiche 0009). Si un autre process vivant le tient, on SORT
  //    ici — sans ouvrir le transport MCP. Sinon le perdant resterait un serveur MCP zombie,
  //    WhatsApp indisponible en permanence (revue Codex #27). L'acquisition est synchrone.
  try {
    wa.acquireLock();
  } catch (e) {
    if (e?.code === "ELOCKED") {
      log(e.message);
      process.exit(1); // perdant du verrou : ne pas servir en MCP
    }
    throw e;
  }

  // 1) Démarre WhatsApp (affiche un QR sur stderr si pas encore appairé).
  //    On n'attend pas la connexion : le serveur MCP doit répondre tout de suite.
  //    start() re-prend le verrou (réentrant, même PID) — inoffensif.
  wa.start().catch((e) => log("Echec démarrage WhatsApp:", e?.message));

  // 2) Démarre le transport MCP sur stdio.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const granted = settings.list();
  log(
    "Serveur MCP prêt (stdio, LECTURE SEULE). Canaux autorisés:",
    granted.length ? granted.map((g) => g.subject || g.jid).join(", ") : "(aucun)"
  );
}

main().catch((e) => {
  log("Erreur fatale:", e?.message);
  process.exit(1);
});
