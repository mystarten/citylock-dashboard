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
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | pour rédiger | Clé et identifiant du modèle (à choisir sur openrouter.ai) |
| `WP_BASE_URL` | oui | `https://citylock.fr` |
| `WP_USER`, `WP_APP_PASSWORD` | pour WordPress | Identifiant et mot de passe d'application |
| `PAGESPEED_API_KEY` | non | Sans elle, le critère vitesse est « non mesuré » |
| `SUPPORT_CONTACT` | non | Contact affiché dans l'aide |
| `SIMULATE` | non | `true` : simule OpenRouter et WordPress |
| `PORT`, `DATA_DIR` | non | Port (3000) et dossier de données (`./data`) |

Identifiant et mot de passe ne sont jamais dans le code : ils se saisissent dans l'hébergeur (onglet Environment), ou dans `.env` en local. Aucune clé n'est envoyée au navigateur. Les journaux masquent les valeurs secrètes. `.env` et `data/` sont exclus de git.

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

## Relier l'outil à WordPress (envoi automatique en brouillon)

1. Un administrateur crée le mot de passe d'application (section précédente).
2. Dans Render, service > Environment, renseigner `WP_USER` et `WP_APP_PASSWORD`, et passer `SIMULATE` à `false` (ou supprimer la variable).
3. Renseigner aussi `OPENROUTER_API_KEY` et `OPENROUTER_MODEL`. Enregistrer : Render redéploie.
4. Dans l'outil, Réglages > Connexions > « Tester la connexion ». Le message doit indiquer « Connecté en tant que ... » et « Création de brouillons : oui ».
5. Réglages > Publication : l'envoi automatique en brouillon est activé par défaut. Chaque article rédigé arrive alors dans WordPress au statut brouillon, dans la catégorie « Blog » (créée si besoin).

**La publication reste manuelle, volontairement** : un texte rédigé par IA peut contenir des chiffres non vérifiés. Le bouton « Publier » exige la case « J'ai relu et validé ». De plus, le serveur relit le texte réellement présent dans WordPress et refuse de publier s'il contient encore le marqueur `[SOURCE A VERIFIER]`.

Pannes fréquentes : l'API REST désactivée par une extension de sécurité, un pare-feu qui bloque l'hébergeur, un site sans HTTPS, ou un utilisateur WordPress sans le droit de créer des articles (prendre le rôle Éditeur).

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
