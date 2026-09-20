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
// Écriture atomique (tmp+rename), comme sessions.js/settings.js.

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

  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, secret, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* déjà absent */
    }
    throw e;
  }
  // Sous course (deux process créent en même temps), rename ÉCRASE : on relit ce qui
  // est effectivement sur disque après coup, pour que tout le monde converge vers LA
  // MÊME valeur — jamais celle qu'on vient d'écrire si un autre a écrit après nous.
  return tryRead(file) || secret;
}
