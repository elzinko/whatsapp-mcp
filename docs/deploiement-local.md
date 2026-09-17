# Déploiement local (blue-green)

## En clair

Ce guide explique comment faire tourner `whatsapp-mcp` **proprement** sur ta machine :
une version **stable** que Claude Desktop/Code lancent, insensible à ce que tu bricoles
dans le dépôt ; et, quand tu veux, une version **dev** en parallèle pour tester ta branche
avant de la promouvoir.

L'idée tient en une phrase : **le code qui sert n'est pas le code sur lequel tu travailles.**
On fige chaque version dans un dossier à part, un lien `current` désigne celle qui tourne,
et l'appairage WhatsApp vit dans un troisième dossier qu'aucune mise à jour ne touche.

Décision et compromis complets : [ADR-0007](adr/0007-deploiement-local-versionne-et-moteur-partage.md).
Fiche : [20260911212530209](../features/done/20260911212530209_deploiement-local-versionne.md).

## Le schéma : trois dossiers, trois rôles

```
CODE (versions figées)             ÉTAT (jamais touché par une MAJ)    TON TRAVAIL
~/.local/share/whatsapp-mcp/       ~/.config/whatsapp-mcp/             ~/git/.../whatsapp-mcp/
├── current  ── lien ─┐            ├── auth/          (appairage)      (ton checkout, tes
├── previous ─ lien ─┼─┐          ├── data/          (archives)        branches — instable
├── 4f349c1/  (figé)  │ │          ├── settings.json  (grants)          par nature)
├── dev/      (figé) ◄─┼─┘ (dev)  ├── allowlist.json (plafond)
└── …          ◄──────┘ (stable)  └── sessions/ · profiles.json · strong-auth.json
```

- **Figer** une version = copier les fichiers *commités* (jamais l'arbre sale) + `npm ci`.
- **Basculer** = déplacer le lien `current`. Deux `ln -sfn`, réversible en un geste.
- Le client (Desktop/Code) lance **le shim** `current/bin/whatsapp-mcp`, qui résout `current`
  à chaque démarrage et pose l'état hors du code. Il ne lance **jamais** ton checkout.

## Déployer la version stable

Depuis ton checkout, **arbre propre** (commite d'abord) :

```bash
npm run deploy
```

La commande fige la version de `HEAD`, installe ses dépendances, et bascule `current`.
Elle **ne configure pas** Claude toute seule (le serveur ne touche pas le client, ADR-0005) :
elle t'affiche le geste qui reste. Branche ensuite Desktop :

```bash
cd ~/.local/share/whatsapp-mcp/current && npm run install:client
```

Puis quitte complètement Claude Desktop (Cmd-Q) et relance-le. Le connecteur reste nommé
`whatsapp-mcp` d'une version à l'autre — sinon Claude croit à un nouveau serveur et
réinitialise les permissions d'outils.

**Racine personnalisée** : `WHATSAPP_DEPLOY_ROOT=/chemin npm run deploy` déploie ailleurs
que `~/.local/share/whatsapp-mcp`. La commande d'install que `deploy` affiche **reporte
automatiquement** cette racine — recopie-la telle quelle.

## Migration initiale de l'état (une fois, si tu utilisais déjà le checkout)

Le déploiement range l'état sous `~/.config/whatsapp-mcp/`. Si tu avais **déjà** appairé et
accordé des accès en lançant le serveur depuis le checkout, cet état vit encore dans ton dépôt
(`auth/`, `settings.json`, `allowlist.json`, `profiles.json`, `strong-auth.json`, `sessions/`).
La **première** bascule ne le transporte pas : le serveur déployé démarrerait vierge (QR
redemandé, grants perdus) tant que tu ne l'as pas importé **une fois**.

Serveur arrêté (Desktop quitté), depuis ton checkout :

```bash
mkdir -p ~/.config/whatsapp-mcp
cp -a auth ~/.config/whatsapp-mcp/ 2>/dev/null || true
for f in settings.json allowlist.json profiles.json strong-auth.json; do
  [ -e "$f" ] && cp -a "$f" ~/.config/whatsapp-mcp/
done
cp -a sessions ~/.config/whatsapp-mcp/ 2>/dev/null || true
```

Après cette copie, l'appairage et les grants sont sous `~/.config/whatsapp-mcp/` — et **y
restent** : les mises à jour et rollbacks n'y touchent plus.

## Réglages persistants (`config.env`)

`git archive` n'emporte **pas** ton `.env` (gitignoré), donc la version figée retombe aux
réglages par défaut. Pour fixer des réglages **non-chemin** — `WHATSAPP_PROFILE`,
`WHATSAPP_PERSIST`, `WHATSAPP_MAX_MESSAGES`, `WHATSAPP_SESSION_TTL_MS`, `WHATSAPP_DEVICE_NAME` —
pose-les dans `~/.config/whatsapp-mcp/config.env` (une ligne `CLÉ=valeur` par réglage). Le shim
le charge à chaque lancement, quelle que soit la version servie. Sans lui, un install **profilé**
cesserait de servir ses canaux (profil vidé).

## Revenir en arrière

```bash
npm run deploy:list     # versions figées (* = current, + la ligne previous)
npm run deploy:revert   # current → previous (le retour le plus fréquent)
# ou, vers une version précise :
bash scripts/deploy-local.sh --rollback <version>
```

Une fois l'état sous `~/.config/whatsapp-mcp/` (voir la migration ci-dessus), l'appairage et
les grants **survivent** à une bascule, à un update et à un rollback : revenir en arrière ne te
fait rien perdre.

## Tester une version de dev **en parallèle** de la stable

```bash
npm run deploy:dev            # fige ta branche de travail (même sale) sur le slot « dev »
cd ~/.local/share/whatsapp-mcp/dev && npm run install:client:dev
```

`deploy:dev` **ne touche jamais** `current` : ta stable continue de tourner. Le connecteur
dev s'appelle `whatsapp-feat` et utilise un **état séparé** `~/.config/whatsapp-mcp-dev/`.

La contrainte dure de WhatsApp : **une session = un seul process** sur un appairage donné.
Pour faire tourner stable **et** dev en même temps, le rail dev a donc son **propre
appairage** : au premier lancement, `whatsapp-feat` affichera **son propre QR** à scanner
(idéalement un numéro/appareil de test). C'est la **réponse de phase 1**.

> **Phase 2 (plus tard)** : le démon unique de la [fiche 0005](../features/0005-demon-frontends-mcp.md)
> tiendra la seule session ; stable et dev deviendront des frontends minces qui lui parlent.
> Un seul appairage, multiplexé — plus de double QR. Ce guide couvre la phase 1.

## Vérifier que l'isolation marche (contre-test de l'incident du 2026-09-11)

1. Déploie, branche Desktop, confirme que le serveur répond.
2. Dans ton **checkout**, casse volontairement le dossier :
   ```bash
   rm -rf node_modules
   ```
3. Le serveur **déployé continue de répondre** : il tourne depuis `current`, avec ses
   propres dépendances figées. Le dossier de travail cassé ne l'atteint pas.
4. `npm install` remet ton checkout d'aplomb — sans avoir jamais dérangé la version servie.

## Limites connues / suite

- **`update` sans clone** (re-tirer un tag publié sans dépôt local) n'est pas encore porté.
  Aujourd'hui on fige depuis le checkout (`npm run deploy`). C'est un ajout ultérieur.
- **Fichiers non suivis** : `deploy:dev` capture les fichiers *suivis* modifiés, pas les
  nouveaux fichiers jamais `git add`. Ajoute-les pour les inclure dans le rail dev.
- **Noms de version** : un tag contenant un « / » (ex. `release/v1`) n'est pas supporté — le
  nom de version sert de nom de dossier. Retague sans slash.
- **Multi-simultané propre sur un seul appairage** = phase 2 (démon, fiche 0005).
