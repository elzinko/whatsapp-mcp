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

// Voie 2 — repli terminal : la commande EXACTE à lancer, et où elle écrit.
export function buildTerminalPairingMessage() {
  return (
    "WhatsApp n'est pas appairé. Lance, dans un terminal, sur cette machine :\n" +
    `  ${PAIR_COMMAND}\n` +
    "Cette commande affiche un QR code (ou un code d'appairage) à saisir sur ton " +
    `téléphone, et écrit l'appairage dans l'état partagé ${SHARED_AUTH_HINT} — jamais ` +
    "dans un checkout."
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
export function buildGuidedPairingRefusal(isElicitationSupported) {
  if (isElicitationSupported) {
    return (
      "WhatsApp n'est pas appairé. Utilise l'outil 'whatsapp_pair' : il demande ton " +
      "numéro de téléphone puis affiche un code d'appairage à saisir sur ton téléphone."
    );
  }
  return buildTerminalPairingMessage();
}

// Pilote le flux guidé de l'outil MCP `whatsapp_pair`. Effets de bord injectés
// (elicitInput, requestPairingCode) -> testable sans Baileys ni humain (comme
// buildConfirmGrant/buildSessionConsent dans consent.js). ADR-0005 : ce flux ne fait
// JAMAIS le geste lui-même sans un numéro fourni par l'humain via l'élicitation.
export function buildPairingFlow({ isElicitationSupported, elicitInput, requestPairingCode, log = () => {} }) {
  return async () => {
    if (!isElicitationSupported()) {
      return { route: "terminal", message: buildTerminalPairingMessage() };
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
      return { route: "terminal", message: buildTerminalPairingMessage(), reason: "élicitation indisponible" };
    }

    const phoneNumber = String(res?.content?.phoneNumber || "").trim();
    if (res?.action !== "accept" || !phoneNumber) {
      return { route: "declined", reason: `formulaire ${res?.action || "sans réponse"}` };
    }

    const pairingCode = await requestPairingCode(phoneNumber);
    return { route: "elicitation", phoneNumber, pairingCode, message: buildPairingCodeMessage(pairingCode) };
  };
}
