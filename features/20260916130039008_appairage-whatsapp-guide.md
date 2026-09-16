---
id: "20260916130039008"
title: Appairage WhatsApp guidé — le MCP propose la connexion (élicitation, code, repli terminal)
type: feature
priority: P1
version:
epic:
status: idea
ready:
pr:
created: 2026-09-16
---

## En clair

Aujourd'hui, connecter WhatsApp = scanner un QR **caché dans les logs** du serveur. Quand une
session LLM demande un accès et que rien n'est appairé, elle voit « non connecté » sans chemin
clair. Cette fiche fait de l'appairage **le premier rôle** du MCP : quand personne n'est
connecté, il **propose** la connexion — par élicitation dans le chat si le client le permet,
sinon en indiquant la procédure à lancer au terminal. Une fois, sur la machine, ton geste.

Indépendante du démon ([fiche 0005](0005-demon-frontends-mcp.md)) : livrable **avant** lui.

## Contexte / Problème

- L'appairage se fait via un QR imprimé sur la sortie du serveur (stderr). Invisible depuis le
  chat, non découvrable.
- Une session qui appelle un outil de lecture sans appairage obtient un refus « non connecté »
  (`state: "qr"`), mais **aucun moyen guidé** de s'appairer.
- L'appairage est pourtant la **porte d'entrée** de tout l'outil : sans lui, rien ne marche.
- Contrainte [ADR-0005](../docs/adr/0005-le-serveur-ne-configure-pas-le-client.md) : le serveur
  ne configure pas le client ; l'appairage reste un **geste humain**. On guide, on n'automatise pas.

## Proposition

Quand le MCP n'est pas appairé et qu'une session demande un accès, son **premier rôle** est de
proposer la connexion, selon ce que le client permet :

- **Voie 1 — élicitation dans le chat** (préférée) : présenter un **code d'appairage** (saisi
  côté téléphone : WhatsApp > Appareils liés > Lier un appareil > Lier avec un numéro). Le code
  passe en **texte**, contrairement au QR — donc jouable en élicitation, sans image.
- **Voie 2 — repli terminal** (si le client ne supporte pas l'élicitation) : indiquer la
  **commande exacte** à lancer (ex. `npm run pair`) qui affiche le QR / le code et écrit
  l'appairage dans l'état partagé `~/.config/whatsapp-mcp/`.

L'appairage vise l'**état partagé** ([ADR-0007](../docs/adr/0007-deploiement-local-versionne-et-moteur-partage.md)),
donc il profite à toutes les surfaces. Reste fort-authentifié là où c'est pertinent (ADR-0003).

## Critères d'acceptation

- [ ] Sans appairage, un appel d'accès renvoie un **chemin guidé** : formulaire d'élicitation
      (code) si supporté, sinon la procédure terminal exacte — jamais un simple « non connecté ».
- [ ] La voie **code d'appairage** fonctionne de bout en bout (saisie téléphone → session
      appairée), sans QR.
- [ ] Le repli terminal appaire dans `~/.config/whatsapp-mcp/` (état partagé), jamais dans un checkout.
- [ ] Une fois appairé, les sessions suivantes se connectent **sans** ré-appairage.
- [ ] Reste un **geste humain** (ADR-0005) : le MCP guide, ne s'appaire pas tout seul.

## Comment vérifier

1. État vide → une session demande une lecture → le MCP **propose** l'appairage (élicitation ou procédure).
2. Suivre la voie code : saisir le code sur le téléphone → `whatsapp_status` passe à `connected`.
3. Rouvrir une session → connectée sans QR.

## Notes

- **Indépendante du démon** ([fiche 0005](0005-demon-frontends-mcp.md)) : l'appairage guidé marche
  déjà sur le modèle un-serveur actuel ; il n'attend pas la phase 2.
- Sépare proprement les deux phases voulues par le PO : (1) appairage initial unique ; (2) accès
  par session — déjà livré, [fiche 20260902223310499](done/20260902223310499_droits-par-session-jeton-porte.md).
- Fort-auth systématique sur les grants : [ADR-0003](../docs/adr/0003-consentement-par-presence-touch-id.md).
- Aligner le vocabulaire et le flux avec le travail « autorisation par session sans admin » en
  cours sur `google-mcp-multi-account`.
- Technique à confirmer : Baileys sait générer un **code d'appairage** (alternative au QR, via un
  appel type `requestPairingCode(numéro)`) — c'est ce qui rend la voie élicitation possible. À
  vérifier côté API avant de s'engager.
- Priorité proposée **P1** (porte d'entrée de tout l'outil, indépendante du démon) — à confirmer par le PO.
