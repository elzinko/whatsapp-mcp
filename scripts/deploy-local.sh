#!/usr/bin/env bash
# deploy-local.sh — fige une version du serveur MCP HORS du dossier de travail,
# installe ses dépendances, et bascule le lien « current ».
#
# Pourquoi (ADR-0007, fiche 20260911212530209) : tant que Claude Desktop lance le
# checkout, développer casse l'outil en service (incident du 2026-09-11). Ce script
# copie une version identifiable dans ~/.local/share/whatsapp-mcp/<version>/, y fait
# « npm ci » (git archive n'emporte pas node_modules, qui est gitignoré), puis pointe
# « current » dessus. Un « previous » est posé à chaque bascule pour revenir en un geste.
# Porté de google-mcp-multi-account/scripts/deploy-local.sh — copie assumée (pas
# d'extraction de kit commun pour l'instant, décision 2026-09-11).
#
# Usage :
#   ./scripts/deploy-local.sh                # fige HEAD (arbre propre), bascule current
#   ./scripts/deploy-local.sh --tag v0.3.0   # fige CE tag, quel que soit HEAD
#   ./scripts/deploy-local.sh --list         # versions figées (* = current)
#   ./scripts/deploy-local.sh --revert       # rebascule current sur « previous »
#   ./scripts/deploy-local.sh --rollback X   # rebascule current sur la version X
#   ./scripts/deploy-local.sh --print        # dry-run : dit ce qu'il ferait, n'écrit rien
#
# Refuse un arbre sale ou un déploiement par défaut non identifiable : une version
# figée doit correspondre à un commit (le rail dev, lui, déploie une branche sale).
# Destination surchargeable via WHATSAPP_DEPLOY_ROOT ; dépôt source via
# WHATSAPP_REPO_ROOT (utilisé par les tests). Ne touche NI Claude Desktop NI l'état
# (~/.config/whatsapp-mcp) : il affiche à la fin le geste qui reste à l'humain (ADR-0005).
set -euo pipefail

REPO_ROOT="${WHATSAPP_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DEPLOY_ROOT="${WHATSAPP_DEPLOY_ROOT:-$HOME/.local/share/whatsapp-mcp}"
CURRENT_LINK="$DEPLOY_ROOT/current"
# « previous » — la version que current pointait AVANT la dernière bascule. Posé à
# chaque bascule (déploiement, rollback, revert) : c'est le socle de « --revert ».
PREVIOUS_LINK="$DEPLOY_ROOT/previous"

# ── affichage ────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=""; G=""; R=""; Y=""; N=""
fi
step() { echo; echo "${B}── $* ──${N}"; }
ok()   { echo "${G}✓${N} $*"; }
warn() { echo "${Y}⚠${N} $*"; }
die()  { echo "${R}✗ $*${N}" >&2; exit 1; }

usage() {
  cat <<'EOF'
deploy-local.sh — fige une version hors du dossier de travail, bascule « current ».
  (défaut)          fige HEAD (arbre propre requis), bascule current
  --tag <v>         fige ce tag, quel que soit HEAD
  --dev             fige la branche de travail (MÊME sale) sur le rail « dev »,
                    SANS toucher current (connecteur séparé whatsapp-feat)
  --list            versions figées (* = current)
  --revert          rebascule current sur « previous »
  --rollback <v>    rebascule current sur la version <v>
  --print           dry-run : dit ce qu'il ferait, n'écrit rien
EOF
}

# ── arguments ──────────────────────────────────────────────────────────────
DRY=""; MODE="deploy"; WANT_TAG=""; ROLLBACK_TO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --print|--dry-run) DRY=1 ;;
    --tag) shift; WANT_TAG="${1:-}" ;;
    --tag=*) WANT_TAG="${1#*=}" ;;
    --list) MODE="list" ;;
    --dev) MODE="dev" ;;
    --revert) MODE="revert" ;;
    --rollback) shift; ROLLBACK_TO="${1:-}"; MODE="rollback" ;;
    --rollback=*) ROLLBACK_TO="${1#*=}"; MODE="rollback" ;;
    -h|--help) usage; exit 0 ;;
    *) die "argument inconnu « $1 » (voir --help)" ;;
  esac
  # `|| break` : un flag à valeur en dernière position (« --tag »/« --rollback » nu)
  # a déjà vidé $@ ; sans ça ce shift échoue et set -e avorte avant le die d'usage.
  shift || break
done

current_version()  { [[ -L "$CURRENT_LINK"  ]] || return 0; basename "$(readlink "$CURRENT_LINK")"; }
previous_version() { [[ -L "$PREVIOUS_LINK" ]] || return 0; basename "$(readlink "$PREVIOUS_LINK")"; }

# point_current_at <version> — pose « previous » (si current pointait ailleurs)
# AVANT de basculer current. Deux ln -sfn : atomiques chacun.
point_current_at() {
  local target="$1" old
  old="$(current_version)"
  if [[ -n "$old" && "$old" != "$target" ]]; then
    ln -sfn "$DEPLOY_ROOT/$old" "$PREVIOUS_LINK"
  fi
  ln -sfn "$DEPLOY_ROOT/$target" "$CURRENT_LINK"
}

human_gesture() {
  cat <<EOF

${B}Il reste un geste — à toi${N} (le serveur ne configure pas le client, ADR-0005) :

  cd "$CURRENT_LINK" && npm run install:client
  # puis quitte complètement Claude Desktop (Cmd-Q) et relance-le.

Ensuite, dans whatsapp_status, la version servie doit être « $(current_version) »
(et non « dev », qui est la signature d'un lancement depuis le checkout).
EOF
}

# ── --list ─────────────────────────────────────────────────────────────────
if [[ "$MODE" == "list" ]]; then
  [[ -d "$DEPLOY_ROOT" ]] || die "aucun déploiement dans $DEPLOY_ROOT"
  cur="$(current_version)"; found=""
  for d in "$DEPLOY_ROOT"/*/; do
    [[ -d "$d" ]] || continue
    v="$(basename "$d")"
    case "$v" in current|previous) continue ;; esac   # ce sont des liens, pas des versions
    found=1
    if [[ "$v" == "$cur" ]]; then echo "* $v"; else echo "  $v"; fi
  done
  [[ -n "$found" ]] || die "aucune version figée dans $DEPLOY_ROOT"
  prev="$(previous_version)"; [[ -n "$prev" ]] && echo "  (previous → $prev)"
  exit 0
fi

# ── --revert (current → previous) ────────────────────────────────────────────
if [[ "$MODE" == "revert" ]]; then
  prev="$(previous_version)"
  [[ -n "$prev" ]] || die "pas de « previous » à restaurer (une seule version déployée ?)"
  [[ -d "$DEPLOY_ROOT/$prev" ]] || die "« previous » pointe une version absente ($prev)"
  if [[ -n "$DRY" ]]; then ok "dry-run : current → $prev (previous actuel)"; exit 0; fi
  point_current_at "$prev"
  ok "current → $prev (revert)"
  human_gesture
  exit 0
fi

# ── --rollback <version> ─────────────────────────────────────────────────────
if [[ "$MODE" == "rollback" ]]; then
  [[ -n "$ROLLBACK_TO" ]] || die "usage : --rollback <version> (voir --list)"
  [[ -d "$DEPLOY_ROOT/$ROLLBACK_TO" ]] || die "version « $ROLLBACK_TO » non déployée (voir --list)"
  if [[ -n "$DRY" ]]; then ok "dry-run : current → $ROLLBACK_TO"; exit 0; fi
  point_current_at "$ROLLBACK_TO"
  ok "current → $ROLLBACK_TO"
  human_gesture
  exit 0
fi

# ── --dev (rail de test parallèle, NE TOUCHE PAS current) ────────────────────
# Déploie la branche de travail — même sale — sur un slot « dev » à part, avec son
# propre connecteur (whatsapp-feat) et son propre état (~/.config/whatsapp-mcp-dev,
# donc son propre appairage). Règle de l'ADR-0007 : une commande de dev ne bascule
# JAMAIS la stable. C'est le « déployer la dev pour la tester » demandé.
if [[ "$MODE" == "dev" ]]; then
  step "Contrôles (rail dev)"
  command -v git >/dev/null 2>&1 || die "git est requis"
  git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_ROOT n'est pas un dépôt git"
  # Instantané du working tree, MÊME sale. « git stash create » fabrique un commit
  # de l'état courant SANS rien empiler sur la pile de stash (partagée entre worktrees) :
  # aucun git stash push/pop, donc rien à un autre worktree. Vide si l'arbre est propre.
  ref="$(git -C "$REPO_ROOT" stash create 2>/dev/null || true)"
  [[ -n "$ref" ]] || ref="HEAD"
  sha="$(git -C "$REPO_ROOT" rev-parse --short "$ref")"
  # NB : « stash create » capture les fichiers SUIVIS modifiés, pas les nouveaux
  # fichiers non suivis — ajoute-les (git add) pour les inclure dans le rail dev.
  ok "instantané de la branche de travail : $sha (current reste « $(current_version) »)"
  if [[ -n "$DRY" ]]; then
    ok "dry-run : figerait le rail dev depuis $sha, connecteur whatsapp-feat, sans toucher current"
    exit 0
  fi
  DEVSLOT="$DEPLOY_ROOT/dev"
  mkdir -p "$DEPLOY_ROOT"
  tmp="$(mktemp -d "$DEPLOY_ROOT/.tmp-XXXXXX")"
  git -C "$REPO_ROOT" archive "$ref" | tar -x -C "$tmp" || { rm -rf "$tmp"; die "échec de git archive (dev)"; }
  step "Dépendances du rail dev"
  if [[ -f "$tmp/package-lock.json" ]]; then
    ( cd "$tmp" && npm ci --omit=dev --no-audit --no-fund ) || { rm -rf "$tmp"; die "npm ci (dev) a échoué"; }
  else
    ( cd "$tmp" && npm install --omit=dev --no-audit --no-fund ) || { rm -rf "$tmp"; die "npm install (dev) a échoué"; }
  fi
  printf '%s\n'    "$REPO_ROOT" > "$tmp/.source"
  printf 'dev@%s\n' "$sha"      > "$tmp/VERSION"
  [[ -f "$tmp/bin/whatsapp-mcp" ]] && chmod +x "$tmp/bin/whatsapp-mcp"
  rm -rf "$DEVSLOT"          # le rail dev est un slot unique, réécrit à chaque fois
  mv "$tmp" "$DEVSLOT"
  ok "rail dev figé : $DEVSLOT"
  ok "current INCHANGÉ : $(current_version)"
  cat <<EOF

${B}Il reste un geste — à toi${N} (rail dev, en parallèle de la stable) :

  cd "$DEVSLOT" && npm run install:client:dev
  # branche le connecteur « whatsapp-feat » (état séparé ~/.config/whatsapp-mcp-dev).
  # Quitte/relance Claude Desktop. La première fois, whatsapp-feat demandera SON
  # propre QR : c'est l'appairage séparé (phase 1 de l'ADR-0007), pour tourner en
  # même temps que la stable sans guerre de session.
EOF
  exit 0
fi

# ── déploiement ──────────────────────────────────────────────────────────────
step "Contrôles"
command -v git >/dev/null 2>&1 || die "git est requis"
git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1 || die "$REPO_ROOT n'est pas un dépôt git"

if [[ -n "$WANT_TAG" ]]; then
  # --tag archive une référence git, jamais l'arbre de travail : on peut installer
  # une version pendant qu'on développe autre chose à côté.
  git -C "$REPO_ROOT" rev-parse -q --verify "refs/tags/$WANT_TAG" >/dev/null \
    || die "tag « $WANT_TAG » inconnu (git tag pour la liste ; git fetch --tags si besoin)"
  VERSION="$WANT_TAG"; SOURCE_REF="refs/tags/$WANT_TAG"
  ok "version : $VERSION (tag demandé — arbre de travail ignoré)"
else
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ]] \
    || die "arbre de travail sale — commite ou remise avant de déployer (le rail dev, lui, déploie une branche sale)"
  ok "arbre de travail propre"
  # Nom identifiable : le tag exact s'il existe, sinon « <dernier-tag>-<n>-g<sha> »,
  # sinon le sha court. Toujours traçable à un commit (pas besoin d'avoir taggé).
  VERSION="$(git -C "$REPO_ROOT" describe --tags --exact-match HEAD 2>/dev/null \
    || git -C "$REPO_ROOT" describe --tags --always HEAD 2>/dev/null || true)"
  [[ -n "$VERSION" ]] || die "impossible de nommer la version (HEAD introuvable ?)"
  SOURCE_REF="HEAD"
  ok "version : $VERSION"
fi

TARGET="$DEPLOY_ROOT/$VERSION"

if [[ -n "$DRY" ]]; then
  step "Dry-run"
  echo "figerait   : $VERSION (git archive $SOURCE_REF, puis npm ci)"
  echo "vers       : $TARGET"
  echo "current →  : $VERSION"
  [[ -d "$TARGET" ]] && warn "déjà figé — seul le lien current serait rebasculé"
  exit 0
fi

step "Gel de la version"
mkdir -p "$DEPLOY_ROOT"
if [[ -d "$TARGET" ]]; then
  ok "$VERSION déjà figé — pas de réécriture (seul current va bouger)"
else
  tmp="$(mktemp -d "$DEPLOY_ROOT/.tmp-XXXXXX")"
  # git archive n'exporte que les fichiers SUIVIS de la référence : pas de .git, pas
  # de node_modules, aucun fichier non commité. C'est ce qui garantit la copie figée.
  git -C "$REPO_ROOT" archive "$SOURCE_REF" | tar -x -C "$tmp" \
    || { rm -rf "$tmp"; die "échec de git archive"; }
  # node_modules est gitignoré : on le reconstruit à l'identique dans la copie figée,
  # sinon le serveur figé retombe sur « Cannot find package » — l'incident même qu'on corrige.
  step "Dépendances de la version figée"
  if [[ -f "$tmp/package-lock.json" ]]; then
    ( cd "$tmp" && npm ci --omit=dev --no-audit --no-fund ) \
      || { rm -rf "$tmp"; die "npm ci a échoué dans la copie figée"; }
  else
    ( cd "$tmp" && npm install --omit=dev --no-audit --no-fund ) \
      || { rm -rf "$tmp"; die "npm install a échoué dans la copie figée"; }
  fi
  # Repères de la copie figée. .source = le clone d'où elle vient (pour un futur
  # « update »). VERSION = le nom servi. Le shim doit rester exécutable après archive.
  printf '%s\n' "$REPO_ROOT" > "$tmp/.source"
  printf '%s\n' "$VERSION"   > "$tmp/VERSION"
  [[ -f "$tmp/bin/whatsapp-mcp" ]] && chmod +x "$tmp/bin/whatsapp-mcp"
  mv "$tmp" "$TARGET"
  ok "copie figée : $TARGET"
fi

point_current_at "$VERSION"
ok "current → $VERSION"
human_gesture
