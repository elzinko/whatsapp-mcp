// Test du verrou OS exclusif sur auth/ (fiche 0009).
// Hermétique : tout se passe dans un tmpdir, aucun contact avec le vrai auth/ du projet.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AuthLock, defaultLockPath, isProcessAlive } from "../src/authlock.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-authlock-"));
const authDir = path.join(tmp, "auth");
const lockPath = defaultLockPath(authDir);

try {
  // 0) Emplacement du verrou : à côté de auth/, pas dedans.
  check("le verrou par défaut est un chemin frère de auth/, pas un fichier dedans", lockPath === `${authDir}.lock`);

  // 1) acquire() réussit sur un dossier libre.
  const owner = new AuthLock(lockPath);
  const first = owner.acquire();
  check("premier acquire réussit sur un verrou libre", first.acquired === true);
  check("le fichier de verrou contient le PID du détenteur", fs.readFileSync(lockPath, "utf8").trim() === String(process.pid));

  // 2) Un 2e acquire sur le même verrou, PID vivant simulé = le PID courant, échoue
  //    proprement (pas de dégât : le fichier garde le PID du premier détenteur).
  const challenger = new AuthLock(lockPath, { pid: 999999 }); // PID distinct, forcément != owner
  const second = challenger.acquire();
  check("un 2e acquire sur un verrou tenu par un PID vivant échoue", second.acquired === false);
  check("l'échec rapporte le PID du détenteur", second.heldByPid === process.pid);
  check("le fichier n'a pas été altéré par la tentative perdante", fs.readFileSync(lockPath, "utf8").trim() === String(process.pid));

  // 3) Le message du perdant dit quoi faire, pas juste "erreur".
  const message = AuthLock.describeConflict(second.heldByPid, lockPath);
  check("le message mentionne npm run stop", message.includes("npm run stop"));
  check("le message mentionne le PID détenteur", message.includes(String(process.pid)));
  check("le message n'est pas un simple mot 'erreur'", message.length > 20 && /auth/.test(message));
  // P1 : échappatoire réelle en cas de PID recyclé (npm run stop ne supprime pas le verrou).
  check("le message donne l'échappatoire manuelle (rm du fichier verrou)", message.includes(`rm ${lockPath}`));

  // 4) release() libère ; re-acquire OK ensuite (autre "process" représenté par un PID différent).
  owner.release();
  // On vérifie la disparition du fichier SANS existsSync/stat : le couple « contrôle d'état
  // de fichier puis opération » déclenche le faux positif CodeQL js/file-system-race (sans
  // objet ici — tmpdir privé, mono-thread). Une lecture qui lève ENOENT prouve la même chose.
  let lockGone = false;
  try {
    fs.readFileSync(lockPath);
  } catch (e) {
    lockGone = e.code === "ENOENT";
  }
  check("le fichier de verrou disparaît après release()", lockGone);
  const reacquirer = new AuthLock(lockPath, { pid: 555555 });
  const third = reacquirer.acquire();
  check("un nouvel acquire après release() réussit", third.acquired === true);
  check("le fichier contient le PID du nouveau détenteur", fs.readFileSync(lockPath, "utf8").trim() === "555555");
  reacquirer.release();

  // 5) Verrou orphelin : fichier avec un PID mort -> le nouvel acquire RÉCLAME et réussit.
  //    On obtient un PID garanti mort en attendant la fin réelle d'un process enfant.
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = dead.pid;
  check("le process enfant utilisé pour le PID mort est bien terminé", !isProcessAlive(deadPid));

  fs.writeFileSync(lockPath, String(deadPid));
  const rescuer = new AuthLock(lockPath, { pid: 777777 });
  const fourth = rescuer.acquire();
  check("un verrou orphelin (PID mort) est réclamé sans suppression manuelle", fourth.acquired === true);
  check("l'acquisition orpheline rapporte le PID récupéré", fourth.reclaimedFrom === deadPid);
  check("le fichier contient désormais le PID du nouveau détenteur", fs.readFileSync(lockPath, "utf8").trim() === "777777");
  rescuer.release();

  // 6) Réentrance : le même détenteur peut ré-acquérir son propre verrou (redémarrage
  //    interne / reconnexion, cf. whatsapp.js#start rappelé après une coupure réseau).
  const self1 = new AuthLock(lockPath, { pid: 424242 });
  check("première acquisition (self) réussit", self1.acquire().acquired === true);
  const self2 = new AuthLock(lockPath, { pid: 424242 });
  const selfReacquire = self2.acquire();
  check("le même PID peut ré-acquérir son propre verrou", selfReacquire.acquired === true);
  self2.release();

  // 7) Exclusivité sous concurrence réelle : deux process Node distincts tentent
  //    d'acquérir le même verrou en même temps. Un seul doit gagner ; l'état final
  //    du fichier prouve l'exclusivité (un seul PID, celui du gagnant).
  const raceLockPath = path.join(tmp, "race.lock");
  const helper = path.join(__dirname, "fixtures", "authlock-race-worker.js");
  const collect = (proc) =>
    new Promise((resolve) => {
      let out = "";
      proc.stdout.on("data", (d) => (out += d));
      proc.on("close", () => resolve(out.trim()));
    });

  // Le gagnant TIENT le verrou (holdMs) : c'est ce que fait un vrai process (il garde le
  // verrou tant qu'il tourne). Sans hold, le gagnant sort aussitôt, son PID meurt, et le 2e
  // récupère l'orphelin → deux "gagnants" comptés à tort (exclusion correcte dans le temps,
  // mais le test ne modélisait pas la réalité → flaky, rouge sur CI Node 20).
  const HOLD_FRESH_MS = 800;
  const p1 = spawn(process.execPath, [helper, raceLockPath, String(HOLD_FRESH_MS)]);
  const p2 = spawn(process.execPath, [helper, raceLockPath, String(HOLD_FRESH_MS)]);
  const [out1, out2] = await Promise.all([collect(p1), collect(p2)]);
  const results = [JSON.parse(out1), JSON.parse(out2)];
  const acquiredCount = results.filter((r) => r.acquired).length;
  check("sous concurrence réelle (verrou frais), un seul des deux process acquiert", acquiredCount === 1);
  const winner = results.find((r) => r.acquired);
  check(
    "le perdant voit le gagnant vivant (heldByPid = gagnant), pas une acquisition",
    acquiredCount === 1 && results.filter((r) => !r.acquired).every((r) => r.heldByPid === winner.pid)
  );

  // 8) Exclusivité sous concurrence sur un verrou ORPHELIN (le cas qui a fait tomber la
  //    1re version : la réclamation par rename ÉCRASE et n'arbitre rien, donc N casseurs
  //    concurrents gagnaient tous). Ici : un orphelin (PID mort) pré-posé, N process
  //    lancés ensemble ; le gagnant TIENT le verrou (holdMs) pendant que les autres
  //    tentent. Un seul doit acquérir ; les autres voient le gagnant vivant et se retirent.
  const orphanLockPath = path.join(tmp, "orphan-race.lock");
  const deadForRace = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  fs.writeFileSync(orphanLockPath, String(deadForRace.pid)); // orphelin : PID mort
  check("le PID pré-posé pour la course orpheline est bien mort", !isProcessAlive(deadForRace.pid));

  const HOLD_MS = 800; // > temps de démarrage/tentative des perdants, pour qu'ils voient le gagnant vivant
  const N = 4;
  const workers = Array.from({ length: N }, () =>
    spawn(process.execPath, [helper, orphanLockPath, String(HOLD_MS)])
  );
  const outs = await Promise.all(workers.map(collect));
  const orphanResults = outs.map((o) => JSON.parse(o));
  const orphanWinners = orphanResults.filter((r) => r.acquired);
  check(
    `sous concurrence sur un orphelin, un seul des ${N} process acquiert (gagnants=${orphanWinners.length})`,
    orphanWinners.length === 1
  );
  // Sous concurrence, un pair peut avoir déjà supprimé l'orphelin quand le gagnant lit le
  // PID : reclaimedFrom vaut alors null (rien à signaler) — c'est correct. L'invariant à
  // prouver n'est pas « a lu le PID mort » mais « n'a JAMAIS cassé un verrou VIVANT ».
  check(
    "le gagnant orphelin n'a jamais cassé un verrou vivant (reclaimedFrom absent ou PID mort)",
    orphanWinners.length === 1 &&
      (orphanWinners[0].reclaimedFrom == null || !isProcessAlive(orphanWinners[0].reclaimedFrom))
  );
  check(
    "les perdants voient un détenteur vivant (heldByPid = le gagnant), pas une acquisition",
    orphanResults.filter((r) => !r.acquired).every((r) => r.heldByPid === orphanWinners[0]?.pid)
  );

  // 9) Propagation du conflit AU DÉMARRAGE DU DÉMON (revue Codex #27, repointé fiche 225) :
  //    depuis le frontend mince, c'est le DÉMON (src/daemon.js) qui tient le verrou auth/
  //    (ADR-0008 §4), plus src/index.js. Un 2e démon sur un verrou tenu par un PID vivant
  //    doit SORTIR (exit != 0), pas rester un process zombie. On tient le verrou avec NOTRE
  //    propre PID (vivant), donc c'est déterministe. FAKE_BAILEYS : le démon sort sur le
  //    verrou AVANT même de démarrer WhatsApp, aucune vraie connexion.
  const serverLock = path.join(tmp, "server-conflict.lock");
  fs.writeFileSync(serverLock, String(process.pid)); // détenteur vivant = ce process de test
  const daemonEntry = path.join(__dirname, "..", "src", "daemon.js");
  const child = spawnSync(process.execPath, [daemonEntry], {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      WHATSAPP_AUTH_LOCK: serverLock,
      WHATSAPP_AUTH_DIR: path.join(tmp, "auth9"),
      WHATSAPP_SETTINGS_FILE: path.join(tmp, "settings9.json"),
      WHATSAPP_ALLOWLIST_FILE: path.join(tmp, "allowlist9.json"),
      WHATSAPP_PERSIST: "false",
      WHATSAPP_DAEMON_TEST_FAKE_BAILEYS: "1",
    },
  });
  check(
    "un 2e démon sur un verrou tenu par un PID vivant SORT (exit != 0, pas de zombie)",
    child.status !== 0 && child.status != null
  );
  check(
    "le 2e serveur n'a pas altéré le verrou du détenteur vivant",
    fs.readFileSync(serverLock, "utf8").trim() === String(process.pid)
  );
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
