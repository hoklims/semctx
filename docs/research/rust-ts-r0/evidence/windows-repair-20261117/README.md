# Semctx T00 — corrections Windows du 17 novembre 2026

Le candidat corrige quatre défauts observés pendant la reprise T00 : l’identité
des chemins lors d’une mutation après capture, les origines des sources retenues,
la politique Git locale des fixtures et la construction des ancêtres de chemins.
Les contrôles locaux ci-dessous passent. **R0 reste non décidé ; aucune admission
canonique ni qualification globale n’est annoncée.**

## Source et changements

Base Semctx : `a754b59bb1ffe037c5a06f35b7601bde4aae7b89`.

- `5080f2a867581b889d4f03d878a0b47cd919f2b9` — conserve la clé Windows exacte de la capture et vérifie séparément la cible physique.
- `f0836b9d0395e86e2afc13447c807499732f5e90` — normalise les chemins consommés par les analyses d’origine, sans modifier le contrat de Map retenue exacte.
- `d0cfdf2068e590f72c932cc3ed72234ae814f159` — isole la politique de fins de ligne Git dans chaque fixture. Le test V2 vérifie l’origine réelle des réglages globaux et locaux ; la première preuve fondée sur une variable filtrée par le superviseur reste rétractée.

La préparation suivante ajoute les parents CaptureFs bornés par la vraie racine
et la provenance exacte de la dépendance expérimentale
[`85671c0de022b8f34e89a1bf9c72d4c1c1631a2d`](https://github.com/hoklims/ts-rust/commit/85671c0de022b8f34e89a1bf9c72d4c1c1631a2d),
publiée sur la branche `codex/semctx-r0-verbatim-root-20261117` de `hoklims/ts-rust`.
Cette publication rend le candidat reproductible ; elle ne vaut pas admission
amont. Le candidat Semctx final est 605eb775adf14a517aab17db4ddab200dbbb521a
(tree 158f3f6d5bc3f4a7319837b6b5ca129b8a24b9d4).

## Vérifications observées

| Contrôle | Résultat |
|---|---|
| CaptureFs : trois nouveaux contrôles | Avant correction : 2 échecs, 1 succès ; après : 3 succès |
| Mutation après capture | Échec attendu sur ancienne implémentation, puis 4 contrôles réussis |
| Git de fixture V2, avec origine réelle | 1 test intégré réussi |
| Unités Windows du binaire candidat | **287 réussies**, 0 échec ; 98,89 s de tests, 155,648 s au total |
| Provenance du compilateur natif | 11 tests réussis |
| Liaison des builds natifs | 13 tests réussis |
| Famille token / sortie parsée / jointure finale / évaluateur | Respectivement 4 / 1 / 1 / 4 tests réussis |
| Rustfmt | exit0 |
| Clippy all-targets / Clippy de l’observateur | exit0 ; respectivement 71,785 s et 7,138 s |
| Ruff exigé par le dépôt, **0.16.10** | exit0 après retrait d’un import inutilisé |

Les témoins et leurs entrées restent liés à leurs sources réelles dans les reçus.
Le relevé final du lead ajoute **144 comparateurs de l’observateur réussis**
et **1 contrôle Git final réussi** sur ce candidat.

## Captures a754 et limites

Les captures natives **macOS et Linux à a754** ont chacune 446 lignes évaluées
`RELEVANT_PASS` — 395 propriétés et 51 supports. Ces observations ne qualifient
pas automatiquement les 240 obligations, ni le candidat corrigé.

La campagne Windows a754 reste partielle. Après les dispositions étroites déjà
existantes, elle conserve **6 lignes source et 4 lignes publiques non conformes**.
Les 16 et 5 différences brutes correspondantes restent conservées ; la campagne
originale s’est interrompue sur la préparation de la mutation de chemin.
Les corrections locales ne remplacent pas la reprise ciblée de ces captures.

La revue indépendante du candidat de politique reste **PROOF_WEAK** : l’environnement
fourni expose des outils d’écriture et un contexte mémoire injecté, alors que
le contrat exige un environnement réellement en lecture seule et sans mémoire
persistante. Aucun défaut de ce candidat de politique n’a été identifié dans
cette revue, mais aucun gate canonique n’a été exécuté après le blocage. Ce résultat
ne constitue pas une revue d’acceptation globale des corrections Semctx.

## Conservation des preuves

`manifest.json` liste les reçus, leurs empreintes et les résultats numériques.
Le `manifest.json` de ce dossier épingle les sources du candidat et les copies
exactes des reçus et journaux publics sous `raw/`. Les chemins inscrits dans les
reçus gardent leur sens original. Les grandes captures restent sur leurs hôtes;
leurs résumés n'en remplacent pas la chaîne de conservation.
Les charges réservées, données privées et grandes captures ne sont pas copiées.

Restent à rattacher : plan et checks CI du même SHA, reprise ciblée des cas
affectés, puis audit et admission canoniques
dans un environnement conforme. Aucun merge, release ou verdict R0 n’est déduit
des résultats locaux.

## Reproduction et portée

Le contenu Rust testé est celui de `605eb775adf14a517aab17db4ddab200dbbb521a`.
Le commit documentaire qui transporte ce dossier ne modifie pas ce contenu.
La reconstruction locale utilise Rust 1.95.0, les deux variables
`GOPORT_LIB_PARSE_SNAPSHOT=0` et `GOPORT_LIB_SNAPSHOT=0`, un thread de tests
et les commandes exactes de chaque reçu. Préparer séparément les dépendances
épinglées avant les commandes `--locked --offline`; ne pas modifier le Node
ou le Ruff global. Les tests de provenance utilisent le cache Git exact, ou
`SEMCTX_TS_RUST_REPO` vers la révision amont épinglée. Ils n'accèdent pas au réseau.

Le manifeste du package évaluateur a seulement été remis en cohérence avec son
fichier modifié. Le scope-map historique reste intact : sa présence ne permet
pas de qualifier cette nouvelle source. La CI actuelle conditionne encore la
campagne terminale à PR386. Un futur parcours de qualification doit faire
l'objet d'un successeur vérifié du protocole et d'un véritable job Windows.
