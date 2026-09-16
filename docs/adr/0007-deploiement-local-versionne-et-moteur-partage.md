# ADR-0007 : Déploiement local versionné (blue-green) + moteur de release partagé avec google-mcp-multi-account

**Statut :** Accepté
**Date :** 2026-09-11
**Décideurs :** Thomas (propriétaire du projet et du compte WhatsApp)
**Décidé le 2026-09-11 (avec Thomas) :** Option A retenue (étage release maintenant). Extraction d'un **kit commun** avec le voisin **écartée pour l'instant** (pas de besoin). « Déployer la dev pour la tester » (type `mag dev deploy`) passe au **premier plan**.
**Voisin de référence :** `google-mcp-multi-account` — projet, connecteur `google-multi-account`, dossier d'install `~/.local/share/google-mcp/`. A déjà livré ce modèle.
**Touche à :** [ADR-0005](0005-le-serveur-ne-configure-pas-le-client.md) (le geste d'install reste humain), [fiche 0005](../../features/0005-demon-frontends-mcp.md) (démon — la moitié « runtime » du moteur), [fiche 0010](../../features/done/0010-installer-doctor-cli.md) (install-client, socle réutilisé)

## En clair

Aujourd'hui, « la version déployée » et « ta version de travail » sont **le même dossier**.
Claude Desktop lance le serveur directement depuis `git/bacasable/whatsapp-mcp/src/index.js`.
Donc dès que ce dossier bouge — un renommage, un `node_modules` pas réinstallé, une refacto à
moitié faite — le serveur que Desktop lance casse. C'est arrivé le 2026-09-11 (voir Contexte).

La décision : **séparer le code qui sert du code sur lequel tu travailles.** On fige chaque
version dans un dossier à part, un lien `current` désigne celle qui tourne, un lien `previous`
permet de revenir en arrière en une commande. L'état (appairage, messages, grants) vit dans un
**troisième** dossier, jamais touché par une mise à jour. C'est exactement le schéma **blue-green**
que google-mcp-multi-account fait déjà.

Le tronc commun existe, mais il a **deux étages**. L'étage « release » (figer / basculer /
revenir) est identique aux deux MCP : c'est un vrai moteur partageable, presque tel quel. L'étage
« tourner à deux en même temps » ne l'est **pas** : WhatsApp n'a qu'**une seule session**, qu'un
seul process peut tenir. C'est la différence dure avec google.

## Contexte

### L'incident qui déclenche cette décision

Le 2026-09-11, le serveur `whatsapp-mcp` de Claude Desktop tombe en boucle :
`Cannot find package '@modelcontextprotocol/sdk'`. Cause : le renommage
`whatsapp-group-mcp → whatsapp-mcp` (#37) a créé un nouveau dossier ; `node_modules` est
gitignoré, il n'a pas suivi ; personne n'a relancé `npm install` dedans. Or Desktop pointait
déjà sur ce dossier neuf. Un `npm ci` a réparé le symptôme.

La cause profonde n'est pas le renommage. C'est que **Desktop lance le dossier de travail**. Le
dossier de travail est, par nature, un endroit instable.

### Forces en présence

1. **Tu veux une version déployée stable** que Desktop/Cowork/Code lancent, insensible à ce que
   tu bricoles à côté.
2. **Tu veux travailler en parallèle** sur une version de dev, et la tester sans casser la stable.
3. **Tu veux promouvoir** la dev en stable quand elle est bonne, et **revenir en arrière** vite si
   elle ne l'est pas.
4. **La contrainte WhatsApp** : une session = un seul process vivant sur `auth/` (Baileys, verrou
   fiche 0009). Deux serveurs Baileys sur le même appairage = guerre de sessions, rate-limit,
   appairage rasé (l'incident « 8 serveurs » du 2026-09-03).

Le point 4 n'existe pas chez google : son courtier (broker) est **sans état**, l'API Google est
multi-connexion. C'est pour ça que chez google « faire tourner stable + dev en même temps » est
gratuit, et que chez nous ça ne l'est pas.

### Ce que le code actuel permet déjà

- `src/setup.js` a déjà les bonnes briques, **sans rien de spécifique à WhatsApp** :
  `resolveStableNode` (le node à chemin absolu que Desktop sait lancer), `mergeMcpServer`
  (fusion idempotente de la config client, sans rien écraser), `desktopConfigPath`.
- `src/config.js` résout chaque emplacement d'état (`authDir`, `dataDir`, `settingsFile`,
  `allowlistFile`, `profilesFile`, `strongAuthFile`, `sessionsDir`) via une variable
  d'environnement. **Un chemin absolu les sort déjà du checkout.** La séparation état/code est
  donc à portée de configuration, pas de réécriture.

## Décision

### 1. Adopter le schéma blue-green local, calqué sur google-mcp-multi-account

Trois arbres de répertoires, séparés par rôle :

```
CODE (versions figées)          ÉTAT (jamais touché par une MAJ)      TRAVAIL (ton git)
~/.local/share/whatsapp-mcp/    ~/.config/whatsapp-mcp/               ~/git/bacasable/whatsapp-mcp/
├── current  ── symlink ─┐      ├── auth/           (appairage)       (ton checkout, tes branches,
├── previous ─ symlink ─┼─┐    ├── data/           (archive)          tes worktrees — instable
├── v0.2.0/  (figé)      │ │    ├── settings.json   (grants)           par nature)
├── v0.3.0/  (figé) ◄────┘ │    ├── allowlist.json  (plafond)
└── …                 ◄────┘    ├── profiles.json / strong-auth.json
                                └── sessions/
```

- **Figer** une version = copier les fichiers *commités* (`git archive`, jamais le working tree
  sale) dans `~/.local/share/whatsapp-mcp/<tag>/`.
- **Basculer** = déplacer le lien `current` vers la nouvelle version, après avoir pointé
  `previous` sur l'ancienne. Deux `ln -sfn`, atomique.
- **L'entrée client** (Desktop/Code) pointe sur `current`, **jamais** sur `<tag>/` directement
  (qui, lui, ne bouge pas — utile pour épingler). Le nom du connecteur reste **figé** à
  `whatsapp-mcp` d'une version à l'autre : sinon Claude croit à un nouveau connecteur et
  réinitialise les permissions d'outils (leçon explicite de google, fiche 0042 côté voisin).

### 2. L'état vit hors du code — invariant, pas option

Les sept emplacements d'état déménagent par défaut sous `~/.config/whatsapp-mcp/` (ou
`~/Library/Application Support/whatsapp-mcp/`). Concrètement : un **shim** `bin/whatsapp-mcp`
pose ces variables `WHATSAPP_*` puis lance le `src/index.js` de **son propre dossier** (celui où
le lien l'a mené). Une mise à jour ou un rollback ne touchent alors **jamais** ton appairage ni
tes grants. C'est ce qui rend le rollback sans peur.

### 3. Deux rails : stable et dev

- **Stable** : entrée `whatsapp-mcp` → `current` → l'état partagé `~/.config/whatsapp-mcp/`.
- **Dev** : entrée à nom distinct (`whatsapp-feat`) → un worktree, ou un dossier `dev-<sha>/` —
  **et son propre état** `~/.config/whatsapp-mcp-dev/` avec **son propre appairage** (voir §4).

**Déployer la dev pour la tester** — la brique que tu as pointée, et elle manque en effet à la v1.
Une commande (l'équivalent de `mag dev deploy` chez `google-mcp-multi-account`) copie ta branche de
travail — **même sale** — dans un slot `dev-<sha>/`, la branche sur son **propre** nom de connecteur,
et **ne touche jamais** `current`. C'est ce qui te laisse *tester la dev en parallèle du déployé*,
puis la promouvoir en stable si elle tient. Figer/copier + brancher est **gratuit et portable** ;
seule la faire **tourner en vrai contre WhatsApp** retombe sur la contrainte de session (§4).

Règle reprise telle quelle : **une commande de dev ne bascule jamais la stable.**

### 4. La contrainte dure : une seule session WhatsApp — deux réponses, dans l'ordre

C'est le seul point où google ne nous aide pas. Deux process Baileys ne peuvent pas tenir le
**même** appairage.

- **Réponse 1 (maintenant, sans le démon)** : le rail dev utilise un **appairage séparé** — son
  propre `auth/`, donc son propre « appareil lié » scanné au QR (idéalement un numéro/appareil de
  test). Stable et dev tournent alors vraiment en parallèle, chacun sa session. Le prix : deux
  appairages à maintenir. Un rail dev **sans** appairage propre reste possible mais alors c'est
  séquentiel (`npm run stop` avant de switcher).
- **Réponse 2 (plus tard — [fiche 0005](../../features/0005-demon-frontends-mcp.md), déjà P2)** : un
  **démon unique** tient la seule session ; stable et dev deviennent des **frontends minces** qui
  lui parlent (socket local). Là, plus besoin de double appairage : un seul, multiplexé. C'est
  l'étage où nos deux MCP convergent le plus — google a déjà livré exactement ça (« Phase 2A
  broker »).

### 5. Le tronc commun — ce qui EST le moteur, ce qui ne l'est pas

**Le moteur partageable (agnostique au domaine, à extraire en kit commun) :**

| Brique | google-mcp-multi-account (référence) | whatsapp (état actuel) |
|---|---|---|
| Figer une version + bascule `current`/`previous` | `scripts/deploy-local.sh` | à porter (Bash, ~identique) |
| Mise à jour sans clone (tarball du tag) | `scripts/update.sh` → `mag update` | à porter |
| **Déployer la dev pour la tester** | `mag dev deploy` (slot `dev-*/`, port + nom propres) | à porter |
| Rollback en un geste | `mag revert` (lit `previous`) | à porter |
| Release = semver depuis commits conventionnels → tag | `scripts/release.sh` → `mag release` | outillage ezk déjà en place |
| Brancher le client sans clobber | `install-claude-desktop.sh` / `mag wire` | **déjà là** : `mergeMcpServer` + `install:client` |
| node/lanceur à chemin stable | `bin/google-mcp` (résout son symlink) | **déjà là** : `resolveStableNode` (manque le shim) |
| État hors du code | `~/.config/gws-accounts/` | **déjà possible** : variables `WHATSAPP_*` |

Ces briques sont en Bash / shell chez google, paramétrées par variables
(`GWSA_DEPLOY_ROOT`, `GWSA_ROOT`, `PRODUCT_SLUG`). Elles ne connaissent ni Google ni WhatsApp.
**C'est ça, le moteur** : un petit kit de déploiement paramétré par 4 valeurs (slug produit,
racine code, racine état, commande de lancement). whatsapp fournirait seulement son lanceur et sa
liste de dossiers d'état.

**Ce qui N'EST PAS partageable (spécifique WhatsApp, à écrire de zéro) :**

- La **propriété de la session** unique (Baileys) et sa **machine à états** (connecting / paired /
  logged-out / needs-QR). Le broker de google est sans état : il n'y a rien à copier là.
- Le fait qu'un rail dev exige **son propre appairage** (on ne « copie » pas un appareil lié comme
  google copie un `client_secret.json`).

Autrement dit : **l'étage release est un vrai moteur commun ; l'étage runtime a la même *forme*
mais un contenu WhatsApp propre.**

## Options considérées

### Option A — Moteur de release seul, tout de suite *(retenue pour la phase 1)*

Porter le blue-green (figer / `current`+`previous` / wire / release / revert) **et la commande
`dev deploy`** (déployer ta branche de travail sur un rail à part pour la tester), et sortir l'état
du code. Dev en parallèle via appairage séparé, ou séquentiel.

**Pour :** supprime la classe de bug du 2026-09-11 (le déployé est figé, isolé de ton travail) ;
donne update + rollback ; petit périmètre ; réutilise beaucoup d'existant ; copiable presque tel
quel de google.
**Contre :** parallèle stable+dev exige un 2ᵉ appairage tant que le démon n'est pas là.

### Option B — Option A + démon (fiche 0005) *(retenue pour la phase 2)*

Ajoute le démon unique + frontends minces. Parallèle vrai sur **un seul** appairage.

**Pour :** multi-clients simultanés propre ; convergence maximale avec google ; c'est déjà au
backlog (P2).
**Contre :** plus gros ; introduit la machine à états de session ; à faire quand le multi-simultané
est un besoin constaté (il commence à l'être).

### Option C — Statu quo *(écartée)*

Desktop continue de lancer le dossier de travail.

**Pour :** rien à faire.
**Contre :** l'incident du 2026-09-11 se répétera à chaque mouvement du checkout ; ni update propre
ni rollback ; « travailler en parallèle » reste bancal.

## Analyse des compromis

Le vrai arbitrage n'est pas « peut-on déployer comme google ? » — oui, l'étage release se copie.
Il est : **combien de la contrainte-session on veut résoudre, et quand.**

- Si tu acceptes un **appairage de dev séparé**, l'Option A te donne dès maintenant : stable
  intouchable, dev en parallèle, promote, rollback. C'est 80 % de ta demande pour 20 % du travail.
- Si tu veux **un seul appairage** partagé entre stable et dev qui tournent ensemble, il faut le
  démon (Option B). C'est le bon objectif, mais c'est la fiche 0005, pas ce sprint.

Extraire un **kit commun** (plutôt que copier-coller le voisin) paierait à chaque MCP suivant et
éviterait que les deux moteurs divergent. Vu que `google-mcp-multi-account` est en shell paramétré,
l'extraction serait réaliste (du Bash agnostique, pas du Python à marier avec du Node).
**Décision 2026-09-11 : on ne l'extrait pas maintenant** — pas de besoin. On copie pour livrer, on
ré-évaluera si un 3ᵉ MCP arrive.

## Conséquences

**Ce qui devient plus facile :**
- Le serveur déployé ne dépend plus de l'état de ton working tree. Le bug du jour ne peut plus
  arriver.
- Mettre à jour = une commande ; se tromper = une commande pour revenir. Sans risque pour
  l'appairage ni les grants (ils sont ailleurs).
- Un 2ᵉ MCP pourra partager le même moteur de release (extraction différée — pas maintenant).

**Ce qui devient plus difficile / à surveiller :**
- Deux appairages à gérer tant que le démon n'est pas là (Option A).
- Un invariant à tenir : l'entrée client pointe `current` ou un `<tag>/` épinglé, **jamais** un
  worktree — sinon on recrée le couplage qu'on vient de casser (drift observé côté google, voir
  note ci-dessous).
- `bin/whatsapp-mcp` (le shim qui pose le PATH et l'état) devient un point de passage obligé à
  tester.

**Cohérence avec les ADR existants :** le déploiement reste un **geste humain** (CLI lancée au
terminal), le serveur ne configure toujours pas le client tout seul (ADR-0005). Le moteur ne touche
ni au plafond (ADR-0002) ni au consentement (ADR-0003) : il déplace du code, pas de l'autorité.

## Actions

1. [ ] Créer la fiche dédiée « déploiement local versionné » (via ezk-backlog) : l'étage release
   (Option A), indépendant du démon ([fiche 0005](../../features/0005-demon-frontends-mcp.md)).
2. [ ] Écrire `bin/whatsapp-mcp` : shim qui résout le node stable (`resolveStableNode`), pose les
   `WHATSAPP_*` vers `~/.config/whatsapp-mcp/`, lance le `src/index.js` de son dossier.
3. [ ] Porter depuis `google-mcp-multi-account` : `deploy-local.sh` (figer + bascule
   `current`/`previous`), `update.sh`, `revert`, **et `dev deploy`** (rail de test à part). Copie
   assumée — **pas d'extraction de kit commun pour l'instant** (décision 2026-09-11).
4. [ ] Étendre `install:client` (`mag wire`-like) pour pointer `current` et poser l'`env` d'état ;
   garder le nom de connecteur figé `whatsapp-mcp`.
5. [ ] Documenter le rail dev : appairage séparé (`~/.config/whatsapp-mcp-dev/`, nom `whatsapp-feat`)
   comme réponse phase 1 ; le démon (0005) comme réponse phase 2.

## Le jour où on voudrait revenir dessus

Si le multi-simultané ne devient jamais un vrai besoin et qu'un appairage de dev séparé suffit
toujours, l'Option B (démon) peut rester en veille indéfiniment sans rien coûter. L'étage release
(Option A), lui, se justifie seul : il paie dès le premier rollback évité.
