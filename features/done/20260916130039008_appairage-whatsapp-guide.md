---
id: "20260916130039008"
title: Appairage WhatsApp guidé — le MCP propose la connexion (élicitation, code, repli terminal)
type: feature
priority: P1
version:
epic:
status: shipped
ready: 2026-09-17
pr: "#40"
created: 2026-09-16
---

## En clair

Aujourd'hui, connecter WhatsApp = scanner un QR **caché dans les logs** du serveur. Quand une
session LLM demande un accès et que rien n'est appairé, elle voit « non connecté » sans chemin
clair. Cette fiche fait de l'appairage **le premier rôle** du MCP : quand personne n'est
connecté, il **propose** la connexion — par élicitation dans le chat si le client le permet,
sinon en indiquant la procédure à lancer au terminal. Une fois, sur la machine, ton geste.

Indépendante du démon ([fiche 0005](../0005-demon-frontends-mcp.md)) : livrable **avant** lui.

## Contexte / Problème

- L'appairage se fait via un QR imprimé sur la sortie du serveur (stderr). Invisible depuis le
  chat, non découvrable.
- Une session qui appelle un outil de lecture sans appairage obtient un refus « non connecté »
  (`state: "qr"`), mais **aucun moyen guidé** de s'appairer.
- L'appairage est pourtant la **porte d'entrée** de tout l'outil : sans lui, rien ne marche.
- Contrainte [ADR-0005](../../docs/adr/0005-le-serveur-ne-configure-pas-le-client.md) : le serveur
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

L'appairage vise l'**état partagé** ([ADR-0007](../../docs/adr/0007-deploiement-local-versionne-et-moteur-partage.md)),
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

Le mécanisme se teste en automatique ; le « dernier mètre » (le code tapé sur le téléphone)
se valide à la main, comme le QR aujourd'hui.

**Automatique (suite de tests) :**

1. Sans appairage, un appel d'accès (`list_groups`, `get_recent_messages`, `session_open`)
   renvoie un **chemin guidé** — jamais un simple « non connecté » : voie élicitation si le
   client la supporte, sinon la procédure terminal exacte.
2. Sélection de voie : capacité élicitation présente → voie 1 (code) ; absente → voie 2
   (terminal). Testable par injection — le getter `clientSupportsElicitation` existe déjà
   (`src/index.js:437`).
3. Le repli terminal vise l'état partagé `~/.config/whatsapp-mcp/auth`, jamais un checkout.

**Manuel (une fois, sur la machine) :**

4. État vide → une session demande une lecture → le MCP **propose** l'appairage.
5. Voie code : saisir le code sur le téléphone (WhatsApp > Appareils liés > Lier avec un
   numéro) → `whatsapp_status` passe à `connected: true`.
6. Rouvrir une session → connectée sans ré-appairage.

## Faisabilité (confirmée 2026-09-17)

Ancrée dans le code (exploration du 2026-09-17). Constructible sur l'existant :

- **Code d'appairage sans QR : OUI.** Baileys `6.7.24` expose `sock.requestPairingCode(numéro)`,
  appelé tant que le compte n'est pas enregistré. Point d'insertion : `WhatsAppClient.start()`,
  à la création du socket (`src/whatsapp.js:321-352`), en amont de la branche QR. `start()`
  devra recevoir le numéro (il n'en prend aucun aujourd'hui).
- **Choix voie 1 / voie 2 : déjà là.** Le serveur détecte la capacité élicitation du client au
  handshake (`src/index.js:437-442`). C'est le sélecteur, réutilisé tel quel.
- **Formulaire de saisie : à créer.** L'élicitation existe (`server.elicitInput`, `src/consent.js`)
  mais toujours avec un **schéma vide** (Accept/Decline seuls). La voie code a besoin du
  **premier schéma non vide** (saisir le numéro), ou d'un message qui affiche le code à recopier.
- **État partagé : acquis.** L'auth est persistée dans `~/.config/whatsapp-mcp/auth`
  (`src/whatsapp.js:298`, chemin injecté par le shim).
- **Nouvel outil `whatsapp_pair` + `npm run pair`** : à ajouter (pattern d'outil régulier dans
  `src/index.js` ; repli terminal calqué sur `scripts/list-groups.js`).
- **À trancher dans le sprint** : harmoniser le vocabulaire — l'état interne est `open`/`qr`/…
  tandis que la fiche parle de `connected` (booléen dérivé). Exposer un statut clair et unique.
- **Limite honnête** : l'appel `requestPairingCode` réel se teste par mock Baileys (à introduire)
  ou par validation manuelle — le vrai appairage reste non-automatisable (ADR-0005, geste humain).

## Notes

- **Indépendante du démon** ([fiche 0005](../0005-demon-frontends-mcp.md)) : l'appairage guidé marche
  déjà sur le modèle un-serveur actuel ; il n'attend pas la phase 2.
- Sépare proprement les deux phases voulues par le PO : (1) appairage initial unique ; (2) accès
  par session — déjà livré, [fiche 20260902223310499](20260902223310499_droits-par-session-jeton-porte.md).
- Fort-auth systématique sur les grants : [ADR-0003](../../docs/adr/0003-consentement-par-presence-touch-id.md).
- Aligner le vocabulaire et le flux avec le travail « autorisation par session sans admin » en
  cours sur `google-mcp-multi-account`.
- **Priorité P1 confirmée par le PO (2026-09-17)** : porte d'entrée de tout l'outil, indépendante du démon.
