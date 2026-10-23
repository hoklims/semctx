# Liaison des lecteurs après intégration des outils T00

Source figée : `e155c944fe0bff4299ddc05b3d59ecddda8175ab`, après intégration du
travail auteur `f3886d95` et correction des collecteurs et des relations.
Le commit de packaging ultérieur doit être utilisé lors des acquisitions.

Les lecteurs conservent leurs 16 et 22 membres et tous leurs fichiers Python.
Seules les métadonnées de liaison changent. Les contrôles hors ligne des sources
et des cas publics passent sur les deux lecteurs ; la vérification du paquet
Windows passe également. Aucun processus natif n'a été acquis par ces contrôles.

| Inventaire | Résultat |
| --- | --- |
| Sources du lecteur existant | 139 noms conservés ; 1 empreinte modifiée, 138 identiques au parent47a |
| Delta Git complet47a vers la source figée | 139 fichiers ; les 138 hors de cet inventaire sont hashés séparément |
| Conditions existantes | 395 propriétés, 51 supports, 446 lignes, 590 checks inchangés |
| Fichiers des cas gelés | 1386 fichiers inchangés |

Ces deux ensembles de 139 fichiers ont des rôles différents. L'inventaire du
lecteur n'est pas la fermeture du build. Le nouveau module suite, les collecteurs
et leurs témoins hors de cet inventaire exigent une liaison indépendante du
loader, des preuves effectives et une revue de l'ensemble.

Le producteur suite vérifie ses cinq sources avant de les charger. Le consumer
partagé conserve ses métadonnées optionnelles et son hash externe obligatoire.
Les quatre assertions expérimentales qui imposaient une politique plus stricte
ont été écartées comme défauts ; leurs sources et résultats restent conservés
dans le dossier de travail, avec erratum. Les témoins de compatibilité distincts
ont reproduit le refus puis passé après restauration du contrat public.

Les captures historiques, leurs échecs et arbitrages restent historiques.
Aucun crédit de qualification, décision R0 ou admission ne découle du packaging.
Les acquisitions Mac/Linux, les 76 emplacements privés autorisés une fois,
l'unique exécution Windows finale et la preuve canonique restent à accomplir.

Paquet natif SHA256 : `cba886f43d657647a49093555ef315f3607f1c525b527564cadc36b22c054b29`.
Paquet Windows SHA256 : `32ddb665d90831a21f6edbe7ff67b273a695025a6661e4c152c212e8a007cc48`.
Scope SHA256 : `7791fd8880bcbd62535f0bf2f0cd35089f8ac1146f2c9919f1f2eefa3049bf6f`.
Protocole Windows SHA256 : `1101760957beb259f1019f0ccbaff0b1e75238ef85b063cb59ccc161bf4964db`.
