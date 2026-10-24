# Contrat d’évaluation réservé — gel de B, 2026-10-22

Sources autorisées : reçu public `cases/reserved/PUBLIC-FREEZE-RECEIPT.json`,
ADR 0037, règles R0 et interfaces publiques du probe/comparateur gelés en A.
Aucun contenu réservé n’a servi à rédiger ce contrat ou son runner.

Le reçu engage 23 cas / 26 variantes et huit familles publiques ; ses comptes
sont la source canonique du dénominateur et de l’agrégation. Il engage l’oracle
Compiler API 5.9.3, mais indique `nativeAnalysisReady:false` et ne spécifie aucun
schéma JSON privé. Le protocole ci-dessous définit donc l’entrée native acceptée,
sans affirmer que les documents privés possèdent cette représentation. Toute
incompatibilité est consignée sans adaptation ni relance. Un échec de format
n’est jamais présenté comme une comparaison native exécutée.

## Entrée stricte

Le document dont les octets correspondent à l’engagement public des attentes
doit être un objet `{schema_version:1, oracle, units}`. `oracle` exige
`typescript_version:"5.9.3"` et `baseline` égal au reçu. Seuls `sourceIdentities`
et `inputs_sha256` sont des métadonnées optionnelles de cet objet oracle.

`units` contient exactement le nombre de variantes du reçu. Chaque unité exige
un `unit_id` privé unique non vide, une `primary_family` exactement publique,
`surface`, `checks` non vide et `gaps:[]`. Les comptes par famille doivent égaler
le reçu, y compris la famille de zéro variante. Les noms restent privés.

Deux surfaces publiques sont acceptées :

- `raw_cli` : `requests` contient un ou deux DTO publics de replay, avec `id`, `sdk_directory`,
  `files` textuels, `roots` non vide et `options`. Le materializer gelé valide
  chemins et contenu avant le probe. Les options, retained/qualified, SDK,
  encodages et sélections suivent ces DTO publics ; aucun fallback nouveau.
- `primitive_cli` : `primitive_requests` contient un ou deux objets dont
  `operation` est explicite ; le probe gelé décide quelles opérations il sait
  exécuter. Aucune requête d’une seconde surface n’est admise dans une unité.

Les seuls champs optionnels de l’unité sont `relations`,
`physical_live_after_capture` vide, `independent_input_origin`,
`obligation_indices`, `oracle_full_value` et `oracle_full_values`.
Chaque check exige `target`, `mode:"eq"`, un `expected` présent même s’il est
null, `expected_origin:"typescript-5.9.3"` et `actual_transform` explicite. Seuls
`observation` et `operation_binding` sont optionnels. Aucun filtre,
arbitrage, attendu candidat ou opérateur de comparaison alternatif n’est admis.
Les transformations sont `none`, `outline_without_digest_bytes` ou
`baseline_raw_extraction`, exactement telles que testées et gelées en A.
Une relation éventuelle fixe deux indices d’observation, une cible, `none` et
une égalité booléenne ; `origin` peut documenter sa provenance privée.

Un envelope non conforme, un compte absent ou une famille inconnue rend tout
le bundle non exécutable : zéro comparaison, zéro lancement natif, 26 échecs
de format ventilés suivant les seuls comptes publics. On ne devine ni un champ,
ni un chemin, ni une traduction des assertions après ouverture. Ce résultat
n’attribue aucun défaut sémantique au producer. Un engagement d’octets différent
est un refus d’intégrité, distinct d’un échec de format.

## Invocation et comparaison

Le fichier de gel de B lie par SHA256 ce contrat, le runner, le reçu, les
runtimes Bun 1.4.3 et le gel final A. Celui-ci lie le commit candidat, producer,
helper, fixture, SDK 5.9.3 et observer optimisés de chaque plateforme.
Les chemins des freezes exécutables sont également liés et revérifiés.
Aucun rebuild, nouveau producer/helper, SDK ou adaptation du comparateur après B.

Le runner appelle une fois par plateforme :

`<frozen-observer> suite_replay::suite_phase_a_replay_requires_frozen_manifest --exact --nocapture`

Il fournit le manifeste privé haché, le freeze lié, un dossier de preuve neuf,
`SEMCTX_PROCESS_HELPER` gelé, `GOPORT_LIB_PARSE_SNAPSHOT=0`,
`GOPORT_LIB_SNAPSHOT=0`, `RUST_TEST_THREADS=1`. Il ne transmet pas
`GIT_CONFIG_GLOBAL` ni les variables SEMCTX ambiantes. L’observer utilise les
invocations du probe et du vrai helper gelés en A, avec timeout/cap par processus,
contrôle d’identité avant/après, liaison des entrées, capacité et provenance des
lectures rapportées. Le runner borne aussi le processus observer à 20 minutes.
MacOS arm64 natif et Linux aarch64 OrbStack utilisent les deux lanes A ; Linux
reste dans l’image Rust 1.95.0 imposée, réseau `none`. Windows n’est pas exécuté.

Les attendus proviennent exclusivement des engagements indépendants du reçu
sur l’oracle TS 5.9.3. Le runner ne génère ni ne corrige un attendu. Toutes les
comparaisons et relations de l’unité, la liaison des entrées et la capacité native
doivent passer pour donner PASS. Unknown, unsupported et mismatch unitaires
restent NONPASS. Une erreur du processus observer ou un rapport
manquant/incomplet/non lié donne `EXECUTION_UNAVAILABLE` : refus global, sans
résultat comportemental par variante. Exit 101 n’est
accepté comme campagne complète que si le rapport lié contient effectivement un
NONPASS ; un panic avec toutes les lignes vertes reste indisponible. Aucun ARB
n’accorde du crédit. Aucun PASS de projection ne prouve une admission globale,
une closure de dépendances tierces ou un typecheck de projet complet.

## Une seule tentative, confidentialité et publication

Les sept engagements publics doivent être vérifiés avant invocation par la
procédure privée de C. L’archive et tous les contenus/sorties restent hors Git.
Le runner refuse les chemins privés d’entrée/sortie dans le worktree, lexicalement
et après résolution des liens. Le dossier de sortie doit être neuf : création
exclusive en mode 700, fichiers du runner en 600. Les sous-sorties héritées de
l’observer restent protégées pendant l’exécution par cette racine 700, puis sont
vérifiées et ramenées récursivement à 700/600 avant publication ; liens et objets
non réguliers refusés. Une seconde tentative sur ce
même dossier est refusée ; la procédure de C interdit également un nouveau dossier
pour relancer une variante. Ce dernier verrou de protocole relève de la conduite
de l’expérience, pas d’une prétendue sécurité contre un opérateur modifiant Git.

Les détails, identifiants, sources, attendus, argv et erreurs restent dans les
sorties privées. Le stdout publiable contient uniquement : compte total, PASS,
échecs de format, comparaisons effectuées, compteurs par famille publique,
plateforme, horodatages, empreintes, tentatives/processus observer et exit code.
`variantsReported` compte les lignes du rapport lié ; `variantsCompared` compte
seulement les unités ayant tous leurs checks et relations réellement comparés
(états PASS_PROJECTED_PROPERTY/MISMATCH, avec cibles et indices cohérents). Un
refus antérieur ou un état UNKNOWN ne compte pas comme comparaison. La même
distinction et les erreurs de format/indisponibilité sont ventilées par famille.
Y/26 compte les PASS, jamais les échecs de format ou l’acceptation d’un arbitrage.
Les deux plateformes sont rapportées séparément ; le total conjoint exige PASS
sur les deux, sans double comptage. Le mode
`--joint <mac-record> <linux-record> <fresh-output> <receipt> <freeze>` joint
strictement les identifiants privés ordonnés des deux `execution-record.json`,
après liaison au même candidat, runner, contrat et engagement. Seuls les
compteurs publics résultants sont publiés ; ni somme ni minimum des totaux
marginaux ne remplace cette intersection. Les empreintes des sorties détaillées peuvent
être publiées, jamais leurs chemins internes, noms ou messages. La synthèse finale
nomme explicitement le nombre de variantes réellement comparées et de processus
lancés ; une entrée incompatible peut donc donner 0/26 et 0 comparaisons.

Les tests du runner utilisent exclusivement des données synthétiques publiques
créées pour cette tâche. Ils sont découverts par `bun test` via
`scripts/t00-holdout-runner.test.ts` et le contrôle global `verify:pr`.
