---
id: "20260917211902355"
title: Admin de monitoring — regarder le démon, sans aucun pouvoir
type: feature
priority: P3
version:
epic: "0005"
status: idea
ready:
pr:
created: 2026-09-17
---

**En clair.** Quand le démon tient tout et tourne en fond, on perd la visibilité qu'offrait le
terminal du serveur. Cette fiche ajoute une petite **console web locale, en lecture seule** :
est-il connecté ? quels grants ? quelles sessions ouvertes ? quel journal d'audit ? Elle
**observe**, elle ne configure rien et ne contrôle rien. Calquée sur l'admin de
google-mcp-multi-account. Troisième pièce de l'épic [0005](0005-demon-frontends-mcp.md),
optionnelle, en dernier.

## Contexte / Problème

Un démon en fond, sans client ouvert, est une boîte noire. On ne voit plus la connexion, ni les
sessions actives, ni les refus. Il faut pouvoir **constater l'état** sans pouvoir **agir** :
recréer un canal de contrôle hors du geste humain casserait tout le modèle (l'action passe par
le serveur + Touch ID, [ADR-0003](../docs/adr/0003-consentement-par-presence-touch-id.md), jamais
par une console).

## Proposition

Une **console web locale** (loopback) servie par le démon, strictement en lecture :

- état de connexion (la machine à états : `open`, `qr`, `connecting`…) ;
- le plafond et les grants ;
- les sessions actives, avec leur TTL ;
- un **journal d'audit** append-only : une ligne par événement sensible (session ouverte, refus
  d'un process parasite, expiration, wipe 401…).

**Aucun pouvoir** : pas de bouton « révoquer », « accorder », « configurer ». Pas d'endpoint
mutant. L'admin regarde ; il ne touche pas.

## Critères d'acceptation

- [ ] Une page web locale montre : connexion, plafond, sessions actives (avec TTL), journal
      d'audit.
- [ ] **Aucune action possible** depuis l'admin — vérifié : pas d'endpoint mutant (GET only).
- [ ] L'admin n'est joignable qu'en **local** (loopback), jamais exposé au réseau.
- [ ] Le journal d'audit est **append-only** et horodaté.

## Comment vérifier

- `npm test` — les endpoints admin sont en lecture (GET) ; une tentative de mutation (POST/PUT/
  DELETE) est refusée.
- Manuel : ouvrir la console, ouvrir une session depuis un client, la voir apparaître avec son
  TTL, puis disparaître à l'expiration.

## Notes

- Dépend de la fiche socle [20260917211902097](20260917211902097_demon-tient-whatsapp.md)
  (le démon héberge l'admin).
- **Optionnelle / en dernier** (Décision 2026-09-11 de l'épic) : l'épic peut clore sans elle.
- Dépendance externe : l'admin de google-mcp-multi-account comme **modèle** (console web locale,
  journal d'audit, aucun pouvoir) — accès à **reconstater** à l'implémentation.
- Frontière : l'admin **regarde**. L'authentification, l'autorisation et l'accès vivent dans le
  serveur, pas ici.
