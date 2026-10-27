# Campagnes du candidat C1 — 22 octobre 2026

Le candidat source est `da24a4a5fb8b51a36f2b7786f666c2e97598e4b0`.
Le [gel](../../resumption/candidate-freeze-20261022.json) est provisoire au commit local
`764eac76`, puis définitif au commit local `84c46592`, avant toute lecture du réservé.
Les commits documentaires suivants ne modifient aucun input du producteur, helper,
fixture, observer, cas, attendu ou comparateur.

| Exécution | Unités PASS | Supports PASS | Groupes dont toutes les unités passent | Test agrégé |
| --- | --- | --- | --- | --- |
| macOS 27.0.1 arm64 | 352/354 | 50/51 | 239/240 | exit 0, 132,02 s |
| Linux OrbStack aarch64 | 352/354 | 50/51 | 239/240 | exit 0, 139,19 s |

Rust et Cargo 1.95.0 ; Bun 1.4.3. Linux utilise l’image
`rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1`,
avec réseau `none`. Les deux campagnes ont tourné en parallèle, sur des binaires natifs
et des dossiers de sortie distincts. Les volumes `target` Linux et les dossiers macOS
sont séparés. Aucun Windows, Linux x86_64 ou macOS x86_64 n’est exercé.

Le [résumé](summary.json) lie les [rapports macOS](report-macos.json) et
[Linux](report-linux.json), leurs SHA256, logs, scripts d’orchestration et sorties
conservées hors Git. Les [manifestes macOS](members-macos.json) et
[Linux](members-linux.json) identifient chacun 1 838 chemins retenus par taille/SHA256,
selon la sélection publique du 20 octobre ; aucun chemin attendu ne manque.
Le [manifeste des inputs suivis](candidate-input-members.json) identifie les fichiers
source/outillage/cas utilisés pour vérifier l’absence de changement après gel.

Les sorties complètes sont hors dépôt dans
`/Users/sebastien/semctx-evidence/t00/20261022/campaign-macos/` et
`/Users/sebastien/semctx-evidence/t00/20261022/campaign-linux/`.
La seconde conserve le run complet dans `raw-campaign.tar.gz` : les noms non UTF-8
restent dans l’archive Linux, sans extraction macOS. Les copies de workspaces,
compilateurs et `target/` ne sont pas ajoutées à Git. Les manifestes sont des
identités de bytes retenus, sans attestation de processus ni garantie de rétention.

## Reproduction locale

La [procédure du 21 octobre](../reproduction-20261021.md) fournit les commandes
épinglées de build, préparation des recipes et compilation de l’observer.
Cette passe a utilisé ces commandes avec `--offline`, `CARGO_BUILD_JOBS=2`,
`RUST_TEST_THREADS=1`, `GOPORT_LIB_PARSE_SNAPSHOT=0`, `GOPORT_LIB_SNAPSHOT=0` et
`GIT_CONFIG_GLOBAL` absent. Le cache historique macOS a été restauré depuis les
caches existants d’OrbStack ; aucun téléchargement ni changement de dépendance.

Le runner historique conservé au jalon du 20 octobre a été séparé juste avant
son unique `subprocess.run` : `freeze-only.py` produit les inputs et copies de
binaires, puis `run-campaign.py` exécute exactement l’observer gelé. Les scripts
et leurs SHA256 figurent dans `summary.json`. Cette séparation permet le gel avant
campagne ; elle ne change aucune comparaison, recette ou attente.

Après préparation, la commande réellement exécutée sur macOS est :

```sh
python3 /Users/sebastien/semctx-evidence/t00/20261022/run-campaign.py \
  /Users/sebastien/semctx-evidence/t00/20261022/campaign-macos
```

Sur le conteneur existant, dont l’image et le réseau ont été inspectés :

```sh
docker exec --user 501:20 \
  --workdir /Users/sebastien/.herdr/worktrees/semctx/issue-365-t00-rust-ts-feasibility \
  semctx-t00-oct20-linux-v1 \
  python3 /work/evidence/qualification-20261022/run-campaign.py \
  /work/evidence/qualification-20261022/campaign-linux
```

Une nouvelle exécution exige des dossiers neufs : l’observer refuse d’écraser une
preuve existante. Ces commandes documentent la campagne publique ; elles n’ouvrent
et n’exécutent aucun contenu réservé.

## Portée des résultats

Les projections comparées des 354 unités et 51 supports sont identiques entre
macOS et Linux ; `summary.json` nomme exactement les champs comparés. Les bindings,
chemins, timestamps et provenance ne sont pas assimilés à cette égalité.

Le test agrégé accepte les trois différences individuellement arbitrées, en
conservant leurs NONPASS et crédit zéro : émission ES5 sans `__generator`
(ARB-003), compilateur/dialecte 7.1.0-dev contre 5.9.3 (ARB-004), diagnostic 1490
contre 1127 pour le surrogate UTF16LE isolé (ARB-002). Cette passe ne démontre pas
une nouvelle cause racine du dernier écart. Les attendus restent inchangés.

Le [bilan des 240 obligations](../../qualification/obligations-qualification-20261022.md)
distingue 82 projections finies vertes de **0/240 obligations R0 formellement
qualifiées**. Le [reçu agrégé du réservé](../../qualification/reserved-aggregate-20261022.json)
constate un blocage avant extraction : aucun contrat gelé d’invocation/comparaison
pour ses 26 variantes n’est disponible. Son archive a seulement été hachée après
le gel définitif ; aucun contenu n’a été listé, extrait ou inspecté.

`r0Decision` reste `null`. Windows native, fermeture des propriétés/supports,
contrat et évaluation du réservé, puis audit/admission agrégés restent ouverts.
Aucun push, appel API GitHub ou lancement CI n’a été effectué. Le seul accès distant
est le `git fetch origin` explicitement demandé par l’étape a.
