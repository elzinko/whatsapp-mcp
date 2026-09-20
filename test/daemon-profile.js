// Le démon PARTAGÉ ignore le profil de projet (revue Codex #3). Construit comme
// daemon.js main() ({...config, profile:""} + profil inerte `null`), _inScope capte
// grant ∩ plafond MÊME si profiles.json existe et qu'un WHATSAPP_PROFILE est hérité du
// frontend qui l'a spawné — sinon le démon ne capterait que ce projet-là, voire rien.
//
// Contraste direct avec test/profiles.js cas #4 : là, profile:"" + Profiles CHARGÉ
// (exists=true) -> _inScope FAUX (capture rien). Le démon évite ça via le stub inerte.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Allowlist } from "../src/allowlist.js";
import { Settings } from "../src/settings.js";
import { Profiles } from "../src/profiles.js";
import { WhatsAppClient } from "../src/whatsapp.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-profile-"));
const ceilingFile = path.join(tmp, "ceiling.json");
fs.writeFileSync(ceilingFile, JSON.stringify({ version: 1, channels: ["111@g.us", "222@g.us", "333@g.us"] }));
const profFile = path.join(tmp, "profiles.json");
fs.writeFileSync(profFile, JSON.stringify({ version: 1, profiles: { copro: ["111@g.us"] } }));

const cfg = (profile) => ({ maxMessages: 10, persist: false, allowlistFile: ceilingFile, profilesFile: profFile, profile });

try {
  // Frontend d'un projet "copro" : profil ACTIF -> ne voit que 111, pas 333.
  const waFrontend = new WhatsAppClient(cfg("copro"), new Settings(path.join(tmp, "s-fe.json")), new Allowlist(ceilingFile).load(), new Profiles(profFile).load());
  check("frontend copro : 111 in scope", waFrontend._inScope("111@g.us") === true);
  check("frontend copro : 333 hors scope (hors profil)", waFrontend._inScope("333@g.us") === false);

  // LE PIÈGE (cas #4 de profiles.js) : profile:"" MAIS Profiles chargé (exists=true)
  // -> capture RIEN. C'est précisément ce que le démon ne doit PAS faire.
  const waPiege = new WhatsAppClient(cfg(""), new Settings(path.join(tmp, "s-piege.json")), new Allowlist(ceilingFile).load(), new Profiles(profFile).load());
  check("piège : profile:'' + Profiles chargé -> 111 NON capté (le bug évité)", waPiege._inScope("111@g.us") === false);

  // LE DÉMON : {...config, profile:""} + stub inerte (null) -> capte grant ∩ plafond,
  // profiles.json ignoré. Exactement la construction de daemon.js main().
  const waDaemon = new WhatsAppClient(cfg(""), new Settings(path.join(tmp, "s-daemon.json")), new Allowlist(ceilingFile).load(), null);
  check("démon : 111 capté malgré profiles.json", waDaemon._inScope("111@g.us") === true);
  check("démon : 222 capté", waDaemon._inScope("222@g.us") === true);
  check("démon : 333 capté (hors profil copro, mais dans le plafond)", waDaemon._inScope("333@g.us") === true);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failed) {
  console.log("=== RÉSULTAT: ÉCHEC ===");
  process.exit(1);
}
console.log("=== RÉSULTAT: SUCCÈS ===");
