#!/usr/bin/env node
// Client de test du démon (ADR-0008 action 6) : lit `status` sur la socket NDJSON,
// SANS jamais toucher WhatsApp. Usage manuel :
//   node scripts/daemon-status.js

import { config } from "../src/config.js";
import { request } from "../src/daemon-client.js";
import { readOrCreateSecret } from "../src/daemon-secret.js";

async function main() {
  const secret = readOrCreateSecret(config.daemonSecretFile);
  const res = await request(config.daemonSocket, { verb: "status", secret });
  if (!res) {
    console.error(`Aucune réponse du démon (absent, ou socket muette) : ${config.daemonSocket}`);
    process.exit(1);
  }
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

main();
