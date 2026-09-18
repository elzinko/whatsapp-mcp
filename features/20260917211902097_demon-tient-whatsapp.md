---
id: "20260917211902097"
title: Le démon tient WhatsApp — un seul process, derrière une socket locale
type: feature
priority: P2
version: 0.3.0
epic: "0005"
status: idea
ready:
pr:
created: 2026-09-17
---

**En clair.** Aujourd'hui chaque client lance son propre serveur, et tous se battent pour
l'unique connexion WhatsApp autorisée : le dernier gagne, les autres tombent (erreur 440).
Cette fiche sort WhatsApp des clients. Un seul processus — le démon — tient la connexion, la
capture et l'archive. Il expose une petite socket locale. Les clients ne parleront plus jamais
à WhatsApp : ils parleront au démon (fiche frontend). C'est le socle de l'épic
[0005](0005-demon-frontends-mcp.md) : rien d'autre ne tient sans lui.

## Contexte / Problème

Une session WhatsApp = un seul process vivant par dossier `auth/`. Le 2026-09-03, **8 serveurs**
`src/index.js` tournaient en parallèle sur le poste ; un seul répondait, les autres se
retiraient en 440.

Deux limites structurelles :

- **Le verrou est un pansement.** Le verrou exclusif sur `auth/`
  ([fiche 0009](done/0009-verrou-exclusif-auth.md)) empêche la collision en **refusant** le 2ᵉ
  process. Il gère la panne, il ne donne pas le multi-clients. Un démon la supprime autrement :
  il n'y a **qu'un** process légitime, par nature.
- **La capture meurt avec le dernier client.** Aujourd'hui, fermer tous les serveurs coupe
  l'ingestion. Un démon capte en continu, client ouvert ou non.

## Proposition

Extraire dans un **process démon** ce qui détient la capacité WhatsApp :

- la connexion Baileys (`whatsapp.js`) et sa machine à états — `starting → qr → connecting →
  open → closed` — avec le plan de reconnexion `wipe` (401, ré-appairage) / `giveup` (440) ;
- la capture / ingestion, filtrée par le plafond **à l'entrée** ;
- l'archive (`store.js`) ;
- le plafond et les grants (`allowlist.js`, `settings.js`) ;
- le registre de sessions (`sessions.js` **migre ici**) : le périmètre d'une session est
  désormais vérifié **côté démon**, pas côté client.

Le démon expose une **socket Unix locale** (loopback, dans le state root déployé), protocole
**NDJSON une ligne par requête**, un petit jeu de verbes (statut, liste, lecture, ouverture /
fermeture de session). Un helper `ensure_daemon_running()` le démarre au besoin : ping → spawn
détaché → polling borné → log en append (transféré de google-mcp-multi-account, Phase 2A).

Un **secret partagé local** garde la socket contre un process parasite. C'est un **garde-fou
anti-parasite, pas une authentification** — et l'ADR doit l'écrire tel quel (voir Notes).

## Critères d'acceptation

- [ ] Un seul process tient la connexion WhatsApp ; le nombre de clients n'y change rien.
- [ ] La capture continue tant que le démon tourne, **même sans aucun client ouvert**.
- [ ] Le démon expose une socket Unix locale ; un client de test lit le statut via le contrat
      NDJSON, **sans toucher WhatsApp**.
- [ ] `ensure_daemon_running()` démarre le démon s'il est absent, se contente de pinguer s'il
      tourne ; **jamais deux démons**.
- [ ] Le plafond (ADR-0002) est appliqué **dans le démon**, à l'ingestion ; aucun canal hors
      plafond n'entre dans l'archive.
- [ ] Le registre de sessions vit dans le démon ; le périmètre d'une session est vérifié
      côté démon.
- [ ] Un process sans le secret ne peut pas parler à la socket ; le refus est journalisé.
- [ ] ADR écrit : cycle de vie du démon (lancement, supervision, arrêt) + contrat socket +
      frontière de sécurité (secret = anti-parasite, pas authentification).

## Comment vérifier

- `npm test` — la machine à états a déjà ses tests hermétiques (`test/reconnect-plan.js`) ;
  ajouter le contrat socket (verbes NDJSON, refus sans secret).
- Manuel : lancer le démon, **fermer tous les clients**, envoyer un message dans un groupe
  capté, constater qu'il arrive dans l'archive.
- Manuel : deux clients de test simultanés → une seule connexion WhatsApp, **zéro 440** dans
  les logs.

## Notes

- Dépendance externe : `google-mcp-multi-account` (Phase 2A local broker, commit `12114ac`) —
  accès constaté le 2026-09-03 (épic parent). À **reconstater** à l'implémentation.
- **À reprendre tel quel** : RPC mince / démon détenteur de la capacité / contrat stable au
  milieu · `ensure_broker_running()` · NDJSON loopback deux verbes · policy évaluée en process
  séparé avec « non classifiable = refus ».
- **À ne pas reprendre** : le bind TCP comme singleton (cf. [0009](done/0009-verrou-exclusif-auth.md)) ·
  le threading libre — une socket WhatsApp unique exige **une file + un worker unique**, là où
  le broker google est sans état.
- **À écrire de zéro** : la machine à états d'une session WhatsApp longue. Le broker google est
  sans état, il n'y a rien à copier là.
- **Frontière de sécurité (à graver dans l'ADR).** Le secret de la socket borne *qui* parle au
  démon : des process locaux que l'humain a lancés. Il n'authentifie personne. Le geste humain
  (Touch ID, côté frontend, [ADR-0003](../docs/adr/0003-consentement-par-presence-touch-id.md))
  ouvre un périmètre ; le démon fait confiance à un frontend authentifié-par-secret. C'est de la
  **sûreté**, pas de la **sécurité** — cohérent avec le threat-model du projet (données propres,
  lecture seule, machine mono-utilisateur coopérative). La vraie frontière reste **le doigt + le
  plafond** ([ADR-0002](../docs/adr/0002-le-plafond-et-le-consentement.md)).
- Le verrou [0009](done/0009-verrou-exclusif-auth.md) devient soit inutile (un seul démon par
  nature), soit re-ciblé sur « un seul démon » — à trancher à l'implémentation.
- Le registre de sessions ([fiche 20260902223310499](done/20260902223310499_droits-par-session-jeton-porte.md))
  est conçu pour migrer tel quel.
