// Round-trip RÉEL sur une socket Unix (ADR-0008 action 2/4) : un vrai net.Server
// (src/daemon.js#serveDaemon) + un BACKEND FACTICE (aucun import Baileys). Couvre :
//   - la socket existe, en mode 0600 ;
//   - un client lit `status` / `recent` avec le bon secret ;
//   - un client SANS le secret (ou avec un mauvais) est refusé, et le refus est
//     journalisé dans le log d'audit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { serveDaemon } from "../src/daemon.js";
import { request } from "../src/daemon-client.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

function fakeBackend() {
  return {
    status: () => ({ state: "open", connected: true }),
    listGroups: () => ({ groups: [] }),
    recent: (token, jid) => {
      if (token !== "tok-ok") throw new Error("session invalide, expirée ou fermée");
      return { jid, messages: [{ id: "1", text: "hello" }] };
    },
    sessionOpen: () => ({ session: "tok-ok", expiresAt: new Date().toISOString(), channels: [] }),
    sessionClose: () => ({ closed: true }),
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-daemon-socket-"));
  const socketPath = path.join(tmp, "daemon.sock");
  const logFile = path.join(tmp, "daemon.log");
  const secret = "test-secret";

  const server = await serveDaemon(fakeBackend(), { socketPath, secret, logFile });
  try {
    check("la socket existe après serveDaemon()", fs.existsSync(socketPath));
    const mode = fs.statSync(socketPath).mode & 0o777;
    check("la socket est en mode 0600", mode === 0o600);

    let res = await request(socketPath, { verb: "status", secret });
    check("status avec le bon secret -> ok:true", res?.ok === true && res.data.state === "open");

    res = await request(socketPath, { verb: "recent", secret, session: "tok-ok", jid: "a@g.us" });
    check("recent avec le bon secret -> messages renvoyés", res?.ok === true && res.data.messages.length === 1);

    res = await request(socketPath, { verb: "status" }); // aucun secret fourni
    check("status SANS secret -> refus", res?.ok === false && /secret/.test(res.error));

    res = await request(socketPath, { verb: "status", secret: "faux" });
    check("status avec un MAUVAIS secret -> refus", res?.ok === false && /secret/.test(res.error));

    const auditLines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
    check("chaque refus de secret est journalisé (2 lignes d'audit)", auditLines.length === 2);
    check("l'audit est du JSON exploitable, nommant la raison", JSON.parse(auditLines[0]).reason.includes("secret"));
  } finally {
    server.close();
  }

  fs.rmSync(tmp, { recursive: true, force: true });
} catch (e) {
  console.error("Erreur test:", e);
  failed = true;
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
