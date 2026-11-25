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

## Les réglages : trois onglets

Tout se gère dans **Réglages**, sans redéployer. Sous chaque réglage, une phrase explique à quoi il sert.

- **Connexions** : « Mise en route » (4 points à valider), mode démonstration, liaison WordPress, clé de rédaction (OpenRouter), clé PageSpeed.
- **Rédaction** : modèle d'intelligence artificielle, instructions pour la rédaction, sujets d'articles, nom et zone de l'entreprise.
- **Publication** : nombre d'articles par mois, mode de publication, publication automatique (règles, « Tout arrêter »), envoi en brouillon, essais en cours, journal des publications.

### Mettre en place WordPress et l'IA (une seule fois)

1. Un administrateur crée le mot de passe d'application WordPress (section « Créer le mot de passe d'application »).
2. Réglages > Connexions > Liaison avec WordPress : coller l'identifiant et le mot de passe, puis « Enregistrer et tester ». Le message doit dire « Connexion réussie ... Créer des brouillons : oui ».
3. Réglages > Connexions > Clé de rédaction : coller la clé OpenRouter, puis « Enregistrer la clé ».
4. Réglages > Rédaction > Modèle : coller l'identifiant du modèle, puis « Tester et activer le modèle » (voir ci-dessous).
5. Réglages > Connexions : désactiver le mode démonstration (une confirmation est demandée).

### Changer de modèle d'intelligence artificielle

1. Aller dans Réglages > Rédaction, carte « Modèle d'intelligence artificielle ».
2. Copier l'identifiant exact du modèle depuis openrouter.ai/models (exemple : `anthropic/claude-haiku-5-5`) dans le champ.
3. Cliquer sur **« Tester et activer le modèle »**. L'outil envoie une toute petite demande (quelques mots) pour vérifier que le modèle répond.
4. Deux résultats possibles :
   - **« Modèle activé : [nom] »** : le modèle sera utilisé pour les prochains articles.
   - **« Ce modèle n'a pas répondu : [raison] »** : le nouveau modèle n'est pas activé, **l'ancien reste en place**. Les raisons sont écrites simplement (identifiant inconnu, clé refusée, crédit épuisé, OpenRouter trop lent...).
5. L'outil garde en mémoire le modèle précédent : le bouton « Revenir au modèle précédent » le réactive (après un nouveau test).

À savoir :
- Le modèle utilisé s'affiche en permanence sur la page Rédaction (« Rédigé avec : ... ») et sur chaque article (« Rédigé avec : ... »). Un ancien article garde le nom du modèle qui l'a rédigé.
- Champ vide + « Tester et activer » : l'outil revient au modèle du serveur (variable `OPENROUTER_MODEL`, conservée comme valeur de secours). Sans modèle, rien ne peut être activé.
- En mode démonstration, aucun test réel n'est fait et le modèle n'est pas changé : désactivez d'abord le mode démonstration.
- Le modèle ne peut pas être changé autrement que par ce test.

### Modifier les instructions pour la rédaction

Réglages > Rédaction > « Instructions pour la rédaction » : c'est le texte envoyé à l'IA avec chaque sujet (ton, faits autorisés, mots interdits, structure). Modifier, puis « Enregistrer les instructions » : le changement s'applique aux prochains articles. « Rétablir le texte d'origine » remet le texte de départ (6000 caractères au maximum).

- **Longueur** : l'outil impose toujours 600 à 900 mots, même si les instructions n'en parlent pas. Le **format de réponse** (titre, texte, faits à vérifier...) est lui aussi imposé par le code et n'est pas modifiable.
- Si vous aviez déjà enregistré vos propres instructions dans Réglages, elles restent en place : le nouveau texte par défaut ne s'applique que si vous cliquez sur « Rétablir le texte d'origine ».
- Les balises de tableau sont autorisées dans les articles (le texte par défaut demande un tableau comparatif quand le sujet s'y prête).

### Longueur des articles (600 à 900 mots)

- L'outil demande explicitement 600 à 900 mots au modèle, avec une limite de sortie de 6000 jetons (largement suffisant).
- Le compteur de mots est fiable : les titres, paragraphes, listes et tableaux ne se collent plus entre eux.
- Hors de la plage, une alerte s'affiche. L'article **n'est pas envoyé automatiquement** sur le site, et l'envoyer ou le publier à la main demande une confirmation. Le bouton **« Régénérer »** rédige un nouveau texte pour le même sujet (l'ancien reste dans l'historique). Une régénération compte comme un essai : 1 toutes les 3 secondes, 10 par jour.
- Contrôles affichés sur chaque article : longueur, mots interdits (meilleur, leader, certifié, garanti, 100 %, à vie, révolutionnaire, sans risque, avec leur féminin et pluriel), marqueurs `[SOURCE A VERIFIER]`, faits à vérifier, tirets longs et flèches.

### Modifier un article à la main

Ouvrir l'article, puis « Modifier » : titre, mot-clé principal, titre et description pour Google, adresse de la page, texte, liste des faits à vérifier. Le bouton « Insérer un lien » ajoute un lien à l'endroit du curseur. L'aperçu et les contrôles se mettent à jour en écrivant. Les problèmes restants s'affichent, **sans bloquer l'enregistrement**.

- Le texte modifié est celui qui part en brouillon. Si l'article est déjà un brouillon sur le site, il est mis à jour en même temps.
- Si le texte a été modifié directement dans WordPress depuis le dernier envoi, une confirmation est demandée avant de l'écraser.
- Si le site ne répond pas pendant l'enregistrement, le texte est gardé dans l'outil et la publication est bloquée jusqu'à ce que la mise à jour du site réussisse (réenregistrer suffit).
- Chaque enregistrement garde la version d'avant (20 au maximum) : « Revenir à la version précédente », ou « Restaurer » sur une version plus ancienne. Rien n'est perdu : l'état actuel est lui aussi gardé.

### Les trois modes de publication

Réglages > Publication > « Mode de publication » :

1. **Brouillon seulement** (par défaut, recommandé) : l'article part dans WordPress en brouillon. Personne ne le publie sans clic sur « Publier » (case « J'ai relu et validé » obligatoire).
2. **Essai** : comme « brouillon seulement », mais l'article est marqué « essai » (préfixe `[ESSAI]` dans le titre sur WordPress, retiré à la publication). Tous les essais en cours sont listés. Publier un essai demande une confirmation.
3. **Automatique** (désactivé par défaut) : ne s'active que par un interrupteur explicite, après l'avertissement « Les articles seront publiés sans relecture. Laurent doit avoir donné son accord écrit. »

**Publication automatique : un article n'est publié que si toutes ces conditions sont remplies :**
- aucun fait à vérifier dans la liste ;
- un texte de 600 à 900 mots ;
- aucun mot interdit ;
- aucun marqueur `[SOURCE A VERIFIER]` ;
- la date de publication prévue est atteinte : délai d'attente réglable (3 jours par défaut) après l'envoi sur le site, pendant lequel on peut annuler article par article ;
- et pas plus de 2 articles publiés par semaine (réglable, semaine du lundi au dimanche, heure de Paris).

Protections supplémentaires :
- Le texte **présent sur le site** est relu (longueur, mots interdits, marqueurs) juste avant de publier : une correction ou une erreur faite dans WordPress est prise en compte.
- Un article de démonstration, un « essai », un article annulé ou avec des modifications pas encore envoyées n'est jamais publié seul.
- Seuls les articles créés **après l'activation** sont concernés : réactiver le mode automatique ne publie jamais d'anciens brouillons.
- **« Tout arrêter »** suspend immédiatement les publications automatiques (relu avant chaque publication). « Reprendre » les relance. Vous pouvez toujours publier vous-même.
- La vérification tourne toutes les heures, et sur demande (« Vérifier maintenant »). **Sur un hébergement gratuit qui s'endort, elle ne tourne pas pendant le sommeil du service.**
- En mode automatique, l'envoi en brouillon est toujours actif (on ne publie que ce qui est déjà sur le site).
- **Journal des publications** : chaque publication (manuelle ou automatique) est notée avec la date, l'heure, le titre et l'adresse. Il est effacé à un redémarrage sans disque persistant.

**Etat de chaque article**, en clair en haut de sa fiche : « Brouillon, pas encore publié », « À vérifier avant publication » (longueur, mot interdit, source ou fait à vérifier) ou « Publié le [date] ».

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

## Choix faits (points ambigus)

- **Génération puis envoi** : si l'envoi en brouillon est activé (par défaut, et toujours en mode automatique), chaque article rédigé dont la longueur est dans la plage (600 à 900 mots) est envoyé à WordPress en brouillon. Sinon, il reste « À relire » jusqu'au clic sur « Envoyer en brouillon ». Dans tous les cas, la publication à la main exige la case « J'ai relu et validé ».
- **Lot** : au plus `fréquence − articles déjà rédigés ce mois-ci` articles, un par sujet pas encore traité ce mois-ci. Un deuxième clic ne relance donc pas d'appels inutiles.
- **Fichiers supplémentaires** : `data/articles.json` (articles et leur historique de versions) et `data/publications.json` (journal des publications), en plus de `settings.json` et `audits.json`.
- **Meta titre et meta description** : affichés dans l'écran de relecture, non envoyés à WordPress (le champ dépend de l'extension SEO). La meta description est mise dans l'extrait de l'article. À copier à la main dans Yoast / Rank Math.
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
- API : connexion, validation, plafond du lot, parcours simulé génération, brouillon, publication, suppression.
- Longueur des articles : comptage des mots, plage 600 à 900 aux bornes, mots interdits (féminin, pluriel, sans faux positif), longueur demandée au modèle (message et format verrouillé), limite de sortie, réponse coupée détectée, tableaux conservés.
- Changement de modèle : test avant activation, modèle conservé en cas d'échec (identifiant inconnu, clé refusée, crédit épuisé), modèle précédent, nom du modèle gardé sur chaque article.
- Modification manuelle : texte nettoyé, historique et retour arrière, brouillon du site mis à jour, protection contre l'écrasement d'une modification faite dans WordPress, panne du site, régénération.
- Modes de publication : automatique désactivé par défaut et confirmation obligatoire, chacune des conditions de publication automatique, texte du site relu avant publication, plafond par semaine (heure de Paris), « Tout arrêter » (y compris pendant une vérification), anciens brouillons jamais publiés, journal des publications, mode essai.
- Chaque règle de sécurité a été cassée volontairement pour vérifier que les tests la détectent.
- Interface dans Chromium (bureau et téléphone) : tout le parcours en mode réel contre un faux WordPress et un faux OpenRouter (réglages en trois onglets, modèle testé, instructions, modes de publication, alerte de longueur, régénération, écran Modifier avec lien et aperçu, historique, conflit WordPress, publication, journal, essai), sans défilement horizontal ni erreur JavaScript.

**Non vérifié** (aucun accès à ces services depuis l'environnement de développement) :
- Appels réels à OpenRouter : format de réponse JSON, respect des règles de rédaction par le modèle choisi, longueur 600 à 900 mots (le code l'exige et le contrôle, mais seul un vrai modèle montrera s'il s'y tient). Relisez les premiers articles avec soin.
- Publication automatique contre le vrai WordPress de citylock.fr (testée uniquement contre un faux WordPress).
- API réelle de citylock.fr : structure réelle du sitemap, comportement du thème, éventuels blocages (pare-feu, extension de sécurité) sur l'API REST ou sur l'audit.
- Appel réel à PageSpeed Insights.
- Déploiement sur Render ou Railway.
- Aucun score réel de citylock.fr n'a été calculé.
