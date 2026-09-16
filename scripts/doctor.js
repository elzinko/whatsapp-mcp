#!/usr/bin/env node
// [fiche 0010] doctor — diagnostic LECTURE SEULE du branchement du serveur whatsapp-mcp.
// N'écrit RIEN. Jumeau exécutable de la Phase 0 (docs/tests/validation-manuelle-desktop.md).
// CLI autonome (pas le serveur MCP) : stdout est libre pour le rapport.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  nodeVersionOk,
  resolveStableNode,
  desktopConfigPath,
  currentShimPath,
  deployedStateRoot,
} from "../src/setup.js";

const ok = (m) => console.log(`✅ ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);
const info = (m) => console.log(`   ${m}`);

console.log("— doctor whatsapp-mcp —\n");

// 1. node : version + chemin stable pour Desktop
if (nodeVersionOk(process.version)) ok(`node ${process.version} (≥ 20)`);
else warn(`node ${process.version} — le projet exige ≥ 20`);
const stable = resolveStableNode((p) => fs.existsSync(p));
if (stable.warning) warn(stable.warning);
else ok(`node stable pour Desktop : ${stable.path}`);

// 2. Claude Desktop branché ?
const desktopPath = desktopConfigPath();
try {
  const raw = fs.readFileSync(desktopPath, "utf8");
  try {
    const cfg = JSON.parse(raw);
    const entry = cfg?.mcpServers?.["whatsapp-mcp"];
    const shim = currentShimPath();
    if (!entry) warn("Claude Desktop : whatsapp-mcp ABSENT de mcpServers → « npm run install:client »");
    else if (entry.command === shim) ok("Claude Desktop : whatsapp-mcp branché sur la version déployée (current)");
    else warn(`Claude Desktop : branché mais PAS sur le shim déployé (command: ${entry.command}) → « npm run install:client » (sinon Desktop relance ton checkout)`);
  } catch {
    warn(`Claude Desktop : config présente mais JSON illisible (${desktopPath})`);
  }
} catch {
  warn(`Claude Desktop : aucune config à ${desktopPath} → « npm run install:client »`);
}

// 3. Claude Code branché ? (tolère l'absence de la CLI `claude`)
try {
  execFileSync("claude", ["mcp", "get", "whatsapp-mcp"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  ok("Claude Code : whatsapp-mcp branché");
} catch {
  info("Claude Code : non détecté (ou CLI `claude` absente). Pour brancher la version déployée :");
  info(`  claude mcp add whatsapp-mcp -- ${currentShimPath()}`);
}

// 4. Session WhatsApp appairée ? — sous la racine d'état DÉPLOYÉE (~/.config/whatsapp-mcp),
// PAS le checkout où doctor tourne : le serveur déployé n'utilise jamais l'auth du checkout
// (revue Codex PR #38).
const stateRoot = deployedStateRoot();
const deployedAuth = path.join(stateRoot, "auth");
try {
  if (fs.readdirSync(deployedAuth).length > 0) ok(`auth/ présent (appairé) : ${deployedAuth}`);
  else warn(`auth/ vide — appaire la version déployée (QR au 1er lancement) : ${deployedAuth}`);
} catch {
  warn(`auth/ absent — déploie (« npm run deploy ») puis appaire : ${deployedAuth}`);
}

// 5. Plafond (sous la racine d'état déployée)
const deployedAllowlist = path.join(stateRoot, "allowlist.json");
if (fs.existsSync(deployedAllowlist)) ok(`plafond présent : ${deployedAllowlist}`);
else info(`plafond ${deployedAllowlist} absent (généré au 1er démarrage)`);

console.log("\n(doctor ne modifie rien — pour configurer : npm run install:client)");
