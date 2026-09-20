// Secret partagé local de la socket du démon (ADR-0008 §5, action 4).
//
// C'est un garde-fou ANTI-PARASITE, PAS une authentification : il borne QUI parle au
// démon (des process locaux que l'humain a lancés, capables de lire un fichier 0600
// sous son compte), il n'authentifie personne. La vraie frontière reste le doigt +
// le plafond (ADR-0002/0003). On l'écrit noir sur blanc pour ne pas le confondre avec
// un vrai token d'authentification.
//
// Read-or-create : le premier process (démon ou client, peu importe l'ordre de
// démarrage) qui ne trouve pas le fichier le génère, l'écrit en 0600, et toute
// lecture ultérieure — par n'importe quel process — retrouve la même valeur.
// Création ATOMIQUE par lien (link + EEXIST), race-free même à froid — voir
// readOrCreateSecret (revue P1 : rename écrasait et deux créateurs pouvaient diverger).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function tryRead(file) {
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

export function readOrCreateSecret(file) {
  const existing = tryRead(file);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString("hex");
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  try {
    // link() est ATOMIQUE et échoue (EEXIST) si `file` existe déjà — au contraire de
    // rename qui ÉCRASE. Un seul créateur gagne ; les autres lisent SA valeur. `file`
    // n'apparaît qu'une fois `tmp` entièrement écrit : jamais de fenêtre « fichier
    // vide ». Ça ferme la course de création à froid (revue P1).
    fs.linkSync(tmp, file);
    return secret;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // Un autre process a gagné la création entre notre tryRead et notre link : on lit
    // SA valeur (la nôtre est jetée). `file` est complet (link post-écriture), donc
    // tryRead ne tombe pas sur un fichier vide — SAUF si `file` est un résidu VIDE
    // (créé/tronqué par un tiers, jamais par ce module) : `tryRead` le voit "absent",
    // et sans ce garde-fou `link` échoue en EEXIST pour toujours sans jamais rien
    // persister — démon et client divergeraient, refus muet permanent (revue #3).
    const rescued = tryRead(file);
    if (rescued) return rescued;
    try {
      fs.unlinkSync(file);
    } catch {
      /* déjà retiré entre-temps, tant mieux */
    }
    try {
      // UNE seule retentative, bornée : si un autre créateur regagne la course ici,
      // on s'incline et on relit sa valeur, sans jamais boucler.
      fs.linkSync(tmp, file);
      return secret;
    } catch (e2) {
      if (e2.code !== "EEXIST") throw e2;
      return tryRead(file) || secret;
    }
  } finally {
    // En cas de succès, `file` garde l'inode partagé (hard link) ; en cas d'EEXIST,
    // `tmp` était inutile. Dans les deux cas on retire notre `tmp`.
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* déjà retiré */
    }
  }
}
