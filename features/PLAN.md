# Plan — whatsapp-mcp

> Séquence **décidée** (curée, pas générée). **Décidé le 2026-09-11**, mis à jour le
> **2026-09-18** (découpage de l'épic 0005 en 3 enfants). Le gate `ready` prime pour
> *tirer maintenant* ; ce plan prime pour *décider la suite*.
> Index du backlog : [BACKLOG.md](BACKLOG.md).

**Fil directeur** : « ça doit marcher pour un **chat sur Claude Desktop** » — épic
[20260902223310355](20260902223310355_acces-whatsapp-par-session.md).

## NOW — la séquence décidée

1. [0001](0001-valider-adr-0002-conditions-reelles.md) — mesurer le consentement sur
   Desktop/Cowork, **Touch ID d'abord** (façon google-mcp-multi-account) · **audit** (zéro
   code, une mesure). Seule carte `ready`, répond direct à « un chat Desktop marche-t-il ? ».

Puis **la phase 2 — démon + frontends (jalon v0.3.0)**, enfants de l'épic
[0005](0005-demon-frontends-mcp.md), dans cet ordre :

2. [20260917211902097](20260917211902097_demon-tient-whatsapp.md) — le démon tient WhatsApp
   (socle : socket locale, contrat NDJSON, registre de sessions migré) · **build** après
   `ready`. Rien d'autre de la phase ne tient sans lui.
3. [20260917211902225](20260917211902225_frontend-mcp-mince.md) — le frontend MCP mince
   (parle au démon, Touch ID reste au frontend) · **build**. Dépend de (2).
4. [20260917211902355](20260917211902355_admin-monitoring-lecture-seule.md) — admin de
   monitoring, lecture seule · **build**, **optionnel, en dernier**. Dépend de (2).

> Les cartes 2-4 sont `idea` (groomées) : passer chacune par le gate `ready` avant de la
> tirer. L'épic 0005 clôt quand (2) et (3) sont livrées ; (4) peut suivre.

## Garées — maintenues, pas tirées

- [0002](0002-article-mes-messages-mes-agents-et-moi.md) — article : **non publié**, gardé
  dans `docs/articles/`, tenu à jour.
- [0007](0007-elicitation-signee-touch-id.md) — élicitation signée v2 : **porter la version
  de google quand un déclencheur apparaît** (`send` / démon réseau / client non fiable). Aucun
  aujourd'hui.
- [20260902223310640](20260902223310640_emballage-plugin-cowork-marketplace.md) — emballage
  plugin : différé ; préférer une commande `wire` (extension de `install:client`). Après la
  phase 2.
- [0006](0006-app-mobile-tokens.md) — app mobile / réseau : **garée très loin** (diverge du
  local-first de google).

## Épics — jamais tirés, on tire leurs enfants

- [20260902223310355](20260902223310355_acces-whatsapp-par-session.md) — accès par session
  (**in-progress**) : le fil. Enfants : 0001, 0004 ✓, 0005 (prérequis frère), plugin.
- [0005](0005-demon-frontends-mcp.md) — démon + frontends (**v0.3.0**), découpé en 3 enfants
  (cartes 2-4 ci-dessus). [0006](0006-app-mobile-tokens.md) — épic frère (phase 3).
