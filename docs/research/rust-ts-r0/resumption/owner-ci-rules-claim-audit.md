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
