# Backlog features & bugs — whatsapp-mcp

> Index auto-généré (`regen-backlog.sh` mega-city, via `/ezk-backlog regen`) — **ne pas éditer à la main**. Source de vérité = le front-matter de chaque fiche.
> Guide du dossier : [README.md](README.md). Statuts : 💡 idea · 🔵 ready · 🟠 in-progress · ⛔ blocked · ✅ shipped · 🗑️ superseded.

> 📋 Séquence décidée (curée, hors index) : [PLAN.md](PLAN.md).

| # | Titre | Type | Prio | Épic | Statut | PR |
|---|-------|------|------|------|--------|----|
| [0001](0001-valider-adr-0002-conditions-reelles.md) | Valider le consentement humain sur Desktop/Cowork (Touch ID, élicitation, session) | chore | P0 | 20260902223310355 | 🔵 ready |  |
| [0002](0002-article-mes-messages-mes-agents-et-moi.md) | Article : « La question que le LLM ne peut pas trafiquer » (le MCP comme leçon de sécurité vécue) | feature | P1 |  | ⛔ blocked |  |
| [20260902223310499](done/20260902223310499_droits-par-session-jeton-porte.md) | Droits par session — jeton porté dans chaque appel, ouvert par Touch ID, périmètre ⊆ grants, TTL et révocation | feature | P1 | 20260902223310355 | ✅ shipped | #25 |
| [20260911212530209](20260911212530209_deploiement-local-versionne.md) | Déploiement local versionné (blue-green) — stable figée, dev testable en parallèle, update & rollback | feature | P1 |  | 🔵 ready |  |
| [0003](done/0003-hygiene-locale-permissions-filevault.md) | Hygiène locale — permissions fichiers, FileVault, pas de dossier synchronisé | chore | P2 |  | ✅ shipped | #28 |
| [0004](done/0004-profils-par-projet.md) | Profils par projet (.mcp.json → profil nommé, effectif = plafond ∩ profil) | feature | P2 | 20260902223310355 | ✅ shipped | #34 |
| [0008](done/0008-repli-sans-elicitation-fail-open.md) | Documenter le repli sans élicitation (fail-open refermé par défaut par l'ADR-0003) | chore | P2 |  | ✅ shipped | #31 |
| [0009](done/0009-verrou-exclusif-auth.md) | Verrou OS exclusif sur auth/ — garde-fou anti-collision entre process | feature | P2 |  | ✅ shipped | #27 |
| [0010](done/0010-installer-doctor-cli.md) | Installer / doctor en CLI — brancher le MCP sans se tromper (check node, chemin absolu) | feature | P2 |  | ✅ shipped | #8 |
| [0012](done/0012-adr-serveur-ne-configure-pas-le-client.md) | ADR — le serveur MCP reste read-only et ne configure jamais le client | chore | P2 |  | ✅ shipped | #26 |
| [0013](done/0013-garde-touchid-presence-grant.md) | Garde Touch ID (presence check) sur grant_channel — v1, portée de google-mcp | feature | P2 |  | ✅ shipped | e096a7a (poussé sur main, sans PR) |
| [20260903085814506](done/20260903085814506_exposer-id-message-pour-ingestion.md) | Exposer l'id de message (et le JID canal) dans get_recent_messages pour une ingestion idempotente | feature | P2 |  | ✅ shipped | #24 |
| [0011](done/0011-outil-aide-mcp.md) | Aide déclenchée — outil (et prompt) « comment j'utilise ce MCP ? » | feature | P3 |  | ✅ shipped | #9 |

## 🧭 Épics (jamais tirables — tirer leurs enfants ready, ADR-0017)

| # | Titre | Type | Prio | Épic | Statut | PR |
|---|-------|------|------|------|--------|----|
| [20260902223310355](20260902223310355_acces-whatsapp-par-session.md) | Accès WhatsApp par session — Cowork, Desktop et Code, chacun son périmètre (plafond ∩ profil ∩ session) | epic | P1 |  | 🟠 in-progress |  |
| [0005](0005-demon-frontends-mcp.md) | Démon unique + frontends MCP minces (phase 2 — multi-clients simultanés) | epic | P2 |  | 💡 idea |  |
| [0006](0006-app-mobile-tokens.md) | Accès réseau pour l'app mobile — tokens à capabilities, TLS/Tailscale (phase 3) | epic | P3 |  | 💡 idea |  |

## 💡 Idées (non groomées)

| # | Titre | Type | Prio | Épic | Statut | PR |
|---|-------|------|------|------|--------|----|
| [0007](0007-elicitation-signee-touch-id.md) | Élicitation signée — consentement par authentification physique (Touch ID / Secure Enclave) | feature | P3 |  | 💡 idea |  |
| [20260902223310640](20260902223310640_emballage-plugin-cowork-marketplace.md) | Emballage plugin Claude (marketplace elzinko) — skills + .mcp.json pour Cowork et Code | feature | P3 | 20260902223310355 | 💡 idea |  |

> Livrées (`done/`) : [0003](done/0003-hygiene-locale-permissions-filevault.md), [0004](done/0004-profils-par-projet.md), [0008](done/0008-repli-sans-elicitation-fail-open.md), [0009](done/0009-verrou-exclusif-auth.md), [0010](done/0010-installer-doctor-cli.md), [0011](done/0011-outil-aide-mcp.md), [0012](done/0012-adr-serveur-ne-configure-pas-le-client.md), [0013](done/0013-garde-touchid-presence-grant.md), [20260902223310499](done/20260902223310499_droits-par-session-jeton-porte.md), [20260903085814506](done/20260903085814506_exposer-id-message-pour-ingestion.md).
