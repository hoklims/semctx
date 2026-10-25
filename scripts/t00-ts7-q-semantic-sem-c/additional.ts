import { helperResult, witness, type ContractWitness, type NativeExpectation } from "../t00-ts7-q-semantic-contract-witness-types";

const bool = (index: number, variant: "activate" | "control", argument: string, value: boolean, alternatives: string[]): NativeExpectation => helperResult(index, variant, argument, { kind: "boolean", value }, alternatives);
const syntax = (variant: "activate" | "control", syntaxKind: string, text: string, alternatives: string[]): NativeExpectation => ({ kind: "syntax", variant, syntaxKind, text, minimumCount: 1, alternatives });
const sortAlias = (variant: "activate" | "control", alternatives: string[]): NativeExpectation => helperResult(129, variant, "sort", { kind: "symbol", native: { nodeText: "[1].sort", target: "symbol" }, name: "sort", defaultLibrary: true }, alternatives);

const syntaxForms = witness(84, "syntax-runtime-forms", "import.meta.url;const object={__proto__:{}};import {exec} from 'node:child_process';export const primitive=1;const arrow=async()=>1;const Item=class extends Error{};const fn=function(){};fn['constructor'];fn instanceof Function;", "const object={'__proto__':null};const computed={['other']:1};String(1);const Item=class{};", ["meta-property", "prototype-name", "execution-import", "export-modifier", "async-arrow", "class-expression-heritage", "element-constructor", "instanceof-expression", "quoted-prototype-control"], [
  syntax("activate", "MetaProperty", "import.meta", ["meta-property"]),
  syntax("activate", "PropertyAssignment", "__proto__:{}", ["prototype-name"]),
  syntax("activate", "ImportDeclaration", "import {exec} from 'node:child_process';", ["execution-import"]),
  syntax("activate", "ExportKeyword", "export", ["export-modifier"]),
  syntax("activate", "ArrowFunction", "async()=>1", ["async-arrow"]),
  syntax("activate", "ClassExpression", "class extends Error{}", ["class-expression-heritage"]),
  syntax("activate", "ElementAccessExpression", "fn['constructor']", ["element-constructor"]),
  syntax("activate", "BinaryExpression", "fn instanceof Function", ["instanceof-expression"]),
  syntax("control", "PropertyAssignment", "'__proto__':null", ["quoted-prototype-control"]),
]);

export const additionalWitnesses: ContractWitness[] = [
  witness(72, "sort-callable-alias", "const sort=[1].sort;sort();", "const sort=[1].sort;sort(()=>0);", ["SDK-sort-alias-without-receiver", "explicit-comparator-alias"], [sortAlias("activate", ["SDK-sort-alias-without-receiver"]), sortAlias("control", ["explicit-comparator-alias"])]),
  witness(83, "serializer-const-alias", "const stringify=JSON.stringify;stringify(1);", "const {stringify}=JSON;stringify({toJSON(){return 1}});", ["const-serializer-primitive", "destructured-serializer-hook"], [bool(95, "activate", "1", true, ["const-serializer-primitive"]), bool(95, "control", "{toJSON(){return 1}}", false, ["destructured-serializer-hook"])]),
  witness(85, "timer-receiver-reference", "setTimeout.call(null,()=>1,0);", "const timer=setTimeout;timer(()=>1,0);", ["timer-as-helper-receiver", "timer-const-call"], [bool(132, "activate", "setTimeout", true, ["timer-as-helper-receiver"]), bool(132, "control", "timer", true, ["timer-const-call"])]),
  witness(77, "opaque-missing-member-root", "const api={};api.missing(()=>1);", "declare const api:{missing(value:unknown):void};api.missing(()=>1);", ["unmodeled-member-owner-root", "ambient-declared-member-control"], [bool(98, "activate", "api.missing", true, ["unmodeled-member-owner-root"]), bool(98, "control", "api.missing", true, ["ambient-declared-member-control"])]),
  witness(134, "visitor-overloaded-function", "export function overloaded():void;export function overloaded(){}", "declare function overloaded():void;String(1);", ["overload-implementation-modifiers", "bodyless-declaration-control"], [syntax("activate", "FunctionDeclaration", "export function overloaded():void;", ["overload-implementation-modifiers"]), syntax("control", "FunctionDeclaration", "declare function overloaded():void;", ["bodyless-declaration-control"])]),
  witness(134, "visitor-navigation-await-and-date", "location.href='javascript:run()';const object={};async function run(){await object}new Date(object);object in {};", "location.href='https://example.invalid';async function run(){await 1}new Date(1);1 in {};", ["SDK-location-navigation", "object-await", "Date-argument-coercion", "object-property-membership", "safe-navigation-control"], [helperResult(62, "activate", "'javascript:run()'", {kind:"string",value:"javascript:run()"}, ["SDK-location-navigation"]), syntax("activate", "AwaitExpression", "await object", ["object-await"]), helperResult(134, "activate", "new Date(object)", {kind:"undefined"}, ["Date-argument-coercion"]), bool(101, "activate", "object", false, ["object-property-membership"]), helperResult(62, "control", "'https://example.invalid'", {kind:"string",value:"https://example.invalid"}, ["safe-navigation-control"])]),
  witness(134, "visitor-thenable-write", "const target={};target.then=()=>1;", "const target={};target.then=1;", ["callable-then-write", "primitive-then-write"], [bool(100, "activate", "()=>1", false, ["callable-then-write"]), bool(100, "control", "1", true, ["primitive-then-write"])]),
  syntaxForms,
  { ...syntaxForms, index: 134, idSuffix: "visitor-runtime-forms" },
  witness(134, "visitor-declarations-and-protocols", "function pending():void;pending();const object={__proto__:{method(){}}};const protocol={[Symbol.iterator]:()=>({next(){return {done:true}}})};class Value{[Symbol.toPrimitive](){return 1}[Symbol.iterator]=()=>({next(){return {done:true}}})}Math['abs']=()=>1;globalThis['Date']=class{};", "declare function pending():void;pending();const object={__proto__:null};class Value{[Symbol.toPrimitive]=1}Math['abs']=1;", ["bodyless-function", "prototype-literal", "protocol-object-property", "protocol-method", "protocol-class-property", "element-SDK-assignment", "ambient-function-control"], [
    syntax("activate", "FunctionDeclaration", "function pending():void;", ["bodyless-function"]),
    syntax("activate", "PropertyAssignment", "__proto__:{method(){}}", ["prototype-literal"]),
    syntax("activate", "PropertyAssignment", "[Symbol.iterator]:()=>({next(){return {done:true}}})", ["protocol-object-property"]),
    syntax("activate", "MethodDeclaration", "[Symbol.toPrimitive](){return 1}", ["protocol-method"]),
    syntax("activate", "PropertyDeclaration", "[Symbol.iterator]=()=>({next(){return {done:true}}})", ["protocol-class-property"]),
    helperResult(134, "activate", "Math['abs']=()=>1", { kind: "undefined" }, ["element-SDK-assignment"]),
    syntax("control", "FunctionDeclaration", "declare function pending():void;", ["ambient-function-control"]),
  ]),
  witness(134, "visitor-operators-and-iteration", "const object={valueOf(){return 1}};object+1;+object;`value${object}`;async function run(value){return value}const arrow=async()=>object;async function loops(){for await(const item of [,1,...[]]){}}let first;[first]=[object];function* values(){yield* object}object instanceof Function;", "const object=1;object+1;+object;`value${object}`;async function run(){return 1}const arrow=async()=>1;async function loops(){for await(const item of [1]){}}let first;[first]=[1];function* values(){yield* [1]}object instanceof Function;", ["binary-coercion", "numeric-unary", "template-coercion", "async-return", "async-arrow-return", "for-await-array-alternatives", "array-assignment", "delegated-yield", "primitive-operator-control"], [
    bool(100, "activate", "object", false, ["binary-coercion", "numeric-unary", "template-coercion"]),
    syntax("activate", "ReturnStatement", "return value", ["async-return"]),
    syntax("activate", "ArrowFunction", "async()=>object", ["async-arrow-return"]),
    syntax("activate", "ForOfStatement", "for await(const item of [,1,...[]]){}", ["for-await-array-alternatives"]),
    helperResult(134, "activate", "[first]=[object]", { kind: "undefined" }, ["array-assignment"]),
    syntax("activate", "YieldExpression", "yield* object", ["delegated-yield"]),
    bool(100, "control", "object", true, ["primitive-operator-control"]),
  ]),
];
