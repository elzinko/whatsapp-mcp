---
id: "20260920190548166"
title: Durcir la session par un bail de lecture (TTL court + budget), repris de google
type: feature
priority: P3
version:
epic:
status: idea
ready:
pr:
created: 2026-09-20
---

**En clair.** Aujourd'hui une session WhatsApp dure **8 h fixe** (un TTL). Si une injection
détourne une conversation, elle a 8 h pour lire tout le périmètre ouvert. google-mcp-multi-account
a remplacé cette fenêtre par un **bail de lecture court qui se referme tout seul** — au premier
atteint entre un **temps court** et un **budget de lectures**. Cette fiche propose de reprendre
ce durcissement ici. Idée capturée le 2026-09-20, non groomée.

## Contexte / Problème

Le TTL fixe de 8 h ([ADR-0004](../docs/adr/0004-droits-par-session.md)) est une **fenêtre
d'abus** : une injection qui ouvre ou réutilise une session lit librement, jusqu'à 8 h, tout ce
que le périmètre autorise. Le temps seul ne borne pas le **volume** — une rafale épuise 8 h sans
rien épuiser d'autre.

whatsapp-mcp est **en lecture seule** : la moitié « écriture » du design google (un Touch ID par
acte) est sans objet ici. Mais la moitié « lecture » lui va exactement.

## Proposition

Ajouter au registre de sessions un **bail de lecture** : un TTL court **et** un budget de
lectures, le **premier atteint referme**. Le retrait est calculé **côté démon à chaque appel**,
jamais par un geste du LLM (un LLM détourné ne peut rien prolonger).

- **À reprendre de google** (ADR-0011, PR #149) : le bail lecture (TTL + budget), et le principe
  « le retrait ne dépend jamais du LLM ». Défaut naturel pour un outil lecture seule = **bail
  court** (mode `fenetre`), pas « un Touch ID par lecture » (google a choisi ce dernier parce
  qu'il porte des mutations).
- **À NE PAS reprendre** : tout le volet mutation, le grain fin service × opération × ressource,
  le manifeste projet. whatsapp a **une seule ressource** (le canal) et pas de multi-comptes.
- **Rapport au démon** (fiche [0005](0005-demon-frontends-mcp.md)) : le registre de sessions vit
  désormais dans le démon ; le bail s'y calcule.

## Critères d'acceptation

- [ ] Une session lit dans une **fenêtre courte** ET un **budget borné** ; le premier atteint la referme.
- [ ] Le bail se referme **seul** (temps ou budget), sans aucune action du LLM.
- [ ] Défaut aligné sur un outil lecture seule (bail court), pas « un geste par lecture ».
- [ ] Rétrocompat : le TTL reste une borne ; le budget s'**ajoute** (pas de régression du flux actuel).
- [ ] Documenté comme **durcissement anti-injection** (le pourquoi, pas seulement le comment).

## Comment vérifier

- `npm test` — bail : expiration par le temps, et refus par épuisement du budget (deux cas).
- Manuel : ouvrir une session, dépasser le budget de lectures → refus ; ré-ouvrir en repart.

## Notes

- Dépendance externe : `google-mcp-multi-account` — **accès constaté le 2026-09-20** (analyse de
  session) : `docs/adr/ADR-0011-consentement-transactionnel-par-session.md`,
  `docs/adr/ADR-0012-*`, `gateway/sessions.py` (`ReadLease`, `open_read_lease`,
  `try_consume_read_lease`), PR #149.
- Hérite du modèle « droits par session » ([ADR-0004](../docs/adr/0004-droits-par-session.md)) et
  s'inscrit sous l'épic accès par session
  [20260902223310355](20260902223310355_acces-whatsapp-par-session.md) — rattachement à trancher au grooming.
- Réversible et bon marché : c'est une borne de plus sur un mécanisme existant, pas une refonte.
