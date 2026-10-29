# Comparateur Mooup × Glovo — Oujda

Application locale de comparaison Mooup/Glovo, intégrée au dashboard FastAPI/SQLite existant.

## Installation et lancement

Python 3.10+ est requis.

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m playwright install chromium
Copy-Item .env.example .env
uvicorn app.main:app --reload
```

Ouvrir http://127.0.0.1:8000. Le bouton « Lancer la comparaison » lance une tâche en arrière-plan; la progression est disponible via `GET /api/runs/current`. `POST /api/runs` démarre une analyse, `GET /api/report` retourne le rapport et `GET /api/health` vérifie le service.

## Configuration

`DATABASE_PATH` définit la base SQLite, `GLOVO_EXPORT_PATH` le dossier de l'export Glovo, `MOOUP_API_BASE` l'API Mooup et `MOOUP_CATALOG_API_KEY` une clé read-only avec scope `catalog:read`. La clé est à fournir dans le fichier `.env` local (ignoré par git), jamais dans `.env.example` ni dans le code. `MOOUP_API_PAGE_SIZE` est limité à 100/page. Ne publiez pas ce serveur local sans contrôle d'accès.

## Données collectées et règles de décision

- Sources actuelles : export local Glovo (`GLOVO_EXPORT_PATH`, 72 restaurants et 4 132 produits, export du 28/10/2026) et catalogue Mooup via l'API partenaire `https://api.mooup.ma/api/integrations/catalog/all` (34 restaurants et 3 567 produits, catalogue du 29/10/2026, pagination 100/page, header Bearer, gestion de `Retry-After`). La clé est une clé read-only avec scope `catalog:read`, portée par `MOOUP_CATALOG_API_KEY` dans `.env`; elle n'est ni affichée ni journalisée. Le dernier run a terminé `completed` avec 0 erreur.
- Décision de présence : un restaurant de la liste suivie est déclaré « Présent » seulement si la similarité exacte de nom atteint le seuil `PRESENCE_THRESHOLD` (0.96). Sinon, il est « Absent de Mooup (vérifié) » seulement si aucun candidat Mooup n'atteint le seuil `ABSENCE_THRESHOLD` (0.60); tout candidat entre 0.60 et 0.96 laisse le statut « À vérifier ». Sans catalogue Mooup ou sans collecte Glovo, le statut devient « Données insuffisantes » et l'absence n'est jamais déclarée.
- Comparaison des prix : écart MAD = prix Glovo − prix Mooup; écart % = (écart / prix Mooup) × 100. Un prix manquant donne « Non calculable ». Les produits de tailles différentes ne sont pas comparés. Les prix hors plage plausible (1 à 1 000 MAD) sont affichés avec l'indicateur « anomalie de prix », signalés comme non vérifiables et exclus du décompte des écarts; ils ne sont jamais corrigés.
- Restaurants communs : seules les correspondances fiables (statut `confirmed`, ou `review` avec confiance ≥ `RELIABLE_MATCH_CONFIDENCE` = 0.70) alimentent la comparaison. Sur le dernier run, 24 correspondances ont été scorées: 20 fiables (0.72, noms quasi identiques) et 4 spéculatifs (0.51–0.55) laissés à la vérification manuelle. Les correspondances de type sous-ensemble de tokens (`token_set_ratio`) ne sont jamais considérées comme une preuve.
- Le fichier de l'export Glovo fournit les 72 fiches et leurs images, servies après validation des chemins. Sans clé API valide, le dashboard conserve les données déjà en base, l'import manuel JSON/CSV et les trois validations manuelles, sans inventer d'absence ni d'écart.

## Interface

Trois pages, en français, alimentées par `/api/report`.

- **Vue générale** — les 45 restaurants suivis (3 validations manuelles City Meal, Smash N Tacos et Mr chef puis les 42 noms de la liste de surveillance, dans l'ordre de la base, doublons conservés en lignes séparées), avec recherche, filtre de statut et de catégorie, tri, export CSV et fiche détaillée (présences vérifiées des deux côtés, produits collectés côté Glovo, historique). Le panneau « Sources, dates de collecte et limites » expose les dates et volumes de chaque source, l'état des correspondances, les anomalies de prix et l'import JSON/CSV du catalogue Mooup.
- **Comparaison des restaurants** — les restaurants présents sur les deux plateformes avec catégorie, produits, produits comparables, écarts de prix et confiance. La fiche détaillée est une comparaison visuelle côte à côte : en-tête compact (nom, retour, dates de collecte Glovo et Mooup, résumé des produits et différences), puis deux colonnes de largeur égale GLOVO | MOOUP séparées par un filet vertical. Chaque colonne porte son propre en-tête de restaurant (image, nom, catégorie, adresse, note/avis ou horaires, état, source, date de collecte, nombre de produits), ses catégories réelles et toutes ses cartes produits (image ou mention « Image indisponible », nom, description, prix MAD, prix initial et remise, format, variantes, options, disponibilité, lien fiche). Les produits équivalents partagent la même ligne avec un indicateur d'écart (prix identiques, Glovo/Mooup plus cher de X MAD et %, non calculable, anomalie de prix, tailles ou composition différentes, correspondance à vérifier avec sa confiance) ; les produits non rapprochés restent visibles avec la mention « Aucun produit correspondant sur Mooup/Glovo ». Une barre de filtres (tous, prix différents, prix identiques, absents de Mooup, absents de Glovo, correspondances à vérifier), une recherche produit et une navigation par catégories (synchronisée par catégorie normalisée, originales conservées) agissent sur les deux colonnes simultanément, avec export CSV et validation manuelle de la correspondance. Sur mobile, des onglets GLOVO/MOOUP affichent une colonne à la fois. L'endpoint /api/catalog-comparison?restaurant=…&mooup=… renvoie les deux fiches, la couverture totale des produits alignés (avant/après), les écarts, les drapeaux et les résumés.
- **Historique** — exécutions, imports et journal des validations utilisateur.
- Import manuel du catalogue Mooup (Vue générale, encart « Accès au catalogue Mooup ») : en-têtes `restaurant, restaurant_url, restaurant_image, restaurant_category, address, phone, delivery_zone, product, price, regular_price, currency, category, description, size, image, available, options, product_url`, ou JSON `{"restaurants":[{"name":"…","products":[…]}]}`. Une ligne par produit; la devise est requise pour comparer les prix. Les entrées suivies, leurs doublons et les validations manuelles ne sont jamais fusionnées.

## Vérifications

```powershell
python -m unittest discover -s tests -v
```

53 tests. Ils emploient exclusivement des données fictives et vérifient le rapprochement restaurant/produit, l'écart de prix, l'import Mooup et ses erreurs, les 45 entrées suivies (ordre, doublons, validations manuelles), les règles de statut (présence, absence vérifiée, données insuffisantes, catalogue Mooup indisponible), la sélection des restaurants communs, le signalement des anomalies de prix, et la comparaison de catalogues (	ests/test_catalog_comparison.py : couverture totale des produits sans doublon, sens de l'écart, lignes inverses sans prix, tailles et compositions différentes, confiance faible, résumés, catégories propres à chaque source, métadonnées et erreurs 400/404). Les rapports du dashboard ne contiennent pas de données de démonstration.
