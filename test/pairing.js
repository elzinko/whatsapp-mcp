// Tests de l'appairage guidé (fiche 20260916130039008), sans Baileys ni humain.
//
// Deux étages :
//   1. les fonctions PURES de composition du message/schéma (voie 1 élicitation,
//      voie 2 repli terminal) — DoD ezk-pm : le CONTENU est assené, pas juste la
//      présence d'un champ ou d'un texte quelconque.
//   2. buildPairingFlow en isolation (faux elicitInput / requestPairingCode injectés,
//      comme test/elicitation.js pour buildConfirmGrant) : sélection de voie selon la
//      capacité d'élicitation du client, et contenu du résultat.

import {
  PAIR_COMMAND,
  SHARED_AUTH_HINT,
  buildTerminalPairingMessage,
  buildPairingRequestedSchema,
  buildPairingElicitationMessage,
  buildPairingCodeMessage,
  buildGuidedPairingRefusal,
  buildPairingFlow,
} from "../src/pairing.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

try {
  // --- 1) Fonctions pures ---
  check("PAIR_COMMAND est 'npm run pair'", PAIR_COMMAND === "npm run pair");
  check("SHARED_AUTH_HINT cible l'état partagé", SHARED_AUTH_HINT === "~/.config/whatsapp-mcp/auth");

  const terminalMsg = buildTerminalPairingMessage();
  check("voie 2 : message contient la commande EXACTE 'npm run pair'", terminalMsg.includes("npm run pair"));
  check(
    "voie 2 : message contient la cible EXACTE ~/.config/whatsapp-mcp/auth",
    terminalMsg.includes("~/.config/whatsapp-mcp/auth")
  );

  const schema = buildPairingRequestedSchema();
  check(
    "voie 1 : requestedSchema NON VIDE (champ numéro présent)",
    Object.keys(schema?.properties || {}).length > 0 && "phoneNumber" in schema.properties
  );
  check("voie 1 : phoneNumber est de type string", schema.properties.phoneNumber.type === "string");

  const elicitMsg = buildPairingElicitationMessage();
  check("voie 1 : le message d'élicitation demande le numéro", /numéro/i.test(elicitMsg));

  const codeMsg = buildPairingCodeMessage("ABCD-1234");
  check("le message final contient le code obtenu", codeMsg.includes("ABCD-1234"));

  const refusalElicit = buildGuidedPairingRefusal(true);
  check("refus guidé (client avec élicitation) -> pointe vers whatsapp_pair", /whatsapp_pair/.test(refusalElicit));
  check("refus guidé (client avec élicitation) -> jamais 'non connecté' sec", !/^non connecté$/i.test(refusalElicit));

  const refusalTerminal = buildGuidedPairingRefusal(false);
  check("refus guidé (sans élicitation) -> commande EXACTE 'npm run pair'", refusalTerminal.includes("npm run pair"));
  check(
    "refus guidé (sans élicitation) -> cible EXACTE ~/.config/whatsapp-mcp/auth",
    refusalTerminal.includes("~/.config/whatsapp-mcp/auth")
  );

  // --- 2) buildPairingFlow — isolation, dépendances injectées ---

  // Client SANS élicitation -> voie terminal directement, jamais d'elicitInput appelé.
  {
    let elicitCalled = false;
    const flow = buildPairingFlow({
      isElicitationSupported: () => false,
      elicitInput: async () => {
        elicitCalled = true;
        return { action: "accept", content: { phoneNumber: "+33612345678" } };
      },
      requestPairingCode: async () => "SHOULD-NOT-BE-CALLED",
    });
    const res = await flow();
    check("sans élicitation -> route 'terminal'", res.route === "terminal");
    check("sans élicitation -> message contient 'npm run pair'", res.message.includes("npm run pair"));
    check("sans élicitation -> message contient ~/.config/whatsapp-mcp/auth", res.message.includes("~/.config/whatsapp-mcp/auth"));
    check("sans élicitation -> elicitInput jamais appelé", elicitCalled === false);
  }

  // Client AVEC élicitation, accepte, fournit un numéro -> voie élicitation, code affiché.
  {
    let seenParams = null;
    let seenPhoneNumber = null;
    const flow = buildPairingFlow({
      isElicitationSupported: () => true,
      elicitInput: async (params) => {
        seenParams = params;
        return { action: "accept", content: { phoneNumber: "+33612345678" } };
      },
      requestPairingCode: async (phoneNumber) => {
        seenPhoneNumber = phoneNumber;
        return "WXYZ-9876";
      },
    });
    const res = await flow();
    check(
      "avec élicitation -> requestedSchema NON VIDE transmis au client",
      Object.keys(seenParams?.requestedSchema?.properties || {}).length > 0
    );
    check("avec élicitation -> route 'elicitation'", res.route === "elicitation");
    check("avec élicitation -> le numéro saisi est transmis à requestPairingCode", seenPhoneNumber === "+33612345678");
    check("avec élicitation -> le code obtenu est renvoyé", res.pairingCode === "WXYZ-9876");
    check("avec élicitation -> message présente le code", res.message.includes("WXYZ-9876"));
  }

  // Client AVEC élicitation, decline -> refus, jamais de code demandé.
  {
    let requestCalled = false;
    const flow = buildPairingFlow({
      isElicitationSupported: () => true,
      elicitInput: async () => ({ action: "decline" }),
      requestPairingCode: async () => {
        requestCalled = true;
        return "NOPE";
      },
    });
    const res = await flow();
    check("decline -> route 'declined'", res.route === "declined");
    check("decline -> requestPairingCode jamais appelé", requestCalled === false);
  }

  // Client AVEC élicitation mais formulaire en échec -> repli terminal (fail-safe, pas de crash).
  {
    const flow = buildPairingFlow({
      isElicitationSupported: () => true,
      elicitInput: async () => {
        throw new Error("client parti");
      },
      requestPairingCode: async () => "NOPE",
    });
    const res = await flow();
    check("élicitation indisponible -> repli voie terminal", res.route === "terminal" && res.message.includes("npm run pair"));
  }
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
