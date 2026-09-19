# ADR-0008 : Le démon unique — un process tient WhatsApp, derrière une socket locale

**Statut :** Proposé
**Date :** 2026-09-19
**Décideurs :** Thomas (propriétaire du projet et du compte WhatsApp)
**Amende :** compose ADR-0002 (plafond/consentement), ADR-0003 (Touch ID), ADR-0004 (sessions) —
il déplace *où* ces règles s'appliquent, il ne les change pas
**Feature :** [20260917211902097](../../features/20260917211902097_demon-tient-whatsapp.md)
(épic [0005](../../features/0005-demon-frontends-mcp.md), phase 2, v0.3.0)

## Contexte

Une session WhatsApp = **un seul** process vivant par dossier `auth/`. Aujourd'hui chaque
client (Desktop, Cowork, chaque session Code) lance **son** serveur `src/index.js`, qui ouvre
sa propre connexion Baileys. Le dernier connecté gagne ; les autres tombent en 440
(`connectionReplaced`). Constat du 2026-09-03 : **8 serveurs** en parallèle, un seul répondait.

Deux limites structurelles :

- Le verrou exclusif sur `auth/` ([fiche 0009](../../features/done/0009-verrou-exclusif-auth.md))
  **empêche** la collision en refusant le 2ᵉ process. Il gère la panne ; il ne donne pas le
  multi-clients.
- La capture **meurt** avec le dernier client. Fermer tous les serveurs coupe l'ingestion.

L'analogie : aujourd'hui, chaque personne qui veut lire le courrier veut **sa propre clé** de la
boîte aux lettres — deux clés dans la serrure en même temps, elle casse. On veut plutôt **un seul
gardien** qui tient la boîte, et des guichets par lesquels chacun demande son courrier.

## Décision

### 1. Un démon unique détient la capacité WhatsApp

Un nouveau process — le **démon** — est le seul à ouvrir `auth/` et la socket Baileys. Il
détient : la connexion et sa machine à états (`starting → qr → connecting → open → closed`), le
plan de reconnexion (`wipe` 401 / `giveup` 440), la capture filtrée par le plafond, l'archive
(`store.js`), le plafond et les grants, et le **registre de sessions** (`sessions.js`, migré
depuis la couche application — [ADR-0004](0004-droits-par-session.md) l'avait prévu « déménage
tel quel »). Il tourne **sans tête** : la capture continue même sans aucun client.

### 2. Le transport : socket Unix locale + NDJSON — pas TCP

Le démon écoute sur une **socket Unix** (fichier `daemon.sock` dans le state root déployé,
permissions `0600`), pas sur du TCP loopback. Raison : la leçon de la
[fiche 0009](../../features/done/0009-verrou-exclusif-auth.md) — un bind TCP comme modèle de
singleton est fragile (port occupé, course). Un fichier de socket porte des **permissions
fichier** et ne collisionne pas de port. C'est justement ce que google-mcp-multi-account fait
autrement (leur broker est en loopback TCP) : on **ne le copie pas**.

Protocole : **NDJSON**, un objet JSON par ligne, requête → réponse. Jeu de verbes minimal :
`status`, `list_groups`, `recent`, `session_open`, `session_close`. Le démon **applique le
périmètre** (session ∩ grant ∩ plafond) **de son côté** à chaque `recent`.

### 3. Le frontend reste mince et détient l'élicitation

Le serveur MCP que lance chaque client devient un **client mince** du démon : il parle à la
socket, jamais à WhatsApp. L'**élicitation / Touch ID** ([ADR-0003](0003-consentement-par-presence-touch-id.md))
reste **dans le frontend**, au plus près de la personne. Le frontend fait le geste humain,
**puis** dit au démon « ouvre une session pour ces canaux » — le démon ne présente jamais de
prompt. *(Le rewire du frontend actuel est la [fiche 20260917211902225](../../features/20260917211902225_frontend-mcp-mince.md) ;
le présent ADR fixe le contrat que les deux côtés respectent.)*

### 4. Singleton du démon : `ensure_daemon_running` + un verrou

Côté client, `ensure_daemon_running()` : **ping** la socket → si personne ne répond, **spawn
détaché** du démon → **polling borné** jusqu'à réponse → **log en append**. Transféré du patron
de google (nom de symbole à adapter).

Côté démon, l'unicité est garantie par le **verrou exclusif** existant
([fiche 0009](../../features/done/0009-verrou-exclusif-auth.md), `authlock.js`, PID en `O_EXCL`) :
au démarrage, le démon prend le verrou ; un second démon le trouve tenu et **s'arrête**. Le rôle
du verrou **se déplace** : il n'arbitre plus une course entre N serveurs, il garantit **un seul
démon**. Pendant la transition, démon et serveur legacy **partagent** ce verrou — donc restent
mutuellement exclusifs (on lance l'un **ou** l'autre, jamais les deux).

### 5. La frontière de sécurité : le secret est anti-parasite, PAS une authentification

La socket est gardée par un **secret partagé local** (fichier `0600` dans le state root, lisible
par le seul utilisateur). Tout process local qui lit ce secret peut parler au démon.

Ce secret **borne qui** parle au démon — des process que l'humain a lancés. Il **n'authentifie
personne**. Le geste humain (Touch ID) se fait au frontend ; le démon **fait confiance** à un
frontend authentifié-par-secret quand il affirme qu'un consentement a eu lieu. C'est de la
**sûreté** (anti-process-parasite), **pas de la sécurité**.

On l'écrit noir sur blanc pour ne pas refaire l'erreur du voisin : reprendre le mot « token »
comme s'il protégeait quelqu'un. La **vraie** frontière reste le **doigt + le plafond**
([ADR-0002](0002-le-plafond-et-le-consentement.md), [ADR-0003](0003-consentement-par-presence-touch-id.md)) :

- le plafond est ré-appliqué **dans le démon**, à l'ingestion **et** à chaque `recent` (défense
  en profondeur, [ADR-0002](0002-le-plafond-et-le-consentement.md) §6 intact) ;
- un process **sans le secret** est refusé, et le refus est **journalisé** (audit).

### 6. Transition sans big-bang

Cette fiche (child A) livre le **démon + un client de test**. Le frontend actuel
(`src/index.js`) **n'est pas touché** ici ; il est réécrit dans la
[fiche 20260917211902225](../../features/20260917211902225_frontend-mcp-mince.md) (child B). Pour
tester child A : on arrête les serveurs legacy, on lance le démon, on branche le client de test.
Le multi-clients réel (Desktop + N Code) arrive avec child B.

## Conséquences

**Plus sûr / plus robuste**
- Une seule connexion WhatsApp par nature ; plus de guerre de sessions (440).
- La capture survit sans client — l'archive ne dépend plus d'une fenêtre ouverte.
- Le périmètre d'une session est vérifié **côté démon**, hors de portée d'un frontend mince.

**Rupture assumée**
- Un nouveau process de fond apparaît (le démon). Son cycle de vie (spawn, supervision, arrêt)
  devient une pièce à part entière — d'où cet ADR.
- Le secret de socket est un garde-fou **coopératif** : il ne protège pas une machine déjà
  compromise (comme le jeton de session, [ADR-0004](0004-droits-par-session.md)).

**Inchangé**
- Le domaine `whatsapp.js` (Baileys, ingestion, plafond) garde sa logique ; il **déménage** dans
  le démon, il ne change pas de règles.
- `grant_channel` / `session_open` gardent leur sémantique et leur geste humain.
- Aucun outil d'envoi : le serveur reste en lecture seule ([ADR-0001](0001-modele-d-acces-aux-canaux.md)).

**À revisiter**
- Scope **par client** (« ce Desktop lit #famille, ce Code non ») : exigerait un secret **par
  client** vérifié côté démon — strictement plus que le secret global d'aujourd'hui. Différé tant
  qu'un client à la fois par périmètre suffit.
- Admin de monitoring (lecture seule) : [fiche 20260917211902355](../../features/20260917211902355_admin-monitoring-lecture-seule.md), après child A/B.
- Superviseur d'OS (launchd) pour relancer le démon au boot : hors périmètre du POC.

## Actions

1. [ ] Démon : process qui prend le verrou `auth/`, ouvre Baileys, capte, sert la socket Unix.
2. [ ] Contrat NDJSON : `status` / `list_groups` / `recent` / `session_open` / `session_close`,
       périmètre (session ∩ grant ∩ plafond) appliqué côté démon.
3. [ ] `ensure_daemon_running()` : ping → spawn détaché → polling borné → log append.
4. [ ] Secret partagé local (`0600`) : handshake sur la socket ; refus journalisé sans secret.
5. [ ] Registre de sessions migré dans le démon (même format `sessions/<id>.json`, même logique).
6. [ ] Client de test (pas le frontend) : lit `status` via NDJSON, sans toucher WhatsApp.
7. [ ] Tests hermétiques : contrat socket, singleton (jamais 2 démons), refus sans secret,
       capture sans client. Ajoutés à `npm test`.
8. [ ] `.gitignore` : `daemon.sock`, le secret, le log du démon.
