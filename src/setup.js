// Helpers pour les CLI de branchement (doctor / install-client), fiche 0010.
//
// Fonctions PURES et testables : aucune I/O cachée (fs/exec injectés par l'appelant
// dans les tests). Ce ne sont PAS des outils MCP — le serveur (src/index.js) ne
// configure JAMAIS un client (frontière fiche 0012) ; ici c'est une CLI lancée par
// l'humain, son geste au terminal EST le consentement.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// node ≥ min ? Parse "v22.18.0" -> 22. Format inattendu -> false (fail-safe).
export function nodeVersionOk(versionString, min = 20) {
  const m = /^v?(\d+)\./.exec(String(versionString || ""));
  if (!m) return false;
  return Number(m[1]) >= min;
}

// Résout un node en chemin ABSOLU STABLE : Claude Desktop lance les serveurs MCP avec
// un PATH minimal (sans nvm ni Homebrew), donc "node" nu ou un chemin nvm versionné
// échoue. Ordre : Homebrew, /usr/local, /usr/bin. `existsFn` injectée pour test.
// Aucun trouvé -> process.execPath + warning (souvent nvm, instable pour Desktop).
const STABLE_NODE_CANDIDATES = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
];

export function resolveStableNode(existsFn, execPath = process.execPath) {
  for (const candidate of STABLE_NODE_CANDIDATES) {
    if (existsFn(candidate)) return { path: candidate, warning: null };
  }
  return {
    path: execPath,
    warning:
      "node introuvable en chemin stable (/opt/homebrew, /usr/local, /usr/bin) — " +
      "probablement nvm ; Claude Desktop (PATH minimal) risque de ne pas le trouver.",
  };
}

// Fusionne un serveur MCP dans une config client SANS rien écraser d'autre.
// PUR : renvoie un NOUVEL objet, ne mute ni `config` ni `entry`. Préserve les autres
// serveurs ET les autres clés racine (preferences…). C'est LE point critique : ne
// jamais clobber la config existante de l'utilisateur (qui peut contenir des secrets).
export function mergeMcpServer(config, name, entry) {
  const base = config && typeof config === "object" ? config : {};
  const servers =
    base.mcpServers && typeof base.mcpServers === "object" ? base.mcpServers : {};
  return {
    ...base,
    mcpServers: {
      ...servers,
      [name]: { ...entry },
    },
  };
}

// Chemin de la config Claude Desktop (macOS).
export function desktopConfigPath(home = os.homedir()) {
  return path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json"
  );
}

// Racine des versions figées (blue-green, ADR-0007). MÊME défaut que
// scripts/deploy-local.sh (DEPLOY_ROOT) — garder les deux synchronisés. Surchargeable
// par WHATSAPP_DEPLOY_ROOT. `env`/`home` injectés pour test.
export function deployRoot(env = process.env, home = os.homedir()) {
  const override = (env.WHATSAPP_DEPLOY_ROOT || "").trim();
  return override || path.join(home, ".local", "share", "whatsapp-mcp");
}

// Chemin du shim de la version COURANTE : c'est lui que le client (Desktop/Code)
// doit lancer, jamais un checkout. `current` est un lien vers la version figée ;
// le shim résout ce lien à chaque lancement (bascule = un seul ln -sfn).
export function currentShimPath(env = process.env, home = os.homedir()) {
  return path.join(deployRoot(env, home), "current", "bin", "whatsapp-mcp");
}

// Rail DEV (ADR-0007) : un slot « dev » à part, jamais pointé par « current », et un
// état séparé (donc un appairage WhatsApp propre) pour tourner en parallèle de la stable.
export function devShimPath(env = process.env, home = os.homedir()) {
  return path.join(deployRoot(env, home), "dev", "bin", "whatsapp-mcp");
}

// Racine d'état du rail dev : distincte de la stable, sinon les deux serveurs se
// disputeraient le même appairage (contrainte « une seule session » de l'ADR-0007).
export function devStateRoot(home = os.homedir()) {
  return path.join(home, ".config", "whatsapp-mcp-dev");
}

// Racine d'état du rail STABLE (là où la version déployée range appairage/grants) —
// MÊME défaut que le shim bin/whatsapp-mcp : WHATSAPP_MCP_STATE_ROOT || ~/.config/whatsapp-mcp.
// Sert à doctor pour diagnostiquer la cible DÉPLOYÉE, pas le checkout où il est lancé (revue
// Codex PR #38). Garder synchro avec le shim.
export function deployedStateRoot(env = process.env, home = os.homedir()) {
  const override = (env.WHATSAPP_MCP_STATE_ROOT || "").trim();
  return override || path.join(home, ".config", "whatsapp-mcp");
}

// Version DÉPLOYÉE : le fichier VERSION que deploy-local.sh écrit dans chaque copie
// figée (ex. « de985f3 », « dev@<sha> » pour le rail dev). Absent = lancement depuis le
// checkout -> « dev », la signature du dossier de travail. `readFileSync` injecté pour test.
export function deployedVersion(projectRoot, readFileSync = fs.readFileSync) {
  try {
    const v = String(readFileSync(path.join(projectRoot, "VERSION"), "utf8")).trim();
    return v || "dev";
  } catch {
    return "dev";
  }
}

// Claude Desktop tourne-t-il ? Il faut le savoir avant d'écrire sa config : s'il est
// vivant, il la réécrit et efface notre ajout (le clobber observé le 2026-09-12).
// PIÈGE macOS : le « comm » du process principal est son CHEMIN complet
// (…/Claude.app/Contents/MacOS/Claude), donc « pgrep -x Claude » ne le matche JAMAIS —
// c'est ce qui rendait la garde aveugle. On teste plutôt ce binaire précis dans la sortie
// de « ps -axo comm= ». Pur : la sortie ps est injectée (I/O chez l'appelant, testable).
// NB : « …/claude » minuscule = le CLI claude-code, PAS Desktop ; lui n'écrit pas
// claude_desktop_config.json, donc on ne veut surtout pas le confondre (le « C » majuscule
// et le suffixe exact suffisent à les distinguer).
export function desktopRunningFrom(psCommOutput) {
  return String(psCommOutput || "")
    .split("\n")
    .some((line) => line.trim().endsWith("/Claude.app/Contents/MacOS/Claude"));
}
