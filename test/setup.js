// Tests des helpers purs de src/setup.js (fiche 0010). Aucun accès au vrai fichier de
// config Desktop de l'utilisateur — tout est en mémoire, fs/exec injectés.

import {
  nodeVersionOk,
  resolveStableNode,
  mergeMcpServer,
  desktopConfigPath,
  deployRoot,
  currentShimPath,
  devShimPath,
  devStateRoot,
  deployedVersion,
  desktopRunningFrom,
} from "../src/setup.js";

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

// --- nodeVersionOk ---
check("v20.0.0 -> ok", nodeVersionOk("v20.0.0") === true);
check("v22.18.0 -> ok", nodeVersionOk("v22.18.0") === true);
check("v18.19.0 -> non", nodeVersionOk("v18.19.0") === false);
check("v16 -> non", nodeVersionOk("v16.20.0") === false);
check("sans 'v' (20.1.0) -> ok", nodeVersionOk("20.1.0") === true);
check("format bizarre -> non (fail-safe)", nodeVersionOk("banane") === false);
check("undefined -> non", nodeVersionOk(undefined) === false);

// --- resolveStableNode ---
check(
  "homebrew présent -> choisi en premier",
  resolveStableNode((p) => p === "/opt/homebrew/bin/node").path === "/opt/homebrew/bin/node"
);
check(
  "pas de homebrew -> /usr/local ensuite",
  resolveStableNode((p) => p === "/usr/local/bin/node").path === "/usr/local/bin/node"
);
{
  const r = resolveStableNode(() => false, "/Users/x/.nvm/versions/node/v22/bin/node");
  check("aucun stable -> fallback execPath", r.path === "/Users/x/.nvm/versions/node/v22/bin/node");
  check("aucun stable -> warning présent", typeof r.warning === "string" && r.warning.length > 0);
}
check(
  "un stable trouvé -> pas de warning",
  resolveStableNode((p) => p === "/usr/bin/node").warning === null
);

// --- mergeMcpServer : ne JAMAIS clobber les autres serveurs (le point critique) ---
{
  const existing = {
    mcpServers: {
      "shopify-dev-mcp": { command: "npx", args: ["shopify"] },
      render: { command: "render", env: { TOKEN: "secret-render" } },
    },
    preferences: { theme: "dark" },
  };
  const merged = mergeMcpServer(existing, "whatsapp-mcp", {
    command: "/opt/homebrew/bin/node",
    args: ["/abs/src/index.js"],
  });
  check("shopify préservé", merged.mcpServers["shopify-dev-mcp"]?.command === "npx");
  check(
    "render préservé (avec son env/secret)",
    merged.mcpServers.render?.env?.TOKEN === "secret-render"
  );
  check(
    "whatsapp-mcp ajouté",
    merged.mcpServers["whatsapp-mcp"]?.command === "/opt/homebrew/bin/node"
  );
  check("clé racine preferences préservée", merged.preferences?.theme === "dark");
  check("objet d'origine NON muté", existing.mcpServers["whatsapp-mcp"] === undefined);
}
{
  let cfg = mergeMcpServer({}, "whatsapp-mcp", { command: "old" });
  cfg = mergeMcpServer(cfg, "whatsapp-mcp", { command: "new" });
  check("config {} -> crée mcpServers", cfg.mcpServers["whatsapp-mcp"]?.command === "new");
  check("idempotent : une seule entrée whatsapp-mcp", Object.keys(cfg.mcpServers).length === 1);
}
check(
  "mcpServers absent -> géré",
  mergeMcpServer({ preferences: {} }, "x", { command: "c" }).mcpServers.x.command === "c"
);

// --- desktopConfigPath ---
check(
  "chemin Desktop macOS",
  desktopConfigPath("/Users/test").endsWith(
    "/Library/Application Support/Claude/claude_desktop_config.json"
  )
);

// --- deployRoot / currentShimPath (ADR-0007) ---
check(
  "deployRoot : défaut ~/.local/share/whatsapp-mcp",
  deployRoot({}, "/Users/test") === "/Users/test/.local/share/whatsapp-mcp"
);
check(
  "deployRoot : WHATSAPP_DEPLOY_ROOT l'emporte",
  deployRoot({ WHATSAPP_DEPLOY_ROOT: "/tmp/dep" }, "/Users/test") === "/tmp/dep"
);
check(
  "currentShimPath : pointe current/bin/whatsapp-mcp sous la racine",
  currentShimPath({}, "/Users/test") ===
    "/Users/test/.local/share/whatsapp-mcp/current/bin/whatsapp-mcp"
);
check(
  "currentShimPath : suit l'override de racine",
  currentShimPath({ WHATSAPP_DEPLOY_ROOT: "/tmp/dep" }, "/Users/test") ===
    "/tmp/dep/current/bin/whatsapp-mcp"
);
check(
  "devShimPath : slot dev sous la racine",
  devShimPath({}, "/Users/test") === "/Users/test/.local/share/whatsapp-mcp/dev/bin/whatsapp-mcp"
);
check(
  "devStateRoot : distinct de la stable (~/.config/whatsapp-mcp-dev)",
  devStateRoot("/Users/test") === "/Users/test/.config/whatsapp-mcp-dev"
);

// --- deployedVersion (readFileSync injecté, aucun accès disque) ---
check("deployedVersion : lit le fichier VERSION", deployedVersion("/x", () => "de985f3\n") === "de985f3");
check("deployedVersion : dev@<sha> préservé", deployedVersion("/x", () => "dev@abc1234\n") === "dev@abc1234");
check("deployedVersion : VERSION absent -> 'dev'", deployedVersion("/x", () => { throw new Error("ENOENT"); }) === "dev");
check("deployedVersion : VERSION vide -> 'dev'", deployedVersion("/x", () => "  \n") === "dev");

// --- desktopRunningFrom (le bug du 2026-09-12 : pgrep -x Claude était aveugle) ---
check(
  "desktop détecté par son binaire principal (chemin complet)",
  desktopRunningFrom("/usr/sbin/cfprefsd\n/Applications/Claude.app/Contents/MacOS/Claude\n/bin/zsh") === true
);
check(
  "claude-code (CLI, 'claude' minuscule) n'est PAS pris pour Desktop",
  desktopRunningFrom("/Users/x/Library/Application Support/Claude/claude-code/2.1.266/claude.app/Contents/MacOS/claude") === false
);
check(
  "helpers seuls / aucun Claude -> non détecté",
  desktopRunningFrom("/Applications/Claude.app/Contents/Helpers/disclaimer\n/bin/zsh") === false
);
check("sortie vide -> non détecté", desktopRunningFrom("") === false);

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
