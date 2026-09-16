// Repli terminal de l'appairage guidé (fiche 20260916130039008, voie 2).
// `npm run pair` : un geste HUMAIN au terminal (ADR-0005 — le serveur guide, ne
// s'appaire jamais lui-même). Écrit TOUJOURS dans l'état PARTAGÉ (ADR-0007)
// ~/.config/whatsapp-mcp/auth, jamais dans un checkout — même lancé depuis un
// worktree — pour profiter à toutes les surfaces (Desktop, Code, CLI…).
//
// Usage :
//   npm run pair                 -> affiche un QR code (comme aujourd'hui)
//   npm run pair -- +33612345678 -> affiche un code d'appairage (voie texte)
//
// Calqué sur scripts/list-groups.js (même garde-fou : un seul process Baileys à la
// fois sur ce dossier auth).

import path from "node:path";

import { deployedStateRoot } from "../src/setup.js";
import { Settings } from "../src/settings.js";
import { WhatsAppClient } from "../src/whatsapp.js";

const stateRoot = deployedStateRoot();

// Config MINIMALE, indépendante de src/config.js (qui résout tout par rapport au
// checkout) : ici la cible est TOUJOURS l'état partagé, jamais le dossier de travail.
const config = {
  authDir: path.join(stateRoot, "auth"),
  authLockFile: path.join(stateRoot, "auth.lock"),
  dataDir: path.join(stateRoot, "data"),
  settingsFile: path.join(stateRoot, "settings.json"),
  allowlistFile: path.join(stateRoot, "allowlist.json"),
  profile: "",
  profilesFile: path.join(stateRoot, "profiles.json"),
  maxMessages: 500,
  persist: true,
  deviceName: "whatsapp-mcp",
  groupId: "",
  groupName: "",
};

const phoneNumber = (process.argv[2] || "").trim() || undefined;

const settings = new Settings(config.settingsFile).load();
const wa = new WhatsAppClient(config, settings);

console.error(`Appairage vers l'état partagé : ${stateRoot}`);
console.error(
  phoneNumber
    ? `Demande d'un code d'appairage pour ${phoneNumber}…`
    : "En attente du QR code (passe un numéro en argument pour un code texte à la place)…"
);

await wa.start(phoneNumber);

console.error("Connexion en cours… (Ctrl+C pour annuler)");

const deadline = Date.now() + 60000;
while (!wa.isReady() && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
}

if (wa.isReady()) {
  console.error("\nAppairé et connecté. Les autres surfaces (Desktop, Code…) partagent désormais cet état.");
  process.exit(0);
} else {
  console.error(
    "\nPas encore connecté après 60s. Si un code d'appairage ou un QR a été affiché, " +
      "saisis-le sur ton téléphone puis relance cette commande si besoin."
  );
  process.exit(1);
}
