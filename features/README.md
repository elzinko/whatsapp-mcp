---
skill: ezk-backlog
layout_version: 4
---

# Features — backlog du projet

Ce dossier est le **suivi versionné** des features / bugs / chores. Il vit sur
`main`, commité — la référence ne se perd pas entre worktrees ni entre sessions.

## Contenu

| Fichier / dossier | Rôle |
|---|---|
| `<id>_slug.md` | Fiches **actives** (`idea` / `ready` / `in-progress` / `blocked`) — `id` horodaté `AAAAMMDDHHMMSSmmm` ; legacy `0001-slug.md` (4 chiffres) toléré |
| [`BACKLOG.md`](BACKLOG.md) | **Index généré** (`regen`) — ne pas éditer à la main |
| [`PLAN.md`](PLAN.md) | Séquence décidée (curée) — horizon **NOW** court. **Utilisé depuis le 2026-09-11.** |
| [`done/`](done/) | Fiches **livrées** (`status: shipped`) |
| [`feature-template.md`](feature-template.md) | Gabarit pour une nouvelle fiche |

## Comment travailler

1. **Capturer** — `/ezk-backlog add …` (anti-doublon, priorité demandée, `idea` si non mûr).
2. **Séquencer** — buckets `priority` (P0→P3) + `PLAN.md` pour l'ordre réel (NOW = prochaines N cartes).
3. **Groomer / ready** — `groom <id>` puis gate `ready <id>` (DoR) avant tirage.
4. **Tirer** — `next --ready-only` (point d'entrée d'ezk-sprint).
5. **Livrer** — `ship <id> #PR` → déplacement vers `done/` + regen.
6. **Régénérer l'index** — `/ezk-backlog regen` (écrit `BACKLOG.md` uniquement).

Source de vérité du **statut** = le front-matter YAML de chaque fiche.
L'index `BACKLOG.md` en est un **miroir** — jamais l'inverse.

## Layout version (Skema)

Le front-matter `layout_version` ci-dessus marque le contrat de dossier installé.
Si la skill `ezk-backlog` est en avance, elle **proposera** les migrations
pending (voir `migrations/` de la skill) — pas d'auto-mutation sans accord.
