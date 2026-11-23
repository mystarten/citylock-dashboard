# Tableau de bord CityLock

Outil interne pour rédiger des articles de blog SEO (brouillons WordPress) et suivre un score SEO hebdomadaire de citylock.fr. Node.js + Express, sans base de données, sans framework front.

## Installation locale

Prérequis : Node.js 20.6 ou plus.

```bash
npm install
cp .env.example .env
```

Remplissez `.env` (voir plus bas), puis :

```bash
npm run dev
```

Ouvrez http://localhost:3000. Pour tester sans aucun appel externe (ni OpenRouter, ni WordPress), mettez `SIMULATE=true` dans `.env` : un bandeau « Mode simulation » s'affiche. L'audit SEO, lui, interroge toujours le vrai site.

Tests automatiques :

```bash
npm test
```

## Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DASHBOARD_USER` | oui | Identifiant de connexion (choisi par vous) |
| `DASHBOARD_PASSWORD` | oui | Mot de passe de connexion |
| `SESSION_SECRET` | oui | Signe le cookie de session (32 caractères aléatoires : `openssl rand -hex 32`) |
| `OPENROUTER_API_KEY` | non | Clé OpenRouter de secours. Elle se saisit plutôt dans Réglages, Rédaction |
| `OPENROUTER_MODEL` | non | Modèle par défaut. Il se change ensuite dans Réglages, Rédaction automatique, sans redéployer |
| `WP_BASE_URL` | oui | `https://citylock.fr`. Fixée sur le serveur : volontairement non modifiable depuis l'interface (voir Sécurité) |
| `WP_USER`, `WP_APP_PASSWORD` | non | Identifiant et mot de passe d'application de secours. Ils se saisissent plutôt dans Réglages, Connexions |
| `PAGESPEED_API_KEY` | non | De secours. Sans clé, le critère vitesse est « non mesuré » |
| `SUPPORT_CONTACT` | non | Contact affiché dans l'aide |
| `SIMULATE` | non | `true` : mode démonstration au démarrage. Se change ensuite dans Réglages, Connexions |
| `PORT`, `DATA_DIR` | non | Port (3000) et dossier de données (`./data`) |

Identifiant et mot de passe de connexion ne sont jamais dans le code : ils se saisissent dans l'hébergeur (onglet Environment), ou dans `.env` en local. Aucune clé n'est envoyée au navigateur. Les journaux masquent les valeurs secrètes. `.env` et `data/` sont exclus de git.

## Déploiement sur Render

1. Poussez le dépôt sur GitHub (sans `.env`).
2. Render : New > Web Service, build `npm install`, start `npm start`.
3. Onglet Environment : saisissez les variables demandées (Render les réclame à la création, grâce à `render.yaml`).
4. **Disque persistant** : `render.yaml` en crée un (1 Go, `/var/data`). Sans lui, les réglages, l'historique et les articles sont effacés à chaque redéploiement. Les disques sont payants sur Render, et le plan `starter` aussi.
5. **Hébergement gratuit** : le service s'endort sans trafic, donc l'audit du lundi 8 h ne se lance pas. Utilisez une offre qui reste active, ou relancez l'audit avec le bouton.

Railway : même principe (variables dans l'onglet Variables, volume monté et `DATA_DIR` pointant dessus).

Le service doit tourner en une seule instance (les données sont dans des fichiers locaux).

## Créer le mot de passe d'application WordPress

À faire par un administrateur du site, sans jamais communiquer le mot de passe du compte :

1. Se connecter à WordPress, puis Utilisateurs > Profil (ou modifier l'utilisateur dédié).
2. Conseillé : créer un utilisateur dédié « Tableau de bord » avec le rôle Éditeur (peut créer et publier des articles, pas administrer le site).
3. Descendre à la section « Mots de passe d'application ».
4. Nom : `Tableau de bord CityLock`, cliquer « Ajouter un mot de passe d'application ».
5. Copier le mot de passe affiché (il n'est montré qu'une fois) dans `WP_APP_PASSWORD`, et l'identifiant dans `WP_USER`.

Si la section est absente : le site doit être en HTTPS, et une extension de sécurité peut désactiver l'API REST ou ces mots de passe.

## Clés et liaison WordPress, depuis les Réglages

Tout se gère dans **Réglages**, sans redéployer :

- **Connexions** : carte « Mise en route » (4 points à valider), mode démonstration, liaison WordPress (identifiant + mot de passe d'application, bouton « Enregistrer et tester »), clé PageSpeed.
- **Rédaction** : clé OpenRouter, modèle, consignes.

**Mettre en place WordPress (une fois) :**
1. Un administrateur crée le mot de passe d'application (section suivante).
2. Réglages > Connexions > Liaison avec WordPress : coller l'identifiant et le mot de passe, puis « Enregistrer et tester ». Le message doit dire « Connexion réussie ... Créer des brouillons : oui ». Les erreurs sont expliquées (identifiant incorrect, site injoignable, API bloquée, droits insuffisants).
3. Réglages > Rédaction : coller la clé OpenRouter, choisir le modèle, « Enregistrer et tester ».
4. Réglages > Connexions : désactiver le mode démonstration (une confirmation est demandée).
5. Réglages > Général : l'envoi automatique en brouillon est activé par défaut. Chaque article rédigé arrive dans WordPress au statut brouillon, catégorie « Blog » (créée si besoin).

**La publication reste manuelle, volontairement** : un texte rédigé par IA peut contenir des chiffres non vérifiés. Le bouton « Publier » exige la case « J'ai relu et validé », et le serveur refuse de publier tant que le marqueur `[SOURCE A VERIFIER]` reste dans le texte sur WordPress.

**Comment les clés saisies dans l'interface sont protégées :**
- Chiffrées sur le serveur (AES-256-GCM, clé dérivée de `SESSION_SECRET`), jamais renvoyées au navigateur : on peut les remplacer ou les effacer, jamais les relire (seuls les 4 derniers caractères de la clé OpenRouter sont rappelés).
- Masquées dans les journaux.
- Une valeur saisie dans l'interface prend le pas sur la variable d'environnement ; en l'effaçant, on revient à la variable.
- Si `SESSION_SECRET` change, les clés saisies dans l'interface deviennent illisibles : il faut les ressaisir.
- L'adresse du site WordPress (`WP_BASE_URL`) reste fixée côté serveur et doit être en HTTPS. Sinon, quelqu'un qui se connecte au tableau de bord pourrait la rediriger vers un site à lui et récupérer le mot de passe WordPress.
- **Limite importante** : toute personne qui se connecte au tableau de bord peut remplacer ces clés. Le mot de passe de connexion doit donc être long, et ne se partage qu'avec les personnes de confiance.
- **Hébergement gratuit sans disque** : les clés et réglages saisis dans l'interface sont effacés à chaque redémarrage. Gardez aussi les clés dans les variables de l'hébergeur (elles servent de secours) ou prenez un disque persistant.

## Essayer un article et vérifier les sujets

- **Articles > « Ce qui sera rédigé »** : liste les sujets du prochain lot, dans l'ordre, limités à la fréquence réglée. Un sujet déjà utilisé ce mois-ci n'est pas repris avant le mois suivant.
- **Articles > « Essayer un article »** : rédige un article d'essai pour un sujet de la liste ou un sujet libre. Rien n'est envoyé à WordPress et le lot du mois n'est pas touché, sauf si on clique sur « Garder dans mes articles ». L'écran montre aussi **exactement ce qui est envoyé à l'IA** (modèle, sujet, ville, consignes). Limites : 1 essai toutes les 3 secondes, 10 par jour (un essai coûte un appel payant à l'IA).

## Mode démonstration et mode réel

- Un interrupteur dans Réglages > Connexions (une confirmation est demandée pour passer en réel). Le bandeau « Mode démonstration » disparaît dès que le mode est désactivé.
- En mode réel : les articles sont rédigés par l'IA, envoyés en brouillon dans WordPress, et **peuvent être vraiment publiés** (case « J'ai relu et validé » obligatoire, et refus tant que `[SOURCE A VERIFIER]` reste dans le texte sur WordPress).
- Chaque article porte la marque du mode dans lequel il a été créé. Un article de démonstration n'existe pas sur le site : il ne peut pas être publié en mode réel, il ne compte pas dans le quota du lot réel, et un bouton permet de tous les supprimer sans toucher à WordPress. Inversement, un vrai brouillon ne peut ni être « publié » ni supprimé tant que le mode démonstration est actif.

## Modèle et consignes modifiables depuis l'interface

Dans Réglages, onglet « Rédaction » :
- **Modèle OpenRouter** : identifiant à copier depuis openrouter.ai/models. Vide = celui de la variable `OPENROUTER_MODEL`.
- **Consignes de rédaction** : le prompt système, modifiable (6000 caractères maximum). « Rétablir le texte d'origine » le remet comme au départ.
- **Tester le modèle** : un appel de quelques mots pour vérifier la clé et l'identifiant avant de lancer un lot.
- Le **format de réponse JSON** est toujours ajouté par le code et n'est pas modifiable : le serveur en a besoin pour lire l'article. Si vous supprimez les règles « pas de chiffres inventés » ou « pas de promesse de classement », elles ne sont plus imposées au modèle (le serveur signale seulement les prix et pourcentages dans les remarques de relecture).
- Sur l'hébergement gratuit sans disque, ces réglages sont effacés à un redémarrage et on revient au texte d'origine et au modèle de `OPENROUTER_MODEL`.

## Choix faits (points ambigus)

- **Génération puis envoi** : si l'envoi automatique est activé (par défaut), chaque article rédigé est envoyé à WordPress en brouillon. Sinon, il reste « À relire » jusqu'au clic sur « Envoyer en brouillon ». Dans tous les cas, la publication exige la case « J'ai relu et validé ».
- **Lot** : au plus `fréquence − articles déjà rédigés ce mois-ci` articles, un par sujet pas encore traité ce mois-ci. Un deuxième clic ne relance donc pas d'appels inutiles.
- **Fichier supplémentaire** : `data/articles.json` (articles en relecture), en plus de `settings.json` et `audits.json`.
- **Meta titre et meta description** : affichés dans l'écran de relecture, non envoyés à WordPress (le champ dépend de l'extension SEO). La meta description est mise dans l'extrait de l'article. À copier à la main dans Yoast / Rank Math.
- **Contenu de l'article** : `htmlContent` ne contient pas le H1, c'est le titre de l'article WordPress. Le HTML est filtré (h2, h3, p, listes, a, strong, em). Les avertissements (longueur, tirets cadratins, marqueur de source) sont signalés, pas corrigés automatiquement.
- **Clé « faitsA verifier »** : le JSON demandé au modèle utilise `faitsAVerifier` (les variantes avec espace ou underscore sont acceptées).
- **Liens internes** : le modèle ne peut choisir que parmi les URL du dernier audit (jusqu'à 40), pour ne pas inventer de pages.
- **Suppression** : supprime aussi le brouillon dans WordPress (définitivement), mais refuse si l'article n'y est plus au statut brouillon.

## Score SEO : règles de calcul

Total de 100 points, 11 critères exactement comme demandé. Précisions :

- Critères par page (titre, meta, H1, contenu mince, orphelines) : points proportionnels au nombre de pages conformes. Images : proportion d'images avec alt non vide.
- LocalBusiness : présent sur l'accueil (`LocalBusiness` ou un sous-type courant : Locksmith, HomeAndConstructionBusiness, ProfessionalService, Store). Binaire.
- Liens cassés : liens internes trouvés dans les pages et pages du sitemap, réponse finale différente de 200 (redirections suivies). Maximum 300 liens vérifiés, 150 pages explorées (indiqué si la limite est atteinte).
- Orpheline : page du sitemap (hors accueil) sans lien depuis une autre page explorée. Le menu compte comme un lien.
- Contenu mince : mots du `main`/`article`, sinon du `body` sans menu, en-tête, pied de page.
- Hors sujet : seuls les motifs évidents sont détectés (adresse contenant demo, test, sample, exemple, lorem, hello, bonjour, brouillon, draft ; titres « Hello world », « Bonjour tout le monde », « Page d'exemple »). Binaire. Le « hors sujet » éditorial n'est pas mesurable.
- Vitesse : accueil, mobile. Si non mesurée (pas de clé, ou PageSpeed en erreur), le critère est exclu et le score est ramené sur les points comptés (par exemple 71,2 sur 90 donne 79/100). Deux audits ne sont donc comparables que si les mêmes critères sont mesurés.
- Améliorations : critères classés par points perdus, les 5 plus gros en premier.

Audit automatique : lundi 8 h (Europe/Paris) via node-cron, tant que le serveur tourne. Historique conservé : 104 audits.

### Sur quoi repose le score, et ce qu'il ne mesure pas

Le robot lit les vraies pages publiques du site (celles du plan du site, 150 au maximum) et applique 11 vérifications chiffrées. Le résultat est reproductible : deux mesures d'un site inchangé donnent le même score. C'est un score d'**hygiène technique**, pas une note Google : il ne mesure ni le classement, ni le trafic, ni la qualité des textes, ni les liens venant d'autres sites, ni la fiche Google Business Profile.

**Critère « entreprise locale » (10 points)** : il lit le **code de la page d'accueil du site** et cherche une déclaration LocalBusiness (données structurées JSON-LD). Il est indépendant de la fiche Google Business Profile : une fiche parfaite peut cohabiter avec 0/10 ici. Le constat liste les types réellement trouvés sur l'accueil (par exemple « Organization, WebSite »). Une extension SEO qui ne déclare que « Organization » ne suffit pas.

### Suivre la progression dans le temps

- L'écran Score affiche la variation depuis la mesure précédente (« +7 points depuis le 10 novembre »), la variation par critère, la courbe et le tableau.
- La comparaison n'est fiable qu'à conditions égales. Si les critères mesurés changent (par exemple ajout de la clé PageSpeed), un avertissement s'affiche. Ajouter ou supprimer des pages peut aussi faire bouger le score sans vraie amélioration.
- **Sans disque persistant, l'historique est effacé à chaque redémarrage** (hébergement gratuit) : il n'y a alors pas de suivi sur plusieurs mois. Deux parades : un disque persistant (payant), ou télécharger régulièrement l'historique en CSV (bouton sous la courbe).


## Sécurité

Cookie de session signé, HttpOnly, SameSite Strict ; 5 échecs de connexion par IP bloquent 15 minutes (compteur en mémoire) ; en-tête obligatoire sur les requêtes modifiantes ; CSP stricte ; entrées validées côté serveur ; OpenRouter appelé uniquement par le bouton (timeout 90 s, pas de nouvelle tentative).

## Ce qui a été vérifié, et ce qui ne l'a pas été

Vérifié (`npm test` et essais manuels) :
- Calcul du score sur un jeu de données dont les résultats ont été calculés à la main.
- Audit complet (sitemap, crawl, liens cassés, orphelines, robots.txt) contre un **faux site local**.
- Client WordPress contre un **faux serveur WordPress local** (authentification Basic, catégorie Blog sans doublon, brouillon, publication, refus de supprimer un article publié).
- API : connexion, validation, plafond du lot, parcours simulé génération, brouillon, publication, suppression.
- Interface dans Chromium (bureau et téléphone) : connexion, mauvais mot de passe, réglages, lot simulé avec envoi automatique en brouillon, relecture, bouton Publier verrouillé tant que la case n'est pas cochée, écran Score, aucun défilement horizontal ni erreur JavaScript.

**Non vérifié** (aucun accès à ces services depuis l'environnement de développement) :
- Appels réels à OpenRouter : format de réponse JSON, respect des règles de rédaction par le modèle choisi, longueur 600 à 900 mots. Relisez les premiers articles avec soin.
- API réelle de citylock.fr : structure réelle du sitemap, comportement du thème, éventuels blocages (pare-feu, extension de sécurité) sur l'API REST ou sur l'audit.
- Appel réel à PageSpeed Insights.
- Déploiement sur Render ou Railway.
- Aucun score réel de citylock.fr n'a été calculé.
