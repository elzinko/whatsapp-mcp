---
id: 0002
title: "Article : « La question que le LLM ne peut pas trafiquer » (le MCP comme leçon de sécurité vécue)"
type: feature
priority: P3
version:
epic:
status: blocked
ready:
pr:
created: 2026-07-18
---

## Contexte / Problème

Le développement de ce MCP a produit une intrigue réelle et complète — chaque incident
vécu motive la décision d'architecture suivante. Thomas veut un article « qui donne envie
de lire telle une belle intrigue », avec de beaux diagrammes. La matière première est
dans le git log et les deux ADR ; il manque la rédaction.

## Proposition

Récit en 6 chapitres, chacun ancré dans un artefact vérifiable du repo :

1. *« Un seul groupe, en dur »* — l'innocence du premier design (import initial).
2. *« Do you want to proceed? »* — grants dynamiques, default-deny (ADR-0001).
3. *« code=440 »* — la guerre de sessions : un singleton disputé (commit `602b9be`).
4. *« ENOENT: creds.json »* — le zombie qui rase un appairage (commit `b69d1b7`).
5. *« Qui a le droit de lire mes messages ? »* — le renversement : l'attaquant est le
   mandataire (confused deputy) ; le plafond + l'élicitation (ADR-0002, `a39f6cf`).
6. *« Le jour où mon téléphone voudra lire mon téléphone »* — l'app mobile, la frontière
   réseau, le moment où les tokens cessent d'être du théâtre (phase 3, fiche 0006).

Diagrammes versionnés via `ezk-diagram` (architecture 3 étages, séquence d'élicitation,
la guerre de sessions). Dépend du résultat de la fiche 0001 (élicitation : pilier ou
note de bas de page).

## Critères d'acceptation

*(recadrés par le PO le 2026-07-19 : support libre, < 4 min, UN graphique, arc
problème → contexte → solution → implémentation — remplace les 6 chapitres / ≥3 diagrammes)*

- [x] Cadrage PO : < 4 min, un graphique, arc imposé, projet cité
- [x] Premier jet rédigé (~1070 mots), chaque affirmation adossée au vécu du repo
- [x] 1 diagramme Mermaid (séquence du grant : plafond + élicitation), syntaxe validée
- [x] Relecture « intrigue » par Thomas : **validé le 2026-07-19** (« il est top »), sans retouche
- [ ] Publication (support à choisir) → alors `shipped`

## Notes

- Texte final validé : `docs/articles/2026-07-19-la-question-que-le-llm-ne-peut-pas-trafiquer.md`.
- Verdict fiche 0001 intégré (élicitation = pilier, mesurée OUI dans Claude Code).
- Teaser final vers la fiche 0007 (élicitation signée / Touch ID) en guise d'ouverture.
- **Bloquée le 2026-07-19** : contenu terminé et validé, en attente du **choix du support**
  de publication (décision PO, pas de travail restant côté rédaction).
- **Décision 2026-09-11 : on ne publie pas maintenant.** L'article reste dans `docs/articles/`,
  **tenu à jour** au fil du produit (épilogue daté ajouté ce jour : droits par session, profils,
  épic « accès par session »). « Bloquée » = garée volontairement, pas un obstacle. Débloquer
  plus tard = choisir le support puis publier (probablement après le passage du repo en public).
- **Priorité P1 → P3 le 2026-09-25** (revue de validité) : le contenu est fini et garé, la P1
  surdimensionnait l'urgence d'une fiche qui attend une simple décision de publication. Reste
  `blocked` (garée volontairement) — pas un obstacle, une mise en attente.
- Deux points à trancher au moment de publier :
  1. le repo `whatsapp-mcp` est **privé** → le lien cité dans l'article tombe dans
     le vide tant qu'il ne passe pas public ;
  2. Markdown + Mermaid passe tel quel sur GitHub / dev.to / Hashnode ; pour Medium ou
     LinkedIn, exporter le diagramme en image (SVG/PNG).
