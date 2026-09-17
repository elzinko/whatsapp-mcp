// Enveloppe autour de Baileys (protocole WhatsApp Web).
// IMPORTANT : tout ce qui est log/QR est écrit sur STDERR.
// STDOUT est réservé au protocole MCP (JSON-RPC) ; y écrire le corromprait.
//
// LECTURE SEULE : ce client ne sait pas envoyer de message. Il n'y a pas de méthode
// d'envoi, pas de drapeau pour l'activer. Voir docs/adr/0001-modele-d-acces-aux-canaux.md
// pour le contrat à respecter le jour où l'écriture reviendra.

import fs from "node:fs";
import path from "node:path";
import makeWASocketDefault, {
  useMultiFileAuthState as useMultiFileAuthStateDefault,
  DisconnectReason,
  fetchLatestBaileysVersion as fetchLatestBaileysVersionDefault,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { dataFileFor, isGroupJid } from "./config.js";
import { MessageStore } from "./store.js";
import { AuthLock } from "./authlock.js";

// Log applicatif -> stderr
export function log(...args) {
  console.error("[whatsapp-mcp]", ...args);
}

// Extrait le texte lisible d'un message WhatsApp (conversation, légende, etc.)
function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    null
  );
}

function toRecord(waMessage) {
  const key = waMessage.key || {};
  const ts = waMessage.messageTimestamp;
  const timestamp =
    typeof ts === "number"
      ? ts
      : ts?.low ?? (ts ? Number(ts) : Math.floor(Date.now() / 1000));
  return {
    id: key.id,
    groupId: key.remoteJid,
    sender: key.participant || waMessage.participant || key.remoteJid,
    fromMe: !!key.fromMe,
    pushName: waMessage.pushName || null,
    text: extractText(waMessage.message),
    timestamp,
  };
}

// Projette un record interne vers le message renvoyé par get_recent_messages (surface MCP).
// `id` (l'identifiant WhatsApp natif, key.id) est exposé pour une ingestion IDEMPOTENTE côté
// consommateur (fiche 20260903085814506) : sans identifiant stable, un rejeu duplique les
// messages. Aucune donnée sensible en plus — c'est un id technique, pas du contenu.
export function toRecentMessage(m) {
  return {
    id: m.id,
    from: m.pushName || m.sender,
    sender: m.sender,
    fromMe: m.fromMe,
    text: m.text,
    at: new Date((m.timestamp || 0) * 1000).toISOString(),
  };
}

function normalize(s) {
  return String(s || "").trim().toLowerCase();
}

// Décide quoi faire quand la connexion se ferme. Fonction PURE (aucun effet de bord),
// pour être testable sans WhatsApp. Voir test/reconnect-plan.js.
//   - "wipe"   : identifiants invalides (401) -> effacer auth, ré-appairage requis.
//   - "giveup" : session remplacée (440) -> une autre connexion a pris la main sur le
//                même dossier auth ; se reconnecter relancerait une guerre + un rate-limit.
//   - "retry"  : coupure ordinaire (515 restart, réseau…) -> reconnexion avec backoff
//                exponentiel plafonné (2s, 4s, 8s… max 60s), `attempt` = n° de tentative.
export function planReconnect(statusCode, attempt) {
  if (statusCode === DisconnectReason.loggedOut) return { action: "wipe" };
  if (statusCode === DisconnectReason.connectionReplaced) return { action: "giveup" };
  const delayMs = Math.min(60000, 2000 * 2 ** Math.max(0, attempt - 1));
  return { action: "retry", delayMs };
}

// Décide si CE process a le droit d'effacer le dossier auth après un 401.
// Fonction PURE, testée dans test/reconnect-plan.js.
// `ours` = creds chargés par ce process ; `rawOnDisk` = contenu actuel de
// creds.json (null si absent). On n'efface QUE si l'identité sur disque est la
// nôtre : si un autre process a ré-appairé entre-temps (registrationId
// différent), le dossier contient SA session — l'effacer casserait son
// appairage en cours (vécu : un serveur zombie recevant un 401 tardif a rasé
// l'appairage tout neuf d'un npm start, crash ENOENT sur creds.json).
export function mayWipeAuth(ours, rawOnDisk) {
  if (rawOnDisk === null || rawOnDisk === undefined) return false; // rien à effacer
  try {
    const disk = JSON.parse(rawOnDisk);
    return disk?.registrationId === ours?.registrationId;
  } catch {
    return true; // creds.json illisible : résidu corrompu, nettoyer est sain
  }
}

export class WhatsAppClient {
  // `deps` : Baileys injectable (fiche 20260916130039008 — teste la voie code
  // d'appairage sans réseau ni vraie session). Absent -> le vrai Baileys, comme avant.
  constructor(config, settings, allowlist, profile, deps) {
    this.config = config;
    this.deps = deps || {
      makeWASocket: makeWASocketDefault,
      useMultiFileAuthState: useMultiFileAuthStateDefault,
      fetchLatestBaileysVersion: fetchLatestBaileysVersionDefault,
    };
    this.settings = settings; // Settings : les canaux autorisés (grants)
    // Le PLAFOND (ADR-0002) : borne les grants, l'ingestion et la lecture.
    // Absent = plafond vide = rien de servi (fail closed).
    this.allowlist = allowlist || {
      entries: [],
      permits: () => false,
      match: () => null,
      load() { return this; },
      refresh() { return this; },
    };
    // Le PROFIL (fiche 0004) : seconde borne, au même point que le plafond.
    // Stub INERTE par défaut (couche opt-in, ADR-0006) : les clients construits
    // sans 4e argument gardent le comportement ADR-0002 inchangé.
    this.profile = profile || {
      exists: false,
      permits: () => false,
      refresh() { return this; },
      load() { return this; },
    };
    // Consentement humain avant chaque grant, injecté par index.js (élicitation MCP
    // quand le client la supporte). Absent = pas de cérémonie supplémentaire.
    this.confirmGrant = null;
    this.sock = null;
    this.state = "starting"; // starting | qr | connecting | open | closed
    this.lastQR = null;
    // Code d'appairage (voie 1, fiche 20260916130039008) : alternative textuelle au QR,
    // jouable en élicitation. null tant qu'aucun n'a été demandé.
    this.pairingCode = null;
    // Numéro mémorisé par start(phoneNumber) (fiche 20260917180706311) : le code n'est
    // demandé à Baileys QU'AU MOMENT de l'event `qr` (WS prêt), jamais juste après
    // makeWASocket (trop tôt -> "Connection Closed", bug confirmé en réel).
    this._pairPhoneNumber = null;
    this.startedAt = Date.now();
    this.stores = new Map(); // jid -> MessageStore (un tampon + une archive par canal)
    this.knownGroups = new Map(); // jid -> nom, snapshot du dernier fetch
    this.reconnectAttempts = 0; // pour le backoff exponentiel des reconnexions
    this.giveUp = false; // vrai si une autre session a pris la main (440) : on cesse de lutter
    // Verrou OS exclusif anti-collision entre process (fiche 0009). Pris AVANT le
    // premier contact avec auth/ (useMultiFileAuthState), dans start().
    this.authLock = new AuthLock(this.config.authLockFile);
    this._shutdownHooked = false;
  }

  isReady() {
    return this.state === "open" && !!this.sock;
  }

  // « Appairé » = identifiants WhatsApp enregistrés (creds.registered) — signal AUTORITAIRE.
  // Lu sur le DISQUE (creds.json), pas sur le socket vivant, pour deux raisons :
  //  1. disponible dès le boot, AVANT que start() ait créé le socket — sinon un compte
  //     déjà appairé serait guidé vers l'appairage pendant la fenêtre de démarrage ;
  //  2. un logout 401 EFFACE auth/ (donc creds.json absent = non appairé), tandis que les
  //     grants (settings.json) SURVIVENT au logout et ne prouvent RIEN (revue Codex #40) —
  //     ne jamais déduire l'appairage des grants.
  isRegistered() {
    try {
      const raw = fs.readFileSync(path.join(this.config.authDir, "creds.json"), "utf8");
      return JSON.parse(raw)?.registered === true;
    } catch {
      return false;
    }
  }

  // Demande un code d'appairage à Baileys pour le socket courant (voie 1, fiche
  // 20260916130039008) : alternative textuelle au QR, présentable en élicitation.
  // Appelable au démarrage (start(phoneNumber)) OU après coup, sur un socket déjà
  // en attente de QR (outil MCP `whatsapp_pair`). Fail-safe : refuse plutôt que de
  // redemander un code à un compte déjà enregistré (rien à ré-appairer).
  async requestPairingCode(phoneNumber) {
    if (!this.sock) throw new Error("Client WhatsApp non démarré.");
    if (this.sock.authState?.creds?.registered) {
      throw new Error("Ce compte WhatsApp est déjà appairé.");
    }
    const code = await this.sock.requestPairingCode(phoneNumber);
    this.pairingCode = code;
    log(`Code d'appairage : ${code} (à saisir sur le téléphone).`);
    return code;
  }

  // Rend `this.lastQR` en art ASCII (via qrcode-terminal), pour l'exposer dans la RÉPONSE
  // de l'outil MCP `whatsapp_pair` (fiche 20260917180706311) — jamais sur stdout, réservé
  // au JSON-RPC (voir en-tête du fichier). null tant qu'aucun QR n'est encore disponible
  // (connexion pas encore montée jusqu'à l'event `qr`).
  currentQrArt() {
    if (!this.lastQR) return null;
    let art = null;
    // qrcode.generate(str, opts, cb) appelle cb de façon SYNCHRONE : on capture la
    // string produite dans cette variable fermée, pas de promesse nécessaire.
    qrcode.generate(this.lastQR, { small: true }, (output) => {
      art = output;
    });
    return art;
  }

  // Tampon d'un canal, créé à la demande et rattaché à son archive JSONL.
  _storeFor(jid) {
    let store = this.stores.get(jid);
    if (store) return store;
    store = new MessageStore(this.config.maxMessages);
    if (this.config.persist) {
      const file = dataFileFor(jid);
      const loaded = store.attachFile(file);
      log(`Canal ${jid} : ${loaded} message(s) rechargé(s) depuis ${file}`);
    }
    this.stores.set(jid, store);
    return store;
  }

  // Le sujet (nom) de référence d'un canal : celui du grant (résolu par Baileys à
  // l'époque) ou, à défaut, du snapshot des groupes — jamais un texte fourni par le LLM.
  // Partagé par _ceilingHas et _profileHas pour qu'ils ne divergent jamais (revue 0004).
  _subjectFor(jid) {
    return this.settings.grants.get(jid)?.subject ?? this.knownGroups.get(jid);
  }

  // Le plafond couvre-t-il ce canal ? Le nom comparé vient du grant (résolu par
  // Baileys à l'époque) ou du snapshot des groupes — jamais d'un texte du LLM.
  //
  // Deux garanties, issues de l'audit de pré-publication :
  //   1. le plafond est RECHARGÉ s'il a changé sur disque (retrait immédiat) ;
  //   2. une couverture par NOM seul est refusée si plusieurs groupes connus portent
  //      ce nom — le nom est contrôlé par les admins d'un groupe, donc usurpable :
  //      un tiers peut renommer SON groupe comme une entrée de ton plafond.
  // Un nom partagé par 2+ groupes connus est une identité FAIBLE : un admin peut
  // renommer SON groupe pour usurper une entrée par nom. Plafond ET profil refusent
  // donc une couverture par nom ambiguë (audit de pré-publication + retour Codex PR #34).
  _nameIsAmbiguous(subject) {
    const target = normalize(subject);
    if (!target) return false;
    return [...this.knownGroups.values()].filter((s) => normalize(s) === target).length > 1;
  }

  _ceilingHas(jid) {
    this.allowlist.refresh();
    const subject = this._subjectFor(jid);
    const match = this.allowlist.match(jid, subject);
    if (match === "jid") return true; // identité forte
    if (match !== "name") return false;
    if (this._nameIsAmbiguous(subject)) {
      log(
        `Plafond : « ${subject} » désigne plusieurs groupes — entrée par nom ambiguë, ` +
          `REFUSÉE. Remplace-la par le JID exact dans ${this.config.allowlistFile}.`
      );
      return false;
    }
    return true;
  }

  // Le PROFIL couvre-t-il ce canal ? Seconde borne, au même point que le plafond
  // (fiche 0004, ADR-0006). Opt-in : ni profiles.json ni WHATSAPP_PROFILE -> couche
  // INERTE (tout ce qui passe le plafond passe aussi le profil). Dès que l'un des
  // deux existe -> fail closed : profil non déclaré ou inconnu -> rien.
  _profileHas(jid) {
    this.profile.refresh();
    const declared = String(this.config.profile || "").trim();
    const active = declared !== "" || this.profile.exists;
    if (!active) return true; // profils non configurés : couche inerte (ADR-0002)
    if (!declared) return false; // configurés mais process non déclaré : RIEN
    const subject = this._subjectFor(jid);
    const match = this.profile.match(declared, jid, subject);
    if (match === "jid") return true; // identité forte
    if (match !== "name") return false;
    // Un match par NOM n'est fiable que si l'inventaire des groupes est autoritatif :
    // avant _refreshGroups (démarrage, déconnexion) knownGroups est vide et l'unicité du
    // nom est INVÉRIFIABLE → fail closed. Inventaire chargé, un nom porté par 2+ groupes
    // reste refusé (un admin renommerait son groupe au nom du profil pour s'y infiltrer).
    // Seul un JID exact passe sans inventaire autoritatif (Codex PR #34, rounds 1-2).
    if (this.knownGroups.size === 0 || this._nameIsAmbiguous(subject)) {
      log(`Profil « ${declared} » : nom « ${subject} » non vérifiable (inventaire absent) ou ambigu — REFUSÉ.`);
      return false;
    }
    return true;
  }

  // Le périmètre effectif : plafond ET profil. Deux bornes au même point.
  _inScope(jid) {
    return this._ceilingHas(jid) && this._profileHas(jid);
  }

  // 1re barrière : rien de ce qui n'est pas explicitement autorisé n'entre,
  // ni en mémoire ni sur disque. Grant ET plafond/profil exigés (ADR-0002/0006).
  _ingest(waMessage) {
    const jid = waMessage?.key?.remoteJid;
    if (!jid || !this.settings.has(jid) || !this._inScope(jid)) return;
    const rec = toRecord(waMessage);
    if (rec.id) this._storeFor(jid).add(rec);
  }

  // Installe les gestionnaires de libération du verrou. Appelé une seule fois, après
  // la première acquisition réussie : un verrou non relâché (crash, kill -9) reste de
  // toute façon récupérable par le mécanisme orphelin (voir src/authlock.js).
  _installLockReleaseOnExit() {
    if (this._shutdownHooked) return;
    this._shutdownHooked = true;
    const release = () => {
      try {
        this.authLock.release();
      } catch {}
    };
    process.once("exit", release);
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.once(sig, () => {
        release();
        process.exit(0);
      });
    }
  }

  // Acquiert le verrou auth/ (synchrone). Lève une Error `{ code: "ELOCKED" }` si un autre
  // process VIVANT le tient. L'appelant DOIT alors sortir SANS ouvrir le transport MCP :
  // sinon le perdant resterait un serveur MCP zombie, WhatsApp indisponible en permanence
  // (revue Codex #27). Réentrant pour le même PID (redémarrage/reconnexion interne).
  acquireLock() {
    const lockResult = this.authLock.acquire();
    if (!lockResult.acquired) {
      const message = AuthLock.describeConflict(lockResult.heldByPid, this.config.authLockFile);
      log(message);
      const err = new Error(message);
      err.code = "ELOCKED";
      throw err;
    }
    if (lockResult.reclaimedFrom) {
      log(
        `Verrou auth/ orphelin récupéré (l'ancien détenteur PID ${lockResult.reclaimedFrom} n'est plus vivant).`
      );
    }
    this._installLockReleaseOnExit();
    return lockResult;
  }

  // `phoneNumber` (optionnel, fiche 20260916130039008) : voie 1 (code d'appairage),
  // alternative au QR. N'affecte rien tant que le compte est DÉJÀ enregistré, et
  // absent -> comportement EXISTANT inchangé (aucun appelant existant ne le fournit).
  async start(phoneNumber) {
    // Le verrou est pris AVANT le premier contact avec auth/ (useMultiFileAuthState
    // juste en dessous). Le perdant n'ouvre rien : il sort proprement avec un message
    // qui dit quoi faire, sans jamais toucher au dossier auth/ (fiche 0009). Idempotent :
    // main() l'a en général déjà pris (même PID → réentrant) pour pouvoir sortir avant
    // d'ouvrir le transport MCP.
    this.acquireLock();

    const { state, saveCreds } = await this.deps.useMultiFileAuthState(this.config.authDir);
    // Baileys crée auth/ avec l'umask du process (souvent 0755, lisible par les autres
    // comptes) : on referme. Ce dossier contient les identifiants de session WhatsApp —
    // quiconque les lit peut se faire passer pour cet appareil lié.
    try {
      fs.chmodSync(this.config.authDir, 0o700);
      for (const f of fs.readdirSync(this.config.authDir)) {
        fs.chmodSync(path.join(this.config.authDir, f), 0o600);
      }
    } catch (e) {
      log("Impossible de restreindre les permissions de auth/ :", e?.message);
    }
    let version;
    try {
      ({ version } = await this.deps.fetchLatestBaileysVersion());
    } catch {
      version = undefined; // Baileys utilisera une version par défaut
    }

    // Les archives des canaux déjà autorisés sont rechargées avant même la connexion :
    // get_recent_messages répond dès le démarrage, sans attendre WhatsApp.
    for (const g of this.settings.list()) this._storeFor(g.jid);

    const sock = this.deps.makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }, pino.destination(2)), // Baileys -> stderr, muet
      printQRInTerminal: false, // on gère le QR nous-mêmes (vers stderr)
      browser: Browsers.appropriate(this.config.deviceName),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    this.sock = sock;

    // Voie 1 (fiche 20260916130039008, timing réparé fiche 20260917180706311) : un
    // numéro fourni -> mémorisé pour être joué au bon moment. PAS ICI : juste après
    // makeWASocket, le WebSocket n'est pas encore prêt (Baileys exige d'attendre l'event
    // `connection.update` avec `qr`) — l'appeler ici a provoqué en réel un
    // « Impossible d'obtenir un code d'appairage : Connection Closed ». Le déclenchement
    // réel se fait dans le handler `connection.update`, branche `qr`, plus bas.
    this._pairPhoneNumber = phoneNumber || null;

    // Une écriture de creds qui échoue (ex: dossier auth supprimé sous nos pieds par
    // un autre process) ne doit JAMAIS crasher le serveur : rejet capté et journalisé.
    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (e) {
        log("Échec de sauvegarde des identifiants (auth supprimé ?) :", e?.message);
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.state = "qr";
        this.lastQR = qr;
        log("Scanne ce QR code depuis ton TÉLÉPHONE :");
        log("  iPhone  : WhatsApp > Réglages > Appareils liés > Lier un appareil");
        log("  Android : WhatsApp > ⋮ > Appareils connectés > Connecter un appareil");
        // qrcode-terminal écrit par défaut sur stdout -> on redirige vers stderr
        qrcode.generate(qr, { small: true }, (art) => process.stderr.write(art + "\n"));

        // Voie 1 (timing réparé, fiche 20260917180706311) : le WebSocket est enfin PRÊT
        // (Baileys vient d'émettre `qr`) — c'est le bon moment pour demander le code,
        // jamais avant. Une seule fois (!this.pairingCode), et seulement si un numéro a
        // été fourni pour un compte pas encore enregistré (rien à ré-appairer sinon).
        if (this._pairPhoneNumber && !sock.authState?.creds?.registered && !this.pairingCode) {
          try {
            await this.requestPairingCode(this._pairPhoneNumber);
          } catch (e) {
            log("Impossible d'obtenir un code d'appairage :", e?.message);
          }
        }
      }
      if (connection === "connecting") {
        this.state = "connecting";
        log("Connexion à WhatsApp…");
      }
      if (connection === "open") {
        this.state = "open";
        this.lastQR = null;
        this.reconnectAttempts = 0; // connexion réussie : on repart de zéro
        log("Connecté à WhatsApp.");
        try {
          await this._refreshGroups();
          this._revalidateGrants();
          this._bootstrapFromEnv();
        } catch (e) {
          log("Initialisation des canaux impossible :", e?.message);
        }
        for (const g of this.settings.list()) this._storeFor(g.jid);
        if (this.settings.grants.size === 0) {
          log(
            "Aucun canal autorisé. Demande à ton LLM : « liste mes groupes WhatsApp » puis « autorise <nom> »."
          );
        } else {
          log(
            `Canaux autorisés en lecture : ${this.settings
              .list()
              .map((g) => `« ${g.subject || g.jid} »`)
              .join(", ")}`
          );
        }
      }
      if (connection === "close") {
        this.state = "closed";
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const plan = planReconnect(statusCode, this.reconnectAttempts + 1);

        if (plan.action === "wipe") {
          // 401 : déconnecté côté téléphone -> on efface les identifiants (ré-appairage
          // requis) — mais SEULEMENT si le dossier contient encore NOTRE session (un
          // autre process a pu ré-appairer entre-temps, voir mayWipeAuth).
          log("Connexion fermée (code=401). Déconnecté.");
          let rawOnDisk = null;
          try {
            rawOnDisk = fs.readFileSync(path.join(this.config.authDir, "creds.json"), "utf8");
          } catch {}
          if (mayWipeAuth(state.creds, rawOnDisk)) {
            try {
              fs.rmSync(this.config.authDir, { recursive: true, force: true });
              log("Session effacée. Relance le serveur pour ré-appairer.");
              log("Les canaux autorisés sont conservés dans settings.json.");
            } catch {}
          } else {
            log(
              "Le dossier auth appartient à une autre session (ré-appairage en cours ?) : " +
                "on n'y touche pas. Ce process s'arrête là."
            );
          }
          return;
        }

        if (plan.action === "giveup") {
          // 440 : une AUTRE connexion utilise le même dossier auth et a pris la main.
          // Se reconnecter relancerait une guerre de sessions (et un rate-limit).
          this.giveUp = true;
          log(
            "Connexion fermée (code=440) : une autre session utilise le même dossier auth " +
              `(${this.config.authDir}). Arrêt des reconnexions pour éviter le conflit et le rate-limit. ` +
              "N'exécute qu'UN seul client à la fois sur ce dossier, ou donne à chacun son propre WHATSAPP_AUTH_DIR."
          );
          return;
        }

        // "retry" : coupure ordinaire -> reconnexion avec backoff exponentiel plafonné.
        this.reconnectAttempts += 1;
        log(
          `Connexion fermée (code=${statusCode}). Reconnexion dans ${Math.round(plan.delayMs / 1000)}s ` +
            `(tentative ${this.reconnectAttempts})…`
        );
        setTimeout(() => {
          if (!this.giveUp) this.start().catch((e) => log("Echec reconnexion:", e?.message));
        }, plan.delayMs);
      }
    });

    // Historique récent envoyé par le téléphone à la connexion
    sock.ev.on("messaging-history.set", ({ messages }) => {
      for (const m of messages || []) this._ingest(m);
    });

    // Messages en direct
    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const m of messages || []) this._ingest(m);
    });

    return this;
  }

  // Rafraîchit le snapshot des groupes du compte. Renvoie les métadonnées brutes.
  async _refreshGroups() {
    const all = await this.sock.groupFetchAllParticipating();
    this.knownGroups = new Map(Object.values(all).map((g) => [g.id, g.subject]));
    return all;
  }

  // Revérification au démarrage : un grant dont le groupe a disparu (ou dont le compte
  // n'est plus membre) est purgé. Un groupe renommé voit son nom rafraîchi.
  _revalidateGrants() {
    for (const g of this.settings.list()) {
      if (!this.knownGroups.has(g.jid)) {
        this.settings.revoke(g.jid);
        this.stores.delete(g.jid);
        log(`Grant purgé (groupe inaccessible ou compte non membre) : « ${g.subject || "?"} » (${g.jid})`);
        continue;
      }
      const current = this.knownGroups.get(g.jid);
      if (current && current !== g.subject) {
        this.settings.grant(g.jid, current);
        log(`Groupe renommé : « ${g.subject} » -> « ${current} »`);
      }
      if (!this._inScope(g.jid)) {
        log(
          `Grant SUSPENDU (hors plafond) : « ${current || g.subject || g.jid} » — ` +
            `réintègre-le à la main dans ${this.config.allowlistFile} pour le réactiver.`
        );
      }
    }
  }

  // Amorçage : convertit un WHATSAPP_GROUP_ID/NAME hérité en grant, une seule fois.
  // Dès qu'un grant existe, settings.json fait foi et l'env n'est plus consulté.
  _bootstrapFromEnv() {
    if (this.settings.grants.size > 0) return;
    const wanted = this.config.groupId || this.config.groupName;
    if (!wanted) return;

    let jid = null;
    if (isGroupJid(this.config.groupId)) {
      jid = this.knownGroups.has(this.config.groupId) ? this.config.groupId : null;
    } else {
      const target = normalize(this.config.groupName);
      for (const [id, subject] of this.knownGroups) {
        if (normalize(subject) === target) {
          jid = id;
          break;
        }
      }
    }

    if (!jid) {
      log(`Amorçage .env : groupe « ${wanted} » introuvable. Utilise 'list_groups' puis 'grant_channel'.`);
      return;
    }
    const subject = this.knownGroups.get(jid);
    this.settings.grant(jid, subject);
    this._storeFor(jid);
    log(`Amorçage depuis .env : « ${subject} » autorisé en lecture (${jid}).`);
  }

  // Résout un JID ou un nom exact de groupe vers un JID.
  // Les canaux déjà autorisés sont résolvables même hors connexion.
  _resolveToJid(channel) {
    const raw = String(channel || "").trim();
    if (!raw) throw new Error("Aucun canal fourni.");
    if (isGroupJid(raw)) return raw;

    const target = normalize(raw);
    for (const g of this.settings.list()) {
      if (normalize(g.subject) === target) return g.jid;
    }
    const matches = [...this.knownGroups.entries()].filter(([, s]) => normalize(s) === target);
    if (matches.length === 1) return matches[0][0];
    if (matches.length > 1) {
      throw new Error(`Plusieurs groupes s'appellent « ${raw} » : utilise le JID exact (…@g.us).`);
    }
    throw new Error(`Groupe « ${raw} » introuvable. Utilise 'list_groups' pour voir les noms et JID.`);
  }

  // Le « menu » — borné au PLAFOND. Ne renvoie aucun contenu de message.
  //
  // Pourquoi borné (audit de pré-publication) : renvoyer TOUS les groupes exposait la
  // cartographie sociale complète du compte (noms, JID, tailles) à un LLM — y compris
  // sous injection — alors que la valeur du projet est justement de garder les groupes
  // non pertinents hors du contexte. Le seul chemin qui voit tout est le terminal
  // (`npm run list-groups`) : un humain, hors conversation.
  async listGroups() {
    if (!this.isReady()) throw new Error("WhatsApp non connecté (scanne d'abord le QR code).");
    const all = await this._refreshGroups();
    const groups = [];
    let hiddenOutsideAllowlist = 0;
    let hiddenOutsideProfile = 0;
    for (const g of Object.values(all)) {
      if (!this._ceilingHas(g.id)) {
        hiddenOutsideAllowlist += 1;
        continue;
      }
      if (!this._profileHas(g.id)) {
        // Au plafond mais hors du profil actif : caché POUR CE PROJET (pas hors plafond).
        hiddenOutsideProfile += 1;
        continue;
      }
      groups.push({
        id: g.id,
        subject: g.subject,
        participants: Array.isArray(g.participants) ? g.participants.length : undefined,
        granted: this.settings.has(g.id),
        inAllowlist: true,
      });
    }
    groups.sort((a, b) => (a.subject || "").localeCompare(b.subject || ""));
    return { groups, hiddenOutsideAllowlist, hiddenOutsideProfile };
  }

  // Autorise la LECTURE d'un canal. Le nom mémorisé est toujours celui résolu par
  // Baileys, jamais celui fourni par l'appelant (ADR-0001). Deux barrières (ADR-0002) :
  //   1. le PLAFOND : hors de allowlist.json, refus sec — seul l'humain, à la main,
  //      peut étendre cette liste ;
  //   2. le CONSENTEMENT : si le client supporte l'élicitation, l'humain valide via
  //      un formulaire rédigé par le serveur, hors de portée du LLM.
  async grantChannel(channel) {
    if (!this.isReady()) throw new Error("WhatsApp non connecté (scanne d'abord le QR code).");
    await this._refreshGroups();
    const jid = this._resolveToJid(channel);
    if (!this.knownGroups.has(jid)) {
      throw new Error(`Groupe inconnu, ou le compte n'en est pas membre : ${jid}`);
    }
    const subject = this.knownGroups.get(jid);

    this.allowlist.refresh(); // fraîcheur : une édition manuelle s'applique sans redémarrage
    if (!this._ceilingHas(jid)) {
      throw new Error(
        `« ${subject} » est hors du plafond. Seul l'humain peut l'y ajouter, à la main, ` +
          `dans ${this.config.allowlistFile} (aucun outil ne peut le faire à sa place). ` +
          `Puis réessaie grant_channel.`
      );
    }
    // Au plafond mais hors du profil actif : le conseil n'est PAS d'éditer le plafond
    // (il y est déjà) mais le profil (Codex PR #34).
    if (!this._profileHas(jid)) {
      throw new Error(
        `« ${subject} » est au plafond mais hors du profil actif` +
          (this.config.profile ? ` « ${this.config.profile} »` : "") +
          `. Ajoute-le à ce profil dans ${this.config.profilesFile} (il est déjà au plafond).`
      );
    }

    let via = null;
    if (this.confirmGrant) {
      const res = await this.confirmGrant({ jid, subject });
      if (!res?.accepted) {
        throw new Error(
          `Autorisation refusée par l'humain pour « ${subject} »` +
            (res?.reason ? ` (${res.reason})` : "") +
            ". Le grant n'a pas été accordé."
        );
      }
      via = res?.via ?? null;
    }

    this.settings.grant(jid, subject, via);
    this._storeFor(jid);
    log(`Grant LECTURE accordé : « ${subject} » (${jid})`);
    return { jid, subject, scope: "read", granted: true };
  }

  // Retire l'autorisation. L'archive disque déjà écrite n'est pas supprimée.
  revokeChannel(channel) {
    const jid = this._resolveToJid(channel);
    const subject = this.settings.grants.get(jid)?.subject || null;
    if (!this.settings.revoke(jid)) throw new Error(`Ce canal n'est pas autorisé : ${jid}`);
    this.stores.delete(jid);
    log(`Grant révoqué : « ${subject || jid} » (${jid})`);
    return { jid, subject, revoked: true };
  }

  // Messages récents d'UN canal autorisé ET couvert par le plafond. Si `channel`
  // est omis et qu'un seul canal est actif, c'est lui. Sinon il faut choisir.
  recentFor(channel, limit = 50) {
    // Un grant sorti du plafond (édition manuelle de allowlist.json) est SUSPENDU :
    // il reste dans settings.json mais ne sert plus rien tant qu'il n'y revient pas.
    const granted = this.settings.list().filter((g) => this._inScope(g.jid));
    let jid;
    if (channel) {
      jid = this._resolveToJid(channel);
      if (!this.settings.has(jid)) {
        throw new Error(`Canal non autorisé : ${jid}. Utilise 'grant_channel' d'abord.`);
      }
      if (!this._inScope(jid)) {
        throw new Error(
          `Canal suspendu : « ${this.settings.grants.get(jid)?.subject || jid} » est sorti du ` +
            `plafond. Seul l'humain peut le réintégrer, à la main, dans ${this.config.allowlistFile}.`
        );
      }
    } else if (granted.length === 1) {
      jid = granted[0].jid;
    } else if (granted.length === 0) {
      throw new Error(
        "Aucun canal autorisé. Utilise 'list_groups' pour voir tes groupes, puis 'grant_channel'."
      );
    } else {
      const noms = granted.map((g) => `« ${g.subject || g.jid} »`).join(", ");
      throw new Error(`Plusieurs canaux autorisés : précise 'channel' parmi ${noms}.`);
    }
    const store = this._storeFor(jid);
    return {
      jid,
      subject: this.settings.grants.get(jid)?.subject || null,
      messages: store.recent(limit),
      buffered: store.size(),
    };
  }

  status() {
    // Un grant hors du profil ACTIF appartient à un autre projet : on ne le divulgue
    // pas (JID, nom, provenance, tampon) — c'est précisément ce que le profil doit
    // cacher (retour Codex PR #34). En couche inerte, _profileHas est vrai pour tous
    // (statu quo). `suspended` reste pour un grant DANS le profil mais sorti du PLAFOND.
    const visible = this.settings.list().filter((g) => this._profileHas(g.jid));
    return {
      state: this.state,
      connected: this.isReady(),
      // Ce serveur ne sait pas envoyer : il n'existe aucune méthode d'envoi (ADR-0001).
      readOnly: true,
      grantedChannels: visible.map((g) => ({
        jid: g.jid,
        subject: g.subject,
        scope: g.scope,
        // suspended = dans le profil mais sorti du plafond : inerte tant que l'humain
        // ne le réintègre pas à la main dans allowlist.json.
        suspended: !this._ceilingHas(g.jid) || undefined,
        messagesBuffered: this.stores.get(g.jid)?.size() ?? 0,
        // Provenance du consentement (fiche 0008) : dit sans ambiguïté si un humain
        // a confirmé (élicitation/Touch ID) ou si le client l'a auto-accordé sans
        // humain (repli fail-open de l'ADR-0002, via="client-permissions").
        consentVia: g.via ?? null,
        confirmedByHuman: g.via == null ? null : g.via === "elicitation" || g.via === "touchid",
      })),
      allowlist: {
        file: this.config.allowlistFile,
        channels: this.allowlist.entries.length,
        editableBy: "l'humain uniquement, à la main — aucun outil MCP n'y écrit",
      },
      persistence: this.config.persist
        ? { enabled: true, dir: this.config.dataDir }
        : { enabled: false },
      settingsFile: this.config.settingsFile,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      hint:
        this.state === "qr"
          ? "Un QR code est affiché dans les logs : scanne-le depuis ton téléphone (iPhone : Réglages > Appareils liés ; Android : ⋮ > Appareils connectés)."
          : visible.length === 0
            ? "Aucun canal autorisé : appelle 'list_groups' puis 'grant_channel'."
            : undefined,
    };
  }
}
