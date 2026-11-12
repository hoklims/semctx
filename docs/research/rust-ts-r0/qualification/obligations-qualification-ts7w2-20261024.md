# T00 — qualification TS7 vague 2, 24 octobre 2026

**115/240** sur macOS arm64 et Linux aarch64 ; 125 non qualifiées. Delta vs 48 : +67 (71 nouvelles, 4 anciens crédits retirés).

**Validation de Guillaume requise** pour les exclusions 49:2/49:4/49:5 et le remplacement J04/J05 ES5 par les variantes ES2015 de 12–14. Les décisions de Sébastien autorisent cette qualification expérimentale ; elles ne valent pas approbation du mainteneur. 145/166 restent en attente. Aucun envoi mainteneur.

Source `816948e00ab8020de49cc934c1497a856cc519d4` ; arbre `af986e300ec610178ddd45e94ba19a7abf1c9855`. [Tableau JSON](obligations-qualification-ts7w2-20261024.json).

| Runner | Total | macOS | Linux | Intersection |
| --- | ---: | ---: | ---: | ---: |
| q-boundary | 26 | 13 | 13 | 13 |
| q-config | 47 | 22 | 22 | 22 |
| q-syntax | 80 | 76 | 76 | 76 |
| q-semantic | 87 | 4 | 4 | 4 |

| Catégorie de livraison | Total | Qualifiées deux OS |
| --- | ---: | ---: |
| refusals | 8 | 8 |
| identity | 3 | 3 |
| config-diag | 11 | 11 |
| live-fs | 19 | 0 |
| syntax-triage | 16 | 14 |
| syntax-checker | 23 | 23 |
| extraction | 17 | 0 |
| emit-helpers | 8 | 8 |
| semantic | 86 | 4 |
| maintained-wave1 | 48 | 44 |
| 49-owner-scope | 1 | 0 |

Campagne : 378.916 s, 20 shards, 6 simultanés au maximum ; 25538 références vérifiées, aucun échec technique/rejeu. Quatre ARB séparés, crédit zéro.

Revue contrat : 119 promotions examinées, 172/173/174/192 retirées ; revue des preuves sans rejet supplémentaire. Les deux rapports, les observations et leurs empreintes sont référencés dans le JSON. Les quatre retraits sont des lacunes de preuve cumulative, sans constat de régression produit.

Verify:pr : 18 étapes natives macOS passantes, délai Bun 45 min inchangé ; compléments producteur/oracles/tests/fmt/Clippy macOS/Linux passants. Windows et CI exclus. Aucun résultat vague 1 réutilisé.

## Obligations

| Index | Consommateur | Statut |
| ---: | --- | --- |
| 0 | inspectRetainedQualifiedScope | qualified |
| 1 | inspectRetainedQualifiedScope > visit | qualified |
| 2 | assembleRepository | not_qualified |
| 3 | assembleRepository > visit | not_qualified |
| 4 | assertSnapshotInputs | not_qualified |
| 5 | createQualifiedPathEligibility | not_qualified |
| 6 | escapedDependencyReason | not_qualified |
| 7 | hasSemanticJSDocImport | qualified |
| 8 | hasSemanticJSDocImport > visit | qualified |
| 9 | hasSemanticJSDocImport > visitDoc | qualified |
| 10 | hasUnsupportedDefaultExpression | qualified |
| 11 | hasUnsupportedDefaultExpression > <callback@446> | qualified |
| 12 | inspectImportedRuntimeHelpers | qualified |
| 13 | inspectImportedRuntimeHelpers > <callback@434> | qualified |
| 14 | inspectImportedRuntimeHelpers > <callback@439> | qualified |
| 15 | inspectJavaScriptSource | qualified |
| 16 | inspectJavaScriptSource > <callback@245> | qualified |
| 17 | inspectJavaScriptSource > <callback@296> | qualified |
| 18 | inspectJavaScriptSource > isDeclaredExternal | not_qualified |
| 19 | inspectJavaScriptSource > visit | not_qualified |
| 20 | inspectJsxRuntimeBoundary | qualified |
| 21 | inspectJsxRuntimeBoundary > <callback@473> | qualified |
| 22 | inspectJsxRuntimeBoundary > visit | qualified |
| 23 | inspectModuleConfiguration | qualified |
| 24 | inspectModuleConfiguration > <callback@381> | qualified |
| 25 | inspectModuleConfiguration > <callback@392> | qualified |
| 26 | inspectModuleConfiguration > <callback@409> | qualified |
| 27 | inspectModuleConfiguration > readFile | qualified |
| 28 | inspectNativeModuleBindings | qualified |
| 29 | inspectNativeModuleBindings > <callback@88> | qualified |
| 30 | inspectNativeModuleBindings > <callback@89> | qualified |
| 31 | inspectNativeModuleBindings > <callback@90> | qualified |
| 32 | inspectNativeModuleBindings > findModule | qualified |
| 33 | inspectNativeModuleBindings > isImportMeta | qualified |
| 34 | inspectNativeModuleBindings > isNodeModule | qualified |
| 35 | inspectNativeModuleBindings > isNodeProcess | qualified |
| 36 | inspectNativeModuleBindings > origin | qualified |
| 37 | inspectNativeModuleBindings > safeNamespaceUse | qualified |
| 38 | inspectNativeModuleBindings > staticName | qualified |
| 39 | inspectNativeModuleBindings > visit | qualified |
| 40 | inspectQualifiedModuleScope | qualified |
| 41 | inspectQualifiedModuleScope > visit | qualified |
| 42 | inspectSourceParsing | qualified |
| 43 | inspectSourceParsing > <callback@336> | qualified |
| 44 | inspectUnconsumedNamedConfigurations | qualified |
| 45 | inspectUnconsumedNamedConfigurations > <callback@351> | qualified |
| 46 | inspectUnconsumedNamedConfigurations > normalize | qualified |
| 47 | inspectUnconsumedNamedConfigurations > readFile | qualified |
| 48 | inspectUnmodeledInvocations > visit | qualified |
| 49 | inspectSemanticDependencies | not_qualified |
| 50 | inspectSemanticDependencies > <callback@138> | not_qualified |
| 51 | inspectSemanticDependencies > actualValue | not_qualified |
| 52 | inspectSemanticDependencies > assignment | qualified |
| 53 | inspectSemanticDependencies > asyncOwner | not_qualified |
| 54 | inspectSemanticDependencies > asyncValue | not_qualified |
| 55 | inspectSemanticDependencies > bindingValue | not_qualified |
| 56 | inspectSemanticDependencies > bindingWritten | not_qualified |
| 57 | inspectSemanticDependencies > builtinModuleValue | not_qualified |
| 58 | inspectSemanticDependencies > callableType | not_qualified |
| 59 | inspectSemanticDependencies > callbackType | not_qualified |
| 60 | inspectSemanticDependencies > clusterLauncherValue | not_qualified |
| 61 | inspectSemanticDependencies > coercingBinary | qualified |
| 62 | inspectSemanticDependencies > constantString | not_qualified |
| 63 | inspectSemanticDependencies > dataDescriptor | not_qualified |
| 64 | inspectSemanticDependencies > declarations | not_qualified |
| 65 | inspectSemanticDependencies > descriptorFactory | not_qualified |
| 66 | inspectSemanticDependencies > destructuredOrigin | not_qualified |
| 67 | inspectSemanticDependencies > functionHelper | not_qualified |
| 68 | inspectSemanticDependencies > importMetaMember | not_qualified |
| 69 | inspectSemanticDependencies > inlineOwned | not_qualified |
| 70 | inspectSemanticDependencies > inspectBuiltinProcessUse | not_qualified |
| 71 | inspectSemanticDependencies > inspectCombinatorUse | not_qualified |
| 72 | inspectSemanticDependencies > inspectDefaultSort | not_qualified |
| 73 | inspectSemanticDependencies > inspectDescriptorUse | not_qualified |
| 74 | inspectSemanticDependencies > inspectImportMetaMember | not_qualified |
| 75 | inspectSemanticDependencies > inspectMetaObjectUse | not_qualified |
| 76 | inspectSemanticDependencies > inspectMutationUse | not_qualified |
| 77 | inspectSemanticDependencies > inspectOpaqueCallbacks | not_qualified |
| 78 | inspectSemanticDependencies > inspectPromiseResolveUse | not_qualified |
| 79 | inspectSemanticDependencies > inspectReflectSetUse | not_qualified |
| 80 | inspectSemanticDependencies > inspectRuntimeCode | not_qualified |
| 81 | inspectSemanticDependencies > inspectSdkCallbacks | not_qualified |
| 82 | inspectSemanticDependencies > inspectSdkCoercion | not_qualified |
| 83 | inspectSemanticDependencies > inspectSerializerUse | not_qualified |
| 84 | inspectSemanticDependencies > inspectSyntax | not_qualified |
| 85 | inspectSemanticDependencies > inspectTimerUse | not_qualified |
| 86 | inspectSemanticDependencies > internal | not_qualified |
| 87 | inspectSemanticDependencies > internalBase | not_qualified |
| 88 | inspectSemanticDependencies > internalCallable | not_qualified |
| 89 | inspectSemanticDependencies > intrinsicConstructor | not_qualified |
| 90 | inspectSemanticDependencies > intrinsicDateCopy | not_qualified |
| 91 | inspectSemanticDependencies > intrinsicIterable | not_qualified |
| 92 | inspectSemanticDependencies > iterableParameter | not_qualified |
| 93 | inspectSemanticDependencies > iterableType | not_qualified |
| 94 | inspectSemanticDependencies > literalArray | not_qualified |
| 95 | inspectSemanticDependencies > literalData | not_qualified |
| 96 | inspectSemanticDependencies > mutationFactory | not_qualified |
| 97 | inspectSemanticDependencies > numericUnary | qualified |
| 98 | inspectSemanticDependencies > opaqueCallee | not_qualified |
| 99 | inspectSemanticDependencies > potentiallyCallable | not_qualified |
| 100 | inspectSemanticDependencies > primitiveValue | not_qualified |
| 101 | inspectSemanticDependencies > propertyKey | not_qualified |
| 102 | inspectSemanticDependencies > propertyMembership | qualified |
| 103 | inspectSemanticDependencies > propertyName | not_qualified |
| 104 | inspectSemanticDependencies > proxyFactory | not_qualified |
| 105 | inspectSemanticDependencies > reflectedInvocation | not_qualified |
| 106 | inspectSemanticDependencies > returnedPrimitiveValue | not_qualified |
| 107 | inspectSemanticDependencies > runtimePrimitiveValue | not_qualified |
| 108 | inspectSemanticDependencies > runtimeProperty | not_qualified |
| 109 | inspectSemanticDependencies > safeAwaitValue | not_qualified |
| 110 | inspectSemanticDependencies > sdkCallableMember | not_qualified |
| 111 | inspectSemanticDependencies > sdkCallableProperty | not_qualified |
| 112 | inspectSemanticDependencies > sdkCallbackDictionary | not_qualified |
| 113 | inspectSemanticDependencies > sdkCallbackSignature | not_qualified |
| 114 | inspectSemanticDependencies > sdkConstruction | not_qualified |
| 115 | inspectSemanticDependencies > sdkGlobalAssignment | not_qualified |
| 116 | inspectSemanticDependencies > sdkGlobalMember | not_qualified |
| 117 | inspectSemanticDependencies > sdkGlobalOrigins | not_qualified |
| 118 | inspectSemanticDependencies > sdkInvocation | not_qualified |
| 119 | inspectSemanticDependencies > sdkMemberOf | not_qualified |
| 120 | inspectSemanticDependencies > sdkMetaOperation | not_qualified |
| 121 | inspectSemanticDependencies > sdkOrigin | not_qualified |
| 122 | inspectSemanticDependencies > sdkPromiseResolve | not_qualified |
| 123 | inspectSemanticDependencies > sdkProtocolKey | not_qualified |
| 124 | inspectSemanticDependencies > sdkReflectSet | not_qualified |
| 125 | inspectSemanticDependencies > sdkRuntimeBinding | not_qualified |
| 126 | inspectSemanticDependencies > sdkScriptElement | not_qualified |
| 127 | inspectSemanticDependencies > sdkSerializer | not_qualified |
| 128 | inspectSemanticDependencies > sdkTimer | not_qualified |
| 129 | inspectSemanticDependencies > sdkValue | not_qualified |
| 130 | inspectSemanticDependencies > serviceWorkerLoader | not_qualified |
| 131 | inspectSemanticDependencies > staticMemberName | not_qualified |
| 132 | inspectSemanticDependencies > timerValue | not_qualified |
| 133 | inspectSemanticDependencies > unsafeHandler | not_qualified |
| 134 | inspectSemanticDependencies > visit | not_qualified |
| 135 | inspectSemanticDependencies > workletLoader | not_qualified |
| 136 | key | not_qualified |
| 137 | <module> | qualified |
| 138 | bindingNames | qualified |
| 139 | classExecutes | qualified |
| 140 | classExecutes > <callback@297> | qualified |
| 141 | classExecutes > <callback@303> | qualified |
| 142 | classExecutes > <callback@305> | qualified |
| 143 | describeStatement | qualified |
| 144 | describeStatement > named | qualified |
| 145 | expressionExecutes | not_qualified |
| 146 | expressionExecutes > <callback@288> | qualified |
| 147 | hasModifier | qualified |
| 148 | hasModifier > <callback@89> | qualified |
| 149 | importDetails | qualified |
| 150 | isMemberName | qualified |
| 151 | leadingCommentStart | qualified |
| 152 | lineOf | qualified |
| 153 | moduleLoad | qualified |
| 154 | moduleLoad > <callback@345> | qualified |
| 155 | moduleLoad > <callback@353> | qualified |
| 156 | outlineModuleLinks | qualified |
| 157 | outlineModuleLinks > literal | qualified |
| 158 | outlineModuleLinks > visit | qualified |
| 159 | outlineTopLevel | qualified |
| 160 | referencedIdentifiers | qualified |
| 161 | referencedIdentifiers > visit | qualified |
| 162 | scriptKindFor | qualified |
| 163 | statementExecutes | qualified |
| 164 | statementExecutes > <callback@321> | qualified |
| 165 | statementExecutes > <callback@332> | qualified |
| 166 | structuralDigest > visit | not_qualified |
| 167 | <compiler-options> | qualified |
| 168 | <dialect-version> | qualified |
| 169 | assertConfinedTypeScriptSources | not_qualified |
| 170 | canonicalTypeScriptFileKey | not_qualified |
| 171 | createProgram | qualified |
| 172 | createProgram > <callback@171> | not_qualified |
| 173 | createProgram > <callback@172> | not_qualified |
| 174 | createProgram > <callback@173> | not_qualified |
| 175 | createProgram > <callback@180> | qualified |
| 176 | enclosingScopeOf | qualified |
| 177 | extractTypeScript | qualified |
| 178 | extractTypeScript > recordSymbol | qualified |
| 179 | extractTypeScript > visit | qualified |
| 180 | hasObjectLiteralMemberAncestor | qualified |
| 181 | importedNames | qualified |
| 182 | isExported | qualified |
| 183 | isFunctionLike | qualified |
| 184 | isModeledCallCallee | qualified |
| 185 | leadingJsDoc | qualified |
| 186 | lineOf | qualified |
| 187 | literalModuleSpecifiers | qualified |
| 188 | literalModuleSpecifiers > visit | qualified |
| 189 | nameOfCallee | qualified |
| 190 | namespaceMemberReferences > add | qualified |
| 191 | namespaceMemberReferences > visit | qualified |
| 192 | preflightParallelSafety | not_qualified |
| 193 | preflightParallelSafety > <callback@732> | not_qualified |
| 194 | preflightParallelSafety > <callback@735> | not_qualified |
| 195 | preflightParallelSafety > <callback@762> | qualified |
| 196 | preflightParallelSafety > visit | qualified |
| 197 | resolveCallTarget | qualified |
| 198 | resolveConfiguredModule | not_qualified |
| 199 | resolveConfiguredModule > <callback@275> | not_qualified |
| 200 | resolveConfiguredModule > <callback@278> | not_qualified |
| 201 | resolveConfiguredModule > directoryExists | not_qualified |
| 202 | resolveConfiguredModule > fileExists | not_qualified |
| 203 | resolveConfiguredModule > readFile | not_qualified |
| 204 | resolveConfiguredModule > realpath | not_qualified |
| 205 | resolveTypeScriptModule | not_qualified |
| 206 | retainedCallableCoordinate | qualified |
| 207 | retainedCallableCoordinate > <callback@1228> | qualified |
| 208 | retainedCallableCoordinate > <callback@1232> | qualified |
| 209 | retainedFunctionOwnerCoordinate | qualified |
| 210 | rootModuleComponents | not_qualified |
| 211 | rootModuleComponents > <callback@779> | not_qualified |
| 212 | rootModuleComponents > <callback@780> | not_qualified |
| 213 | rootModuleComponents > <callback@784> | not_qualified |
| 214 | runtimeReferenceSymbols > visit | qualified |
| 215 | scopeNameOf | qualified |
| 216 | snapshotSystem | not_qualified |
| 217 | snapshotSystem > directoryExists | qualified |
| 218 | snapshotSystem > fileExists | qualified |
| 219 | snapshotSystem > readFile | not_qualified |
| 220 | typeScriptLibraryDirectory | qualified |
| 221 | unwrapStaticExpression | qualified |
| 222 | valueImportBindings | qualified |
| 223 | workspaceLinkedSystem > allowedDirect | not_qualified |
| 224 | workspaceLinkedSystem > directoryExists | not_qualified |
| 225 | workspaceLinkedSystem > fileExists | not_qualified |
| 226 | workspaceLinkedSystem > installed | not_qualified |
| 227 | workspaceLinkedSystem > readFile | not_qualified |
| 228 | workspaceLinkedSystem > realpath | not_qualified |
| 229 | analyzerIdentity | qualified |
| 230 | extractRelativeImportSpecifiers | not_qualified |
| 231 | extractRelativeImportSpecifiers > visit | not_qualified |
| 232 | T00-OBL-packages-app-services-src-qualified-analysis-ts-bindopaquecallbackgraph-44b96ab139 | qualified |
| 233 | T00-OBL-packages-app-services-src-qualified-analysis-ts-qualifiedadmission-5e3c15f48a | qualified |
| 234 | T00-OBL-packages-app-services-src-qualified-analysis-ts-scope-token-revalidation-and-opaque-ow-b3c8039572 | qualified |
| 235 | T00-OBL-packages-app-services-src-plane-a-runtime-ts-produce-extract-plane-a-runtime-analyzere-73e2719cc6 | not_qualified |
| 236 | T00-OBL-packages-app-services-src-verify-ts-immutable-base-capture-inspectretainedqualifiedsco-ee99401afd | qualified |
| 237 | T00-OBL-packages-app-services-src-verify-ts-verify-qualifiedadmission-08496630a9 | qualified |
| 238 | T00-OBL-packages-app-services-src-verify-ts-verify-admission-arguments-bindopaquecallbackgraph-d6d3e9c98f | qualified |
| 239 | self.onmessage → extractTypeScript → restrictToEmitRoots | not_qualified |

Les causes exactes, propriétés cumulatives, supports et pointeurs par plateforme sont conservés dans le tableau JSON. Aucune qualification terminale R0 ni READY_TS_NATIVE.
