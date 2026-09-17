// Appairage WhatsApp GUIDÉ (fiche 20260916130039008) : quand rien n'est appairé, le
// serveur PROPOSE la connexion — par élicitation (voie 1, code de couplage) si le
// client le permet, sinon par la procédure terminal exacte (voie 2). ADR-0005 : le
// serveur guide, il ne s'appaire jamais lui-même.
//
// Fonctions PURES (composition de messages/schéma) + `buildPairingFlow` (effets de
// bord injectés : elicitInput, requestPairingCode) pour rester testable sans Baileys
// ni humain — même pattern que src/consent.js.

export const PAIR_COMMAND = "npm run pair";

// Cible d'état PARTAGÉ (ADR-0007) où l'appairage écrit — jamais un checkout.
export const SHARED_AUTH_HINT = "~/.config/whatsapp-mcp/auth";

// Voie 2 — repli terminal. Deux pièges corrigés (revue Codex #40) :
//  - le serveur MCP tient le verrou auth/ (fiche 0009) : `npm run pair` échouerait en
//    ELOCKED tant qu'il tourne -> on dit d'ABORD d'arrêter le serveur ;
//  - `npm run pair` résout sa racine d'état depuis SON shell : sans la racine du
//    connecteur demandeur, un appairage depuis le rail dev toucherait la prod -> on PORTE
//    la racine dans la commande quand elle n'est pas la racine par défaut.
// `stateRoot` (optionnel) = racine d'état active du connecteur demandeur ; absent = racine
// par défaut (affichage tilde lisible + commande simple).
export function buildTerminalPairingMessage(stateRoot) {
  const authHint = stateRoot ? `${stateRoot}/auth` : SHARED_AUTH_HINT;
  const command = stateRoot ? `WHATSAPP_MCP_STATE_ROOT=${stateRoot} ${PAIR_COMMAND}` : PAIR_COMMAND;
  return (
    "WhatsApp n'est pas appairé. Un seul process peut tenir le verrou auth/ à la fois : " +
    "arrête d'abord le serveur en cours, puis appaire au terminal, sur cette machine :\n" +
    "  1. Quitte Claude Desktop (Cmd-Q), ou : npm run stop\n" +
    `  2. ${command}\n` +
    "Cette commande affiche un QR (ou un code d'appairage) à saisir sur ton téléphone, et " +
    `écrit l'appairage dans l'état partagé ${authHint} — jamais dans un checkout.`
  );
}

// Voie 1 — élicitation : schéma NON VIDE (le premier de ce serveur), pour capter le
// numéro de téléphone. Le code d'appairage passe en TEXTE (contrairement au QR),
// donc jouable sans image.
export function buildPairingRequestedSchema() {
  return {
    type: "object",
    properties: {
      phoneNumber: {
        type: "string",
        description: "Numéro de téléphone WhatsApp, avec indicatif pays (ex. +33612345678).",
      },
    },
    required: ["phoneNumber"],
  };
}

export function buildPairingElicitationMessage() {
  return (
    "WhatsApp n'est pas appairé. Indique le numéro de téléphone du compte WhatsApp à " +
    "lier (avec indicatif pays) : un code d'appairage s'affichera, à saisir sur ton " +
    "téléphone (WhatsApp > Appareils liés > Lier un appareil > Lier avec un numéro)."
  );
}

export function buildPairingCodeMessage(code) {
  return (
    `Code d'appairage : ${code}\n` +
    "Saisis-le sur ton téléphone : WhatsApp > Appareils liés > Lier un appareil > " +
    "Lier avec un numéro."
  );
}

// Le chemin guidé pour un refus « rien n'est appairé » (list_groups, grant_channel,
// get_recent_messages, session_open) — jamais un simple « non connecté » (critère
// d'acceptation de la fiche).
export function buildGuidedPairingRefusal(isElicitationSupported, stateRoot) {
  if (isElicitationSupported) {
    return (
      "WhatsApp n'est pas appairé. Utilise l'outil 'whatsapp_pair' : il demande ton " +
      "numéro de téléphone puis affiche un code d'appairage à saisir sur ton téléphone."
    );
  }
  return buildTerminalPairingMessage(stateRoot);
}

// Pilote le flux guidé de l'outil MCP `whatsapp_pair`. Effets de bord injectés
// (elicitInput, requestPairingCode) -> testable sans Baileys ni humain (comme
// buildConfirmGrant/buildSessionConsent dans consent.js). ADR-0005 : ce flux ne fait
// JAMAIS le geste lui-même sans un numéro fourni par l'humain via l'élicitation.
export function buildPairingFlow({ isElicitationSupported, elicitInput, requestPairingCode, stateRoot, log = () => {} }) {
  return async () => {
    if (!isElicitationSupported()) {
      return { route: "terminal", message: buildTerminalPairingMessage(stateRoot) };
    }

    let res;
    try {
      res = await elicitInput({
        message: buildPairingElicitationMessage(),
        requestedSchema: buildPairingRequestedSchema(),
      });
    } catch (e) {
      // Fail-safe : le formulaire n'a pas pu être présenté -> repli sur la procédure
      // terminal, jamais un crash ni un silence.
      log("Élicitation d'appairage impossible :", e?.message);
      return { route: "terminal", message: buildTerminalPairingMessage(stateRoot), reason: "élicitation indisponible" };
    }

    const phoneNumber = String(res?.content?.phoneNumber || "").trim();
    if (res?.action !== "accept" || !phoneNumber) {
      return { route: "declined", reason: `formulaire ${res?.action || "sans réponse"}` };
    }

    const pairingCode = await requestPairingCode(phoneNumber);
    // Ne JAMAIS renvoyer le numéro saisi : la réponse d'un outil MCP remonte dans le
    // contexte du LLM, or la saisie d'élicitation doit rester hors de sa portée
    // (ADR-0001/0002). Le numéro ne sert à rien en aval ; seul le code est affiché.
    return { route: "elicitation", pairingCode, message: buildPairingCodeMessage(pairingCode) };
  };
}
