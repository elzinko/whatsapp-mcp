---
id: "20261001125109014"
title: "Spike — archive WhatsApp locale (base + MCP + recherche), façon msgvault"
type: chore
priority: P2
version:
epic:
evidence: none # exploration de faisabilité, aucun écran
status: idea
ready:
pr:
created: 2026-10-01
---

## En clair

On veut savoir s'il est faisable de se constituer une **archive WhatsApp locale** — une base
qu'on alimente au fil de l'eau et qu'on interroge (mots-clés, et peut-être par le sens).
C'est le pendant, côté WhatsApp, d'une réflexion menée côté Gmail avec msgvault. Contrairement
à Gmail, il n'existe pas de produit clé-en-main aussi fini ; le plus proche est un **serveur
MCP WhatsApp** (pont → base SQLite locale → recherche), exactement ce que fait ce repo.
Ce spike tranche : repartir d'une base existante (`lharries/whatsapp-mcp`), ou faire le nôtre.

Cadrage d'origine : repo `google-mcp-multi-account`, `docs/recentrage-outils-existants.md`.
Pendant Gmail (msgvault) : fiche `20260930214101550` du même repo.

## Contexte / Problème

WhatsApp n'a **pas d'API officielle de lecture**. Deux voies pour récupérer ses messages,
avec un vrai écart sur l'incrémental :

- **Export natif** (« Exporter la discussion ») : **non incrémental**. C'est un dump
  **complet, par discussion, manuel**, et **plafonné** (média limités). Inadapté à une
  archive tenue à jour automatiquement — hypothèse à **confirmer** dans le spike.
- **Pont live** (client non officiel type whatsmeow/Baileys, appareil lié) : **incrémental
  par nature**. Une fois lié, les nouveaux messages arrivent en continu et s'ajoutent à la
  base locale. Le **backfill de l'historique** à la première connexion est **limité** à une
  fenêtre récente — à confirmer.

Donc l'incrémental passe par le pont live, pas par l'export. Reste à valider le coût et les
limites avant d'investir.

## Proposition

Spike **borné (~30–45 min)**, sans engager d'archi définitive :
1. Évaluer `lharries/whatsapp-mcp` comme **base** : pont whatsmeow → SQLite local → MCP.
2. Confirmer les deux hypothèses d'acquisition (export non incrémental ; pont live incrémental
   avec backfill limité).
3. Juger la **recherche** : FTS5 (mots-clés) suffit-il, ou veut-on **en plus** une base
   vectorielle pour la recherche par le sens ? Si vectoriel : **embeddings locaux**
   obligatoires (ne pas envoyer les messages à une API cloud — on resterait souverain).
4. Trancher : **go/no-go** « repartir de `lharries/whatsapp-mcp` » vs « from scratch » vs
   « voie export seulement ».

Hors périmètre : l'implémentation finale, le multi-comptes complet, l'intégration consentement.

## Critères d'acceptation

- [ ] `lharries/whatsapp-mcp` installé/essayé, ou à défaut analysé (archi : pont → SQLite → MCP).
- [ ] **Hypothèse export** confirmée ou infirmée : incrémental ? plafond ? manuel par chat ?
- [ ] **Hypothèse pont live** confirmée : capture incrémentale OK, et **étendue réelle du
      backfill** d'historique notée.
- [ ] Décision **recherche** : FTS5 seul, ou FTS5 + **base vectorielle à embeddings locaux**
      (avec le surcoût assumé).
- [ ] Décision écrite **go/no-go** datée (base existante vs from scratch vs export), + limites
      notées : risque de **bannissement** (client non officiel → numéro dédié), **média**,
      **multi-comptes = un pont par numéro**.

## Comment vérifier

Relire la décision datée (ici ou dans la note de recentrage du repo google-mcp-multi-account).
Réussi si quelqu'un peut lire le go/no-go **et sa justification** sans rejouer le test. Pas de
test automatique : exploration.

## Notes

- Même famille de risques qu'une coquille type NanoClaw : un pont non officiel expose au ban
  et détient une session « compte entier » en local. Parade : **numéro dédié**.
- Différence clé avec Gmail : pour Gmail, msgvault permet de **déléguer** la lecture ; pour
  WhatsApp, pas d'équivalent fini → construire (ou forker) est légitime, et c'est la raison
  d'être de ce repo.
