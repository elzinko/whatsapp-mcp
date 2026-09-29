// Helper de test (fiche 20260917211902225) : démarre un DÉMON FACTICE — `src/daemon.js`
// avec des deps Baileys bidon (WHATSAPP_DAEMON_TEST_FAKE_BAILEYS=1), donc AUCUNE vraie
// connexion WhatsApp. Le frontend mince spawné ensuite, via ensureDaemonRunning, pingue
// cette même socket et NE spawn PAS (le démon est déjà là). On garde la main sur le PID
// pour le TUER en teardown — pas de process détaché qui fuit entre les tests.
//
// L'appelant fixe explicitement WHATSAPP_DAEMON_SOCKET (chemin COURT < 104 o, hors du
// tmpdir profond de macOS) et WHATSAPP_DAEMON_SECRET_FILE (secret connu, pré-écrit), pour
// que le test connaisse la socket et le secret sans les recalculer depuis config.js.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { request } from "../../src/daemon-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.resolve(__dirname, "..", "..", "src", "daemon.js");

// Démarre le démon factice et attend qu'il réponde `status` sur sa socket (polling borné).
// `env` doit porter les mêmes WHATSAPP_* que le frontend qui suivra (auth, settings,
// allowlist, sessions, socket, secret). Renvoie { proc, stop() }.
export async function startFakeDaemon(env, { socketPath, secret, timeoutMs = 8000 } = {}) {
  const proc = spawn(process.execPath, [DAEMON], {
    stdio: "ignore",
    env: { ...env, WHATSAPP_DAEMON_TEST_FAKE_BAILEYS: "1" },
  });
  const stop = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* déjà mort */
    }
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(socketPath, { verb: "status", secret });
    if (res?.ok) return { proc, stop };
    await new Promise((r) => setTimeout(r, 100));
  }
  stop();
  throw new Error("Le démon factice n'a jamais répondu (timeout).");
}
