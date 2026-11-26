# Tableau de bord CityLock

Outil interne pour rédiger des articles de blog SEO (un article ou un planning de plusieurs mois, brouillons et publications programmées sur WordPress) et suivre un score SEO hebdomadaire de citylock.fr. Node.js + Express, sans base de données, sans framework front.

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
| `OPENROUTER_MODEL` | non | Modèle par défaut. Il se change ensuite dans Réglages, Rédaction, sans redéployer |
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

## Comment ça marche : deux façons de rédiger

Menu **Rédiger** :

1. **Un seul article** : vous choisissez un sujet (de la liste, ou un mot-clé tapé à la main) et une ville facultative. L'article arrive dans **Articles**, en attente. Vous en faites ce que vous voulez : le relire, le **modifier à la main**, l'envoyer en brouillon sur le site, le **programmer** à une date, le publier tout de suite, le supprimer.
2. **Plusieurs articles** : vous choisissez le **nombre d'articles** (1 à 20), la date du premier et l'écart entre deux articles (même jour, tous les jours, 3 jours, semaine, 15 jours, mois). L'outil affiche une ligne par article : une **date** (modifiable), le **mot-clé** et la ville. Les mots-clés de votre liste de sujets sont déjà remplis, vous écrivez les autres. Vous lancez : tous les articles sont rédigés en arrière-plan et rangés dans **Articles**. **Rien n'est envoyé sur le site à ce stade.** Dans **Articles**, le **calendrier de publication** liste chaque article avec un champ date (ouvre un calendrier) et un bouton **« Programmer à 10 h »**, ou **« Programmer les N articles datés »** pour tous d'un coup : WordPress publie chaque article tout seul à **10 h (heure de Paris)** le jour choisi, même si l'outil est fermé.

Si vous avez moins de sujets enregistrés que d'articles demandés, les lignes en trop restent vides : vous tapez le mot-clé vous-même (deux articles sur le même mot-clé se font concurrence sur Google).

### Programmer, annuler, publier

- **Programmer** : une date et une heure (10 h par défaut, heure de Paris, heure d'été et d'hiver gérées). La date doit être dans le futur (5 minutes minimum, 400 jours maximum).
- **Annuler la programmation** : l'article redevient un brouillon sur le site.
- **Publier maintenant** : demande de cocher « J'ai relu et validé ». Un article programmé garde sa date future dans WordPress : l'outil la ramène à maintenant avant de publier, sinon WordPress le reprogrammerait.
- Le tableau de bord vérifie (au plus toutes les 2 minutes quand vous consultez la liste, et toutes les heures) que WordPress a bien publié les articles programmés, et le note dans l'**historique des publications**.
- « Programmer tous les articles prêts » laisse de côté, **avec la raison**, tout article dont la longueur est hors plage, qui contient un mot interdit ou le marqueur `[SOURCE A VERIFIER]`, ou dont le texte a été modifié sur le site depuis l'envoi. Pour les « faits à vérifier » encore listés, une question vous est posée : les programmer quand même (vous avez vérifié) ou les laisser de côté.
- Un article de démonstration ne touche jamais WordPress ; un vrai article ne peut être ni publié, ni programmé, ni supprimé en mode démonstration.
- Garde-fous de coût : 1 rédaction toutes les 3 secondes, **40 articles par jour** au maximum (une liste de 18 articles compte pour 18).

## Les réglages : deux onglets

- **Rédaction** : le prompt, le contrôle de longueur, le modèle d'IA, les sujets, l'entreprise.
- **Connexions** : mise en route, mode démonstration, WordPress, **Yoast SEO**, clé OpenRouter, PageSpeed.

### Le prompt : un seul, dans les réglages

Le texte envoyé à l'IA est **uniquement** celui de **Réglages, Rédaction, Prompt de rédaction** (c'est le message « système »). Rien n'est caché dans le code : ni longueur, ni format, ni règle. Seul le message « utilisateur » est ajouté par l'outil : nom de l'entreprise, zone, mot-clé, ville, et la liste des pages du site (si un audit a été fait), puis « Rédige l'article. ».

- Le texte d'origine (écrit avec Laurent) est enregistré dans les réglages au premier lancement. Il contient la **longueur** (« Longueur : 700 à 900 mots »), les **critères SEO** (MOTCLE dans le titre, la première phrase, la moitié des intertitres, 6 à 10 fois dans le texte, un lien externe vers Ajax, deux liens internes, mots interdits) et le **format de réponse JSON** (`title`, `focusKeyphrase`, `seoTitle`, `metaDescription`, `slug`, `imageAlt`, `htmlContent`, `internalLinkSuggestions`, `faitsAVerifier`). Le message envoyé avec chaque demande contient « MOTCLE : le mot-clé du sujet » : c'est ce mot que le prompt appelle MOTCLE.
- **Rétablir le texte d'origine** remet ce texte.
- Le prompt ne peut pas être vide (80 caractères au minimum, 6000 au maximum). Si vous retirez le mot « JSON » ou les clés `title` / `htmlContent`, ou si aucune longueur n'est demandée, **un avertissement rouge s'affiche** sous le texte, et la rédaction refuse de partir sans « JSON » (OpenRouter renvoie sinon une erreur 400 avec certains modèles).
- **Il n'y a aucun nouvel essai automatique** si l'IA écrit trop court : l'article est signalé (alerte de longueur) et ne part pas sur le site sans votre confirmation. Vous le régénérez ou vous changez de modèle.
- **Contrôle de la longueur** (minimum et maximum, 700 et 900 par défaut) : ces deux nombres servent seulement à **vérifier** le résultat. Ils doivent rester cohérents avec ce que le prompt demande.
- Sur Render gratuit sans disque, les réglages peuvent être effacés à un redémarrage : gardez une copie de votre prompt. Au redémarrage, le texte d'origine est remis automatiquement.
- Si vous aviez une ancienne version personnalisée du prompt (sans le format JSON), elle est conservée : l'avertissement vous le dit. Cliquez alors sur « Rétablir le texte d'origine » ou ajoutez la partie format.

### Changer de modèle d'intelligence artificielle

Réglages, Rédaction, **Modèle** : collez l'identifiant copié depuis openrouter.ai/models (sans espace). **Modèle par défaut : `anthropic/claude-sonnet-5-5`**, utilisé tant que vous n'en avez pas choisi un autre ni défini `OPENROUTER_MODEL` (l'identifiant exact n'a pas pu être vérifié contre OpenRouter depuis l'environnement de développement : le bouton de test le confirme), puis **Tester et activer le modèle**. Le modèle n'est utilisé que si un petit test réussit ; sinon l'ancien est conservé et le message donne la raison (identifiant inconnu, clé refusée, crédit épuisé, délai dépassé). Chaque article garde le nom du modèle qui l'a rédigé.

### Modifier un article à la main

Ouvrir l'article, puis **Modifier** : titre, mot-clé principal, titre et description pour Google, adresse de la page, texte (HTML simple, aperçu en direct), faits à vérifier. **Insérer un lien** ajoute un lien à l'endroit du curseur. Chaque enregistrement garde la version d'avant (20 versions), avec **Revenir à la version précédente**. Si l'article est déjà sur le site (brouillon ou programmé), la version du site est mise à jour en même temps ; si le texte a été modifié directement dans WordPress depuis le dernier envoi, une confirmation est demandée avant de l'écraser.

### Les liens du texte

Le prompt demande des liens internes du type `/choisir-alarme-sans-abonnement/systeme-dalarme-avec-abonnement/`. Ce sont des adresses **de votre site** : dans WordPress, ils fonctionnent. Dans l'aperçu du tableau de bord, ils s'ouvraient auparavant sur le tableau de bord lui-même (« Cannot GET ... ») ; ils s'ouvrent maintenant sur `WP_BASE_URL` (citylock.fr), dans un nouvel onglet. Chaque article a une carte **« Liens dans le texte »** qui liste où chaque lien mène. Un lien écrit sans « / » initial (`choisir-alarme.../`) est complété automatiquement ; un lien étranger ou invalide est retiré.

### Yoast SEO : mot-clé, titre SEO, description

Avant, l'outil n'envoyait à Yoast **ni** mot-clé principal, **ni** titre SEO, **ni** méta description : Yoast était donc rouge partout. Désormais chaque envoi (brouillon, programmation, modification) transmet `_yoast_wpseo_focuskw` (le mot-clé de l'article), `_yoast_wpseo_title` (titre SEO suivi des variables Yoast `%%sep%% %%sitename%%`) et `_yoast_wpseo_metadesc` (description). WordPress n'accepte ces champs par l'API que si un petit extrait de code les déclare. **À installer une fois** (Réglages, Connexions, carte Yoast SEO, bouton « Copier le code ») :

```php
add_action('init', function () {
    foreach (['_yoast_wpseo_focuskw', '_yoast_wpseo_title', '_yoast_wpseo_metadesc'] as $key) {
        register_post_meta('post', $key, [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function () { return current_user_can('edit_posts'); },
        ]);
    }
});
```

1. Dans WordPress : installer l'extension gratuite **WPCode** (ou Code Snippets).
2. Nouvel extrait de type **PHP**, coller le code, activer.
3. Dans le tableau de bord : **Vérifier**. Pour un article déjà envoyé : Modifier, Enregistrer.

Tant que l'extrait n'est pas installé, les articles partent **sans** erreur mais sans champs Yoast (la carte de l'article le dit). **Ce que cela corrige, et ce que cela ne corrige pas** : les voyants « pas de mot-clé principal » et « pas de méta description » passent ; les autres voyants de Yoast (longueur du texte, mot-clé dans l'introduction et les intertitres, liens sortants, lisibilité) dépendent du texte rédigé par l'IA et ne sont pas garantis.

### Corriger un article avec l'IA

Sur la fiche d'un article (pas encore publié), la carte **Corriger avec l'IA** : vous écrivez ce qu'il faut changer et où (« raccourcis l'introduction », « ajoute une phrase sur les capteurs dans la section 2 »...), l'IA réécrit l'article et le range à la place de l'ancien. Garde-fous pour le SEO :
- Elle a **son propre prompt** (Réglages, Rédaction, « Correction par l'IA », modifiable, bouton « Rétablir ») qui lui impose de ne changer que ce qui est demandé et de garder les critères SEO (MOTCLE, 6 à 10 occurrences, 700 à 900 mots, 1 lien externe, 2 liens internes, mots interdits, titre et méta).
- **Modèle par défaut : `anthropic/claude-haiku-5-5`**, réglable et testé avant activation (Réglages, Rédaction).
- Le **mot-clé principal ne change jamais**, et l'adresse de la page (slug) d'un article déjà sur le site non plus (le lien ne doit pas casser).
- Le résultat affiche les **points SEO hors critères avant et après** ; si la correction a dégradé un point, il est nommé en rouge.
- L'ancien texte est gardé dans l'historique : **« Annuler cette correction »** le restaure (et met le site à jour si l'article y est déjà).
- Si l'article est déjà un brouillon ou programmé sur le site, la version du site est mise à jour (confirmation avant d'écraser une modification faite dans WordPress). Une correction compte dans les 40 rédactions par jour.

### Délai d'attente

Un article peut prendre 1 à 3 minutes avec un modèle qui réfléchit. Le délai d'attente est donc de **5 minutes** (il était de 90 secondes, ce qui provoquait « The operation was aborted due to timeout »). Si OpenRouter dépasse quand même le délai, le message dit « Relancez le sujet » : le sujet est listé avec son erreur, les autres continuent. Ce n'est pas réessayé automatiquement.

### Limite de réponse du modèle

La limite de réponse envoyée à OpenRouter est de **32 000 jetons** (largement plus qu'un article). Raison : certains modèles (Sonnet) « réfléchissent » avant d'écrire, et cette réflexion consomme la limite ; avec 6 000 jetons ils pouvaient répondre sans aucun texte (« raison d'arrêt : length »). On ne paie que ce qui est réellement généré. Si un modèle répond tout de même sans texte, le message nomme le modèle et la raison d'arrêt.

### Contrôle SEO après l'envoi

Sur chaque article, la carte **Contrôle SEO** relit l'article **sur le site** (adresse, champs Yoast, texte) et affiche, en rouge ce qui manque ou sort des critères : mot-clé principal, titre SEO (50 caractères hors nom du site, commence par le mot-clé), méta description (130 à 155 caractères, contient le mot-clé), slug, nombre de liens internes (2 minimum) et externes (1 attendu), occurrences du mot-clé (6 à 10), mot-clé au début du titre, dans la première phrase, et dans la moitié des H2 (3 à 5 H2). Avant l'envoi, le contrôle porte sur le texte local. Si le site ne renvoie pas les champs Yoast, les trois lignes Yoast sont rouges avec la raison (extrait de code absent). Les images ne sont pas gérées : `imageAlt` est demandé à l'IA et conservé, mais aucune image n'est envoyée.

### Publier directement, ou brouillon

Pour un article pas encore sur le site, la fiche propose : **Envoyer en brouillon**, **Programmer**, ou **Publier directement** (case « J'ai relu et validé ») : l'article est alors créé puis publié sur le site. Mêmes garde-fous que partout : longueur, marqueur `[SOURCE A VERIFIER]`, mode démonstration.

### Ne jamais ressaisir les identifiants

Les identifiants saisis dans l'interface sont chiffrés dans `data/`, et **l'hébergement gratuit de Render efface ce dossier à chaque redémarrage**. Pour ne plus jamais les remettre, copiez-les une fois dans Render, onglet Environment : `WP_USER`, `WP_APP_PASSWORD`, `OPENROUTER_API_KEY`. Ils sont relus à chaque démarrage. L'écran Réglages, Connexions affiche un avertissement tant que ce n'est pas fait. L'outil n'efface jamais une clé de lui-même.

### Mettre en place WordPress et l'IA (une seule fois)

1. Réglages, Connexions : saisir l'identifiant WordPress et le mot de passe d'application, **Enregistrer et tester** (message vert + droits du compte).
2. Saisir la clé OpenRouter (**Enregistrer la clé**).
3. Réglages, Rédaction : choisir et tester un modèle.
4. Désactiver le **mode démonstration** (Connexions).
5. Installer l'extrait de code Yoast ci-dessus.

## Mode démonstration et mode réel

- Un interrupteur dans Réglages > Connexions (une confirmation est demandée pour passer en réel). Le bandeau « Mode démonstration » disparaît dès que le mode est désactivé.
- En mode réel : les articles sont rédigés par l'IA, puis envoyés en brouillon, **programmés** ou **publiés** dans WordPress à votre demande (« J'ai relu et validé » obligatoire pour publier tout de suite ; refus tant que `[SOURCE A VERIFIER]` reste dans le texte, y compris dans le texte présent sur WordPress).
- Chaque article porte la marque du mode dans lequel il a été créé. Un article de démonstration n'existe pas sur le site : il ne peut pas être publié en mode réel, et un bouton permet de tous les supprimer sans toucher à WordPress. Inversement, un vrai brouillon ne peut ni être « publié » ni supprimé tant que le mode démonstration est actif.

## Choix faits (points ambigus)

- **Rien n'est envoyé sans décision** : la rédaction (un article ou un planning) ne touche jamais WordPress. Seuls « Envoyer en brouillon », « Programmer », « Programmer tous les articles prêts » et « Publier » le font.
- **Date prévue** : chaque article d'un planning garde une « date prévue » (modifiable sur sa fiche). C'est un pense-bête : elle ne programme rien toute seule.
- **Fichiers supplémentaires** : `data/articles.json` (articles et leur historique de versions) et `data/publications.json` (journal des publications), en plus de `settings.json` et `audits.json`.
- **Meta titre, meta description, mot-clé principal** : envoyés à Yoast (clés `_yoast_wpseo_title`, `_yoast_wpseo_metadesc`, `_yoast_wpseo_focuskw`) si l'extrait de code de la section Yoast est installé ; la description est aussi mise dans l'extrait (excerpt) de l'article. Rank Math n'est pas géré.
- **Contenu de l'article** : `htmlContent` ne contient pas le H1, c'est le titre de l'article WordPress. Le HTML est filtré (h2, h3, p, listes, tableaux, a, strong, em). Les contrôles (longueur, mots interdits, tirets longs, marqueurs de source) sont affichés sur chaque article, sans le modifier.
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
- API : connexion, validation, prompt obligatoire (trop court, vide, trop long), avertissements du prompt, longueurs min/max, un article, planning (par nombre d'articles de 1 à 20, ou par mois ; dates), rédaction du planning en arrière-plan, programmation (date passée ou lointaine refusée, marqueur, longueur, faits à vérifier), annulation, publication, « Programmer tous les articles prêts », suppression, plafond de 40 rédactions par jour.
- Dates : 10 h et 9 h à Paris en heure d'hiver et d'été, jour des changements d'heure, fin de mois, planning de 18 articles.
- Le prompt est envoyé tel quel à l'IA (le message système est identique au texte des réglages, rien d'ajouté), le sujet et la ville partent dans le message utilisateur, le modèle des réglages est utilisé.
- Longueur des articles : comptage des mots, plage aux bornes, mots interdits (féminin, pluriel, sans faux positif), limite de sortie, réponse coupée détectée, tableaux conservés.
- Changement de modèle : test avant activation, modèle conservé en cas d'échec, modèle précédent, nom du modèle gardé sur chaque article.
- Modification manuelle : texte nettoyé, historique et retour arrière, version du site mise à jour, protection contre l'écrasement d'une modification faite dans WordPress, panne du site, régénération.
- Programmation contre un faux WordPress : statut « future » avec la bonne date (UTC), annulation, publication d'un article programmé (date ramenée à maintenant), suivi d'un article publié par WordPress, refus du marqueur de source, article de démonstration sans effet sur le site.
- Correction par l'IA (consigne, modèle Haiku par défaut, prompt de correction des réglages, mot-clé et adresse conservés, site mis à jour, SEO avant/après, retour arrière, refus d'un article publié), limite de réponse de 32 000 jetons, message clair si le modèle répond sans texte.
- Contrôle SEO (cas bons, chaque défaut en rouge, champs Yoast absents), format JSON étendu, nouveaux mots interdits, publication directe d'un article pas encore envoyé, programmation à 10 h.
- Yoast : champs envoyés si le site les accepte (envoi, modification, programmation), repli sans erreur sinon, état visible.
- Liens : un lien du texte écrit `/page/` ou `page/` est conservé ou complété, un lien étranger ou `javascript:` est retiré ; dans l'aperçu, les liens pointent vers le site et s'ouvrent dans un nouvel onglet.
- Chaque règle de sécurité a été cassée volontairement pour vérifier que les tests la détectent.
- Interface dans Chromium (bureau et téléphone) : tout le parcours contre un faux WordPress et un faux OpenRouter (prompt et avertissements, connexions, Yoast, modèle testé, un article, liens de l'aperçu, programmation, annulation, planning de 4 articles avec une date changée, programmer tous les articles prêts, accueil, aide), sans défilement horizontal ni erreur JavaScript.

**Non vérifié** (aucun accès à ces services depuis l'environnement de développement) :
- Appels réels à OpenRouter : format de réponse JSON, respect des règles de rédaction et de la longueur par le modèle choisi (le prompt la demande et le code la contrôle, mais seul un vrai modèle montrera s'il s'y tient : un modèle trop économique écrit souvent beaucoup trop court). Relisez les premiers articles avec soin.
- Programmation et Yoast contre le vrai WordPress de citylock.fr (testés uniquement contre un faux WordPress). En particulier : le déclenchement à l'heure exacte dépend du WP-Cron du site ; l'extrait de code Yoast n'a jamais tourné sur le vrai site ; les liens internes n'ont pas pu être ouverts depuis l'environnement de développement (citylock.fr y est injoignable).
- API réelle de citylock.fr : structure réelle du sitemap, comportement du thème, éventuels blocages (pare-feu, extension de sécurité) sur l'API REST ou sur l'audit.
- Appel réel à PageSpeed Insights.
- Déploiement sur Render ou Railway.
- Aucun score réel de citylock.fr n'a été calculé.
