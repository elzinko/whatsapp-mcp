// Tests de la voie 1 (code d'appairage) côté WhatsAppClient (fiche 20260916130039008),
// avec un MOCK Baileys minimal — introduit ici, local à ce test, car Baileys n'est
// jamais mocké ailleurs (aucune vraie connexion réseau). Couvre :
//   - start(phoneNumber) demande un code quand le compte n'est pas encore enregistré ;
//   - start() sans numéro garde le comportement EXISTANT (pas de code demandé) ;
//   - un compte déjà enregistré ne redemande pas de code, même avec un numéro fourni ;
//   - requestPairingCode() exposé pour l'outil MCP `whatsapp_pair` (voie élicitation),
//     utilisable sur un socket déjà démarré.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Settings } from "../src/settings.js";
import { WhatsAppClient } from "../src/whatsapp.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

// Mock Baileys minimal : juste assez pour que start() traverse sans réseau.
// `ev.on` MÉMORISE les handlers par event (au lieu de les ignorer) : `emit` permet aux
// tests de rejouer un event (ex. `connection.update` avec `qr`) et d'observer QUAND
// requestPairingCode est réellement appelé — le bug (Connection Closed) venait
// justement d'un appel trop tôt, avant que Baileys soit prêt (event `qr`).
function fakeSock({ registered = false, code = "ABCD-1234" } = {}) {
  let seenPhoneNumber = null;
  let callCount = 0;
  const handlers = {};
  const sock = {
    authState: { creds: { registered } },
    ev: {
      on: (event, handler) => {
        handlers[event] = handler;
      },
    },
    requestPairingCode: async (phoneNumber) => {
      seenPhoneNumber = phoneNumber;
      callCount += 1;
      return code;
    },
  };
  return {
    sock,
    seenPhoneNumber: () => seenPhoneNumber,
    callCount: () => callCount,
    // Rejoue un event Baileys (ex. "connection.update") vers le handler enregistré par
    // start(). Attend le handler (il est async) : les tests peuvent observer son effet.
    emit: (event, payload) => handlers[event]?.(payload),
  };
}

function freshConfig(tmp) {
  const dir = path.join(tmp, String(Math.random()).slice(2));
  fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
  return {
    authDir: path.join(dir, "auth"),
    authLockFile: path.join(dir, "auth.lock"),
    dataDir: path.join(dir, "data"),
    settingsFile: path.join(dir, "settings.json"),
    allowlistFile: path.join(dir, "allowlist.json"),
    profile: "",
    profilesFile: path.join(dir, "profiles.json"),
    maxMessages: 10,
    persist: false,
    deviceName: "test",
    groupId: "",
    groupName: "",
  };
}

function makeClient(config, { registered = false, code = "ABCD-1234" } = {}) {
  const settings = new Settings(config.settingsFile).load();
  const { sock, seenPhoneNumber, callCount, emit } = fakeSock({ registered, code });
  const deps = {
    useMultiFileAuthState: async () => ({
      state: { creds: { registered } },
      saveCreds: async () => {},
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    makeWASocket: () => sock,
  };
  const wa = new WhatsAppClient(config, settings, undefined, undefined, deps);
  return { wa, seenPhoneNumber, callCount, emit };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-pairing-socket-"));

  // --- 1) start(phoneNumber), compte NON enregistré -> code demandé et mémorisé QUAND
  // Baileys est prêt (event `qr`), pas avant (timing réparé, fiche 20260917180706311 —
  // demander le code juste après makeWASocket a produit "Connection Closed" en réel).
  {
    const { wa, seenPhoneNumber, emit } = makeClient(freshConfig(tmp), { registered: false, code: "ABCD-1234" });
    await wa.start("+33612345678");
    await emit("connection.update", { qr: "FAKE_QR" });
    check("start(numéro) + event qr -> code d'appairage mémorisé sur le client", wa.pairingCode === "ABCD-1234");
    check("start(numéro) + event qr -> le numéro fourni est transmis à Baileys", seenPhoneNumber() === "+33612345678");
  }

  // --- 2) start() SANS numéro -> comportement EXISTANT inchangé (aucun code demandé) ---
  {
    const { wa, seenPhoneNumber } = makeClient(freshConfig(tmp), { registered: false });
    await wa.start();
    check("start() sans numéro -> aucun code demandé", wa.pairingCode === null);
    check("start() sans numéro -> requestPairingCode jamais appelé", seenPhoneNumber() === null);
  }

  // --- 3) compte DÉJÀ enregistré -> pas de nouveau code même si un numéro est fourni ---
  {
    const { wa, seenPhoneNumber } = makeClient(freshConfig(tmp), { registered: true });
    await wa.start("+33612345678");
    check("compte déjà appairé -> aucun code redemandé", wa.pairingCode === null);
    check("compte déjà appairé -> requestPairingCode jamais appelé", seenPhoneNumber() === null);
  }

  // --- 4) requestPairingCode() public, appelable après coup (voie élicitation) ---
  {
    const { wa } = makeClient(freshConfig(tmp), { registered: false, code: "WXYZ-9876" });
    await wa.start(); // pas de numéro au démarrage
    check("après start() sans numéro, pas encore de code", wa.pairingCode === null);
    const code = await wa.requestPairingCode("+33698765432");
    check("requestPairingCode() renvoie le code Baileys", code === "WXYZ-9876");
    check("requestPairingCode() mémorise le code sur le client", wa.pairingCode === "WXYZ-9876");
  }

  // --- 5) requestPairingCode() refuse si le compte est déjà appairé (fail-safe) ---
  {
    const { wa } = makeClient(freshConfig(tmp), { registered: true });
    await wa.start();
    let threw = false;
    try {
      await wa.requestPairingCode("+33612345678");
    } catch {
      threw = true;
    }
    check("requestPairingCode() sur un compte déjà appairé -> refuse", threw === true);
  }

  // --- 6) isRegistered() lit les CREDS PERSISTÉS (creds.json), jamais les grants ---
  // Régression Codex #40 : un logout 401 efface auth/ (creds.json absent) mais CONSERVE
  // settings.json (grants>0). Un tel compte doit être vu NON appairé, pour re-guider.
  {
    const config = freshConfig(tmp); // auth vide = pas de creds.json (état "logout")
    const { wa } = makeClient(config);
    wa.settings.grants.set("x@g.us", { subject: "X" }); // grants présents malgré le logout
    check("auth vidé (logout) + grants>0 -> NON appairé (re-guide, revue Codex #40)", wa.isRegistered() === false);
  }
  {
    const config = freshConfig(tmp);
    fs.writeFileSync(path.join(config.authDir, "creds.json"), JSON.stringify({ registered: true }));
    const { wa } = makeClient(config);
    check("creds.json registered:true -> appairé", wa.isRegistered() === true);
  }
  {
    const config = freshConfig(tmp);
    fs.writeFileSync(path.join(config.authDir, "creds.json"), JSON.stringify({ registered: false }));
    const { wa } = makeClient(config);
    check("creds.json registered:false (jamais appairé) -> non appairé", wa.isRegistered() === false);
  }

  // --- 7) TIMING (fiche 20260917180706311, bug confirmé en réel) : requestPairingCode
  // n'est appelé qu'à l'event `qr` (WS prêt), jamais juste après start() (trop tôt ->
  // Connection Closed en réel, non détecté par l'ancien mock qui n'émettait rien).
  {
    const { wa, callCount, emit } = makeClient(freshConfig(tmp), { registered: false, code: "ABCD-1234" });
    await wa.start("+33612345678");
    check("start(numéro) synchrone -> requestPairingCode PAS ENCORE appelé (avant tout event)", callCount() === 0);
    check("start(numéro) synchrone -> pairingCode pas encore posé", wa.pairingCode === null);

    await emit("connection.update", { qr: "FAKE_QR_DATA" });
    check("event qr -> requestPairingCode appelé À CE MOMENT", callCount() === 1);
    check("event qr -> code mémorisé sur le client", wa.pairingCode === "ABCD-1234");
    check("event qr -> lastQR capturé (le QR reste dispo en parallèle du code)", wa.lastQR === "FAKE_QR_DATA");

    await emit("connection.update", { qr: "FAKE_QR_DATA_2" });
    check("un second event qr -> requestPairingCode PAS redemandé (une seule fois)", callCount() === 1);
  }

  // --- 8) TIMING : sans numéro fourni, l'event qr ne demande jamais de code ---
  {
    const { wa, callCount, emit } = makeClient(freshConfig(tmp), { registered: false });
    await wa.start();
    await emit("connection.update", { qr: "FAKE_QR_DATA" });
    check("event qr sans numéro fourni -> requestPairingCode jamais appelé", callCount() === 0);
    check("event qr sans numéro fourni -> lastQR quand même capturé", wa.lastQR === "FAKE_QR_DATA");
  }

  // --- 9) TIMING : compte déjà enregistré -> l'event qr ne redemande pas de code ---
  {
    const { wa, callCount, emit } = makeClient(freshConfig(tmp), { registered: true });
    await wa.start("+33612345678");
    await emit("connection.update", { qr: "FAKE_QR_DATA" });
    check("event qr, compte déjà appairé -> requestPairingCode jamais appelé", callCount() === 0);
  }

  // --- 10) currentQrArt() : rend lastQR en art ASCII, null si aucun QR ---
  {
    const { wa } = makeClient(freshConfig(tmp), { registered: false });
    check("currentQrArt() sans QR -> null", wa.currentQrArt() === null);
    wa.lastQR = "FAKE_QR_DATA";
    const art = wa.currentQrArt();
    check("currentQrArt() avec lastQR posé -> string non vide", typeof art === "string" && art.length > 0);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
