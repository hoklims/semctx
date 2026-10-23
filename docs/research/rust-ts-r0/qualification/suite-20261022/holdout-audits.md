# Audits du contrat réservé avant ouverture

Auteur : `/root`. Auditeur des claims : `/root/suite_a_qualification_audit`.
Revue adverse : `/root/suite_a_proof_review`. Revue standards/spécification :
`/root/suite_a_standards_review`. Aucun contenu réservé lu pendant ces audits.

Verdict adverse final : PROOF_ADEQUATE pour le runner B courant et ses données
synthétiques, sans résultat réservé ni compatibilité privée démontrée. Les 31
scénarios passent ; retirer le garde de cohérence SDK donne un échec, remplacer
l’intersection par une union donne un échec, restaurer les octets donne 31 PASS.
SDK incohérent refusé avant invocation ; seconde tentative refusée ; vrai
subprocess avec logs en 600 ; pré-spawn refusé avec zéro processus annoncé.
Preuves hors Git dans `/Users/sebastien/semctx-evidence/t00/20261022/holdout-review/`.
Audit adverse sur macOS arm64/Bun 1.4.3 ; fil principal : 31 tests verts également
sur Linux aarch64 dans l’image imposée, réseau none. Windows non exercé.

Ledger complet du child dédié, actualisé pour le manifeste B concret :

| Claim | Authority | Mechanism | Scope | Named behavioral oracle | Status | Failure mechanism |
|---|---|---|---|---|---|---|
| Le reçu engage 23 cas, 26 variantes, huit familles et TS 5.9.3 | Reçu public ; addendum B.1 | Comptes et baseline gelés | Métadonnées publiques | Test `complete public family accounting`, vert macOS/Linux Bun 1.4.3 | held | Reçu modifié ou comptes incohérents |
| Le payload privé respecte le format JSON choisi | Aucune ; reçu `nativeAnalysisReady:false`, aucun schéma publié | Aucun mécanisme avant ouverture | Engagement privé `expectationsSha256` | Aucun oracle vert | contradicted | Compatibilité inconnue, correctement déclarée |
| Le protocole natif public est strict et fermé | Addendum B.1–B.2 | `parseNativeHoldout`, champs fermés, transformation obligatoire, comptes familiaux exacts | Format choisi pour l’exécution native | 14 scénarios d’acceptation/refus de format verts | held | Champ inconnu, attendu/transformation absent, famille ou compte incorrect |
| Une entrée incompatible donne 26 erreurs de format, zéro comparaison et zéro invocation | Addendum B.1 | Parsing avant invocation, `FORMAT_NONCONFORMING` | Bundle complet | Test `nonconforming frozen input…` vert | held | Invocation ou adaptation après rejet |
| Les erreurs de format sont ventilées exactement par famille publique | Addendum B.1 | `byPrimaryFamily[].formatFailure = row.variants` | Huit familles, zéro inclus | Assertion familiale du test de format vert | held | Compteur familial différent du reçu |
| Aucun attendu, champ ou assertion n’est adapté | Addendum B.1–B.2 | Hash exact, schéma fermé, transformations bornées | Entrée acceptée ou rejet global | Tests filtered/arbitration/missing expected/transform/unknown field verts | held | Fallback, traduction ou correction après ouverture |
| PASS exige une comparaison complète et verte | Addendum B ; ADR 0037 | `comparisonCompleted`, cibles/observations validées, relations liées au manifeste, états connus | Une variante conforme | Scénarios pass/nonpass/pre-comparison-refusal verts | held | PASS sans checks/relations complets ou avec MISMATCH |
| `variantsReported` et `variantsCompared` sont distincts | Contrat | Lignes liées versus unités dont tous checks/relations ont un état final connu | Plateforme et famille | Refus préalable : 26 reported, 0 compared | held | UNKNOWN, refus précoce ou rapport incomplet compté comme comparaison |
| Défaillance observer = EXECUTION_UNAVAILABLE, sans faux résultat unitaire | Contrat corrigé | Rapport absent/étranger/incomplet ou exit incohérent vide les résultats | Campagne entière | Scénarios wrong-binding/missing-unit/nonzero/panic/missing-report verts | held | NONPASS artificiellement attribué à une variante |
| Tentatives et processus lancés sont séparés | Contrat | `observerInvocationAttempts` et `observerProcessInvocations` | Une plateforme | throw-before-spawn vert | held | Échec pré-spawn présenté comme processus exécuté |
| Un seul observer est invoqué par plateforme | Addendum B.2 | Un appel à `invokeObserver` | Une plateforme | Scénarios d’invocation verts | held | Deuxième lancement par le runner |
| Seconde tentative dans le même dossier refusée | Contrat ; C.3 | mkdir exclusif, écritures wx | Dossier donné | Test de seconde invocation vert | held | Réutilisation/écrasement |
| Relance dans un nouveau dossier techniquement impossible | Aucune autorité de sécurité | Aucun verrou global | Expérience entière | Aucun oracle vert | contradicted | Opérateur pouvant choisir un autre dossier |
| Une seule exécution entre dossiers reste obligatoire | C.3 | Procédure de conduite de C | 26 variantes | Aucun oracle avant C | target | Relance manuelle après ouverture |
| Entrées/sorties privées dans le worktree refusées | B/C | Vérification lexicale et realpath | Entrée, sorties, fichiers joints | Test private input/output paths vert | held | Chemin direct ou résolu dans le dépôt |
| Racine privée 700, fichiers ramenés à 600 | Contrat | Précréation des logs, scellement récursif, refus des objets non réguliers | Arbre de sortie | Tests de modes logs/native report verts macOS/Linux | held | Objet non régulier ou mode divergent |
| stdout sans identifiant privé | B.1/C.5 | Agrégat séparé du record privé | Exécution simple et jointe | Sentinelle et smoke CLI joint verts | held | Publication de unitId, chemin, argv, source, attendu ou erreur |
| Y/26 ne compte que les PASS comparés | B.1/A.8 | pass AND compared ; crédit ARB zéro | Plateforme/famille | Scénarios pass/nonpass/refus verts | held | Format, refus ou ARB converti en PASS |
| Total conjoint = intersection exacte | B.1 | Jointure ordonnée unitId/famille/identités ; a.pass AND b.pass | Deux plateformes | Test intersection et smoke CLI joint verts | held | Somme, minimum, unité manquante ou identité étrangère |
| Records joints liés au même candidat/contrat | B.3 | Candidat, freeze, contrat, runner, reçu, engagement d’entrée | Deux records privés | Cas joint étranger/manquant verts | held | Identité ou cardinalité différente |
| Freeze exécutable profondément égal au manifeste candidat | B.3 | Hash puis isDeepStrictEqual, SDK inclus | Lane native | FROZEN_MANIFEST_INCOHERENT vert | held pour le mécanisme | Hash valide d’un manifeste différent |
| Manifeste B concret lie candidat A, runner, contrat, reçu, tests, runtimes et exécutables | B.3 | `holdout-freeze-20261022.json`, SHA256 et correspondance profonde | Candidat 02b055e3 ; deux lanes | Deux public-preflights verts sur dix identités chacun ; SHA reçu/tests concordants | held pour l’identité actuelle | Artefact, runtime ou manifeste modifié |
| Gel B immuable autorisant l’ouverture C | B.3 exige commit local dédié | Manifeste indexé ; ouverture interdite avant commit | Transition B→C | Aucun oracle de commit à l’heure de cet audit | target | Index encore modifiable ; effet seulement après commit B |
| Sept engagements publics vérifiés avant invocation | C.2 | Procédure privée C | Archive/pièces privées | Aucun oracle avant C | target | Ouverture/invocation prématurée |
| Résultat attendu du privé avant ouverture | Aucune | Aucun run privé | 26 variantes | Aucun oracle | contradicted | Format et résultat réels inconnus |
| Holdout suffisant pour admission globale/R0 | Reçu, ADR 0037 et contrat l’excluent | formalR0ObligationQualified=false | Projection bornée | Tests d’agrégat/publication verts | contradicted | Windows, dépendances, stabilité, obligations non fermés |
| 31 scénarios synthétiques qualifient le comportement du runner | Suite Bun 1.4.3 | Acceptation, refus, campagnes et contrôles complémentaires | Synthétique macOS/Linux | scripts/t00-holdout-runner.test.ts vert | held | Aucune preuve de compatibilité ou résultat privé |

Les préflights publics n’ont pas ouvert le corpus. Leur gel a pour SHA256
`daedaf79ef86923cd01ae198981508a722b73460c0f52f54f7d82c78410b2961`.
La transition effective vers C sera consignée après le commit local B, sans
modifier producer, helper, contrat ni runner. Aucun verdict R0 n’est enregistré.
