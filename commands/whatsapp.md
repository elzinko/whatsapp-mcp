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
- `pair` → appelle `whatsapp_pair` pour l'appairage initial, ou la récupération
  quand rien n'est appairé. Si un appareil est déjà appairé, l'outil répond
  « déjà appairé, rien à faire » : il NE ré-appaire PAS. Si l'outil renvoie un QR
  ou un code, guide l'humain pas à pas.
- `groups` → appelle `list_groups`. Liste les groupes visibles, chacun avec son
  identifiant de canal, pour pouvoir en autoriser un ensuite.
- `recent <canal>` → lecture des messages récents d'un canal. Le canal est TOUT
  ce qui suit `recent` (un nom de groupe peut contenir des espaces, ex. « Famille
  Couderc ») — pas seulement le 2ᵉ mot.
  `get_recent_messages` EXIGE un jeton de session : ne l'appelle JAMAIS seul.
  Enchaîne :
  1. `session_open` sur le canal donné. Le canal doit déjà être autorisé
     (`grant_channel`) ; sinon l'outil refuse — dis alors à l'humain de lancer
     `/whatsapp grant <canal>` d'abord.
  2. `get_recent_messages` avec le jeton rendu par `session_open` et le canal.
  3. `session_close` sur ce jeton une fois la lecture faite.
  Si aucun canal n'est fourni, demande-le d'abord, ne devine pas.
- `grant <canal>` → appelle `grant_channel` sur le canal donné. Ce geste demande
  un consentement dont le mode dépend de la config : Touch ID si l'auth forte est
  activée, sinon élicitation (formulaire du serveur), sinon permissions du client.
  `whatsapp_status` indique le mode réel (champ `grantConsent`). Laisse l'outil
  mener le consentement, ne le contourne jamais.
- `revoke <canal>` → appelle `revoke_channel` sur le canal donné.
- `help` → appelle `whatsapp_help` et restitue la liste des capacités.

Si le premier mot n'est aucun de ceux-là, montre cette liste de sous-commandes
et n'appelle AUCUN outil.

Après l'appel, réponds en clair : l'essentiel d'abord (≤ 3 phrases), le détail
ensuite. N'invente jamais un canal ni un identifiant — si l'info manque,
demande-la.
