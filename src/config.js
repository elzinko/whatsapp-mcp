// Chargement de la configuration depuis l'environnement + un éventuel fichier .env.
// Volontairement sans dépendance (pas de dotenv) pour garder le projet léger.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TTL_MS as DEFAULT_SESSION_TTL_MS } from "./sessions.js";
import { deployedVersion } from "./setup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

function loadDotEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Retire d'éventuels guillemets englobants
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Ne pas écraser une variable déjà définie dans l'environnement réel
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function bool(v, fallback) {
  if (v === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

const authDir = process.env.WHATSAPP_AUTH_DIR
  ? path.resolve(projectRoot, process.env.WHATSAPP_AUTH_DIR)
  : path.join(projectRoot, "auth");

// Verrou OS exclusif anti-collision entre process (fiche 0009). À CÔTÉ de authDir,
// pas dedans : auth/ est effacé au wipe post-401 (ré-appairage) et un verrou logé
// dedans disparaîtrait avec lui juste avant qu'un nouveau process ne le réutilise.
// Voir src/authlock.js.
const authLockFile = process.env.WHATSAPP_AUTH_LOCK
  ? path.resolve(projectRoot, process.env.WHATSAPP_AUTH_LOCK)
  : `${authDir}.lock`;

const dataDir = process.env.WHATSAPP_DATA_DIR
  ? path.resolve(projectRoot, process.env.WHATSAPP_DATA_DIR)
  : path.join(projectRoot, "data");

// Réglages persistants (canaux autorisés). Volontairement hors de authDir, qui est
// effacé au logout WhatsApp, et hors de dataDir, qui est l'archive des messages.
const settingsFile = process.env.WHATSAPP_SETTINGS_FILE
  ? path.resolve(projectRoot, process.env.WHATSAPP_SETTINGS_FILE)
  : path.join(projectRoot, "settings.json");

// Le PLAFOND : liste des canaux que le serveur a le droit de servir, éditée
// uniquement à la main (aucun outil MCP n'y écrit). Voir src/allowlist.js et ADR-0002.
const allowlistFile = process.env.WHATSAPP_ALLOWLIST_FILE
  ? path.resolve(projectRoot, process.env.WHATSAPP_ALLOWLIST_FILE)
  : path.join(projectRoot, "allowlist.json");

// Le PROFIL (fiche 0004) : seconde borne au même point que le plafond, activée
// par projet via WHATSAPP_PROFILE (posé par le .mcp.json de ce projet). Voir
// src/profiles.js et docs/adr/0006. Opt-in : absent + profiles.json absent =
// couche inerte.
const profile = (process.env.WHATSAPP_PROFILE || "").trim();
const profilesFile = process.env.WHATSAPP_PROFILES_FILE
  ? path.resolve(projectRoot, process.env.WHATSAPP_PROFILES_FILE)
  : path.join(projectRoot, "profiles.json");

// Drapeau d'authentification forte (Touch ID) sur grant_channel (ADR-0003). Absent ->
// ON par défaut ; {"enabled":false} désarme à la main. Voir src/strongauth.js.
const strongAuthFile = process.env.WHATSAPP_STRONG_AUTH_FILE
  ? path.resolve(projectRoot, process.env.WHATSAPP_STRONG_AUTH_FILE)
  : path.join(projectRoot, "strong-auth.json");

// Registre des sessions de lecture (fiche 20260902223310499) : un fichier par
// jeton, à côté de settings.json. Gitignored, dossier 0700 (voir src/sessions.js).
const sessionsDir = process.env.WHATSAPP_SESSIONS_DIR
  ? path.resolve(projectRoot, process.env.WHATSAPP_SESSIONS_DIR)
  : path.join(projectRoot, "sessions");

// TTL par défaut d'une session, en millisecondes. 8h (fiche), surchargeable par
// variable d'environnement. Toute valeur non entière ou <= 0 est ignorée
// (fail-secure vers le défaut plutôt qu'un TTL absurde ou nul).
const sessionTtlMs = (() => {
  const raw = Number.parseInt(process.env.WHATSAPP_SESSION_TTL_MS || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_TTL_MS;
})();

// Le démon (ADR-0008) : socket Unix, secret partagé local, log d'audit. Ces trois
// chemins vivent au STATE ROOT STABLE, PAS dans projectRoot (revue Codex #4). En
// déploiement versionné (ADR-0007), projectRoot est le dossier de LA VERSION FIGÉE,
// qui change à chaque `deploy`. Le verrou auth/ — le singleton du démon — vit, lui, au
// state root stable (via WHATSAPP_AUTH_DIR posé par bin/whatsapp-mcp). Si socket/secret
// suivaient projectRoot, après un switch de version le nouveau frontend viserait un
// nouveau chemin de socket, spawnerait un 2e démon qui mourrait sur le verrou partagé
// tenu par l'ancien, et le polling échouerait jusqu'à tuer l'ancien à la main. On dérive
// donc du state root = dirname(authDir) : il suit WHATSAPP_AUTH_DIR (stable inter-versions)
// et vaut projectRoot en dev (aucun shim). Démon et client calculent le même chemin tant
// qu'ils importent ce config.js.
const stateRoot = path.dirname(authDir);

// Secret et log : fichiers normaux (aucune limite de longueur), au state root stable —
// sinon un frontend d'une nouvelle version lirait un secret différent de celui du démon
// en cours, et toutes les requêtes seraient refusées (secrets divergents).
const daemonSecretFile = process.env.WHATSAPP_DAEMON_SECRET_FILE
  ? path.resolve(projectRoot, process.env.WHATSAPP_DAEMON_SECRET_FILE)
  : path.join(stateRoot, "daemon.secret");

const daemonLogFile = process.env.WHATSAPP_DAEMON_LOG_FILE
  ? path.resolve(projectRoot, process.env.WHATSAPP_DAEMON_LOG_FILE)
  : path.join(stateRoot, "daemon.log");

// La socket Unix est limitée à ~104 octets (`sun_path`, macOS). Au state root elle est
// courte (ex. ~/.config/whatsapp-mcp/daemon.sock ≈ 47 octets) ET stable. Repli seulement
// si le state root lui-même est trop profond (worktree de dev à chemin long) : un dossier
// runtime court, keyé sur le hash DU STATE ROOT (jamais du projectRoot — sinon deux
// versions ne partageraient pas le même démon).
const MAX_SOCKET_PATH_BYTES = 104;

function defaultDaemonSocket() {
  const atStateRoot = path.join(stateRoot, "daemon.sock");
  if (Buffer.byteLength(atStateRoot, "utf8") < MAX_SOCKET_PATH_BYTES) return atStateRoot;
  const hash = crypto.createHash("sha1").update(stateRoot).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `whatsapp-mcp-${hash}.sock`);
}

const daemonSocket = process.env.WHATSAPP_DAEMON_SOCKET
  ? path.resolve(projectRoot, process.env.WHATSAPP_DAEMON_SOCKET)
  : defaultDaemonSocket();

// Garde-fou : chemin résolu trop long (surcharge env explicite, ou tmpdir anormal) ->
// on échoue TÔT avec un message clair plutôt que de crasher plus tard sur bind/chmod.
const daemonSocketBytes = Buffer.byteLength(daemonSocket, "utf8");
if (daemonSocketBytes >= MAX_SOCKET_PATH_BYTES) {
  throw new Error(
    `Chemin de socket démon trop long (${daemonSocketBytes} octets >= ${MAX_SOCKET_PATH_BYTES}) : ` +
      `${daemonSocket}. Fixe WHATSAPP_DAEMON_SOCKET vers un chemin plus court.`
  );
}

export const config = {
  projectRoot,
  // Version servie (ADR-0007) : lue dans le fichier VERSION de la copie figée, « dev »
  // si on tourne depuis le checkout. Exposée par whatsapp_status pour vérifier d'un
  // coup d'œil QUELLE build répond (déployée vs dossier de travail).
  deployedVersion: deployedVersion(projectRoot),
  // Amorçage uniquement : au tout premier démarrage, si aucun grant n'existe encore,
  // ce groupe est converti en grant de lecture. Ensuite, settings.json fait foi et
  // ces variables ne servent plus à rien (voir ADR-0001).
  groupId: (process.env.WHATSAPP_GROUP_ID || "").trim(),
  groupName: (process.env.WHATSAPP_GROUP_NAME || "").trim(),
  // Taille du tampon mémoire, PAR canal autorisé (le disque garde tout).
  maxMessages: Number.parseInt(process.env.WHATSAPP_MAX_MESSAGES || "500", 10) || 500,
  // Persistance des messages sur disque (archive JSONL, survit aux redémarrages).
  persist: bool(process.env.WHATSAPP_PERSIST, true),
  // Nom affiché dans WhatsApp > Appareils liés/connectés. Figé AU MOMENT de
  // l'appairage : le changer n'a d'effet qu'après un ré-appairage (QR).
  deviceName: (process.env.WHATSAPP_DEVICE_NAME || "").trim() || "whatsapp-mcp",
  authDir,
  authLockFile,
  dataDir,
  settingsFile,
  allowlistFile,
  profile,
  profilesFile,
  strongAuthFile,
  sessionsDir,
  sessionTtlMs,
  daemonSocket,
  daemonSecretFile,
  daemonLogFile,
};

// Un JID de groupe WhatsApp se termine toujours par "@g.us".
export function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith("@g.us");
}

// Nom de fichier sûr pour un JID (ex: "12036...@g.us" -> "12036..._g.us.jsonl")
export function dataFileFor(groupId) {
  const safe = String(groupId).replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(dataDir, `${safe}.jsonl`);
}
