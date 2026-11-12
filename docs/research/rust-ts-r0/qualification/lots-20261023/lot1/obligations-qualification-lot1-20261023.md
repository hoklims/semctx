# T00 lot 1 — qualification publique du 23 octobre 2026

**0/8 qualifiées.** Aucune promotion dans le tableau partagé. Candidat producer `b2350dac0e081cecad50bd5dd39991a33fb9b25f` ; oracle indépendant `3e94997fcbefa72ad4d49b2cad180ee79b7c0a9b`, TypeScript 5.9.3.

Sur macOS arm64 et Linux aarch64 : 15 témoins scope, dont 8 rapports structurés et 7 refus CLI1 sans admission ; 4 témoins opaques, 12 comparaisons de phases exactes et 64 variantes de tokens source. Les 5 contrôles de récepteur et 4 contrôles de processus refusent leurs entrées sur chaque plateforme. Aucun de ces compteurs ne ferme une obligation entière.

Le correctif canonique des dépendances externes admet la dépendance optionnelle avec sa limitation opaque explicite. Le contrat actuel du helper exige un index Analyzed ; son refus d’un batch refusé ne fournit pas le rejet structuré attendu. Ce décalage reste un manque de portage/contrat, sans arbitrage de politique implicite.

| Index | Statut | Raison |
| --- | --- | --- |
| 0 | not_qualified | La dépendance optionnelle déclarée concorde après correction. La référence non retenue produit encore CLI1 (SOURCE_REFERENCE_PATH_UNSUPPORTED puis UnexpectedOutcome) sans admission structurée, au lieu du rejet TS5.9.3 avec raison exacte. Sept témoins de refus n’exposent aucune admission native ; les listes complètes de raisons de périmètre et d’imports non résolus ne sont pas publiées. |
| 1 | not_qualified | Même refus triple-slash sans admission structurée ; les contrôles import-type/import-equals/computed/two-arguments/unresolved sont arrêtés CLI1 avant la projection du visiteur. La propriété cumulative et sa consommation complète ne sont pas fermées. |
| 232 | not_qualified | Les 12 comparaisons de phases et les captures réelles concordent, mais aucun reçu natif possédé par le consommateur ni sa revalidation après émission n’est observé. Le helper ne reconsomme ni ne revalide le Receipt après receive_index ; trois alternatives donnent CLI1 sans admission. |
| 233 | not_qualified | qualifiedAdmission ne peut être comparée complètement : référence non retenue et six autres refus sans admission native ; raisons complètes différentes pour les importeurs exclus computed/unresolved et absence des listes complètes de périmètre. |
| 234 | not_qualified | Les 16 variantes de tokens TS par cas ne sont pas appariées à une revalidation native après émission. Le reçu natif n’est pas exposé/reconsommé ; phases et refus de processus ne suffisent pas à fermer provenance et mutations après émission. |
| 236 | not_qualified | Les témoins working-tree ne ferment pas la capture immuable de base : le helper refuse tout index non Analyzed avant l’admission. La référence non retenue n’a pas de raison exacte/admission structurée native et la consommation complète du périmètre reste manquante. |
| 237 | not_qualified | La composition verify/qualifiedAdmission reste incomplète : sept refus natifs CLI1 sans admission structurée, malgré l’admission optionnelle corrigée et les contrôles hérités/exclus concordants. |
| 238 | not_qualified | Le chemin public verify reçoit le batch, sans reconsommer ni revalider le Receipt ; aucune consommation native complète des arguments d’ownership/revalidation après émission n’est établie. Trois contrôles opaques restent CLI1 sans admission structurée. |

Le [tableau JSON](obligations-qualification-lot1-20261023.json) conserve les identifiants et propriétés par plateforme. Les [résultats compacts](campaign-results.json) et le [manifeste](evidence-manifest.json) donnent les chemins, tailles et SHA256 des sorties brutes hors dépôt. Les tentatives interrompues ou avec oracle inexécutable ne sont pas utilisées pour la qualification.

Les 209 obligations antérieurement qualifiées n’ont pas été re-campagnées sur ce candidat. R0 terminal et all-target restent faux : Windows natif et l’admission terminale sont absents. macOS x86_64 et Linux x86_64 ne sont pas exercés. ARB-002/003/004 : aucun cas réexécuté, zéro crédit ; leurs NONPASS historiques restent NONPASS. Aucune action distante.
