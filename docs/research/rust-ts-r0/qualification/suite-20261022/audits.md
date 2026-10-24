# Audits indépendants de Phase A

Auteur : `/root`. Auditeur des claims : `/root/suite_a_qualification_audit`.
Revue de mécanisme : `/root/suite_a_proof_review`. Revue de spécification :
`/root/suite_a_spec_review`. Revue de standards : `/root/suite_a_standards_review`.
Aucun auditeur n’a lu le corpus réservé ni modifié le candidat.

Verdict de mécanisme : PROOF_ADEQUATE, limité aux comparaisons de la suite.
Le contournement `actual_filter` a été démontré puis rejeté par le vrai point
 d’entrée ; attendu faux sans filtre rejeté, restauration PASS. Seize mutations
 des faits d’extraction ont été rejetées, restaurations PASS. Les 69 comparateurs
 ont passé indépendamment sur macOS arm64. Le manifeste de 321 unités a été
 régénéré indépendamment, identique octet à octet :
`3a6d9660881316032e1b9f5f4eb47f5b25c504a5d7d1ee6dc0f6bceb29780540`.
Preuves conservées hors Git dans
`/Users/sebastien/semctx-evidence/t00/20261022/suite-a/proof-integrity-review/`.
Ce verdict seul ne prouve aucune campagne native ni qualification.

Le ledger ci-dessous reproduit l’audit final du child dédié.

| Claim | Authority | Mechanism | Scope | Named behavioral oracle | Status | Failure mechanism |
|---|---|---|---|---|---|---|
| Candidat et attentes gelés avant les campagnes | Addendum propriétaire A.6–A.8 ; `candidate-freeze-suite-20261022.json` | Commit candidat `02b055e3`, empreintes des recettes, binaires, helper et SDK | macOS arm64 et Linux aarch64 | `replay::verify_sources` et quatre rapports liés au gel | held | Toute modification postérieure des attentes ou du candidat invaliderait la liaison |
| 79 projections précédemment bornées sont qualifiées en Phase A | Addendum A.3 ; registre canonique | Témoins et supports alloués par propriété, tous verts sur les deux plateformes | `5,10,11,48,57,60,63,65,68,70,72,73,74,76,78,79,83,85,96,104,105,122,124,127,128,130,132,133,135,136,137,138,139,140,141,142,143,144,145,146,147,148,149,150,151,152,153,154,155,157,160,161,162,163,164,165,172,173,174,176,181,184,187,188,189,193,194,195,196,206,207,208,215,216,217,218,219,222,239` | Unités nommées de `report-macos.json` et `report-linux.json` | held | Le crédit reste limité aux champs et relations enregistrés |
| 28 manques antérieurs sont fermés en Phase A | Addendum A.2 ; propriétés cumulatives canoniques | Témoins supplémentaires associés individuellement aux propriétés | `7,8,9,28,29,30,31,32,33,34,35,36,37,38,39,156,158,166,182,183,185,186,190,191,214,221,230,231` | Unités `SUITE-*` vertes dans les deux rapports supplémentaires ; ligne 186 : `P04`, `SUITE-extract-closest-jsdoc`, `SUITE-outline-30` | held | Une association de famille ou de voisinage source sans témoin propre ne recevrait aucun crédit |
| Les 107 lignes qualifiées possèdent une preuve explicite par propriété | Exigence projet « no guarantee without a green oracle » | `properties[].phaseAQualification` contient plateforme, unité, rapport, recette et cible ou relation exacte | Toutes les propriétés des 107 lignes | Rapports macOS/Linux et recettes référencées | held | Aucun tableau de preuve qualifié n’est vide ; aucune preuve qualifiée n’est dépourvue de cible ou relation |
| Les quatre propriétés auparavant sans liaison sont explicitement closes | Registre canonique | `/157/1` → `ORD-LINK-NO-ARG`; `/188/1` → `P10`; `/206/2` et `/208/1` → variantes `ORD-CALLABLE-DECLARATION-PAIR` | Quatre propriétés, huit enregistrements plateforme | Unités 282, 59, 308 et 309, vertes sur macOS/Linux | held | Disparition d’un des deux résultats plateforme |
| Les relations sans cible scalaire sont explicitement tracées | Recettes gelées | `exactComparedRelations` enregistre observations, cible, transformation et égalité attendue | `SEM-KEY-*` et `P09-outline-logical-set::digest-relation-{01,02}` | Relations vertes des rapports macOS/Linux | held | Relation absente, transformation différente ou égalité observée incorrecte |
| 105 contrats observables précis sont déclarés | Décision propriétaire A.1 | `consumer-observable-contracts.json` décrit sites API, prédicat, entrées, opération, cibles, invocation TS 5.9.3 et pass/fail | `12–27,40–47,49–56,58,59,61,62,64,66,67,69,71,75,77,80–82,84,86–95,97–103,106–121,123,125,126,129,131,134,159,177–180,197–205,209–213` | Aucun oracle vert par site | target | Mapping activation/contrôle indépendant encore incomplet ; zéro crédit d’exécution |
| Qualification Phase A des 133 lignes restantes | Addendum A, objectif de maximisation | Ajouter les témoins, contrôles ou frontières nommés dans chaque ligne | `0,1,2,3,4,6,12–27,40–47,49–56,58,59,61,62,64,66,67,69,71,75,77,80–82,84,86–95,97–103,106–121,123,125,126,129,131,134,159,167–171,175,177–180,192,197–205,209–213,220,223–229,232–238` | Aucun oracle vert complet | target | Propriété, contrôle, support ou frontière consommateur manquant |
| Qualification terminale R0 du candidat | Autorité R0 ; addendum séparant Phase A et admission | Windows natif, audit/admission et fermeture terminale | `0–239` | Oracle Windows/admission absent | contradicted | Windows non exécuté et audit/admission non clos |
| ARB-002/003/004 accordent du crédit | Addendum A.8 | NONPASS bruts et `qualification_credit: 0` | UTF16, émission `importHelpers`, dialecte `7.1.0-dev` contre `5.9.3` | `ENC::UTF16LE-lone-high-surrogate`, `N17c-importhelpers-es5-actual-emission`, `ORD-DIALECT-CAPABILITY` | contradicted | Les arbitrages conservent le NONPASS sans crédit |
| `SUITE-outline-3` et `SUITE-outline-5` qualifient une capacité native | Politique de qualification | Champs exacts verts, capacité native inconnue | Deux unités supplémentaires | États `NATIVE_PRODUCT_CONTEXT_UNKNOWN_OR_UNIMPLEMENTED` | contradicted | L’unité complète reste NONPASS et non créditée |

Conclusion réconciliée : 107/240 qualifiées pour les seules propriétés cumulatives
finies sur macOS arm64 et Linux aarch64. R0 terminal reste 0/240. Les 133 lignes
restantes et les 105 contrats déclaratifs ne reçoivent aucun crédit supplémentaire.
Aucun push, action GitHub ou CI n’appartient à ces preuves locales.
