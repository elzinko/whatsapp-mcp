---
description: Pilote le serveur whatsapp-mcp (lecture seule) — statut, appairage, groupes, messages récents, consentement de canal.
argument-hint: "status | pair | groups | recent <canal> | grant <canal> | revoke <canal> | help"
---

Tu pilotes le serveur MCP `whatsapp-mcp` : lecture seule, et seuls les canaux
explicitement autorisés par l'humain sont lisibles.

Sous-commande reçue : **$ARGUMENTS**

Route selon le PREMIER mot de la sous-commande :

- `status` (ou rien) → appelle l'outil `whatsapp_status`. Restitue en clair :
  version servie, état (connecté ou non), nombre de canaux autorisés. Signale si
  la version est « dev » — ça veut dire qu'il tourne depuis un checkout, pas
  depuis la version figée.
- `pair` → appelle `whatsapp_pair` pour (ré)appairer l'appareil. Si l'outil
  renvoie un QR ou un code, guide l'humain pas à pas.
- `groups` → appelle `list_groups`. Liste les groupes visibles, chacun avec son
  identifiant de canal, pour pouvoir en autoriser un ensuite.
- `recent <canal>` → appelle `get_recent_messages` sur le canal donné (2ᵉ mot).
  Si aucun canal n'est fourni, demande-le d'abord, ne devine pas.
- `grant <canal>` → appelle `grant_channel` sur le canal donné. Ce geste exige
  une présence physique (Touch ID) : laisse l'outil mener le consentement, ne le
  contourne jamais.
- `revoke <canal>` → appelle `revoke_channel` sur le canal donné.
- `help` → appelle `whatsapp_help` et restitue la liste des capacités.

Si le premier mot n'est aucun de ceux-là, montre cette liste de sous-commandes
et n'appelle AUCUN outil.

Après l'appel, réponds en clair : l'essentiel d'abord (≤ 3 phrases), le détail
ensuite. N'invente jamais un canal ni un identifiant — si l'info manque,
demande-la.
