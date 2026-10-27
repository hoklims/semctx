# Résultat réservé — suite du 2026-10-22

**0/26 PASS conjointement ; 0 variante comparée au natif.** Les deux plateformes
ont consigné chacune 26 échecs de format, zéro observer lancé et zéro relance.
Ce résultat n’est pas un échec sémantique de 26 variantes : l’envelope d’attentes
n’est pas conforme au protocole natif strict gelé en B. Aucune adaptation du
payload, du contrat ou du runner n’a été faite après ouverture.

Le commit local `ccc7a5cf` a gelé le contrat, le runner, le candidat et les
empreintes avant tout accès au payload. L’archive correspond à l’empreinte
attendue, les sept engagements publics ont été vérifiés, puis le contrat gelé a
été appliqué une seule fois par plateforme. La règle non conforme → échec
consigné sans adaptation a empêché tout lancement natif.

Le [record agrégé](reserved-aggregate-suite-20261022.json) contient exclusivement
comptes/familles publics, horodatages et empreintes. Les détails et sorties
restent hors Git dans des espaces privés. Aucun nom de cas, source, attendu,
chemin interne ou message d’erreur du corpus n’est publié ici. Les artefacts
protégés sont restés inchangés ; aucune CI, action GitHub ou publication n’a été
exécutée.

Ce holdout ouvert ne donne aucun crédit de qualification. Le candidat reste
sans admission R0 ; Windows natif, les 133 obligations Phase A non fermées et
l’audit/admission terminale restent pendants. Une compatibilité native et un
nouvel holdout indépendant sont à préparer dans une expérience distincte ;
aucune correction ou relance n’est autorisée dans cette expérience gelée.
`r0Decision` reste null ; proposition seulement : ne pas déclarer READY_TS_NATIVE.
