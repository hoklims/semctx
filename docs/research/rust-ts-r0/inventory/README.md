# Semctx T00 — bundle source stage 2

Baseline strict : `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`. Préparé par `/root/ordinary_ts_inventory`, puis adopté comme candidat documentaire au checkpoint 2, sans qualification native.

`obligations.json` contient les 240 obligations, exactement huit champs chacune. Tous les états natifs restent `unknown`. `catalogue.json` contient une seule fois les 111 DEVREF, les 27 familles et les propositions de microcas. Aucun fichier JSONL doublonnant les obligations n’est distribué.

`scope-and-method.json` conserve 19 roots et leurs hashes, quatre ancres de consommateurs indirects, l’annexe de packaging et la confirmation du census attribuée au fil principal. Les sources sont récupérables par `git show BASELINE:chemin` puis comparaison SHA-256 des octets, sans checkout. Ni sources ni dépendances ne sont copiées ici.

`provenance-summary.json` est une copie exacte du résumé de découverte existant. Les chemins absolus et l’environnement Darwin arm64/Bun 1.4.3/TypeScript 5.9.3 décrivent son exécution d’origine. La copie ne constitue aucune exécution sur un autre host. Les 5 317 candidats membres recensés ont une disposition statique ; cela ne qualifie ni le runtime injecté ni la parité sémantique. Le détail de 28 MB est omis, identifié et hashé dans le manifeste ; les sites source exacts restent embarqués dans les obligations.

`mechanism-feasibility.json` est la copie exacte de l’enquête documentaire référencée. Les références ont été rendues relatives. Cette enquête ne sélectionne aucune composition et ne prouve aucun mécanisme natif. D’autres ports TS7 sont examinés séparément ; ne pas déduire une préférence de la liste.

`baseline-to-T00-deltas.json` identifie les 17 chemins modifiés du périmètre explicitement énuméré, leurs hashes de diff Git et leur disposition hors dénominateur strict. Le nombre préliminaire de16 est remplacé par ce recensement défini ; il ne décrit pas le delta global du dépôt. Les profils baseline `qualified-static-v1` / `modelo-suite-static-v1` restent distincts du profil actuel `public-monorepo-static-v1`. L’ADR0037 de #383 est une autorité d’outillage distincte au commit indiqué.

Fermeture source ≠ gel des cas ≠ preuve runtime. Un site attribué, un consommateur nommé ou une référence de test héritée ne démontre pas qu’une branche est exercée. Le dénominateur des cas et les attendus indépendants restent à geler ; les mécanismes restent à choisir puis qualifier sur Windows natif et Linux. Aucun de ces targets n’a été exercé par ce bundle. L’absence d’un diagnostic ne vaut pas admission globale. Aucun cas réservé n’a été consulté.

Le manifeste identifie les entrées originales, les fichiers distribués, leurs hashes et tailles, ainsi que chaque transformation. Les chemins d’origine du manifeste sont des indications de provenance, pas des dépendances nécessaires pour lire ce dossier. Aucun script, gate ou validator n’est livré. La transformation initiale du bundle n’a rejoué aucun scan/test/build/producteur ; le fil principal a ensuite inspecté les diffs Git documentés. Le bug historique des réexports ambigus suit l’arbitrage explicite dans `../arbitrations.json`.
