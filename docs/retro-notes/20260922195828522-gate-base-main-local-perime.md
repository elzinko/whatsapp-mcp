# Le portier compare à un `main` LOCAL périmé quand le travail est poussé direct sur `origin/main`

- **Date** : 2026-09-22
- **Repo** : whatsapp-mcp
- **Symptôme concret** : à la clôture de la session « démon » (fiche `20260917211902097`,
  PR #44 squash-mergée, commit `f615e93`, puis ship/idée `7e14080` poussés directement sur
  `origin/main`), `scripts/check.sh` a rendu `VERDICT: DIRTY points=2,4` avec **deux faux
  positifs** :
  - `[P2] branch REAL ship-20260917211902097 7e14080 unproven=<toute la feature>` — alors
    que cette tête **EST** `origin/main`.
  - `[P4] pending-merge docs/adr/0008-demon-unique-socket-locale.md` — alors que l'ADR est
    sur `origin/main`.
  Cause : `BASE: main` pointe sur le `main` **local** (worktree principal), resté à
  `207c60d`, soit **-4 derrière `origin/main`**. Le portier l'a d'ailleurs vu et l'a dit :
  `MAINSYNC: BEHIND ahead=0 behind=4 stale_ref=1`.

- **Pourquoi c'est une friction durable** : le flux de ce repo pousse des commits
  **directement sur `origin/main`** (ship + captures d'idées hors PR) sans re-synchroniser
  le `main` local des autres worktrees. Chaque clôture ultérieure re-produira les mêmes
  faux positifs P2/P4 tant que le `main` local traîne derrière `origin/main`. Le juge doit
  alors les neutraliser à la main à chaque fois — exactement le genre de re-jugement que le
  portier est censé éviter.

- **Piste (à débattre en rétro, pas une décision)** : quand `MAINSYNC` révèle
  `behind>0 stale_ref=1` **et** qu'un remote existe, faire classer P2/P4 par `check.sh`
  contre `origin/main` (la base réellement à jour) plutôt que contre le `main` local
  périmé — ou au minimum **taguer** les têtes prouvées identiques à `origin/main` comme
  `ABSORBED_ORIGIN` au lieu de `REAL`, pour qu'aucun juge n'ait à trancher « c'est en fait
  origin/main » de mémoire. À rapprocher de la fiche mega-city 0076 (squash-merge fait
  mentir `--no-merged`) : même famille, base de comparaison mal choisie.

- **Contournement appliqué cette session** : purge des 2 branches ABSORBED prouvées
  (`safe_delete=1`) ; P2/P4 laissés tels quels et signalés comme faux positifs dans le
  handoff ; `main` local **non touché** (checked out ailleurs) — resync reporté à la
  prochaine session via `git switch main && git pull --ff-only`.
