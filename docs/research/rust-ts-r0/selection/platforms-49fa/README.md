# Observations CI natives — head `49fa983`

Cette archive publie les observations locales déjà collectées du [run39103858448](https://github.com/hoklims/semctx/actions/runs/39103858448), head `49fa9830dcde149647323b3e1fe7d9b9e1f6d5e9`. Elle n’effectue aucune nouvelle requête ni exécution.

Les rapports indépendants constatent les quatre mêmes variantes **DEVELOPMENT** sur les builds optimisés natifs Linux/x86_64, macOS/ARM64 et Windows/x86_64 : JS valide, JS malformé, TS BOM+CRLF+astral et contrôle de ligne. Les Outcomes de transport, les contrôles receiver, les requêtes, les projections et les captures source sont conservés. Le contrôle de PATH vide est propre à Unix et n’est pas crédité à Windows. Les archives de tests produit sont également retenues.

Cette portée ne constitue ni une qualification sémantique générale, ni R0, ni `READY_TS_NATIVE`, ni un verdict CI global vert. Ces observations concernent le producteur C1 publié à ce head, pas le producteur C2 externe. Les hashes du helper sont joints aux Outcomes, mais aucun binaire du helper ne figurait dans les archives optimisées examinées. Les observations de lectures SDK ne prouvent ni lecture des100fichiers fournis, ni acquisition cohérente, ni sandbox système.

`report-original.json` est la copie exacte du premier rapport, où deux plateformes optimisées étaient encore en attente. `report-followup.json` ajoute les observations macOS et Windows sans réécrire cette histoire. Les snapshots du run restent historiques et le followup conserve l’état global en attente ; aucune consultation plus récente n’est faite ici.

Le shard Windows1/4 a échoué dans `packages/app-services/test/codex-plugin-metadata.test.ts:271`, test « Codex sidecar snapshot observations reject same-bytes inode replacement ». Son fichier est inchangé depuis la base selon l’observation conservée. Le log, son receipt et ses streams sont inclus. Aucun correctif, retry ou skip n’a été effectué ; cette observation ne démontre ni intermittence ni cause racine, et n’établit pas un échec du candidat natif. Les anciens tests ignorés signalés dans le log d’outillage Linux restent visibles et ne sont pas crédités comme couverture native.

## Contenu et identités

- `ci-49fa-evidence.tar.gz.b64` : bundle déterministe contenant199membres de données/captures issus des neuf ZIP,51fichiers bruts de métadonnées/logs/plan, et les trois index internes.
- `evidence-manifest.json` : tailles et SHA256 des250fichiers bruts retenus.
- `archive-inventory.json` : digest des neuf ZIP originaux, métadonnées API, hashes de chaque membre et exclusions explicites.
- `original-path-aliases.json` : correspondances vers les fichiers et membres portables ; les chaînes de chemins capturées dans les JSON originaux sont inchangées.
- `record.json` : identités du bundle, portée, vérification locale et effort frais distinct de C2.

Les trois exécutables optimisés ELF/Mach-O/PE sous `target/release` sont exclus. Aucun ZIP original, répertoire `target`, exécutable natif ou `.rlib` n’est republié. Leurs hashes et URLs d’artefacts restent identifiés dans l’inventaire et les rapports ; leur disponibilité future en téléchargement n’est pas garantie. Les données retenues permettent d’examiner les observations archivées, pas de réexécuter ces binaires à partir de cette publication.

## Lecture hors ligne

Le payload base64 historique a été retiré du dépôt. L’[index local](../../evidence/archive-index.json)
conserve son identité et ses citants ; les octets restent uniquement sur le Mac du
propriétaire sous la décision du 20 octobre 16:39. Voir le [guide d’accès local](../../evidence/README.md).
Depuis la racine du dépôt, restaurer cette seule archive dans un nouveau répertoire :

```sh
python3 tools/rust-ts-r0/qualification/fetch_evidence.py \
  --source-dir "$HOME/semctx-evidence/t00/20261020" \
  --archive selection--platforms-49fa--ci-49fa-evidence \
  --output /tmp/semctx-t00-ci-49fa

tar -tzf /tmp/semctx-t00-ci-49fa/selection--platforms-49fa--ci-49fa-evidence.tar.gz
```

Tous les membres du tar ont des chemins relatifs vérifiés. Aucun chemin absolu capturé sur les hôtes CI n’est utilisé pour l’extraction. Les bytes de chaque membre ont été comparés après un aller-retour local base64/gzip/tar ; aucune suite CI ni expérience sémantique n’a été relancée. La création a eu lieu sur macOS, avec Python standard, à partir des seules données locales.
