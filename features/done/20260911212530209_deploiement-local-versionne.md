---
id: "20260911212530209"
title: Déploiement local versionné (blue-green) — stable figée, dev testable en parallèle, update & rollback
type: feature
priority: P1
version:
epic:
status: shipped
ready: 2026-09-11
pr: "#38"
created: 2026-09-11
---

## En clair

Aujourd'hui « la version déployée » et « ta version de travail » sont **le même dossier** :
Claude Desktop lance `src/index.js` directement depuis ton checkout. Dès que ce dossier bouge, le
serveur déployé casse (arrivé le 2026-09-11 : renommage → `node_modules` absent → serveur mort en
boucle). Cette fiche **sépare le code qui sert du code sur lequel tu bosses**, sur le modèle
blue-green de `google-mcp-multi-account` : version figée + lien `current`, un `previous` pour
revenir en arrière, l'état (appairage/grants) dans un dossier à part. Elle ajoute une commande pour
**déployer ta branche de dev et la tester en parallèle** du déployé, puis la promouvoir si elle tient.

Décidé dans [ADR-0007](../docs/adr/0007-deploiement-local-versionne-et-moteur-partage.md) (Option A).
Indépendant du démon ([fiche 0005](0005-demon-frontends-mcp.md)).

## Contexte / Problème

`scripts/install-client.js` branche Desktop sur `${projectRoot}/src/index.js` : le serveur déployé
**est** le working tree. Un working tree est instable par nature (refacto en cours, renommage,
`node_modules` non réinstallé, branche à moitié faite). Trois manques concrets :

1. **Pas d'isolation** : le déployé dépend de l'état de ton dossier de travail. L'incident du
   2026-09-11 (`Cannot find package '@modelcontextprotocol/sdk'` en boucle après le renommage #37) en
   est la démonstration directe.
2. **Pas de mise à jour propre ni de rollback** : rien ne fige une version connue-bonne, rien ne
   permet d'y revenir en un geste.
3. **Pas de rail de dev testable** : impossible de faire tourner une version de dev **à côté** de la
   stable pour la valider avant de promouvoir.

Contrainte propre à WhatsApp (absente chez le voisin google, dont le broker est sans état) : **une
session = un seul process vivant** sur `auth/` (Baileys, verrou [fiche 0009](done/0009-verrou-exclusif-auth.md)).
Faire tourner stable **et** dev en même temps exige donc soit un appairage de dev séparé (phase 1),
soit le démon (phase 2, [fiche 0005](0005-demon-frontends-mcp.md)).

## Proposition

Porter le schéma **blue-green local** de `google-mcp-multi-account` (copie assumée — **pas**
d'extraction de kit commun pour l'instant, décision 2026-09-11), en trois arbres séparés :

- **Code figé** : `~/.local/share/whatsapp-mcp/<tag>/`, lien `current` → version active, lien
  `previous` → version d'avant (rollback). Figer via `git archive` (fichiers commités seulement).
- **État hors du code** : `~/.config/whatsapp-mcp/` (auth, data, settings, allowlist, profiles,
  strong-auth, sessions). Déjà possible via les variables `WHATSAPP_*` (chemins absolus) — reste à
  en faire le défaut, posé par un shim.
- **Shim `bin/whatsapp-mcp`** : résout le node stable (`resolveStableNode`, `src/setup.js`), pose les
  `WHATSAPP_*`, lance le `src/index.js` de **son** dossier.

Commandes (portées de `mag`) : figer+basculer (`current`/`previous`), **`dev deploy`** (copie la
branche de travail sur un rail à part, nom de connecteur propre, ne touche jamais `current`),
`update` (sans clone), `revert` (lit `previous`). Nom de connecteur **figé** `whatsapp-mcp` d'une
version à l'autre (sinon Claude réinitialise les permissions d'outils). `install:client`
([fiche 0010](done/0010-installer-doctor-cli.md)) étendu pour pointer `current` et poser l'`env` d'état.

## Critères d'acceptation

- [x] Le serveur déployé tourne depuis `~/.local/share/whatsapp-mcp/current`, **jamais** depuis un
      checkout git — un working tree cassé (ex. `node_modules` absent) **ne casse pas** le déployé.
      *(le shim résout `current` et charge ses dépendances figées ; poignée de main MCP e2e OK)*
- [x] `bin/whatsapp-mcp` (shim) démarre le serveur avec le node stable et l'état sous
      `~/.config/whatsapp-mcp/`, sans variable posée à la main. *(test `test/deploy-shim.js`)*
- [x] Figer une version + basculer `current` = un geste ; l'appairage et les grants (sous
      `~/.config/whatsapp-mcp/`) **ne sont pas touchés** par une bascule. *(l'état vit hors du
      `DEPLOY_ROOT` ; test `test/deploy-local.js`)*
- [x] `revert` ramène `current` sur la version précédente en un geste ; l'état survit.
- [x] `dev deploy` déploie la branche de travail sur un rail à part **sans** toucher `current` ; on
      peut la tester puis la promouvoir *(promotion = merger puis `npm run deploy`)*.
- [x] Faire tourner stable + dev **en parallèle** est documenté : appairage de dev séparé
      (`~/.config/whatsapp-mcp-dev/`, connecteur `whatsapp-feat`) en phase 1 ; démon (0005) en phase 2.
      *(voir [docs/deploiement-local.md](../docs/deploiement-local.md))*
- [x] `install:client` pointe `current` et pose l'`env` d'état ; le nom de connecteur reste `whatsapp-mcp`.
      *(env posé par le shim pour la stable ; en dur dans l'entrée pour le rail dev)*

## État d'implémentation (2026-09-12)

**Livré et testé automatiquement** (`npm test` + un e2e de poignée de main MCP contre le serveur figé) :
`bin/whatsapp-mcp` (shim), `scripts/deploy-local.sh` (`deploy` / `--dev` / `--list` / `--revert` /
`--rollback` / `--print`), `scripts/install-client.js` (stable + `--dev`),
helpers `src/setup.js`, scripts npm `deploy` · `deploy:dev` · `deploy:list` · `deploy:revert` · `install:client:dev`.

**Reste à faire par un humain** (touche l'environnement réel) : brancher **ton** Desktop sur `current`
et vérifier la version via `whatsapp_status` ; rejouer le contre-test `rm -rf node_modules` ; scanner
le QR du rail dev (`whatsapp-feat`) pour valider le parallèle. **Suite optionnelle** : porter `update`
(re-tirer un tag sans clone) ; le démon = [fiche 0005](0005-demon-frontends-mcp.md).

## Comment vérifier

1. Déployer une version, brancher Desktop dessus, confirmer qu'il tourne.
2. Dans le checkout de travail, **casser** volontairement le dossier (`rm -rf node_modules`) → le
   serveur déployé **continue** de répondre (preuve d'isolation — c'est le contre-test de l'incident
   du 2026-09-11).
3. Figer une v2, basculer, vérifier la version servie ; `revert`, vérifier le retour à la v1.
4. `dev deploy` la branche courante, vérifier qu'un second connecteur répond **sans** que `current`
   ait bougé.
5. Vérifier que `~/.config/whatsapp-mcp/auth/` (appairage) est intact après update **et** rollback.

## Notes

- Décision et trade-offs complets : [ADR-0007](../docs/adr/0007-deploiement-local-versionne-et-moteur-partage.md).
- **Frère indépendant du démon** [fiche 0005](0005-demon-frontends-mcp.md) : le démon résout le
  *runtime* (une session multiplexée) ; cette fiche résout le *release* (versionner/promouvoir/revenir).
  Les deux étages partagent la *forme* de google, pas le même chantier.
- Étend [fiche 0010](done/0010-installer-doctor-cli.md) (install/doctor) ; recoupe la piste « commande
  `wire` » de [fiche 20260902223310640](20260902223310640_emballage-plugin-cowork-marketplace.md).
- Reste conforme à [ADR-0005](../docs/adr/0005-le-serveur-ne-configure-pas-le-client.md) : le
  déploiement est un **geste humain** (CLI au terminal), le serveur ne configure pas le client seul.
- Référence à porter : `google-mcp-multi-account` — `scripts/deploy-local.sh` (figer + `current`/`previous`),
  `scripts/update.sh`, `mag revert`, `mag dev deploy`, `bin/google-mcp` (shim). Copie, pas extraction.
