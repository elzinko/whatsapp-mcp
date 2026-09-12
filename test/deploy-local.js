// Test de scripts/deploy-local.sh (ADR-0007, fiche 20260911212530209).
//
// On monte un dépôt git JETABLE (deps vides → npm install instantané et hors-ligne)
// et une racine de déploiement temporaire, puis on déroule le cycle de vie :
//   figer une version → basculer current → figer une 2ᵉ → previous suit →
//   lister → revenir en arrière (revert/rollback) → refuser un arbre sale.
// Aucun accès au vrai ~/.local/share ni au vrai dépôt.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, "..", "scripts", "deploy-local.sh");

let failed = false;
function check(label, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failed = true;
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}
function commit(repo, msg) {
  git(repo, ["add", "-A"]);
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg],
    { encoding: "utf8" }
  );
}
// Lance le script ; renvoie { code, out }. Ne jette jamais (on veut tester les refus).
function deploy(args, env, cwd) {
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}
function linkTarget(p) {
  return fs.existsSync(p) ? path.basename(fs.realpathSync(p)) : null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wa-deploy-"));
try {
  const repo = path.join(tmp, "repo");
  const deployRoot = path.join(tmp, "share");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "wa-fake", version: "0.0.0", private: true }, null, 2));
  fs.writeFileSync(path.join(repo, "src-index-marker"), "v1\n"); // contenu quelconque à figer
  fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
  fs.writeFileSync(path.join(repo, "bin", "whatsapp-mcp"), "#!/usr/bin/env bash\necho stub\n");
  fs.chmodSync(path.join(repo, "bin", "whatsapp-mcp"), 0o755);
  commit(repo, "init");

  const env = { WHATSAPP_REPO_ROOT: repo, WHATSAPP_DEPLOY_ROOT: deployRoot };
  const nameNow = () => git(repo, ["describe", "--tags", "--always", "HEAD"]);

  // --- 1. Déploiement par défaut (arbre propre, pas de tag) ---
  const v1 = nameNow();
  let r = deploy([], env);
  check("deploy v1 : succès", r.code === 0);
  check("v1 : dossier figé créé", fs.existsSync(path.join(deployRoot, v1)));
  check("v1 : current → v1", linkTarget(path.join(deployRoot, "current")) === v1);
  check("v1 : fichier VERSION correct", fs.readFileSync(path.join(deployRoot, v1, "VERSION"), "utf8").trim() === v1);
  check("v1 : .source pointe le dépôt", fs.readFileSync(path.join(deployRoot, v1, ".source"), "utf8").trim() === repo);
  // Preuve que l'étape « npm » a bien tourné dans la copie figée : elle écrit un
  // package-lock.json (le dépôt jetable n'en committe pas ; ici il a 0 dépendance,
  // donc pas de node_modules — mais dans le vrai dépôt, node_modules serait reconstruit).
  check("v1 : étape npm exécutée (package-lock.json généré)", fs.existsSync(path.join(deployRoot, v1, "package-lock.json")));
  check("v1 : étape dépendances annoncée", r.out.includes("Dépendances de la version figée"));

  // --- 2. Deuxième version : previous suit ---
  fs.writeFileSync(path.join(repo, "src-index-marker"), "v2\n");
  commit(repo, "v2");
  const v2 = nameNow();
  check("v1 ≠ v2 (noms distincts)", v1 !== v2);
  r = deploy([], env);
  check("deploy v2 : succès", r.code === 0);
  check("v2 : current → v2", linkTarget(path.join(deployRoot, "current")) === v2);
  check("v2 : previous → v1", linkTarget(path.join(deployRoot, "previous")) === v1);

  // --- 3. --list : current marqué d'une étoile, previous affiché ---
  r = deploy(["--list"], env);
  check("list : v2 marqué courant (*)", r.out.includes(`* ${v2}`));
  check("list : v1 présent (non courant)", r.out.includes(v1));
  check("list : ligne previous", r.out.includes(`previous → ${v1}`));

  // --- 4. --revert : current → previous (v1), previous → v2 ---
  r = deploy(["--revert"], env);
  check("revert : succès", r.code === 0);
  check("revert : current → v1", linkTarget(path.join(deployRoot, "current")) === v1);
  check("revert : previous → v2", linkTarget(path.join(deployRoot, "previous")) === v2);

  // --- 5. --rollback <v2> : current → v2 ---
  r = deploy(["--rollback", v2], env);
  check("rollback v2 : succès", r.code === 0);
  check("rollback v2 : current → v2", linkTarget(path.join(deployRoot, "current")) === v2);
  r = deploy(["--rollback", "version-bidon"], env);
  check("rollback version inconnue : refus", r.code !== 0 && r.out.includes("non déployée"));

  // --- 6. --print (dry-run) : ne crée rien, ne bascule pas ---
  fs.writeFileSync(path.join(repo, "src-index-marker"), "v3\n");
  commit(repo, "v3");
  const v3 = nameNow();
  r = deploy(["--print"], env);
  check("dry-run : succès", r.code === 0);
  check("dry-run : n'a PAS figé v3", !fs.existsSync(path.join(deployRoot, v3)));
  check("dry-run : current inchangé (toujours v2)", linkTarget(path.join(deployRoot, "current")) === v2);

  // --- 7. Arbre sale : refus côté stable (le rail dev, lui, déploiera une branche sale) ---
  fs.appendFileSync(path.join(repo, "src-index-marker"), "modif non commitée\n");
  r = deploy([], env);
  check("arbre sale : refus", r.code !== 0);
  check("arbre sale : message explicite", r.out.includes("sale"));

  // --- 8. --dev : déploie MÊME un arbre sale, SANS toucher current ---
  // (l'arbre est encore sale depuis l'étape 7 — c'est le cas d'usage du rail dev)
  r = deploy(["--dev", "--print"], env);
  check("dev dry-run : succès", r.code === 0);
  check("dev dry-run : ne crée pas le slot dev", !fs.existsSync(path.join(deployRoot, "dev")));
  r = deploy(["--dev"], env);
  check("dev : succès sur un arbre sale", r.code === 0);
  check("dev : slot dev créé", fs.existsSync(path.join(deployRoot, "dev", "VERSION")));
  check("dev : VERSION préfixée « dev@ »", fs.readFileSync(path.join(deployRoot, "dev", "VERSION"), "utf8").startsWith("dev@"));
  check("dev : current NON touché (toujours v2)", linkTarget(path.join(deployRoot, "current")) === v2);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failed ? "\n=== RÉSULTAT: ÉCHEC ===" : "\n=== RÉSULTAT: SUCCÈS ===");
process.exit(failed ? 1 : 0);
