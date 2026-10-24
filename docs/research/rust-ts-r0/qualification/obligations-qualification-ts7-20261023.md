# Qualification TS7 — 23 octobre 2026

**48/240 sur macOS arm64, 48/240 sur Linux aarch64, 48/240 dans leur intersection.** Les mêmes 48 obligations satisfont leurs propriétés cumulatives après revue indépendante. Les 192 autres restent `not_qualified`. Les trois arbitrages T00-ARB-002/003/004 restent séparés et apportent zéro crédit.

Source testée : `8c99eb1dcea4e5e4e7c8c5701cb2cadab4b4a35d`, arbre `0cfe961f35ae16ef6d6cb9fbfe220c1f8d067243`. Manifeste figé SHA256 `5e8bff5e11f11e949dfc8a468b1648508a6ccf47363a4e5b34799ccc367957a0`. TS7 `7.1.0-dev`, révision `780dc512d64f40afebffa6a7028207649fb7ed1c`, SDK de 115 bibliothèques, Rust 1.95.0. Le JSON voisin contient les empreintes des artefacts, les 20 rapports, les propriétés cumulatives et les pointeurs de chaque ligne vers ses observations brutes.

| Lot | Obligations | Qualifiées sur les deux OS |
| --- | ---: | ---: |
| q-boundary | 26 | 2 |
| q-config | 47 | 7 |
| q-syntax | 80 | 39 |
| q-semantic | 87 | 0 |

Les 20 shards terminent sans échec technique ni rejeu. Partition exacte 0–239 sur chaque OS ; 9 044 références uniques vérifiées par SHA256 et taille. Durée murale combinée : 186,847 s ; les durées de lignes qui partagent une frontière ne s’additionnent pas. Linux utilise des volumes natifs, UID 501:20, image épinglée et réseau désactivé ; macOS utilise sandbox-exec avec réseau désactivé.

La revue indépendante du contrat couvre les 48 promotions et confirme qu’aucune n’a de support requis ; aucune n’est rejetée. La seconde revue couvre 17 obligations des 4 lots sur les 2 OS et 330 références recalculées. La qualification reste limitée aux contrôles finis listés : aucun R0 terminal, aucune équivalence TS5 et aucune qualification Windows.

Les refus de reçus non structurés, l’acquisition 229 passant par une primitive TS5, les écarts de diagnostics/configuration et les projections sémantiques cumulatives manquantes restent visibles dans les 192 lignes non qualifiées. Un échec de témoin ne suffit pas à attribuer sa cause au producer.

`verify:pr` passe sur macOS arm64 au commit source testé, en 2 624,04 s : Bun 5 650 passés, 46 ignorés, zéro échec (2 381,61 s) ; gates Rust 69 passés ; qualification Rust 53 passés et 4 helpers de fixture ignorés ; agrégat natif 19 passés. Aucun timeout, relance ou changement de budget. Le rapport de coordination `~/semctx-evidence/t00/briefs/resultat-20261023-ts7.md` distingue cette gate des contrôles documentaires rejoués après ajout du présent agrégat.

## Tableau des 240 obligations

`Q` = qualified sur les deux OS après revue ; `NQ` = not_qualified. Les identifiants canoniques, propriétés et raisons détaillées sont dans le JSON voisin.

| Index | Lot | Consommateur | macOS | Linux | Intersection |
| ---: | --- | --- | :---: | :---: | :---: |
| 0 | q-boundary | inspectRetainedQualifiedScope | NQ | NQ | NQ |
| 1 | q-boundary | inspectRetainedQualifiedScope > visit | NQ | NQ | NQ |
| 2 | q-boundary | assembleRepository | NQ | NQ | NQ |
| 3 | q-boundary | assembleRepository > visit | NQ | NQ | NQ |
| 4 | q-boundary | assertSnapshotInputs | NQ | NQ | NQ |
| 5 | q-boundary | createQualifiedPathEligibility | NQ | NQ | NQ |
| 6 | q-boundary | escapedDependencyReason | NQ | NQ | NQ |
| 7 | q-syntax | hasSemanticJSDocImport | NQ | NQ | NQ |
| 8 | q-syntax | hasSemanticJSDocImport > visit | NQ | NQ | NQ |
| 9 | q-syntax | hasSemanticJSDocImport > visitDoc | NQ | NQ | NQ |
| 10 | q-syntax | hasUnsupportedDefaultExpression | Q | Q | Q |
| 11 | q-syntax | hasUnsupportedDefaultExpression > <callback@446> | Q | Q | Q |
| 12 | q-config | inspectImportedRuntimeHelpers | NQ | NQ | NQ |
| 13 | q-config | inspectImportedRuntimeHelpers > <callback@434> | NQ | NQ | NQ |
| 14 | q-config | inspectImportedRuntimeHelpers > <callback@439> | NQ | NQ | NQ |
| 15 | q-config | inspectJavaScriptSource | NQ | NQ | NQ |
| 16 | q-config | inspectJavaScriptSource > <callback@245> | NQ | NQ | NQ |
| 17 | q-syntax | inspectJavaScriptSource > <callback@296> | Q | Q | Q |
| 18 | q-syntax | inspectJavaScriptSource > isDeclaredExternal | NQ | NQ | NQ |
| 19 | q-syntax | inspectJavaScriptSource > visit | NQ | NQ | NQ |
| 20 | q-config | inspectJsxRuntimeBoundary | NQ | NQ | NQ |
| 21 | q-config | inspectJsxRuntimeBoundary > <callback@473> | NQ | NQ | NQ |
| 22 | q-config | inspectJsxRuntimeBoundary > visit | NQ | NQ | NQ |
| 23 | q-config | inspectModuleConfiguration | NQ | NQ | NQ |
| 24 | q-config | inspectModuleConfiguration > <callback@381> | NQ | NQ | NQ |
| 25 | q-config | inspectModuleConfiguration > <callback@392> | NQ | NQ | NQ |
| 26 | q-config | inspectModuleConfiguration > <callback@409> | NQ | NQ | NQ |
| 27 | q-config | inspectModuleConfiguration > readFile | NQ | NQ | NQ |
| 28 | q-syntax | inspectNativeModuleBindings | NQ | NQ | NQ |
| 29 | q-syntax | inspectNativeModuleBindings > <callback@88> | NQ | NQ | NQ |
| 30 | q-syntax | inspectNativeModuleBindings > <callback@89> | NQ | NQ | NQ |
| 31 | q-syntax | inspectNativeModuleBindings > <callback@90> | NQ | NQ | NQ |
| 32 | q-syntax | inspectNativeModuleBindings > findModule | NQ | NQ | NQ |
| 33 | q-syntax | inspectNativeModuleBindings > isImportMeta | NQ | NQ | NQ |
| 34 | q-syntax | inspectNativeModuleBindings > isNodeModule | NQ | NQ | NQ |
| 35 | q-syntax | inspectNativeModuleBindings > isNodeProcess | NQ | NQ | NQ |
| 36 | q-syntax | inspectNativeModuleBindings > origin | NQ | NQ | NQ |
| 37 | q-syntax | inspectNativeModuleBindings > safeNamespaceUse | NQ | NQ | NQ |
| 38 | q-syntax | inspectNativeModuleBindings > staticName | NQ | NQ | NQ |
| 39 | q-syntax | inspectNativeModuleBindings > visit | NQ | NQ | NQ |
| 40 | q-syntax | inspectQualifiedModuleScope | Q | Q | Q |
| 41 | q-syntax | inspectQualifiedModuleScope > visit | Q | Q | Q |
| 42 | q-syntax | inspectSourceParsing | Q | Q | Q |
| 43 | q-syntax | inspectSourceParsing > <callback@336> | Q | Q | Q |
| 44 | q-config | inspectUnconsumedNamedConfigurations | NQ | NQ | NQ |
| 45 | q-config | inspectUnconsumedNamedConfigurations > <callback@351> | NQ | NQ | NQ |
| 46 | q-config | inspectUnconsumedNamedConfigurations > normalize | NQ | NQ | NQ |
| 47 | q-config | inspectUnconsumedNamedConfigurations > readFile | NQ | NQ | NQ |
| 48 | q-syntax | inspectUnmodeledInvocations > visit | NQ | NQ | NQ |
| 49 | q-semantic | inspectSemanticDependencies | NQ | NQ | NQ |
| 50 | q-semantic | inspectSemanticDependencies > <callback@138> | NQ | NQ | NQ |
| 51 | q-semantic | inspectSemanticDependencies > actualValue | NQ | NQ | NQ |
| 52 | q-semantic | inspectSemanticDependencies > assignment | NQ | NQ | NQ |
| 53 | q-semantic | inspectSemanticDependencies > asyncOwner | NQ | NQ | NQ |
| 54 | q-semantic | inspectSemanticDependencies > asyncValue | NQ | NQ | NQ |
| 55 | q-semantic | inspectSemanticDependencies > bindingValue | NQ | NQ | NQ |
| 56 | q-semantic | inspectSemanticDependencies > bindingWritten | NQ | NQ | NQ |
| 57 | q-semantic | inspectSemanticDependencies > builtinModuleValue | NQ | NQ | NQ |
| 58 | q-semantic | inspectSemanticDependencies > callableType | NQ | NQ | NQ |
| 59 | q-semantic | inspectSemanticDependencies > callbackType | NQ | NQ | NQ |
| 60 | q-semantic | inspectSemanticDependencies > clusterLauncherValue | NQ | NQ | NQ |
| 61 | q-semantic | inspectSemanticDependencies > coercingBinary | NQ | NQ | NQ |
| 62 | q-semantic | inspectSemanticDependencies > constantString | NQ | NQ | NQ |
| 63 | q-semantic | inspectSemanticDependencies > dataDescriptor | NQ | NQ | NQ |
| 64 | q-semantic | inspectSemanticDependencies > declarations | NQ | NQ | NQ |
| 65 | q-semantic | inspectSemanticDependencies > descriptorFactory | NQ | NQ | NQ |
| 66 | q-semantic | inspectSemanticDependencies > destructuredOrigin | NQ | NQ | NQ |
| 67 | q-semantic | inspectSemanticDependencies > functionHelper | NQ | NQ | NQ |
| 68 | q-semantic | inspectSemanticDependencies > importMetaMember | NQ | NQ | NQ |
| 69 | q-semantic | inspectSemanticDependencies > inlineOwned | NQ | NQ | NQ |
| 70 | q-semantic | inspectSemanticDependencies > inspectBuiltinProcessUse | NQ | NQ | NQ |
| 71 | q-semantic | inspectSemanticDependencies > inspectCombinatorUse | NQ | NQ | NQ |
| 72 | q-semantic | inspectSemanticDependencies > inspectDefaultSort | NQ | NQ | NQ |
| 73 | q-semantic | inspectSemanticDependencies > inspectDescriptorUse | NQ | NQ | NQ |
| 74 | q-semantic | inspectSemanticDependencies > inspectImportMetaMember | NQ | NQ | NQ |
| 75 | q-semantic | inspectSemanticDependencies > inspectMetaObjectUse | NQ | NQ | NQ |
| 76 | q-semantic | inspectSemanticDependencies > inspectMutationUse | NQ | NQ | NQ |
| 77 | q-semantic | inspectSemanticDependencies > inspectOpaqueCallbacks | NQ | NQ | NQ |
| 78 | q-semantic | inspectSemanticDependencies > inspectPromiseResolveUse | NQ | NQ | NQ |
| 79 | q-semantic | inspectSemanticDependencies > inspectReflectSetUse | NQ | NQ | NQ |
| 80 | q-semantic | inspectSemanticDependencies > inspectRuntimeCode | NQ | NQ | NQ |
| 81 | q-semantic | inspectSemanticDependencies > inspectSdkCallbacks | NQ | NQ | NQ |
| 82 | q-semantic | inspectSemanticDependencies > inspectSdkCoercion | NQ | NQ | NQ |
| 83 | q-semantic | inspectSemanticDependencies > inspectSerializerUse | NQ | NQ | NQ |
| 84 | q-semantic | inspectSemanticDependencies > inspectSyntax | NQ | NQ | NQ |
| 85 | q-semantic | inspectSemanticDependencies > inspectTimerUse | NQ | NQ | NQ |
| 86 | q-semantic | inspectSemanticDependencies > internal | NQ | NQ | NQ |
| 87 | q-semantic | inspectSemanticDependencies > internalBase | NQ | NQ | NQ |
| 88 | q-semantic | inspectSemanticDependencies > internalCallable | NQ | NQ | NQ |
| 89 | q-semantic | inspectSemanticDependencies > intrinsicConstructor | NQ | NQ | NQ |
| 90 | q-semantic | inspectSemanticDependencies > intrinsicDateCopy | NQ | NQ | NQ |
| 91 | q-semantic | inspectSemanticDependencies > intrinsicIterable | NQ | NQ | NQ |
| 92 | q-semantic | inspectSemanticDependencies > iterableParameter | NQ | NQ | NQ |
| 93 | q-semantic | inspectSemanticDependencies > iterableType | NQ | NQ | NQ |
| 94 | q-semantic | inspectSemanticDependencies > literalArray | NQ | NQ | NQ |
| 95 | q-semantic | inspectSemanticDependencies > literalData | NQ | NQ | NQ |
| 96 | q-semantic | inspectSemanticDependencies > mutationFactory | NQ | NQ | NQ |
| 97 | q-semantic | inspectSemanticDependencies > numericUnary | NQ | NQ | NQ |
| 98 | q-semantic | inspectSemanticDependencies > opaqueCallee | NQ | NQ | NQ |
| 99 | q-semantic | inspectSemanticDependencies > potentiallyCallable | NQ | NQ | NQ |
| 100 | q-semantic | inspectSemanticDependencies > primitiveValue | NQ | NQ | NQ |
| 101 | q-semantic | inspectSemanticDependencies > propertyKey | NQ | NQ | NQ |
| 102 | q-semantic | inspectSemanticDependencies > propertyMembership | NQ | NQ | NQ |
| 103 | q-semantic | inspectSemanticDependencies > propertyName | NQ | NQ | NQ |
| 104 | q-semantic | inspectSemanticDependencies > proxyFactory | NQ | NQ | NQ |
| 105 | q-semantic | inspectSemanticDependencies > reflectedInvocation | NQ | NQ | NQ |
| 106 | q-semantic | inspectSemanticDependencies > returnedPrimitiveValue | NQ | NQ | NQ |
| 107 | q-semantic | inspectSemanticDependencies > runtimePrimitiveValue | NQ | NQ | NQ |
| 108 | q-semantic | inspectSemanticDependencies > runtimeProperty | NQ | NQ | NQ |
| 109 | q-semantic | inspectSemanticDependencies > safeAwaitValue | NQ | NQ | NQ |
| 110 | q-semantic | inspectSemanticDependencies > sdkCallableMember | NQ | NQ | NQ |
| 111 | q-semantic | inspectSemanticDependencies > sdkCallableProperty | NQ | NQ | NQ |
| 112 | q-semantic | inspectSemanticDependencies > sdkCallbackDictionary | NQ | NQ | NQ |
| 113 | q-semantic | inspectSemanticDependencies > sdkCallbackSignature | NQ | NQ | NQ |
| 114 | q-semantic | inspectSemanticDependencies > sdkConstruction | NQ | NQ | NQ |
| 115 | q-semantic | inspectSemanticDependencies > sdkGlobalAssignment | NQ | NQ | NQ |
| 116 | q-semantic | inspectSemanticDependencies > sdkGlobalMember | NQ | NQ | NQ |
| 117 | q-semantic | inspectSemanticDependencies > sdkGlobalOrigins | NQ | NQ | NQ |
| 118 | q-semantic | inspectSemanticDependencies > sdkInvocation | NQ | NQ | NQ |
| 119 | q-semantic | inspectSemanticDependencies > sdkMemberOf | NQ | NQ | NQ |
| 120 | q-semantic | inspectSemanticDependencies > sdkMetaOperation | NQ | NQ | NQ |
| 121 | q-semantic | inspectSemanticDependencies > sdkOrigin | NQ | NQ | NQ |
| 122 | q-semantic | inspectSemanticDependencies > sdkPromiseResolve | NQ | NQ | NQ |
| 123 | q-semantic | inspectSemanticDependencies > sdkProtocolKey | NQ | NQ | NQ |
| 124 | q-semantic | inspectSemanticDependencies > sdkReflectSet | NQ | NQ | NQ |
| 125 | q-semantic | inspectSemanticDependencies > sdkRuntimeBinding | NQ | NQ | NQ |
| 126 | q-semantic | inspectSemanticDependencies > sdkScriptElement | NQ | NQ | NQ |
| 127 | q-semantic | inspectSemanticDependencies > sdkSerializer | NQ | NQ | NQ |
| 128 | q-semantic | inspectSemanticDependencies > sdkTimer | NQ | NQ | NQ |
| 129 | q-semantic | inspectSemanticDependencies > sdkValue | NQ | NQ | NQ |
| 130 | q-semantic | inspectSemanticDependencies > serviceWorkerLoader | NQ | NQ | NQ |
| 131 | q-semantic | inspectSemanticDependencies > staticMemberName | NQ | NQ | NQ |
| 132 | q-semantic | inspectSemanticDependencies > timerValue | NQ | NQ | NQ |
| 133 | q-semantic | inspectSemanticDependencies > unsafeHandler | NQ | NQ | NQ |
| 134 | q-semantic | inspectSemanticDependencies > visit | NQ | NQ | NQ |
| 135 | q-semantic | inspectSemanticDependencies > workletLoader | NQ | NQ | NQ |
| 136 | q-boundary | key | NQ | NQ | NQ |
| 137 | q-syntax | <module> | Q | Q | Q |
| 138 | q-syntax | bindingNames | NQ | NQ | NQ |
| 139 | q-syntax | classExecutes | Q | Q | Q |
| 140 | q-syntax | classExecutes > <callback@297> | Q | Q | Q |
| 141 | q-syntax | classExecutes > <callback@303> | Q | Q | Q |
| 142 | q-syntax | classExecutes > <callback@305> | Q | Q | Q |
| 143 | q-syntax | describeStatement | Q | Q | Q |
| 144 | q-syntax | describeStatement > named | Q | Q | Q |
| 145 | q-syntax | expressionExecutes | NQ | NQ | NQ |
| 146 | q-syntax | expressionExecutes > <callback@288> | Q | Q | Q |
| 147 | q-syntax | hasModifier | Q | Q | Q |
| 148 | q-syntax | hasModifier > <callback@89> | Q | Q | Q |
| 149 | q-syntax | importDetails | Q | Q | Q |
| 150 | q-syntax | isMemberName | Q | Q | Q |
| 151 | q-syntax | leadingCommentStart | Q | Q | Q |
| 152 | q-syntax | lineOf | Q | Q | Q |
| 153 | q-syntax | moduleLoad | Q | Q | Q |
| 154 | q-syntax | moduleLoad > <callback@345> | Q | Q | Q |
| 155 | q-syntax | moduleLoad > <callback@353> | Q | Q | Q |
| 156 | q-syntax | outlineModuleLinks | Q | Q | Q |
| 157 | q-syntax | outlineModuleLinks > literal | Q | Q | Q |
| 158 | q-syntax | outlineModuleLinks > visit | Q | Q | Q |
| 159 | q-syntax | outlineTopLevel | Q | Q | Q |
| 160 | q-syntax | referencedIdentifiers | Q | Q | Q |
| 161 | q-syntax | referencedIdentifiers > visit | Q | Q | Q |
| 162 | q-syntax | scriptKindFor | Q | Q | Q |
| 163 | q-syntax | statementExecutes | Q | Q | Q |
| 164 | q-syntax | statementExecutes > <callback@321> | Q | Q | Q |
| 165 | q-syntax | statementExecutes > <callback@332> | Q | Q | Q |
| 166 | q-syntax | structuralDigest > visit | NQ | NQ | NQ |
| 167 | q-config | <compiler-options> | NQ | NQ | NQ |
| 168 | q-boundary | <dialect-version> | NQ | NQ | NQ |
| 169 | q-boundary | assertConfinedTypeScriptSources | NQ | NQ | NQ |
| 170 | q-boundary | canonicalTypeScriptFileKey | NQ | NQ | NQ |
| 171 | q-config | createProgram | NQ | NQ | NQ |
| 172 | q-config | createProgram > <callback@171> | Q | Q | Q |
| 173 | q-config | createProgram > <callback@172> | Q | Q | Q |
| 174 | q-config | createProgram > <callback@173> | Q | Q | Q |
| 175 | q-config | createProgram > <callback@180> | Q | Q | Q |
| 176 | q-syntax | enclosingScopeOf | NQ | NQ | NQ |
| 177 | q-syntax | extractTypeScript | NQ | NQ | NQ |
| 178 | q-syntax | extractTypeScript > recordSymbol | Q | Q | Q |
| 179 | q-syntax | extractTypeScript > visit | NQ | NQ | NQ |
| 180 | q-syntax | hasObjectLiteralMemberAncestor | NQ | NQ | NQ |
| 181 | q-syntax | importedNames | Q | Q | Q |
| 182 | q-syntax | isExported | Q | Q | Q |
| 183 | q-syntax | isFunctionLike | Q | Q | Q |
| 184 | q-syntax | isModeledCallCallee | NQ | NQ | NQ |
| 185 | q-syntax | leadingJsDoc | NQ | NQ | NQ |
| 186 | q-syntax | lineOf | NQ | NQ | NQ |
| 187 | q-syntax | literalModuleSpecifiers | NQ | NQ | NQ |
| 188 | q-syntax | literalModuleSpecifiers > visit | NQ | NQ | NQ |
| 189 | q-syntax | nameOfCallee | NQ | NQ | NQ |
| 190 | q-syntax | namespaceMemberReferences > add | NQ | NQ | NQ |
| 191 | q-syntax | namespaceMemberReferences > visit | NQ | NQ | NQ |
| 192 | q-config | preflightParallelSafety | Q | Q | Q |
| 193 | q-config | preflightParallelSafety > <callback@732> | NQ | NQ | NQ |
| 194 | q-config | preflightParallelSafety > <callback@735> | NQ | NQ | NQ |
| 195 | q-config | preflightParallelSafety > <callback@762> | Q | Q | Q |
| 196 | q-config | preflightParallelSafety > visit | Q | Q | Q |
| 197 | q-syntax | resolveCallTarget | NQ | NQ | NQ |
| 198 | q-config | resolveConfiguredModule | NQ | NQ | NQ |
| 199 | q-config | resolveConfiguredModule > <callback@275> | NQ | NQ | NQ |
| 200 | q-config | resolveConfiguredModule > <callback@278> | NQ | NQ | NQ |
| 201 | q-config | resolveConfiguredModule > directoryExists | NQ | NQ | NQ |
| 202 | q-config | resolveConfiguredModule > fileExists | NQ | NQ | NQ |
| 203 | q-config | resolveConfiguredModule > readFile | NQ | NQ | NQ |
| 204 | q-config | resolveConfiguredModule > realpath | NQ | NQ | NQ |
| 205 | q-config | resolveTypeScriptModule | NQ | NQ | NQ |
| 206 | q-syntax | retainedCallableCoordinate | NQ | NQ | NQ |
| 207 | q-syntax | retainedCallableCoordinate > <callback@1228> | NQ | NQ | NQ |
| 208 | q-syntax | retainedCallableCoordinate > <callback@1232> | NQ | NQ | NQ |
| 209 | q-syntax | retainedFunctionOwnerCoordinate | NQ | NQ | NQ |
| 210 | q-config | rootModuleComponents | NQ | NQ | NQ |
| 211 | q-config | rootModuleComponents > <callback@779> | NQ | NQ | NQ |
| 212 | q-config | rootModuleComponents > <callback@780> | NQ | NQ | NQ |
| 213 | q-config | rootModuleComponents > <callback@784> | NQ | NQ | NQ |
| 214 | q-syntax | runtimeReferenceSymbols > visit | NQ | NQ | NQ |
| 215 | q-syntax | scopeNameOf | Q | Q | Q |
| 216 | q-boundary | snapshotSystem | NQ | NQ | NQ |
| 217 | q-boundary | snapshotSystem > directoryExists | Q | Q | Q |
| 218 | q-boundary | snapshotSystem > fileExists | Q | Q | Q |
| 219 | q-boundary | snapshotSystem > readFile | NQ | NQ | NQ |
| 220 | q-boundary | typeScriptLibraryDirectory | NQ | NQ | NQ |
| 221 | q-syntax | unwrapStaticExpression | NQ | NQ | NQ |
| 222 | q-syntax | valueImportBindings | NQ | NQ | NQ |
| 223 | q-config | workspaceLinkedSystem > allowedDirect | NQ | NQ | NQ |
| 224 | q-config | workspaceLinkedSystem > directoryExists | NQ | NQ | NQ |
| 225 | q-config | workspaceLinkedSystem > fileExists | NQ | NQ | NQ |
| 226 | q-config | workspaceLinkedSystem > installed | NQ | NQ | NQ |
| 227 | q-config | workspaceLinkedSystem > readFile | NQ | NQ | NQ |
| 228 | q-config | workspaceLinkedSystem > realpath | NQ | NQ | NQ |
| 229 | q-boundary | analyzerIdentity | NQ | NQ | NQ |
| 230 | q-boundary | extractRelativeImportSpecifiers | NQ | NQ | NQ |
| 231 | q-boundary | extractRelativeImportSpecifiers > visit | NQ | NQ | NQ |
| 232 | q-boundary | T00-OBL-packages-app-services-src-qualified-analysis-ts-bindopaquecallbackgraph-44b96ab139 | NQ | NQ | NQ |
| 233 | q-boundary | T00-OBL-packages-app-services-src-qualified-analysis-ts-qualifiedadmission-5e3c15f48a | NQ | NQ | NQ |
| 234 | q-boundary | T00-OBL-packages-app-services-src-qualified-analysis-ts-scope-token-revalidation-and-opaque-ow-b3c8039572 | NQ | NQ | NQ |
| 235 | q-boundary | T00-OBL-packages-app-services-src-plane-a-runtime-ts-produce-extract-plane-a-runtime-analyzere-73e2719cc6 | NQ | NQ | NQ |
| 236 | q-boundary | T00-OBL-packages-app-services-src-verify-ts-immutable-base-capture-inspectretainedqualifiedsco-ee99401afd | NQ | NQ | NQ |
| 237 | q-boundary | T00-OBL-packages-app-services-src-verify-ts-verify-qualifiedadmission-08496630a9 | NQ | NQ | NQ |
| 238 | q-boundary | T00-OBL-packages-app-services-src-verify-ts-verify-admission-arguments-bindopaquecallbackgraph-d6d3e9c98f | NQ | NQ | NQ |
| 239 | q-config | self.onmessage → extractTypeScript → restrictToEmitRoots | NQ | NQ | NQ |
