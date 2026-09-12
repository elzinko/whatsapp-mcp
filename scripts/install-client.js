#!/usr/bin/env node
// [fiche 0010 + ADR-0007] install-client — branche Claude Desktop sur la version
// DÉPLOYÉE (~/.local/share/whatsapp-mcp/current/bin/whatsapp-mcp), jamais sur le
// checkout. CLI lancée PAR L'HUMAIN : son geste au terminal EST le consentement, et
// le serveur MCP ne configure jamais un client lui-même (frontière fiche 0012, ADR-0005).
//
// Pourquoi pointer « current » et non src/index.js : tant que Desktop lance le
// checkout, développer casse l'outil en service (incident du 2026-09-11). Le shim de
// la version figée résout « current » à chaque lancement et pose l'état hors du code.
//
// Garanties conservées : n'écrase JAMAIS les autres serveurs (backup + fusion idempotente
// préservant tout le reste) ; refuse si Desktop tourne (l'app réécrirait le fichier) ;
// refuse si la config existante est un JSON malformé (on n'écrase pas ce qu'on ne comprend pas).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  nodeVersionOk,
  resolveStableNode,
  mergeMcpServer,
  desktopConfigPath,
  currentShimPath,
  devShimPath,
  devStateRoot,
} from "../src/setup.js";

const die = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// Deux rails (ADR-0007). Stable (défaut) : connecteur « whatsapp-mcp » → current, état
// par défaut (~/.config/whatsapp-mcp). Dev (--dev) : connecteur « whatsapp-feat » → slot
// dev, état séparé ~/.config/whatsapp-mcp-dev (appairage propre) posé EN DUR dans l'entrée
// (Desktop lance sans notre PATH : c'est la seule façon de router le dev vers son état).
const isDev = process.argv.includes("--dev");
const connectorName = isDev ? "whatsapp-feat" : "whatsapp-mcp";
const shim = isDev ? devShimPath() : currentShimPath();
const entryEnv = isDev ? { WHATSAPP_MCP_STATE_ROOT: devStateRoot() } : undefined;

// 0. Cible = le shim déployé du rail choisi. On ne branche jamais le checkout : c'est
// tout l'intérêt du déploiement figé. Rien de déployé -> refus qui oriente vers `deploy`.
if (!fs.existsSync(shim)) {
  const cmd = isDev ? "npm run deploy:dev" : "npm run deploy";
  die(
    `rien de déployé pour le rail ${isDev ? "dev" : "stable"} — ${shim} est absent.\n` +
      `  Déploie d'abord : ${cmd}\n` +
      `  puis relance cette commande. Voir ADR-0007.`
  );
}

// 1. node stable : le shim le résout lui-même, mais on prévient si aucun n'est trouvable
// (Claude Desktop lance avec un PATH minimal, où « node » nu peut manquer).
const stable = resolveStableNode((p) => fs.existsSync(p));
if (!nodeVersionOk(process.version)) console.error(`⚠️  node ${process.version} < 20 : le serveur exige ≥ 20.`);
if (stable.warning) console.error(`⚠️  ${stable.warning}`);

// 2. Desktop tourne ? (l'app réécrit sa config en direct -> l'ajout serait effacé)
let desktopRunning = false;
try {
  execFileSync("pgrep", ["-x", "Claude"], { stdio: "ignore" });
  desktopRunning = true;
} catch {
  /* pgrep exit != 0 => process non trouvé */
}
if (desktopRunning) {
  die("Claude Desktop tourne — quitte-le complètement (Cmd-Q), puis relance cette commande. Sinon l'app efface l'ajout.");
}

// 3-4. Config existante : LUE UNE SEULE FOIS. Pas de `existsSync` puis lecture/copie
// (ce check-puis-usage est une course TOCTOU — CodeQL js/file-system-race). Absente
// (ENOENT) -> config neuve ; illisible ou JSON malformé -> REFUS (on ne clobber jamais
// ce qu'on ne comprend pas). Le texte brut déjà lu sert de backup, sans re-lecture disque.
const cfgPath = desktopConfigPath();
let raw = null;
try {
  raw = fs.readFileSync(cfgPath, "utf8");
} catch (e) {
  if (e.code !== "ENOENT") die(`config Desktop illisible : ${e.message}`);
  // ENOENT : pas encore de config -> on en créera une neuve.
}

let existing = {};
if (raw !== null) {
  try {
    existing = JSON.parse(raw);
  } catch {
    die(`config Desktop présente mais JSON malformé (${cfgPath}) — corrige-la à la main d'abord, je refuse de l'écraser.`);
  }
  const bak = `${cfgPath}.bak`;
  fs.writeFileSync(bak, raw); // backup depuis le contenu déjà lu (aucune re-lecture)
  console.log(`↳ backup : ${bak}`);
}

// 5. Fusion idempotente (préserve tous les autres serveurs et clés) + écriture.
// command = le shim ; args vide : le shim trouve node et pose l'état lui-même. Le nom
// de connecteur reste « whatsapp-mcp » (le changer ferait réinitialiser les permissions
// d'outils par Claude — leçon google, ADR-0007).
const entry = { command: shim, args: [] };
if (entryEnv) entry.env = entryEnv; // dev : route vers son état séparé
const merged = mergeMcpServer(existing, connectorName, entry);
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, `${JSON.stringify(merged, null, 2)}\n`);
console.log(`✓ ${connectorName} branché sur la version déployée (${isDev ? "rail dev" : "current"})`);
console.log(`  ${cfgPath}`);
console.log(`  command: ${shim}`);
console.log(`  état    : ${isDev ? `${devStateRoot()}/ (appairage séparé, posé en dur)` : "~/.config/whatsapp-mcp/ (posé par le shim, hors du code)"}`);
console.log("  → Rouvre Claude Desktop pour charger le serveur.");

// 6. Claude Code : imprimer la commande (ne pas écrire ~/.claude.json à la main)
console.log("\nPour Claude Code, lance :");
if (isDev) {
  console.log(`  claude mcp add ${connectorName} -e WHATSAPP_MCP_STATE_ROOT=${devStateRoot()} -- ${shim}`);
} else {
  console.log(`  claude mcp add ${connectorName} -- ${shim}`);
}
