---
id: 0005
title: Démon unique + frontends MCP minces (phase 2 — multi-clients simultanés)
type: epic
priority: P2
version:
epic:
status: idea
ready:
pr:
created: 2026-07-18
---

**En clair.** Aujourd'hui chaque client — Desktop, Cowork, chaque session Code — lance son
propre serveur WhatsApp, et ils se battent pour l'unique connexion autorisée : le dernier gagne,
les autres tombent (erreur 440). Cet épic met **un seul démon** qui tient WhatsApp, et des
**frontends minces** que les clients lancent librement pour lui parler. Résultat visé : Desktop
et N sessions Code en même temps, zéro guerre de sessions. C'est un **épic** : on ne le tire pas,
on tire ses enfants (voir « Découpage » ci-dessous).

## Contexte / Problème

Une session WhatsApp = un seul process vivant par dossier `auth/`. Aujourd'hui chaque
client (Desktop, chaque session Code) lance SON serveur : le dernier connecté gagne,
les autres se retirent (440 → giveup). Vécu : guerres de sessions, rate-limit,
appairage rasé. Utilisable à un client à la fois, mais structurellement bancal dès que
plusieurs consommateurs simultanés deviennent réels.

## Proposition

Un **démon unique** qui possède Baileys (session + capture + archive + plafond), et des
**frontends MCP stdio minces** que les clients lancent librement : ils parlent au démon
(socket Unix local), plus jamais à WhatsApp. Les profils par projet (0004) deviennent
des scopes de frontend. L'élicitation reste dans le frontend (au plus près du client).

## Critères d'acceptation

- [ ] Desktop + plusieurs sessions Code simultanées, zéro 440
- [ ] Une seule connexion WhatsApp quel que soit le nombre de clients
- [ ] La capture continue tant que le démon tourne, même sans client ouvert
- [ ] Plafond et consentement inchangés (ADR-0002 respecté)
- [ ] ADR dédié (cycle de vie du démon : lancement, supervision, arrêt)

## Découpage en fiches tirables (grooming 2026-09-17)

L'épic est découpé en trois enfants, dans cet ordre de construction. Chacun est une fiche
autonome, groomée, prête pour le gate `ready` (elles naissent `idea` — le gate les promeut au
moment de les tirer).

1. **[20260917211902097](20260917211902097_demon-tient-whatsapp.md) — Le démon tient WhatsApp.**
   Le socle. Sort Baileys, la capture, l'archive, le plafond et le registre de sessions des
   clients vers un démon unique, qui expose une socket Unix locale (contrat NDJSON). Porte l'ADR
   (cycle de vie + contrat + frontière de sécurité).
2. **[20260917211902225](20260917211902225_frontend-mcp-mince.md) — Le frontend MCP mince.**
   Réécrit le serveur stdio en client mince du démon ; l'élicitation / Touch ID reste au
   frontend. Dépend de (1).
3. **[20260917211902355](20260917211902355_admin-monitoring-lecture-seule.md) — Admin de
   monitoring (lecture seule).** Console web locale + journal d'audit, aucun pouvoir de config ni
   de contrôle. Dépend de (1) ; **optionnelle, en dernier**.

**La décision d'architecture centrale** (à graver dans l'ADR de la fiche 1) : le secret de la
socket borne *qui* parle au démon — des process locaux que l'humain a lancés. Il **n'authentifie
personne**. Le geste humain (Touch ID, côté frontend) ouvre un périmètre ; le démon fait
confiance à un frontend authentifié-par-secret. C'est de la **sûreté** (anti-process-parasite),
pas de la **sécurité**, et ça doit être écrit tel quel. La vraie frontière reste le doigt + le
plafond, comme partout dans ce projet.

## Comment vérifier

Épic clos quand les fiches **(1) démon** et **(2) frontend** sont livrées : la capture survit
sans client, zéro 440 en multi-clients, Desktop + N sessions Code en parallèle. L'**admin (3)**
peut suivre. Chaque enfant porte ses propres tests hermétiques (`npm test`) et son scénario
manuel — voir sa fiche.

## Notes

Ne construire QUE quand le multi-simultané est un besoin réel constaté (à ce jour :
usage séquentiel, un client à la fois — la règle « npm run stop » suffit).

### Précédent étudié : `google-mcp-multi-account` (2026-07-21)

Le projet voisin a livré exactement cette architecture (« Phase 2A local broker », commit
`12114ac`). Deux enseignements qui **recadrent** l'idée initiale d'un « broker de tokens » :

**1. Leur token n'authentifie personne — et ils le savent.** C'est un secret global unique
(`.broker-token`), identique pour tous les clients, sans scope. Leur propre threat-model
écrit que toute identité déclarée localement est « spoofable, pas une identité forte », et
que le vrai périmètre est par profil, jamais par client. Leur Phase 2A n'ajoute donc
**aucune frontière de sécurité** : elle prépare la plomberie.

**2. Notre motivation est différente de la leur.** Chez eux le broker est un confort. Ici
c'est une **nécessité fonctionnelle** : N clients MCP × 1 process chacun sur `auth/` = panne
garantie. La menace traitée est la **disponibilité** (deux process détruisent la session),
pas la confidentialité. Donc : ne pas reprendre le mot « token » comme s'il authentifiait
quelqu'un. Un secret partagé ne vaut ici que comme **garde-fou anti-process-parasite** —
c'est de la sûreté, pas de la sécurité, et ça doit être écrit comme tel.

**Transférable tel quel** : le découpage client RPC mince / daemon détenteur de la capacité /
contrat stable au milieu · `ensure_broker_running()` (ping → spawn détaché → polling borné →
log en append) · NDJSON une ligne par requête sur loopback, deux verbes · serveur MCP sans
dépendance externe + shim à chemin absolu qui pose le PATH lui-même · policy évaluée en
process séparé avec « non classifiable = refus » et « config corrompue = refus ».

**À ne PAS reprendre** : le bind TCP comme modèle de singleton (cf. fiche **0009**) · le
threading libre — une socket WhatsApp unique exige une file + worker unique, là où leur
`gws` est sans état · le token global présenté comme une frontière.

**À écrire de zéro** : la machine à états d'une session WhatsApp longue (connecting /
paired / logged-out / needs-QR). Leur broker est sans état, il n'y a rien à copier là.

**Si un scope par client devient un besoin** (« ce Desktop lit #famille, ce Code non ») :
il faut un token **par client**, dont le périmètre est vérifié côté broker — strictement
plus que ce que fait le voisin, à concevoir et non à copier.

### Prérequis de l'épic « accès par session » (2026-09-03)

Épic **frère** (pas parent/enfant : deux niveaux max) de
[20260902223310355](20260902223310355_acces-whatsapp-par-session.md), qui en fait son
**prérequis** pour le multi-clients simultanés (Cowork + N sessions Code). Constat du
2026-09-03 : **8 serveurs** `src/index.js` tournaient en parallèle sur le poste, un seul
répondait — le besoin « multi-simultané réel » posé en condition ci-dessus est désormais
constaté. Le registre de sessions (fiche
[20260902223310499](done/20260902223310499_droits-par-session-jeton-porte.md)) est conçu pour
migrer tel quel dans le démon.

### Décision (2026-09-11) — priorité P2 + admin de monitoring

Relevé **P3 → P2** : c'est le prérequis constaté du multi-conversation (plusieurs chats
Desktop / Cowork + Code en même temps — exigence de l'épic
[20260902223310355](20260902223310355_acces-whatsapp-par-session.md)), pas un simple confort.
Reste sous les fiches déjà tirables tant que « un client à la fois » suffit.

Le démon **peut** exposer un **admin de monitoring uniquement**, calqué sur celui de
google-mcp-multi-account (console web locale, journal d'audit — **aucun** pouvoir de config ni de
contrôle). L'authentification / autorisation / accès vivent dans le serveur ; l'admin ne fait
que *regarder*.

### Cadrage PO (2026-09-16) — une connexion pour tous, accès par session

Formulation du PO, qui **recadre** l'épic sans en changer le fond :

- **Une seule connexion WhatsApp pour tout le monde.** Le démon la tient ; le chat, Cowork et
  Code sont des frontends qui lui parlent. Ils **tournent toujours**, même sans appairage. Donc
  l'« Échec / Connection closed » observé le 2026-09-16 sur les surfaces secondaires (le verrou
  [fiche 0009](done/0009-verrou-exclusif-auth.md) qui refuse un 2ᵉ process sur le même appairage)
  **disparaît** : plus personne ne se bat pour la session.
- **Deux phases distinctes, dans l'ordre :**
  1. **Appairage initial** — une fois, sur la machine, geste humain. Le MCP le **propose**
     (élicitation / code / repli terminal) : fiche dédiée
     [20260916130039008](20260916130039008_appairage-whatsapp-guide.md), **indépendante** du démon.
  2. **Accès par session** — par personne/groupe, borné dans le temps, par élicitation avec
     **authentification forte systématique** ([ADR-0003](../docs/adr/0003-consentement-par-presence-touch-id.md)).
     Déjà livré : [fiche 20260902223310499](done/20260902223310499_droits-par-session-jeton-porte.md).
- **Durée des accès** : aujourd'hui TTL **fixe** (8 h par défaut). « Liée à la durée de vie de la
  session LLM » est la variante plus dure — le MCP ne sait pas toujours quand une session finit.
  À concevoir en s'**alignant** sur le travail « autorisation par session sans admin » en cours sur
  `google-mcp-multi-account`, pas en réinventant.

Ce cadrage ne change pas les critères d'acceptation ci-dessus ; il confirme la direction et
rattache la fiche d'appairage guidé.
