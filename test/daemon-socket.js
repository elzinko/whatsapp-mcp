// Round-trip RÉEL sur une socket Unix (ADR-0008 action 2/4) : un vrai net.Server
// (src/daemon.js#serveDaemon) + un BACKEND FACTICE (aucun import Baileys). Couvre :
//   - la socket existe, en mode 0600 ;
//   - un client lit `status` / `recent` avec le bon secret ;
//   - un client SANS le secret (ou avec un mauvais) est refusé, et le refus est
//     journalisé dans le log d'audit.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { serveDaemon } from "../src/daemon.js";
import { request } from "../src/daemon-client.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

// Résout à la 1re ligne ('\n') reçue sur `sock`, telle quelle (chaîne, pas encore
// parsée) — pour les scénarios bas niveau qui écrivent une requête à la main.
function firstLine(sock) {
  return new Promise((resolve) => {
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) resolve(buf.slice(0, idx));
    });
  });
}

// Collecte les `count` premières lignes reçues sur `sock`, chacune parsée en JSON.
function collectLines(sock, count) {
  return new Promise((resolve) => {
    let buf = "";
    const out = [];
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line) out.push(JSON.parse(line));
      }
      if (out.length >= count) resolve(out.slice(0, count));
    });
  });
}

// L'audit (fix #8) est écrit en fs.appendFile ASYNCHRONE : on attend qu'au moins
// `count` lignes non vides apparaissent, borné, plutôt que de lire immédiatement.
async function waitForLines(file, count, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now();
  for (;;) {
    const lines = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
      : [];
    if (lines.length >= count || Date.now() - start > timeoutMs) return lines;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
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

    // L'audit est écrit en fs.appendFile ASYNCHRONE, best-effort (fix #8) : on
    // attend qu'il rattrape plutôt que de lire le fichier au tout premier tick.
    const auditLines = await waitForLines(logFile, 2);
    check("chaque refus de secret est journalisé (2 lignes d'audit)", auditLines.length === 2);
    check("l'audit est du JSON exploitable, nommant la raison", JSON.parse(auditLines[0]).reason.includes("secret"));

    // --- Chemins d'erreur socket (revue #12, fixes #5 et #7) ---

    // JSON malformé -> refus explicite, sans faire tomber la connexion.
    {
      const sock = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      const first = firstLine(sock);
      sock.write("{ceci n'est pas du json\n");
      const parsed = JSON.parse(await first);
      check("JSON invalide -> ok:false", parsed.ok === false);
      check("JSON invalide -> error 'JSON invalide'", parsed.error === "JSON invalide");
      sock.destroy();
    }

    // Ligne non terminée dépassant 1 MiB -> refus + connexion coupée (fix #5 : le cap
    // ne mesure QUE le reste non terminé, pas tout ce qui a transité sur la connexion).
    {
      const sock = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      const first = firstLine(sock);
      const closed = new Promise((resolve) => sock.once("close", resolve));
      sock.write("x".repeat((1 << 20) + 16)); // pas de '\n' : une seule ligne trop longue
      const parsed = JSON.parse(await first);
      check("ligne trop longue -> ok:false", parsed.ok === false);
      check("ligne trop longue -> error 'ligne trop longue'", parsed.error === "ligne trop longue");
      await closed;
      check("ligne trop longue -> connexion coupée", sock.destroyed);
    }

    // Un LOT de petites requêtes complètes, écrites en UN SEUL write(), dont la
    // taille CUMULÉE dépasse 1 MiB -> toutes traitées, AUCUN rejet (fix #5 : on
    // draine d'abord les lignes complètes, le cap ne porte que sur le reste).
    {
      const count = 30000; // ~41 octets/ligne * 30000 ≈ 1.2 MiB cumulés
      const lines = [];
      for (let i = 0; i < count; i++) lines.push(JSON.stringify({ verb: "status", secret }));
      const payload = lines.join("\n") + "\n";
      check("le lot dépasse bien 1 MiB cumulés (le test prouve quelque chose)", payload.length > (1 << 20));

      const sock = net.createConnection(socketPath);
      await new Promise((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      const responsesP = collectLines(sock, count);
      sock.write(payload);
      const responses = await responsesP;
      check(`le lot -> ${count} réponses reçues`, responses.length === count);
      check("le lot -> toutes ok:true, aucun rejet 'ligne trop longue'", responses.every((r) => r.ok === true));
      sock.destroy();
    }
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
