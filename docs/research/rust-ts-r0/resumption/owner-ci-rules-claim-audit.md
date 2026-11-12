# Owner CI/publication rules: independent claim ledger

## Historical CI rules before the exact T00 exception

The six-row audit below is preserved verbatim as the earlier2026-10-19 record.
Its absolute workflow-edit prohibition is historical: the later approved exception
below supersedes it only for the enumerated T00 correction. Other prohibitions
and future evidence requirements remain operative.

Author task: `/root/retained_unresolved_evidence_author`.
Auditor task: `/root/retained_unresolved_evidence_author/owner_ci_rules_auditor`,
a fresh distinct child with the dedicated `design-claim-auditor` role. The caller
`/root` is not the documentary author. The child received only the CI/publication
scope and approved owner rules, without an expected verdict. It returned the
complete six-row ledger below before author evidence reading or drafting.
No Rust behavior, historical behavioral checkpoint, budget decision, reserved
payload or external event was audited. All six claims are approved prospective
targets; this audit supplies no green execution oracle.

The [CI rules record](owner-ci-rules-20261019.json) records the retained rules.
The following ledger is the dedicated child's complete final result.

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
|---|---|---|---|---|---|---|
| Push only complete coherent milestones after green local `verify:pr` with Bun `1.4.3` and `GIT_CONFIG_GLOBAL` absent. | Sébastien’s retained rule, confirmed by « Les autres règles restent valables »; relayed by `/root`. | Withhold push until the exact milestone head passes under the pinned environment. | Future pushes to `rust/365-t00` / PR 386. | Exact-head local `verify:pr`; no current milestone result supplied. | target | An incomplete milestone is pushed, or verification is missing, red, or run under another environment. |
| Do not launch CI manually, including `workflow_dispatch`. | Same approved owner decision. | Abstain from every manual-dispatch path. | T00 CI runs after the correction. | GitHub Actions run-event provenance; none supplied or inspected. | target | Any manual CI launch occurs. |
| Make no further workflow changes. | Same approved owner decision. | Freeze workflow files at the approved published state. | Remaining T00 workflow definitions. | Exact-head workflow diff against the approved baseline; no result supplied. | target | Any workflow definition is edited. |
| Post no GitHub comments. | Same approved owner decision. | Abstain from issue, PR, review, and commit comments. | All GitHub comments associated with this continuation. | GitHub comment-event audit; none supplied or inspected. | target | Any GitHub comment is posted. |
| Run Windows Rust tests if an available permitted route exists; infer no Windows success without a green execution. | Same approved owner decision. | Use a permitted non-manual route when available and bind success to its result. | Current correction’s Windows Rust behavior. | Exact-SHA Windows Rust test result; none supplied. | target | An available route is skipped, a forbidden route is used, or success is claimed without a green result. |
| Do not merge, release, or deploy. | Same approved owner decision. | Withhold merge, release, and deployment actions. | T00 branch, PR, and resulting artifacts. | Merge/release/deployment event audit; none supplied or inspected. | target | The PR is merged, a release is created, or an artifact is deployed. |

Author reconciliation: current record/README publish these CI constraints only.
Future milestones require their own named execution evidence; no constraint is
presented as already executed or externally enforced. No budget, qualification
or R0 conclusion is added.

## Approved T00 CI exception 2026-10-19

Author task: `/root/retained_unresolved_evidence_author`.
Fresh auditor task: `/root/retained_unresolved_evidence_author/ci_exception_claim_auditor`,
a distinct child with the dedicated `design-claim-auditor` role. The caller
`/root` is not the author. The child received the exact narrow owner decision and
paths without an expected verdict; its complete thirteen-row ledger was returned
before author evidence reading or drafting. No current check, performance or CI
result was inspected or asserted; no historical R0 corpus was audited.

The following is the complete new child ledger. Approved future constraints
remain targets; the earlier absolute workflow-edit claim is rejected only within
this exact exception.

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
|---|---|---|---|---|---|---|
| « Make no further workflow changes » demeure une règle actuelle absolue. | Ancienne règle relayée ; remplacée partiellement par l’instruction directe plus récente « correctif CI approuvé sur T00 uniquement […] règle 4 […] levée pour exactement ce changement ». | L’ancien gel absolu ne représente plus l’autorité courante. | T00, pendant le correctif approuvé. | Diff exact-head du workflow contre le périmètre énuméré. | contradicted | Le document présente encore le gel absolu comme actuel. |
| Une exception autorise exactement le correctif CI énuméré, uniquement sur T00 ; toute autre modification de workflow reste interdite. | Décision directe précitée, relayée par `/root`. | Borner le diff aux fichiers et changements approuvés. | `rust/365-t00` / PR 386 ; aucune modification de `main`. | Diff exact-head contre la liste approuvée. | target | Modification hors liste, sur une autre branche, ou élargissement implicite. |
| Ajouter `tools/rust-ts-r0/Cargo.toml` à `TOOL_MANIFESTS` et ajouter le test de gate correspondant. | Point 1 de la décision approuvée. | Étendre l’inventaire possédé et exercer la détection du manifeste T00. | `tools/gates/src/rust_workspace.rs` et son test. | Test de gate Rust workspace couvrant explicitement `tools/rust-ts-r0/Cargo.toml`. | target | Manifeste absent de l’inventaire ou test incapable de détecter sa régression. |
| Le workflow exécute une commande Cargo unique, non filtrée, avec `--locked --release`, couvrant bibliothèque, binaire et intégrations. | Point 2 de la décision approuvée. | `cargo test --manifest-path tools/rust-ts-r0/Cargo.toml --locked --release`, sans `--test` ni filtre. | Étape CI T00 uniquement. | Exécution publique de cette commande dans l’unique run `pull_request`. | target | Filtre ajouté, commande fragmentée, cible omise ou résultat non vert. |
| `RUST_TEST_THREADS=1`, `CARGO_BUILD_JOBS=2` et `GOPORT_LIB_SNAPSHOT=0` ne sont ajoutés à l’étape T00 que si leur nécessité est démontrée ; les snapshots actifs sont préférés lorsqu’ils sont valides. | Point 3 de la décision approuvée. | Commencer avec les snapshots actifs ; n’appliquer les variables qu’au step T00 et sur preuve de nécessité. | Étape Cargo T00, sans effet global. | Run `pull_request` T00 avec snapshots actifs, puis résultat comparatif du même step si un réglage devient nécessaire. | target | Variables globales ou préventives, désactivation injustifiée des snapshots, ou nécessité non étayée. |
| Supprimer `workflow_dispatch` sans autoriser aucun lancement manuel de CI. | Point 4 et maintien explicite de l’interdiction des lancements manuels. | Retirer le trigger manuel ; laisser uniquement la voie `pull_request` autorisée. | Workflow T00. | Provenance `event=pull_request` de l’unique run et inspection native des triggers du workflow exact-head. | target | Trigger manuel conservé, ajouté ailleurs ou run lancé manuellement. |
| Conserver la politique issue de `main#399` et les SHA complets des actions. | Point 5 de la décision approuvée. | Préserver les règles existantes et les références d’actions immuables. | Workflow T00 modifié. | `actionlint`, `zizmor` et diff exact-head contre la politique `main#399`. | target | Politique affaiblie ou action référencée par tag/branche/SHA incomplet. |
| Avant publication, exécuter `actionlint`, `zizmor`, les gates, la release R0 et `verify:pr` sous Bun `1.4.3` avec `GIT_CONFIG_GLOBAL` absent. | Point 6 et règle de publication conservée. | Tous les oracles doivent être verts sur le même head de milestone. | Correctif CI T00 préparé localement. | Résultats exact-head nommés : `actionlint`, `zizmor`, gates, release R0, `verify:pr`. | target | Oracle omis, rouge, exécuté sur un autre head ou dans un environnement différent. |
| Effectuer un seul push après tous les contrôles verts. | Point 6 de la décision approuvée. | Regrouper le correctif en milestone cohérent puis publier une fois. | Branche T00 / PR 386. | Correspondance entre SHA vérifié et SHA poussé. | target | Push anticipé, multiple, ou SHA poussé différent du SHA vérifié. |
| Observer l’unique run `pull_request` produit par ce push. | Point 7 de la décision approuvée. | Aucun rerun ni dispatch manuel ; suivre le run déclenché naturellement. | CI du correctif T00. | Provenance et unicité du run GitHub Actions `pull_request`. | target | Plusieurs runs provoqués, rerun manuel, ou provenance non `pull_request`. |
| Comparer les durées par OS à la plage historique de 22–43 minutes sans en déduire prématurément une performance. | Point 7 et limite explicite « no claim current checks/performance/CI green ». | Relever les durées par OS après achèvement du run et les comparer à la plage. | Jobs OS de l’unique run. | Durées finales par OS du run exact-SHA. | target | Comparaison avant achèvement, agrégation masquant un OS, ou conclusion de performance sans résultat. |
| Ne revendiquer aucun check, résultat de performance ou CI vert avant les exécutions correspondantes. | Limite probatoire explicite de la décision relayée. | Maintenir les résultats comme futurs et non acquis. | Record, ledger et documentation T00. | Conclusions exact-SHA des oracles locaux et de l’unique run `pull_request`. | target | Promotion d’une contrainte ou d’un lancement en preuve verte. |
| Maintenir le budget `8fdc` inchangé. | Instruction directe relayée : « budget 8fdc unchanged ». | Refuser toute modification de ce budget dans ce correctif. | Correctif CI T00. | Diff exact-head contre l’ancre budgétaire `8fdc`. | target | Budget modifié ou documenté comme indéterminé. |

Reconciliation: the original six rows remain dated history. The current record
replaces the absolute workflow-edit ban with exactly the owner-approved T00
exception; every unrelated workflow edit stays prohibited. Manual launches,
comments, milestone evidence, Windows evidence limits and merge/release/deployment
prohibitions remain operative. Here “release R0” means local release-mode tests,
not a published release or a qualification decision. Existing8fdc authority and
counters are preserved; no new budget decision is made. No target is promoted to
an execution, CI-green or performance claim.

## Failed 623 CI and local resource receipts 2026-10-19

Author task: `/root/retained_unresolved_evidence_author`.
Fresh auditor task: `/root/retained_unresolved_evidence_author/ci_memory_receipt_claim_auditor`,
a distinct dedicated `design-claim-auditor` child. The caller `/root` is not the
author. It returned the complete initial sixteen-row ledger below before author
reading of the new evidence or drafting. Earlier owner-policy ledgers remain
unchanged. This audit concerns actual retained receipts and the six-source local
lifecycle patch; it changes no policy, budget, qualification or campaign result.

The initial audit predates the local lifecycle commit; its uncommitted-state row
is retained as that historical snapshot. The complete two-row post-commit
supplement follows. Native measurements retain their exact v1/v2 provenance;
current v3 tests do not turn an earlier measurement into a v3 memory guarantee.
The historical green-v1 row corrects the earlier inaccurate invocation wording
from its retained E0433 compiler message, at root’s request; no current oracle is changed.
Evidence filenames resolve under the JSON's `receiptEvidenceRoot`, with hashes
in `receiptEvidenceSha256`. No archive is duplicated.

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
|---|---|---|---|---|---|---|
| Le milestone approuvé `623c8676…` a produit exactement un push et un run automatique `pull_request`, GitHub run `39313136266`. | Décision propriétaire relayée par root et reçu GitHub conservé. | Le push de l’exact SHA déclenche le run automatique. | Milestone `623c8676…` uniquement. | Audit de provenance GitHub du run `39313136266`, lié à `623c8676…`. | held | Push supplémentaire, run manuel ou provenance/SHA différents. |
| Le run `39313136266` est vert ou démontre une amélioration de performance. | La règle propriétaire interdit toute conclusion avant succès des exécutions. | Les trois jobs Rust natifs terminent en échec. | Linux, macOS et Windows du run `39313136266`. | `ci-623-duration-results.json` et conclusions des trois jobs. | contradicted | Transformer des durées d’échecs précoces en performance validée. |
| Les durées observées sont Linux `9m10s`, macOS `13m37s`, Windows `14m16s`, contre `22m24s`, `40m46s`, `25m43s` auparavant. | Reçus horodatés du run et historique retenu. | Différence entre début et fin des jobs. | Temps écoulé avant échec uniquement. | Contrôle de cohérence `ci-623-duration-results.json` avec les timestamps des jobs. | held | Présenter ces valeurs comme durées de succès ou comme amélioration validée. |
| Les trois échecs CI sont des OOM démontrés. | Journaux CI natifs. | Les signatures terminales diffèrent et Linux ne nomme aucune OOM. | Run `39313136266`. | Contrôle des fins de `ci-623-linux.log`, `ci-623-macos.log`, `ci-623-windows.log`. | contradicted | Inférer une cause uniforme depuis des terminaisons différentes. |
| Linux reçoit un arrêt runner/SIGTERM et sort `143`; macOS termine par `SIGKILL 9`; Windows rapporte un échec d’allocation de `6 219 904` octets. | Journaux CI natifs complets. | Observation des messages terminaux respectifs. | Signatures d’échec, sans causalité supplémentaire. | Présence vérifiée des signatures terminales dans les trois journaux `ci-623-*`. | held | Qualifier Linux ou macOS d’OOM sans preuve additionnelle. |
| Le binaire de référence avant correction passe 244 tests avec `22 729 031 680` octets de RSS maximale et `38 480 701 568` octets de peak footprint. | Reçu `/usr/bin/time -l` et suite release locale. | Exécution sérialisée, snapshots désactivés. | Darwin arm64, Rust 1.95.0, binaire de référence local uniquement. | `ci-623-release-memory.stdout` PASS et `ci-623-release-memory.stderr`. | held | Généralisation à un autre OS, runner ou budget. |
| Libérer seulement les tables corrige la rétention mémoire. | Expérience intermédiaire v1. | 247 tests passent, mais RSS maximale `23 639 867 392`; le parse statique reste retenu. | Candidat intermédiaire Darwin arm64. | `native-program-release-memory-v1.*` et témoin `native-file-version-release-red.log`. | contradicted | Ignorer la durée de vie de `FileVersion` et du frontend parsé. |
| Le candidat v2 mesure `865 042 432` octets de RSS maximale, `712 771 264` octets de peak footprint et 248 PASS en `41.41s`. | Reçus locaux v2. | RAII complet, chemins enregistrés avant parse et `FileVersion` libérable. | Darwin arm64, exécution v2 uniquement. | `native-program-release-memory-v2.stdout/.stderr`, commande terminée avec succès. | held | Attribuer ces nombres à v3 ou à une autre plateforme. |
| Le candidat v3 possède exactement la mesure mémoire v2, garantit zéro fuite ou respecte un budget portable strict. | Aucun oracle v3 de mesure mémoire ni décision de budget nouvelle. | v3 renforce une assertion de test; le code de production reste identique, mais la mesure n’a pas été rejouée. | Candidat courant et plateformes supportées. | Aucun oracle mémoire v3/Windows/Linux vert; seulement la mesure v2 locale. | contradicted | Promotion d’une mesure antérieure en garantie universelle. |
| Le propriétaire RAII courant restaure d’abord le programme parent puis libère checker pool, tables et frontend; erreurs précoces, unwind imbriqué et première/répétition de parse empruntent cette fermeture. | Patch figé et contrat upstream épinglé examinés dans `native-program-spec-v1.md`. | `Drop`, enregistrement avant parse, `FileVersion` et chemin libérable reproduisent le cycle upstream. | Six fichiers, patch SHA-256 `4d179295…`, Darwin arm64. | Quatre tests `native_program::tests::*` verts dans `native-program-spec-v1-tests.log`, binaire SHA-256 `672cb093…`. | held | Ressource créée hors propriétaire, ordre restore/release inversé ou chemin non enregistré. |
| Le candidat v3 passe la suite release non filtrée et Clippy. | Journaux locaux courants et ancre v3 stable. | Exécution release complète puis lint `--all-targets --all-features -D warnings`. | Darwin arm64 seulement. | `native-program-all-release-v1.log`: 49 lib + 248 bin + 25 intégration = 322 PASS; `native-program-clippy-v1.log` PASS. | held | Étendre ce résultat à la matrice CI ou à un autre OS. |
| Le candidat compile pour Windows GNU. | Reçu de compilation croisée local. | Cross-check de toutes les cibles et fonctionnalités. | Hôte Darwin; aucune exécution Windows. | `native-program-windows-crosscheck-v1.log` PASS. | held | Présenter la compilation croisée comme test runtime Windows. |
| La correction est vérifiée en exécution sur Linux, macOS et Windows ou répare déjà la CI. | Aucun run du candidat courant sur Linux/Windows et aucun nouveau run CI. | Seuls macOS arm64 et un cross-check Windows sont verts. | Candidat local courant. | Absence d’oracle runtime trois OS; le dernier run public reste rouge sur `623c8676…`. | contradicted | Confondre compilation croisée, tests macOS et validation de matrice. |
| Le patch de cycle de vie modifie uniquement six sources et n’ajoute ni dépendance ni workflow. | `native-program-source-anchor-v3.json` et diff indexé. | Six SHA stables; diff `.github`, manifestes et locks vide. | Patch SHA-256 `4d179295…`. | Correspondance d’ancre v3, diff borné et suite release verte. | held | Modification hors six fichiers ou changement de manifeste/workflow. |
| La correction mémoire courante est déjà commitée ou publiée. | État Git local et dernier SHA public retenu. | Les six fichiers sont indexés au-dessus de `af5898cf`; ce commit ne contient que Workspace System, tandis que le run public reste sur `623c8676…`. | Worktree courant et PR existante. | `git status --short`, `git show af5898cf`, provenance du run `39313136266`. | contradicted | Attribuer le patch staged à `af5898cf` ou au head public. |
| Le log historique `native-program-release-green-v1.log` démontre un défaut comportemental. | Le log conserve une erreur de compilation Rust `E0433`: trop de mots-clés `super` dans un test. | La compilation échoue avant exécution du test; cette erreur est corrigée dans v2. | Compilation historique uniquement, sans effet sur les oracles courants retenus. | `native-program-release-green-v1.log`: `too many leading super keywords`. | contradicted | Confondre cette erreur de compilation avec une observation comportementale courante. |

Post-ledger supplement, same dedicated auditor, after the local source commit:

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
|---|---|---|---|---|---|---|
| La correction mémoire est désormais commitée localement sous `d448364d66775af44e3514efd1cc0cdb2606bba5`, enfant de `af5898cf`, avec exactement les six sources du patch figé. | État Git local courant. | Commit `fix(rust-r0): release native programs and captured parses`; 203 ajouts, 48 suppressions. | Commit local `d448364d`; aucune publication déduite. | `git show --stat --name-only d448364d` et `HEAD=d448364d`, contrôles PASS. | held | Attribuer le commit à un autre parent, y inclure des documents/workflows ou le présenter comme poussé. |
| Le commit `d448364d` possède une exécution CI courante ou une validation publique. | Aucun push ni run CI de ce SHA; root confirme le commit local non poussé. | Le dernier reçu public audité reste le run `39313136266` sur `623c8676…`. | CI distante du candidat `d448364d` uniquement. | Aucun oracle CI exact-SHA vert pour `d448364d`; `verify:pr` futur n’est pas encore une preuve. | contradicted | Réutiliser les résultats du run `623c8676…` ou les preuves locales comme CI de `d448364d`. |

Fresh final-CI-receipt supplement, same dedicated auditor; the earlier incomplete
snapshot is preserved unchanged:

| claim | authority | mechanism | scope | named behavioral oracle | status | failure mechanism |
|---|---|---|---|---|---|---|
| Le run `39313136266` du SHA `623c8676…` est définitivement `completed/failure` et provient de `pull_request`. | Reçu GitHub API frais. | Lecture des champs `event`, `headSha`, `status`, `conclusion`. | Ce run uniquement; l’ancien snapshot `in_progress` reste un reçu historique antérieur. | `ci-623-run-receipt-with-event.json`. | held | Remplacer l’historique temporel ou présenter le run comme vert. |
| Dans la fenêtre des 30 runs retournés, `39313136266` est l’unique run CI portant exactement `623c8676…`. | Liste GitHub API fraîche de 30 runs de branche. | Filtrage exact sur `headSha`. | Fenêtre retournée uniquement. | `ci-623-run-list-receipt.json`: un seul match exact-SHA. | held | Étendre cette unicité au-delà des 30 runs inspectés. |
| Ces reçus prouvent l’unicité globale de tous les runs ou de tous les actes externes liés au milestone. | Aucun inventaire exhaustif de tous les événements externes; un push reste une attestation d’acte observé. | La liste est bornée à 30 runs CI. | Historique externe global. | Aucun oracle exhaustif nommé. | contradicted | Transformer une fenêtre bornée et une attestation en garantie universelle. |

Reconciliation: all contradicted extrapolations are rejected in their dated
scope. The public run is completed/failure; its elapsed failed-job durations
establish no successful performance gain. Terminal signatures are kept distinct:
Linux runner shutdown/exit143 does not establish OOM, macOS SIGKILL establishes
no additional cause, and Windows names a failed allocation. The single push is
root's observed-act attestation; run uniqueness is limited to the returned30-run
window. The new lifecycle commit is local at recording, with no CI for its SHA.
Local v3 resource tests,322 release tests,Clippy and Windows cross-compilation
remain separate from the measured v2 memory run and from future native threeOS
execution. No zero-leak or portable-resource guarantee follows. Original owner
rules, exception, budget8fdc and prior ledgers are preserved; no qualification,
reserved, campaign or R0 credit is added.

## Three Rust jobs at9da7 — 2026-10-19 receipt

Author task: `/root/retained_unresolved_evidence_author`.
Fresh auditor task: `/root/retained_unresolved_evidence_author/reader_dialect_claim_auditor`,
a distinct dedicated child. The [complete22-row seven-column ledger](gap-reader-dialect-claim-audit.md)
contains every changed reader/dialect and CI9da7 claim, including the CI head,
job/overall distinction, test/qualification denominators, elapsed-time limit and
bounded publication attestation. It was returned and reconciled before these
receipts were drafted; this section does not substitute a shortened ledger.

`ci9da7Receipt` records run39322421229, automatic `pull_request` at9da7:
three native Rust jobs SUCCESS,322 tests each, elapsed Linux9m08s/macOS14m07s/
Windows19m52s. The retained overall snapshot is still `in_progress`; no globally
green run is asserted. Prior fbc debug jobs failed at22m24s/40m46s/25m43s, so this
comparison is not a normalized benchmark.322Rusttests and354qualificationunits
are separate denominators. No reader/dialect b098 CI result or full354 campaign
is inferred. One normal milestone push/no manual run is root's bounded observed-
act attestation, not an exhaustive global-event proof. All earlier failed623 and
local memory receipts, complete ledgers and owner rules remain unchanged.
