# T00 — lot 3, 23 octobre 2026

**0/13 obligations qualifiées** sur le périmètre public fini macOS arm64/Linux aarch64. R0 terminal : **0/13**. Tous les champs `formalR0ObligationQualified` et `allTargetQualified` restent `false`. Windows natif, macOS x86_64 et Linux x86_64 ne sont pas exercés.

[Tableau machine](obligations-qualification-lot3-20261023.json) · [Manifeste de campagne](campaign.json)

Candidat observé : `02b055e3ca3c96d7c4b8ab015aea607507a6053f` ; oracle indépendant : `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`, TypeScript 5.9.3. Producer et helper inchangés. Les binaires gelés sont réutilisés ; les 209 qualifications antérieures ne sont pas recampagnées. Les attendus ne sont jamais réécrits.

| Comparaison | macOS arm64 | Linux aarch64 | Portée |
| --- | --- | --- | --- |
| Configuration complète | 57/60 | 57/60 | Trois target6046 NONPASS par hôte |
| Missing-inherited, même racine oracle/natif | 3/3 | 3/3 | Aucun attendu normalisé |
| Workspace | 2/3 | 2/3 | installed-invalid-module6046 NONPASS |
| Résolution de module, 9 fixtures × live/snapshot | 18/18 | 18/18 | Sortie string/undefined complète ; capture native, pas realpath live |
| Propriétaire, phases sémantiques complètes | 11/12 | 11/12 | nameless NONPASS productContext ; zéro crédit |
| Répertoire/repli de bibliothèque | Oracle TS seulement | Oracle TS seulement | Frontière SDK native distincte, pas équivalence du helper |

| Index | Consommateur | Statut | Raison |
| ---: | --- | --- | --- |
| 23 | `inspectModuleConfiguration` | not_qualified | Dépend de la décision dialecte (lot 4) : diagnostic 6046 target différent dans trois modes. Les trois missing-inherited sont désormais exacts, sans normalisation. |
| 26 | `inspectModuleConfiguration > <callback@409>` | not_qualified | Dépend de la décision dialecte (lot 4) : le callback produit un message 6046 target différent de TS 5.9.3 dans trois modes. |
| 27 | `inspectModuleConfiguration > readFile` | not_qualified | Dépend de la décision dialecte (lot 4) : lectures inherited exactes, mais le résultat cumulatif conserve les trois NONPASS target 6046. |
| 198 | `resolveConfiguredModule` | not_qualified | 18/18 comparaisons finies par plateforme; argument system par défaut non évalué par les callers. repositoryRoot absent, fuite canonique et erreurs realpath non exercés; aucune fermeture de tous les prédicats. |
| 204 | `resolveConfiguredModule > realpath` | not_qualified | Branche realpath fichier régulier observée; alternative directoryExists, delegate absent/undefined, symlinks et erreurs live non exercés. Le natif observé utilise une capture. |
| 209 | `retainedFunctionOwnerCoordinate` | not_qualified | 11/12 témoins exacts par plateforme via le caller sémantique réel; aucun couple active body===undefined ou name===undefined. nameless produit un nom vide et échoue productContext : zéro crédit. |
| 220 | `typeScriptLibraryDirectory` | not_qualified | Helper/fallback TS 5.9.3 exécuté sur les deux hôtes. Le natif requiert un SDK explicite et ne présente pas de surface équivalente de découverte du répertoire/repli ambiant; identité SDK et présence/absence ne qualifient pas ce helper. |
| 223 | `workspaceLinkedSystem > allowedDirect` | not_qualified | Dépend de la décision dialecte (lot 4) : propriété cumulative installed-invalid-module NONPASS, diagnostic 6046 natif sans none/amd/system/umd. Les opérations système et le contrôle above-repository sont exacts. |
| 224 | `workspaceLinkedSystem > directoryExists` | not_qualified | Dépend de la décision dialecte (lot 4) : propriété cumulative installed-invalid-module NONPASS, diagnostic 6046 natif sans none/amd/system/umd. Les opérations système et le contrôle above-repository sont exacts. |
| 225 | `workspaceLinkedSystem > fileExists` | not_qualified | Dépend de la décision dialecte (lot 4) : propriété cumulative installed-invalid-module NONPASS, diagnostic 6046 natif sans none/amd/system/umd. Les opérations système et le contrôle above-repository sont exacts. |
| 226 | `workspaceLinkedSystem > installed` | not_qualified | Dépend de la décision dialecte (lot 4) : propriété cumulative installed-invalid-module NONPASS, diagnostic 6046 natif sans none/amd/system/umd. Les opérations système et le contrôle above-repository sont exacts. |
| 227 | `workspaceLinkedSystem > readFile` | not_qualified | Dépend de la décision dialecte (lot 4) : propriété cumulative installed-invalid-module NONPASS, diagnostic 6046 natif sans none/amd/system/umd. Les opérations système et le contrôle above-repository sont exacts. |
| 228 | `workspaceLinkedSystem > realpath` | not_qualified | Dépend de la décision dialecte (lot 4) : propriété cumulative installed-invalid-module NONPASS, diagnostic 6046 natif sans none/amd/system/umd. Les opérations système et le contrôle above-repository sont exacts. |

La cause 6046 est établie dans la dépendance `780dc512d64f40afebffa6a7028207649fb7ed1c` : `target` ajoute es2025/es2026 et masque es5 ; la map module ne contient pas none et le formatter retire les clés dépréciées amd/system/umd. Ces trois dernières valeurs restent dans l’enum : leur omission du diagnostic ne prouve pas leur refus en entrée. La décision dialecte relève du lot 4 selon le brief. Aucun texte de diagnostic ni contournement n’est ajouté au producer.

ARB-002/003/004 : **zéro crédit**, séparé des PASS ordinaires ; les NONPASS sont conservés. Aucune admission R0 ne découle de ces preuves.

Les résultats par propriété, les couples activation/contrôle observés et les propriétés sans preuve sont dans le tableau JSON. Les manifestes externes référencés dans `campaign.json` conservent tailles et SHA256 des requêtes, oracles, sorties complètes et journaux. Ces empreintes assurent leur liaison aux octets conservés, sans attester un environnement non exécuté.

Les campagnes config précèdent un garde d’entrée `fixtureSource` ajouté pour refuser une source absente ; les 60 entrées contenaient déjà leur source. Les tests du garde ont été exécutés ensuite. La métadonnée nameless est corrigée après la campagne owner ; les sorties brutes antérieures restent intactes. Les hashes des scripts livrés et la provenance productrice sont distingués dans les synthèses externes.

Les deux revues indépendantes sont identifiées dans le manifeste. Leurs conclusions restent limitées aux preuves examinées ; la revue des vérificateurs ne vaut pas qualification des obligations.

Validation locale : 24 tests ciblés / 59 assertions PASS sur chaque plateforme ; quality et docs:check PASS sur macOS arm64. **verify:pr NONPASS (exit101)** dans les tests Rust de tools/gates, après réussite de Bun. Le rejeu avec la cible Cargo commune reproduit deux collisions entre fixtures de mêmes noms ; le test parallèle à cibles propres passe 8/8. Ce diagnostic ne transforme pas la gate échouée en PASS. Aucun correctif des gates hors périmètre, aucune CI exécutée.
