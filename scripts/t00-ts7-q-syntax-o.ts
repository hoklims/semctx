import type { CampaignCase } from "./t00-ts7-q-syntax-types.ts";

type Specimen = {
  name: string;
  indices: number[];
  filename: string;
  source: string;
  files: Record<string, string>;
};

const specimens: Specimen[] = [
  {"name":"P09-outline-logical-set::base-facts","indices":[151,152,159],"filename":"src/x.ts","source":"/** Keys. */\nconst value = 1;\nexport function main() { return value; }\n","files":{"src/x.ts":"/** Keys. */\nconst value = 1;\nexport function main() { return value; }\n"}},
  {"name":"P09-outline-logical-set::digest-relation-01/observation-0","indices":[151,152],"filename":"src/x.ts","source":"/** Keys. */\nconst value = 1;\nexport function main() { return value; }\n","files":{"src/x.ts":"/** Keys. */\nconst value = 1;\nexport function main() { return value; }\n"}},
  {"name":"P09-outline-logical-set::digest-relation-01/observation-1","indices":[151,152],"filename":"src/x.ts","source":"/** Digest comment changed. */\nconst value = 1;\nexport function main() { return value; }\n","files":{"src/x.ts":"/** Digest comment changed. */\nconst value = 1;\nexport function main() { return value; }\n"}},
  {"name":"P09-outline-logical-set::digest-relation-02/observation-0","indices":[151,152],"filename":"src/x.ts","source":"/** Keys. */\nconst value = 1;\nexport function main() { return value; }\n","files":{"src/x.ts":"/** Keys. */\nconst value = 1;\nexport function main() { return value; }\n"}},
  {"name":"P09-outline-logical-set::digest-relation-02/observation-1","indices":[151,152],"filename":"src/x.ts","source":"/** Keys. */\nconst value = -1;\nexport function main() { return value; }\n","files":{"src/x.ts":"/** Keys. */\nconst value = -1;\nexport function main() { return value; }\n"}},
  {"name":"P10-complete-outline-links::base","indices":[156,157,158],"filename":"src/index.ts","source":"import { a } from \"./a\";\nexport { b } from \"./b\";\nexport * from \"@demo/pkg\";\nexport { local };\nconst lazy = () => import(\"./lazy\");\nconst any = (name: string) => import(name);\nconst legacy = require(\"./legacy\");\nimport cjs = require(\"./cjs\");","files":{"src/index.ts":"import { a } from \"./a\";\nexport { b } from \"./b\";\nexport * from \"@demo/pkg\";\nexport { local };\nconst lazy = () => import(\"./lazy\");\nconst any = (name: string) => import(name);\nconst legacy = require(\"./legacy\");\nimport cjs = require(\"./cjs\");"}},
  {"name":"V2-P01-parser-recovery-not-completeness::base","indices":[159],"filename":"broken.ts","source":"export function broken( { return 1; }\nexport function later(){return 2;}\n","files":{"broken.ts":"export function broken( { return 1; }\nexport function later(){return 2;}\n"}},
  {"name":"OL-B01::base","indices":[138,148,153,165,143,147,163],"filename":"src/specimen.ts","source":"const scalar = source;","files":{"src/specimen.ts":"const scalar = source;"}},
  {"name":"OL-B02::base","indices":[138,143,147,150,161],"filename":"src/specimen.ts","source":"export const { remote: local, nested: { leaf }, keep, ...rest } = source;","files":{"src/specimen.ts":"export const { remote: local, nested: { leaf }, keep, ...rest } = source;"}},
  {"name":"OL-B03::base","indices":[138],"filename":"src/specimen.ts","source":"export const [first, , [deep], ...tail] = source;","files":{"src/specimen.ts":"export const [first, , [deep], ...tail] = source;"}},
  {"name":"OL-B04::base","indices":[150,160,161],"filename":"src/specimen.ts","source":"const value = { remote: dependency.member, shorthand };","files":{"src/specimen.ts":"const value = { remote: dependency.member, shorthand };"}},
  {"name":"OL-B06::base","indices":[150],"filename":"src/specimen.ts","source":"type Choice = Space.Member;","files":{"src/specimen.ts":"type Choice = Space.Member;"}},
  {"name":"OL-C00::base","indices":[139,144,151,153,142,152],"filename":"src/specimen.ts","source":"class C {}","files":{"src/specimen.ts":"class C {}"}},
  {"name":"OL-C01::base","indices":[139],"filename":"src/specimen.ts","source":"class C { static {} }","files":{"src/specimen.ts":"class C { static {} }"}},
  {"name":"OL-C02::base","indices":[139,142,163],"filename":"src/specimen.ts","source":"class C { static value = run(); }","files":{"src/specimen.ts":"class C { static value = run(); }"}},
  {"name":"OL-C03::base","indices":[139,163],"filename":"src/specimen.ts","source":"class C { value = run(); }","files":{"src/specimen.ts":"class C { value = run(); }"}},
  {"name":"OL-C04::base","indices":[139,142],"filename":"src/specimen.ts","source":"class C { static value = 1; }","files":{"src/specimen.ts":"class C { static value = 1; }"}},
  {"name":"OL-C05::base","indices":[139,140],"filename":"src/specimen.ts","source":"class C extends factory() {}","files":{"src/specimen.ts":"class C extends factory() {}"}},
  {"name":"OL-C06::base","indices":[140],"filename":"src/specimen.ts","source":"class C extends Base {}","files":{"src/specimen.ts":"class C extends Base {}"}},
  {"name":"OL-C07::base","indices":[140],"filename":"src/specimen.ts","source":"class C implements Contract {}","files":{"src/specimen.ts":"class C implements Contract {}"}},
  {"name":"OL-C08::base","indices":[139],"filename":"src/specimen.ts","source":"class C { [key()]() {} }","files":{"src/specimen.ts":"class C { [key()]() {} }"}},
  {"name":"OL-C09::base","indices":[139],"filename":"src/specimen.ts","source":"class C { [key]() {} }","files":{"src/specimen.ts":"class C { [key]() {} }"}},
  {"name":"OL-C10::base","indices":[139],"filename":"src/specimen.ts","source":"@mark class C {}","files":{"src/specimen.ts":"@mark class C {}"}},
  {"name":"OL-C11::base","indices":[139],"filename":"src/specimen.ts","source":"class C { @mark method() {} }","files":{"src/specimen.ts":"class C { @mark method() {} }"}},
  {"name":"OL-C12::base","indices":[139,141],"filename":"src/specimen.ts","source":"class C { constructor(@mark value: unknown) {} }","files":{"src/specimen.ts":"class C { constructor(@mark value: unknown) {} }"}},
  {"name":"OL-C13::base","indices":[141],"filename":"src/specimen.ts","source":"class C { constructor(value: unknown) { mark(); } }","files":{"src/specimen.ts":"class C { constructor(value: unknown) { mark(); } }"}},
  {"name":"OL-C14::base","indices":[141],"filename":"src/specimen.ts","source":"class C { method(@mark value: unknown) {} }","files":{"src/specimen.ts":"class C { method(@mark value: unknown) {} }"}},
  {"name":"OL-C15::base","indices":[139,141],"filename":"src/specimen.ts","source":"class C { method(value: unknown) { mark(); } }","files":{"src/specimen.ts":"class C { method(value: unknown) { mark(); } }"}},
  {"name":"OL-C16::base","indices":[137,152,160,161,145],"filename":"src/specimen.ts","source":"class C {\n  constructor() { run(); }\n  method() { run(); }\n}","files":{"src/specimen.ts":"class C {\n  constructor() { run(); }\n  method() { run(); }\n}"}},
  {"name":"OL-C17::base","indices":[139,142],"filename":"src/specimen.ts","source":"class C { static method() { run(); } }","files":{"src/specimen.ts":"class C { static method() { run(); } }"}},
  {"name":"OL-C18::base","indices":[137,139,142,145],"filename":"src/specimen.ts","source":"class C { static value = () => run(); }","files":{"src/specimen.ts":"class C { static value = () => run(); }"}},
  {"name":"OL-C19::base","indices":[141],"filename":"src/specimen.ts","source":"class C { constructor(value = run()) {} }","files":{"src/specimen.ts":"class C { constructor(value = run()) {} }"}},
  {"name":"OL-C20::base","indices":[150,137],"filename":"src/specimen.ts","source":"class C { get value() { return run(); } }","files":{"src/specimen.ts":"class C { get value() { return run(); } }"}},
  {"name":"OL-C21::base","indices":[139,142],"filename":"src/specimen.ts","source":"class C { static value; }","files":{"src/specimen.ts":"class C { static value; }"}},
  {"name":"OL-M01::base","indices":[143,149,153,163,150],"filename":"src/specimen.ts","source":"import type { Remote as Local } from \"./mod\";","files":{"src/specimen.ts":"import type { Remote as Local } from \"./mod\";"}},
  {"name":"OL-M02::base","indices":[149,153,154,163],"filename":"src/specimen.ts","source":"import { type T, type U } from \"./mod\";","files":{"src/specimen.ts":"import { type T, type U } from \"./mod\";"}},
  {"name":"OL-M03::base","indices":[149,154,153],"filename":"src/specimen.ts","source":"import { type T, value as local } from \"./mod\";","files":{"src/specimen.ts":"import { type T, value as local } from \"./mod\";"}},
  {"name":"OL-M04::base","indices":[149,153,154],"filename":"src/specimen.ts","source":"import { value as local } from \"./mod\";","files":{"src/specimen.ts":"import { value as local } from \"./mod\";"}},
  {"name":"OL-M05::base","indices":[149,153],"filename":"src/specimen.ts","source":"import Default from \"./mod\";","files":{"src/specimen.ts":"import Default from \"./mod\";"}},
  {"name":"OL-M06::base","indices":[149,153],"filename":"src/specimen.ts","source":"import * as ns from \"./mod\";","files":{"src/specimen.ts":"import * as ns from \"./mod\";"}},
  {"name":"OL-M07::base","indices":[149,153],"filename":"src/specimen.ts","source":"import type * as ns from \"./mod\";","files":{"src/specimen.ts":"import type * as ns from \"./mod\";"}},
  {"name":"OL-M08::base","indices":[149,153],"filename":"src/specimen.ts","source":"import Default, * as ns from \"./mod\";","files":{"src/specimen.ts":"import Default, * as ns from \"./mod\";"}},
  {"name":"OL-M09::base","indices":[149,153,143],"filename":"src/specimen.ts","source":"import \"./mod\";","files":{"src/specimen.ts":"import \"./mod\";"}},
  {"name":"OL-M10::base","indices":[149,153,154],"filename":"src/specimen.ts","source":"import {} from \"./mod\";","files":{"src/specimen.ts":"import {} from \"./mod\";"}},
  {"name":"OL-M11::base","indices":[153],"filename":"src/specimen.ts","source":"import type {} from \"./mod\";","files":{"src/specimen.ts":"import type {} from \"./mod\";"}},
  {"name":"OL-M12::base","indices":[149,153],"filename":"src/specimen.ts","source":"import type Default from \"./mod\";","files":{"src/specimen.ts":"import type Default from \"./mod\";"}},
  {"name":"OL-M13::base","indices":[149,153],"filename":"src/specimen.ts","source":"import cjs = require(\"./mod\");","files":{"src/specimen.ts":"import cjs = require(\"./mod\");"}},
  {"name":"OL-M14::base","indices":[149,153],"filename":"src/specimen.ts","source":"import type cjs = require(\"./mod\");","files":{"src/specimen.ts":"import type cjs = require(\"./mod\");"}},
  {"name":"OL-M15::base","indices":[149,153],"filename":"src/specimen.ts","source":"import Alias = Space.Member;","files":{"src/specimen.ts":"import Alias = Space.Member;"}},
  {"name":"OL-M16::base","indices":[149,153],"filename":"src/specimen.ts","source":"export type { Type } from \"./mod\";","files":{"src/specimen.ts":"export type { Type } from \"./mod\";"}},
  {"name":"OL-M17::base","indices":[149,153,155],"filename":"src/specimen.ts","source":"export { type Type as Public } from \"./mod\";","files":{"src/specimen.ts":"export { type Type as Public } from \"./mod\";"}},
  {"name":"OL-M18::base","indices":[155,153],"filename":"src/specimen.ts","source":"export { type Type, value as publicValue } from \"./mod\";","files":{"src/specimen.ts":"export { type Type, value as publicValue } from \"./mod\";"}},
  {"name":"OL-M19::base","indices":[149,153,155,143,150],"filename":"src/specimen.ts","source":"export { value } from \"./mod\";","files":{"src/specimen.ts":"export { value } from \"./mod\";"}},
  {"name":"OL-M20::base","indices":[153,155],"filename":"src/specimen.ts","source":"export {} from \"./mod\";","files":{"src/specimen.ts":"export {} from \"./mod\";"}},
  {"name":"OL-M21::base","indices":[149,153,155],"filename":"src/specimen.ts","source":"export * from \"./mod\";","files":{"src/specimen.ts":"export * from \"./mod\";"}},
  {"name":"OL-M22::base","indices":[143,149,150,153],"filename":"src/specimen.ts","source":"export { local as outward };","files":{"src/specimen.ts":"export { local as outward };"}},
  {"name":"OL-M23::base","indices":[149,153],"filename":"src/specimen.ts","source":"export * as ns from \"./mod\";","files":{"src/specimen.ts":"export * as ns from \"./mod\";"}},
  {"name":"OL-M24::base","indices":[153],"filename":"src/specimen.ts","source":"export type * from \"./mod\";","files":{"src/specimen.ts":"export type * from \"./mod\";"}},
  {"name":"OL-C22::base","indices":[139,142],"filename":"src/specimen.ts","source":"class C { public value = run(); }","files":{"src/specimen.ts":"class C { public value = run(); }"}},
  {"name":"OL-C23::base","indices":[139,142],"filename":"src/specimen.ts","source":"class C { public static value = run(); }","files":{"src/specimen.ts":"class C { public static value = run(); }"}},
  {"name":"ORD-OUTLINE-DEFAULT-OWNERS::variant-01","indices":[143,144,147,148],"filename":"src/x.ts","source":"export default function named() {}","files":{"src/x.ts":"export default function named() {}"}},
  {"name":"ORD-OUTLINE-DEFAULT-OWNERS::variant-02","indices":[143,144,147,148],"filename":"src/x.ts","source":"export default function() {}","files":{"src/x.ts":"export default function() {}"}},
  {"name":"ORD-OUTLINE-DEFAULT-OWNERS::variant-03","indices":[143,144,147,148],"filename":"src/x.ts","source":"export default local.member;","files":{"src/x.ts":"export default local.member;"}},
  {"name":"ORD-OUTLINE-ENUM-NAMESPACE::variant-01","indices":[143,150,163,164],"filename":"src/x.ts","source":"enum E { a = run() }","files":{"src/x.ts":"enum E { a = run() }"}},
  {"name":"ORD-OUTLINE-ENUM-NAMESPACE::variant-02","indices":[143,150,163,164],"filename":"src/x.ts","source":"enum E { a = 1 }","files":{"src/x.ts":"enum E { a = 1 }"}},
  {"name":"ORD-OUTLINE-ENUM-NAMESPACE::variant-03","indices":[143,150,163,164],"filename":"src/x.ts","source":"namespace N { run(); }","files":{"src/x.ts":"namespace N { run(); }"}},
  {"name":"ORD-OUTLINE-ENUM-NAMESPACE::variant-04","indices":[143,150,163,164],"filename":"src/x.ts","source":"namespace N {}","files":{"src/x.ts":"namespace N {}"}},
  {"name":"ORD-OUTLINE-ENUM-NAMESPACE::variant-05","indices":[143,150,163,164],"filename":"src/x.ts","source":"interface I { field: unknown; method(): void; }","files":{"src/x.ts":"interface I { field: unknown; method(): void; }"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-01","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter = 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter = 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-02","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter += 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter += 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-03","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter -= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter -= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-04","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter *= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter *= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-05","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter **= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter **= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-06","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter /= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter /= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-07","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter %= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter %= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-08","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter <<= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter <<= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-09","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter >>= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter >>= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-10","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter >>>= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter >>>= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-11","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter &= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter &= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-12","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter |= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter |= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-13","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter ^= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter ^= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-14","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter ||= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter ||= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-15","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter &&= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter &&= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-16","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (counter ??= 1);","files":{"__adapter_component_carrier__.ts":"const value = (counter ??= 1);"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-17","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = counter + 1;","files":{"__adapter_component_carrier__.ts":"const value = counter + 1;"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-18","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = counter++;","files":{"__adapter_component_carrier__.ts":"const value = counter++;"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-19","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = --counter;","files":{"__adapter_component_carrier__.ts":"const value = --counter;"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-20","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = new Model();","files":{"__adapter_component_carrier__.ts":"const value = new Model();"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-21","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = tag`text`;","files":{"__adapter_component_carrier__.ts":"const value = tag`text`;"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-22","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = await task;","files":{"__adapter_component_carrier__.ts":"const value = await task;"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-23","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = delete object.key;","files":{"__adapter_component_carrier__.ts":"const value = delete object.key;"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-24","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = { nested: run() };","files":{"__adapter_component_carrier__.ts":"const value = { nested: run() };"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-25","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = { nested: function() { run(); } };","files":{"__adapter_component_carrier__.ts":"const value = { nested: function() { run(); } };"}},
  {"name":"ORD-OUTLINE-EVALUATION::variant-26","indices":[137,145,146,163,165],"filename":"__adapter_component_carrier__.ts","source":"const value = (1 as typeof run);","files":{"__adapter_component_carrier__.ts":"const value = (1 as typeof run);"}},
  {"name":"ORD-OUTLINE-SCRIPT-KIND::variant-01","indices":[150,162],"filename":"src/view.tsx","source":"const view = <Panel item={source} />;","files":{"src/view.tsx":"const view = <Panel item={source} />;"}},
  {"name":"ORD-OUTLINE-SCRIPT-KIND::variant-02","indices":[150,162],"filename":"src/view.ts","source":"const view = <Panel item={source} />;","files":{"src/view.ts":"const view = <Panel item={source} />;"}},
  {"name":"ORD-OUTLINE-COMMENT-CONTROLS::base/observation-0","indices":[151,152,159],"filename":"src/comments.ts","source":"// @ts-ignore\nconst value = 1;\n// ordinary\n/** @invariant INV-1 */\nconst other = 2;","files":{"src/comments.ts":"// @ts-ignore\nconst value = 1;\n// ordinary\n/** @invariant INV-1 */\nconst other = 2;"}},
  {"name":"ORD-OUTLINE-COMMENT-CONTROLS::base/observation-1","indices":[151,152,159],"filename":"src/comments.ts","source":"// ordinary first\nconst value = 1;\n// ordinary\n/** ordinary doc */\nconst other = 2;","files":{"src/comments.ts":"// ordinary first\nconst value = 1;\n// ordinary\n/** ordinary doc */\nconst other = 2;"}},
  {"name":"ORD-OUTLINE-PRIVATE-DIGEST::base/observation-0","indices":[166],"filename":"__adapter_private_digest__.ts","source":"class C { #first = 1; }","files":{"__adapter_private_digest__.ts":"class C { #first = 1; }"}},
  {"name":"ORD-OUTLINE-PRIVATE-DIGEST::base/observation-1","indices":[166],"filename":"__adapter_private_digest__.ts","source":"class C { #second = 1; }","files":{"__adapter_private_digest__.ts":"class C { #second = 1; }"}},
  {"name":"SUITE-links-namespace-type-only","indices":[156,158],"filename":"main.ts","source":"import * as ns from './ns';\nimport defaultValue, * as both from './both';\nimport type * as types from './types';\nimport { named } from './named';\nexport * from './all';\nexport type * from './typed';\nexport type { T } from './t';\nimport type legacy = require('./legacy-types');","files":{"main.ts":"import * as ns from './ns';\nimport defaultValue, * as both from './both';\nimport type * as types from './types';\nimport { named } from './named';\nexport * from './all';\nexport type * from './typed';\nexport type { T } from './t';\nimport type legacy = require('./legacy-types');"}},
  {"name":"SUITE-outline-0","indices":[159,166],"filename":"main.ts","source":"import { a } from \"./a\";","files":{"main.ts":"import { a } from \"./a\";"}},
  {"name":"SUITE-outline-1","indices":[159,166],"filename":"main.ts","source":"import \"./side-effect\";","files":{"main.ts":"import \"./side-effect\";"}},
  {"name":"SUITE-outline-2","indices":[159,166],"filename":"main.ts","source":"const KEYS = [a, 1] as const;","files":{"main.ts":"const KEYS = [a, 1] as const;"}},
  {"name":"SUITE-outline-3","indices":[159,166],"filename":"main.ts","source":"export function f(value: string): boolean {","files":{"main.ts":"export function f(value: string): boolean {"}},
  {"name":"SUITE-outline-4","indices":[159,166],"filename":"main.ts","source":"export { KEYS as keys };","files":{"main.ts":"export { KEYS as keys };"}},
  {"name":"SUITE-outline-5","indices":[159,166],"filename":"main.ts","source":"export const = ;","files":{"main.ts":"export const = ;"}},
  {"name":"SUITE-outline-6","indices":[159,166],"filename":"main.ts","source":"export const D = -1;","files":{"main.ts":"export const D = -1;"}},
  {"name":"SUITE-outline-7","indices":[159,166],"filename":"main.ts","source":"export const D = +1;","files":{"main.ts":"export const D = +1;"}},
  {"name":"SUITE-outline-8","indices":[159,166],"filename":"main.ts","source":"function f(x: number) { return -x; }","files":{"main.ts":"function f(x: number) { return -x; }"}},
  {"name":"SUITE-outline-9","indices":[159,166],"filename":"main.ts","source":"function f(x: number) { return ~x; }","files":{"main.ts":"function f(x: number) { return ~x; }"}},
  {"name":"SUITE-outline-10","indices":[159,166],"filename":"main.ts","source":"function f() { count++; }","files":{"main.ts":"function f() { count++; }"}},
  {"name":"SUITE-outline-11","indices":[159,166],"filename":"main.ts","source":"function f() { count--; }","files":{"main.ts":"function f() { count--; }"}},
  {"name":"SUITE-outline-12","indices":[159,166],"filename":"main.ts","source":"function f() { const lock = acquire(); }","files":{"main.ts":"function f() { const lock = acquire(); }"}},
  {"name":"SUITE-outline-13","indices":[159,166],"filename":"main.ts","source":"function f() { using lock = acquire(); }","files":{"main.ts":"function f() { using lock = acquire(); }"}},
  {"name":"SUITE-outline-14","indices":[159,166],"filename":"main.ts","source":"class C extends B {}","files":{"main.ts":"class C extends B {}"}},
  {"name":"SUITE-outline-15","indices":[159,166],"filename":"main.ts","source":"class C implements B {}","files":{"main.ts":"class C implements B {}"}},
  {"name":"SUITE-outline-16","indices":[159,166],"filename":"main.ts","source":"namespace N {}","files":{"main.ts":"namespace N {}"}},
  {"name":"SUITE-outline-17","indices":[159,166],"filename":"main.ts","source":"const p = String.raw`a\\d`;","files":{"main.ts":"const p = String.raw`a\\d`;"}},
  {"name":"SUITE-outline-18","indices":[159,166],"filename":"main.ts","source":"const p = String.raw`a\\x64`;","files":{"main.ts":"const p = String.raw`a\\x64`;"}},
  {"name":"SUITE-outline-19","indices":[159,166],"filename":"main.ts","source":"export { foo };","files":{"main.ts":"export { foo };"}},
  {"name":"SUITE-outline-20","indices":[159,166],"filename":"main.ts","source":"export type { foo };","files":{"main.ts":"export type { foo };"}},
  {"name":"SUITE-outline-21","indices":[159,166],"filename":"main.ts","source":"import type { S } from \"./s\";","files":{"main.ts":"import type { S } from \"./s\";"}},
  {"name":"SUITE-outline-22","indices":[159,166],"filename":"main.ts","source":"import { S } from \"./s\";","files":{"main.ts":"import { S } from \"./s\";"}},
  {"name":"SUITE-outline-23","indices":[159,166],"filename":"main.ts","source":"export = foo;","files":{"main.ts":"export = foo;"}},
  {"name":"SUITE-outline-24","indices":[159,166],"filename":"main.ts","source":"export default foo;","files":{"main.ts":"export default foo;"}},
  {"name":"SUITE-outline-25","indices":[159,166],"filename":"main.ts","source":"for (x; y;) {}","files":{"main.ts":"for (x; y;) {}"}},
  {"name":"SUITE-outline-26","indices":[159,166],"filename":"main.ts","source":"for (; x; y) {}","files":{"main.ts":"for (; x; y) {}"}},
  {"name":"SUITE-outline-27","indices":[159,166],"filename":"main.ts","source":"const a = [1, 2];","files":{"main.ts":"const a = [1, 2];"}},
  {"name":"SUITE-outline-28","indices":[159,166],"filename":"main.ts","source":"const a = [1, 2,];","files":{"main.ts":"const a = [1, 2,];"}},
  {"name":"SUITE-outline-29","indices":[159,166],"filename":"main.ts","source":"const a = f(1, 2);","files":{"main.ts":"const a = f(1, 2);"}},
  {"name":"SUITE-outline-30","indices":[159,166],"filename":"main.ts","source":"const a = f(\n  1,\n  2,\n);","files":{"main.ts":"const a = f(\n  1,\n  2,\n);"}},
  {"name":"SUITE-outline-31","indices":[159,166],"filename":"main.ts","source":"interface I { a: string; b: number }","files":{"main.ts":"interface I { a: string; b: number }"}},
  {"name":"SUITE-outline-32","indices":[159,166],"filename":"main.ts","source":"interface I { a: string, b: number, }","files":{"main.ts":"interface I { a: string, b: number, }"}},
  {"name":"SUITE-outline-33","indices":[159,166],"filename":"main.ts","source":"/** doc */\nconst a = 1;","files":{"main.ts":"/** doc */\nconst a = 1;"}},
  {"name":"SUITE-outline-34","indices":[159,166],"filename":"main.ts","source":"/** other */\nconst a = 1; // trailing","files":{"main.ts":"/** other */\nconst a = 1; // trailing"}},
  {"name":"SUITE-outline-35","indices":[159,166],"filename":"main.ts","source":"class Ctl { constructor(@Inject(T) svc: unknown) {} }","files":{"main.ts":"class Ctl { constructor(@Inject(T) svc: unknown) {} }"}},
  {"name":"SUITE-outline-36","indices":[159,166],"filename":"main.ts","source":"class Handler { handle(@Inject(T) svc: unknown) {} }","files":{"main.ts":"class Handler { handle(@Inject(T) svc: unknown) {} }"}},
  {"name":"SUITE-outline-37","indices":[159,166],"filename":"main.ts","source":"import type { A } from \"./a\";","files":{"main.ts":"import type { A } from \"./a\";"}},
  {"name":"SUITE-outline-38","indices":[159,166],"filename":"main.ts","source":"import { type B } from \"./a\";","files":{"main.ts":"import { type B } from \"./a\";"}},
  {"name":"SUITE-outline-39","indices":[159,166],"filename":"main.ts","source":"import { v } from \"./a\";","files":{"main.ts":"import { v } from \"./a\";"}},
  {"name":"SUITE-outline-40","indices":[159,166],"filename":"main.ts","source":"import \"./side\";","files":{"main.ts":"import \"./side\";"}},
  {"name":"SUITE-outline-41","indices":[159,166],"filename":"main.ts","source":"export type { T } from \"./t\";","files":{"main.ts":"export type { T } from \"./t\";"}},
  {"name":"SUITE-outline-42","indices":[159,166],"filename":"main.ts","source":"export * from \"./r\";","files":{"main.ts":"export * from \"./r\";"}},
  {"name":"SUITE-outline-43","indices":[159,166],"filename":"main.ts","source":"import cjs = require(\"./cjs\");","files":{"main.ts":"import cjs = require(\"./cjs\");"}},
  {"name":"SUITE-outline-44","indices":[159,166],"filename":"main.ts","source":"import { a } from \"./a\";","files":{"main.ts":"import { a } from \"./a\";"}},
  {"name":"SUITE-outline-45","indices":[159,166],"filename":"main.ts","source":"export { b } from \"./b\";","files":{"main.ts":"export { b } from \"./b\";"}},
  {"name":"SUITE-outline-46","indices":[159,166],"filename":"main.ts","source":"export * from \"@demo/pkg\";","files":{"main.ts":"export * from \"@demo/pkg\";"}},
  {"name":"SUITE-outline-47","indices":[159,166],"filename":"main.ts","source":"export { local };","files":{"main.ts":"export { local };"}},
  {"name":"SUITE-outline-48","indices":[159,166],"filename":"main.ts","source":"const lazy = () => import(\"./lazy\");","files":{"main.ts":"const lazy = () => import(\"./lazy\");"}},
  {"name":"SUITE-outline-49","indices":[159,166],"filename":"main.ts","source":"const any = (name: string) => import(name);","files":{"main.ts":"const any = (name: string) => import(name);"}},
  {"name":"SUITE-outline-50","indices":[159,166],"filename":"main.ts","source":"const legacy = require(\"./legacy\");","files":{"main.ts":"const legacy = require(\"./legacy\");"}},
  {"name":"SUITE-outline-51","indices":[159,166],"filename":"main.ts","source":"import cjs = require(\"./cjs\");","files":{"main.ts":"import cjs = require(\"./cjs\");"}},
  {"name":"SUITE-outline-52","indices":[159,166],"filename":"main.ts","source":"import * as ns from \"./ns\";","files":{"main.ts":"import * as ns from \"./ns\";"}},
  {"name":"SUITE-outline-53","indices":[159,166],"filename":"main.ts","source":"import def, * as both from \"./both\";","files":{"main.ts":"import def, * as both from \"./both\";"}},
  {"name":"SUITE-outline-54","indices":[159,166],"filename":"main.ts","source":"import type * as types from \"./types\";","files":{"main.ts":"import type * as types from \"./types\";"}},
  {"name":"SUITE-outline-55","indices":[159,166],"filename":"main.ts","source":"import def2, { named } from \"./named\";","files":{"main.ts":"import def2, { named } from \"./named\";"}},
  {"name":"SUITE-outline-56","indices":[159,166],"filename":"main.ts","source":"export * as all from \"./all\";","files":{"main.ts":"export * as all from \"./all\";"}},
  {"name":"SUITE-outline-57","indices":[159,166],"filename":"main.ts","source":"export type * from \"./typed\";","files":{"main.ts":"export type * from \"./typed\";"}},
  {"name":"SUITE-outline-58","indices":[159,166],"filename":"main.ts","source":"export type { T } from \"./t\";","files":{"main.ts":"export type { T } from \"./t\";"}},
  {"name":"SUITE-outline-59","indices":[159,166],"filename":"main.ts","source":"import type legacy = require(\"./legacy-types\");","files":{"main.ts":"import type legacy = require(\"./legacy-types\");"}},
  {"name":"ambient-and-dotted-module","indices":[143,144,159,163],"filename":"main.ts","source":"declare module \"ambient\" {}\nnamespace Outer.Inner { export const x = run(); }\ndeclare namespace Missing;","files":{"main.ts":"declare module \"ambient\" {}\nnamespace Outer.Inner { export const x = run(); }\ndeclare namespace Missing;"}},
  {"name":"module-links-literal-and-nonliteral","indices":[156,157,158],"filename":"main.ts","source":"import './side';\nimport legacy = require('./legacy');\nimport type types = require('./types');\nexport { value } from './named';\nexport * as all from './whole';\nimport('./dynamic');\nimport(name);\nrequire(`./template`);\nrequire(name);\nrequire();\nfunction deferred() { require('./nested'); }","files":{"main.ts":"import './side';\nimport legacy = require('./legacy');\nimport type types = require('./types');\nexport { value } from './named';\nexport * as all from './whole';\nimport('./dynamic');\nimport(name);\nrequire(`./template`);\nrequire(name);\nrequire();\nfunction deferred() { require('./nested'); }"}},
  {"name":"evaluation-controls-and-directives","indices":[137,139,140,141,142,145,146,147,148,151,152,159,163,164,165],"filename":"main.ts","source":"// @ts-check\n// @capability outline\ndeclare const ambient: unknown;\nconst enum Frozen { A = run() }\nenum Live { A = run() }\nusing resource = value;\nexport default run();\nclass Deferred { value = run(); method() { run(); } }\nclass Static { static value = run(); }\nclass Computed { [run()]() {} }\n@decorate class Decorated {}\nclass Parameter { constructor(@decorate value: unknown) {} }","files":{"main.ts":"// @ts-check\n// @capability outline\ndeclare const ambient: unknown;\nconst enum Frozen { A = run() }\nenum Live { A = run() }\nusing resource = value;\nexport default run();\nclass Deferred { value = run(); method() { run(); } }\nclass Static { static value = run(); }\nclass Computed { [run()]() {} }\n@decorate class Decorated {}\nclass Parameter { constructor(@decorate value: unknown) {} }"}},
  {"name":"jsx-extension-negative","indices":[162,159],"filename":"main.jsx","source":"const view = <Panel prop={value}>text</Panel>;","files":{"main.jsx":"const view = <Panel prop={value}>text</Panel>;"}},
  {"name":"utf16-name-order","indices":[143,159,160,161],"filename":"main.ts","source":"const value = [𐐀, Ａ]; export {𐐀, Ａ};","files":{"main.ts":"const value = [𐐀, Ａ]; export {𐐀, Ａ};"}},
];

export const coverageGaps: Record<number, string> = {
  145: "Les contrôles couvrent les expressions immédiates et différées sauf un témoin positif indépendant YieldExpression accepté à portée fichier; l'obligation cumulative reste non qualifiée.",
  166: "La représentation exacte getChildren/tokens/digest TS7 n'est pas figée; aucune preuve indépendante des octets ni des relations de digest n'est livrée.",
};

export const cases: CampaignCase[] = specimens.map((specimen) => ({
  name: `O/${specimen.name}`,
  indices: specimen.indices,
  mode: "raw",
  request: { files: specimen.files, roots: Object.keys(specimen.files).filter((path) => /\.(?:[cm]?[tj]sx?)$/.test(path)), qualified: false },
  oracleInput: { operation: "outline", source: specimen.source, filename: specimen.filename },
  checks: [
    {
      name: "all-statement-fields-order-and-absence-except-unspecified-digest",
      actual: ["outlines", specimen.filename, "outline", "statements"],
      expected: ["observation", "statements"],
      transform: "outline-statements-without-digest",
    },
    ...["exportedNames", "hasSyntaxErrors", "directiveLines", "markerLines"].map((field) => ({
      name: field,
      actual: ["outlines", specimen.filename, "outline", field],
      expected: ["observation", field],
    })),
    {
      name: "complete-module-links-in-source-order",
      actual: ["outlines", specimen.filename, "moduleLinks"],
      expected: ["observation", "moduleLinks"],
    },
  ],
  gaps: Object.fromEntries<string>(specimen.indices.flatMap((index): [number, string][] => {
    const gap = coverageGaps[index];
    return gap === undefined ? [] : [[index, gap]];
  })),
}));

export const propertyWitnesses: Record<number, Record<string, string[]>> = {
  "137": {
    "arrow body deferred": [
      "O/OL-C18::base",
      "O/ORD-OUTLINE-EVALUATION::variant-25"
    ],
    "method/constructor bodies deferred": [
      "O/OL-C16::base",
      "O/OL-C20::base"
    ],
    "assignment operators and function-expression deferred": [
      "O/ORD-OUTLINE-EVALUATION::variant-01",
      "O/ORD-OUTLINE-EVALUATION::variant-02",
      "O/ORD-OUTLINE-EVALUATION::variant-03",
      "O/ORD-OUTLINE-EVALUATION::variant-04",
      "O/ORD-OUTLINE-EVALUATION::variant-05",
      "O/ORD-OUTLINE-EVALUATION::variant-06",
      "O/ORD-OUTLINE-EVALUATION::variant-07",
      "O/ORD-OUTLINE-EVALUATION::variant-08",
      "O/ORD-OUTLINE-EVALUATION::variant-09",
      "O/ORD-OUTLINE-EVALUATION::variant-10",
      "O/ORD-OUTLINE-EVALUATION::variant-11",
      "O/ORD-OUTLINE-EVALUATION::variant-12",
      "O/ORD-OUTLINE-EVALUATION::variant-13",
      "O/ORD-OUTLINE-EVALUATION::variant-14",
      "O/ORD-OUTLINE-EVALUATION::variant-15",
      "O/ORD-OUTLINE-EVALUATION::variant-16",
      "O/ORD-OUTLINE-EVALUATION::variant-17",
      "O/ORD-OUTLINE-EVALUATION::variant-18",
      "O/ORD-OUTLINE-EVALUATION::variant-19",
      "O/ORD-OUTLINE-EVALUATION::variant-20",
      "O/ORD-OUTLINE-EVALUATION::variant-21",
      "O/ORD-OUTLINE-EVALUATION::variant-22",
      "O/ORD-OUTLINE-EVALUATION::variant-23",
      "O/ORD-OUTLINE-EVALUATION::variant-24",
      "O/ORD-OUTLINE-EVALUATION::variant-25",
      "O/ORD-OUTLINE-EVALUATION::variant-26"
    ]
  },
  "138": {
    "declaredNames scalar versus recursive binding names": [
      "O/OL-B01::base",
      "O/OL-B02::base",
      "O/OL-B03::base"
    ],
    "complete ordered declaredNames including nested and rest names": [
      "O/OL-B02::base",
      "O/OL-B03::base"
    ],
    "first/deep/tail only; no hole entry": [
      "O/OL-B03::base",
      "O/OL-B01::base"
    ]
  },
  "139": {
    "executesOnLoad false versus isolated trigger true": [
      "O/OL-C00::base",
      "O/OL-C10::base"
    ],
    "true versus false, no call initializer": [
      "O/OL-C00::base",
      "O/OL-C01::base"
    ],
    "empty static block still true": [
      "O/OL-C01::base",
      "O/OL-C00::base"
    ],
    "decorated method definition true versus body call deferred": [
      "O/OL-C11::base",
      "O/OL-C15::base"
    ],
    "computed call true versus identifier-only computed name false": [
      "O/OL-C08::base",
      "O/OL-C09::base"
    ],
    "static call true versus instance/literal/method/deferred-arrow/missing initializer false": [
      "O/OL-C02::base",
      "O/OL-C03::base",
      "O/OL-C04::base",
      "O/OL-C17::base",
      "O/OL-C18::base",
      "O/OL-C21::base"
    ]
  },
  "140": {
    "extends call true, extends identifier false, implements ignored": [
      "O/OL-C05::base",
      "O/OL-C06::base",
      "O/OL-C07::base"
    ]
  },
  "141": {
    "constructor/method parameter decorators true; body/default calls deferred": [
      "O/OL-C12::base",
      "O/OL-C13::base",
      "O/OL-C14::base",
      "O/OL-C15::base",
      "O/OL-C19::base"
    ]
  },
  "142": {
    "Explicit public modifier invokes callback false, public static invokes false then true. Compare complete projection: instance initializer false versus static call true. Empty modifier list is tracked separately and is not a false-callback witness.": [
      "O/OL-C22::base",
      "O/OL-C23::base",
      "O/OL-C00::base"
    ]
  },
  "143": {
    "variable destructuring declared/exported names": [
      "O/OL-B02::base",
      "O/OL-B01::base"
    ],
    "import description and bindings": [
      "O/OL-M01::base",
      "O/OL-M09::base"
    ],
    "local exported original name": [
      "O/OL-M22::base",
      "O/OL-M19::base"
    ],
    "named/anonymous default and export assignment": [
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-01",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-02",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-03"
    ],
    "enum/namespace/interface categories": [
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-01",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-02",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-03",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-04",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-05"
    ]
  },
  "144": {
    "named default adds local+default, anonymous binds default": [
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-01",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-02",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-03"
    ],
    "ordinary named class": [
      "O/OL-C00::base",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-01"
    ]
  },
  "145": {
    "specific executable/deferred/recursive expression predicates": [
      "O/ORD-OUTLINE-EVALUATION::variant-01",
      "O/ORD-OUTLINE-EVALUATION::variant-02",
      "O/ORD-OUTLINE-EVALUATION::variant-03",
      "O/ORD-OUTLINE-EVALUATION::variant-04",
      "O/ORD-OUTLINE-EVALUATION::variant-05",
      "O/ORD-OUTLINE-EVALUATION::variant-06",
      "O/ORD-OUTLINE-EVALUATION::variant-07",
      "O/ORD-OUTLINE-EVALUATION::variant-08",
      "O/ORD-OUTLINE-EVALUATION::variant-09",
      "O/ORD-OUTLINE-EVALUATION::variant-10",
      "O/ORD-OUTLINE-EVALUATION::variant-11",
      "O/ORD-OUTLINE-EVALUATION::variant-12",
      "O/ORD-OUTLINE-EVALUATION::variant-13",
      "O/ORD-OUTLINE-EVALUATION::variant-14",
      "O/ORD-OUTLINE-EVALUATION::variant-15",
      "O/ORD-OUTLINE-EVALUATION::variant-16",
      "O/ORD-OUTLINE-EVALUATION::variant-17",
      "O/ORD-OUTLINE-EVALUATION::variant-18",
      "O/ORD-OUTLINE-EVALUATION::variant-19",
      "O/ORD-OUTLINE-EVALUATION::variant-20",
      "O/ORD-OUTLINE-EVALUATION::variant-21",
      "O/ORD-OUTLINE-EVALUATION::variant-22",
      "O/ORD-OUTLINE-EVALUATION::variant-23",
      "O/ORD-OUTLINE-EVALUATION::variant-24",
      "O/ORD-OUTLINE-EVALUATION::variant-25",
      "O/ORD-OUTLINE-EVALUATION::variant-26",
      "O/OL-C18::base",
      "O/OL-C16::base"
    ],
    "deferred arrow initializer": [
      "O/OL-C18::base",
      "O/ORD-OUTLINE-EVALUATION::variant-24",
      "O/ORD-OUTLINE-EVALUATION::variant-25"
    ]
  },
  "146": {
    "nested object call true versus deferred function/type subtree false": [
      "O/ORD-OUTLINE-EVALUATION::variant-24",
      "O/ORD-OUTLINE-EVALUATION::variant-25",
      "O/ORD-OUTLINE-EVALUATION::variant-26"
    ]
  },
  "147": {
    "exported declarations": [
      "O/OL-B02::base",
      "O/OL-B01::base"
    ],
    "default versus named export names": [
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-01",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-02",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-03"
    ]
  },
  "148": {
    "Export then Default modifiers give false then true when querying default": [
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-01",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-02"
    ],
    "no export control": [
      "O/OL-B01::base",
      "O/ORD-OUTLINE-DEFAULT-OWNERS::variant-01"
    ]
  },
  "149": {
    "external moduleSpecifier present with importBindings absent; local export has neither": [
      "O/OL-M16::base",
      "O/OL-M22::base"
    ],
    "external moduleSpecifier and equals binding; internal alias has neither": [
      "O/OL-M13::base",
      "O/OL-M14::base",
      "O/OL-M15::base"
    ],
    "default-first binding and clause type-only flag": [
      "O/OL-M05::base",
      "O/OL-M08::base",
      "O/OL-M12::base"
    ],
    "star binding versus named binding": [
      "O/OL-M06::base",
      "O/OL-M07::base",
      "O/OL-M01::base"
    ],
    "exact ordered aliases/type flags versus present empty array": [
      "O/OL-M01::base",
      "O/OL-M02::base",
      "O/OL-M03::base",
      "O/OL-M09::base",
      "O/OL-M10::base"
    ],
    "typeOnly is whole-clause OR inline flag": [
      "O/OL-M01::base",
      "O/OL-M02::base",
      "O/OL-M03::base",
      "O/OL-M04::base"
    ],
    "moduleSpecifier/importBindings absent versus present": [
      "O/OL-M09::base",
      "O/OL-M15::base",
      "O/OL-M22::base",
      "O/OL-M01::base"
    ]
  },
  "150": {
    "dependency/shorthand kept, remote/member suppressed": [
      "O/OL-B04::base",
      "O/OL-M01::base"
    ],
    "qualified right member suppressed": [
      "O/OL-B06::base",
      "O/OL-B04::base"
    ],
    "binding property keys suppressed": [
      "O/OL-B02::base",
      "O/OL-B04::base"
    ],
    "export propertyName suppressed": [
      "O/OL-M22::base",
      "O/OL-M19::base"
    ],
    "accessor name suppressed": [
      "O/OL-C20::base",
      "O/OL-B04::base"
    ],
    "JSX attribute name suppressed": [
      "O/ORD-OUTLINE-SCRIPT-KIND::variant-01",
      "O/ORD-OUTLINE-SCRIPT-KIND::variant-02"
    ],
    "enum/property/method-signature names suppressed": [
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-01",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-02",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-05"
    ]
  },
  "151": {
    "leading JSDoc begins line1 before variableline2": [
      "O/P09-outline-logical-set::base-facts",
      "O/OL-C00::base"
    ],
    "no leading comment leadingStartLine=startLine": [
      "O/OL-C00::base",
      "O/P09-outline-logical-set::base-facts"
    ],
    "earliest preceding ordinary commentline3 before statementline5": [
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-0",
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-1"
    ]
  },
  "152": {
    "start/end/leading lines": [
      "O/P09-outline-logical-set::base-facts",
      "O/OL-C16::base",
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-0"
    ],
    "multiline class endLine4": [
      "O/OL-C16::base",
      "O/OL-C00::base"
    ],
    "manual line triples": [
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-0",
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-1",
      "O/P09-outline-logical-set::base-facts"
    ]
  },
  "153": {
    "yes side-effect versus maybe empty import versus never clause type-only": [
      "O/OL-M09::base",
      "O/OL-M10::base",
      "O/OL-M11::base"
    ],
    "never versus inline maybe and value yes": [
      "O/OL-M01::base",
      "O/OL-M02::base",
      "O/OL-M03::base",
      "O/OL-M04::base"
    ],
    "yes early default/namespace versus named-only maybe": [
      "O/OL-M05::base",
      "O/OL-M06::base",
      "O/OL-M07::base",
      "O/OL-M08::base",
      "O/OL-M02::base"
    ],
    "yes external value versus never external type versus absent internal alias": [
      "O/OL-M13::base",
      "O/OL-M14::base",
      "O/OL-M15::base"
    ],
    "yes versus never/maybe/absent; syntax-only no canonical resolution": [
      "O/OL-M16::base",
      "O/OL-M17::base",
      "O/OL-M18::base",
      "O/OL-M19::base",
      "O/OL-M20::base",
      "O/OL-M21::base",
      "O/OL-M22::base",
      "O/OL-M23::base",
      "O/OL-M24::base"
    ],
    "loadsModule absent for non-module-loader statements": [
      "O/OL-M22::base",
      "O/OL-B01::base"
    ]
  },
  "154": {
    "some not-type-only true/false; mixed order exercises false then true; empty uses no callback": [
      "O/OL-M02::base",
      "O/OL-M03::base",
      "O/OL-M04::base",
      "O/OL-M10::base"
    ]
  },
  "155": {
    "every type-only true versus mixed false; empty vacuously true and star has no named callback": [
      "O/OL-M17::base",
      "O/OL-M18::base",
      "O/OL-M19::base",
      "O/OL-M20::base",
      "O/OL-M21::base"
    ]
  },
  "156": {
    "complete ordered literal/nonliteral link list": [
      "O/P10-complete-outline-links::base",
      "O/module-links-literal-and-nonliteral"
    ],
    "unknown specifier null": [
      "O/module-links-literal-and-nonliteral"
    ],
    "whole exactly namespace/star/import()/require()": [
      "O/SUITE-links-namespace-type-only",
      "O/module-links-literal-and-nonliteral"
    ]
  },
  "157": {
    "literal strings and nonliteral null": [
      "O/module-links-literal-and-nonliteral"
    ],
    "missing argument null": [
      "O/module-links-literal-and-nonliteral"
    ]
  },
  "158": {
    "source-order import/reexport/dynamic/require": [
      "O/P10-complete-outline-links::base",
      "O/module-links-literal-and-nonliteral"
    ],
    "type-only namespace/star/import-equals does not get whole": [
      "O/SUITE-links-namespace-type-only",
      "O/module-links-literal-and-nonliteral"
    ]
  },
  "159": {
    "owning consumer observable rule(s) in canonical family/call-path contract": [
      "O/SUITE-outline-0",
      "O/SUITE-outline-1",
      "O/SUITE-outline-2",
      "O/SUITE-outline-3",
      "O/SUITE-outline-4",
      "O/SUITE-outline-5",
      "O/SUITE-outline-6",
      "O/SUITE-outline-7",
      "O/SUITE-outline-8",
      "O/SUITE-outline-9",
      "O/SUITE-outline-10",
      "O/SUITE-outline-11",
      "O/SUITE-outline-12",
      "O/SUITE-outline-13",
      "O/SUITE-outline-14",
      "O/SUITE-outline-15",
      "O/SUITE-outline-16",
      "O/SUITE-outline-17",
      "O/SUITE-outline-18",
      "O/SUITE-outline-19",
      "O/SUITE-outline-20",
      "O/SUITE-outline-21",
      "O/SUITE-outline-22",
      "O/SUITE-outline-23",
      "O/SUITE-outline-24",
      "O/SUITE-outline-25",
      "O/SUITE-outline-26",
      "O/SUITE-outline-27",
      "O/SUITE-outline-28",
      "O/SUITE-outline-29",
      "O/SUITE-outline-30",
      "O/SUITE-outline-31",
      "O/SUITE-outline-32",
      "O/SUITE-outline-33",
      "O/SUITE-outline-34",
      "O/SUITE-outline-35",
      "O/SUITE-outline-36",
      "O/SUITE-outline-37",
      "O/SUITE-outline-38",
      "O/SUITE-outline-39",
      "O/SUITE-outline-40",
      "O/SUITE-outline-41",
      "O/SUITE-outline-42",
      "O/SUITE-outline-43",
      "O/SUITE-outline-44",
      "O/SUITE-outline-45",
      "O/SUITE-outline-46",
      "O/SUITE-outline-47",
      "O/SUITE-outline-48",
      "O/SUITE-outline-49",
      "O/SUITE-outline-50",
      "O/SUITE-outline-51",
      "O/SUITE-outline-52",
      "O/SUITE-outline-53",
      "O/SUITE-outline-54",
      "O/SUITE-outline-55",
      "O/SUITE-outline-56",
      "O/SUITE-outline-57",
      "O/SUITE-outline-58",
      "O/SUITE-outline-59",
      "O/P09-outline-logical-set::base-facts",
      "O/V2-P01-parser-recovery-not-completeness::base",
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-0",
      "O/ORD-OUTLINE-COMMENT-CONTROLS::base/observation-1",
      "O/ambient-and-dotted-module"
    ]
  },
  "160": {
    "complete identifier projection": [
      "O/OL-B04::base",
      "O/OL-C16::base"
    ],
    "deferred body run retained despite false execution": [
      "O/OL-C16::base",
      "O/OL-B04::base"
    ]
  },
  "161": {
    "shorthand inserted and duplicate references deduplicated": [
      "O/OL-B04::base",
      "O/OL-C16::base"
    ],
    "own declared names omitted": [
      "O/OL-B02::base",
      "O/OL-B04::base"
    ],
    "two run uses give one reference": [
      "O/OL-C16::base",
      "O/OL-B04::base"
    ]
  },
  "162": {
    "same bytes TSX valid versus TS syntax errors": [
      "O/ORD-OUTLINE-SCRIPT-KIND::variant-01",
      "O/ORD-OUTLINE-SCRIPT-KIND::variant-02"
    ]
  },
  "163": {
    "clause type-only nonexecution": [
      "O/OL-M01::base",
      "O/OL-M02::base"
    ],
    "inline type-only still executes": [
      "O/OL-M02::base",
      "O/OL-M01::base"
    ],
    "class static call executes": [
      "O/OL-C02::base",
      "O/OL-C03::base"
    ],
    "enum/namespace evaluation": [
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-01",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-02",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-03",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-04",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-05"
    ],
    "variable initializer evaluation": [
      "O/ORD-OUTLINE-EVALUATION::variant-01",
      "O/ORD-OUTLINE-EVALUATION::variant-02",
      "O/ORD-OUTLINE-EVALUATION::variant-03",
      "O/ORD-OUTLINE-EVALUATION::variant-04",
      "O/ORD-OUTLINE-EVALUATION::variant-05",
      "O/ORD-OUTLINE-EVALUATION::variant-06",
      "O/ORD-OUTLINE-EVALUATION::variant-07",
      "O/ORD-OUTLINE-EVALUATION::variant-08",
      "O/ORD-OUTLINE-EVALUATION::variant-09",
      "O/ORD-OUTLINE-EVALUATION::variant-10",
      "O/ORD-OUTLINE-EVALUATION::variant-11",
      "O/ORD-OUTLINE-EVALUATION::variant-12",
      "O/ORD-OUTLINE-EVALUATION::variant-13",
      "O/ORD-OUTLINE-EVALUATION::variant-14",
      "O/ORD-OUTLINE-EVALUATION::variant-15",
      "O/ORD-OUTLINE-EVALUATION::variant-16",
      "O/ORD-OUTLINE-EVALUATION::variant-17",
      "O/ORD-OUTLINE-EVALUATION::variant-18",
      "O/ORD-OUTLINE-EVALUATION::variant-19",
      "O/ORD-OUTLINE-EVALUATION::variant-20",
      "O/ORD-OUTLINE-EVALUATION::variant-21",
      "O/ORD-OUTLINE-EVALUATION::variant-22",
      "O/ORD-OUTLINE-EVALUATION::variant-23",
      "O/ORD-OUTLINE-EVALUATION::variant-24",
      "O/ORD-OUTLINE-EVALUATION::variant-25",
      "O/ORD-OUTLINE-EVALUATION::variant-26",
      "O/OL-B01::base"
    ]
  },
  "164": {
    "enum call initializer true versus literal false": [
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-01",
      "O/ORD-OUTLINE-ENUM-NAMESPACE::variant-02"
    ]
  },
  "165": {
    "variable call-containing initializer true versus literal/arithmetic false": [
      "O/ORD-OUTLINE-EVALUATION::variant-01",
      "O/ORD-OUTLINE-EVALUATION::variant-02",
      "O/ORD-OUTLINE-EVALUATION::variant-03",
      "O/ORD-OUTLINE-EVALUATION::variant-04",
      "O/ORD-OUTLINE-EVALUATION::variant-05",
      "O/ORD-OUTLINE-EVALUATION::variant-06",
      "O/ORD-OUTLINE-EVALUATION::variant-07",
      "O/ORD-OUTLINE-EVALUATION::variant-08",
      "O/ORD-OUTLINE-EVALUATION::variant-09",
      "O/ORD-OUTLINE-EVALUATION::variant-10",
      "O/ORD-OUTLINE-EVALUATION::variant-11",
      "O/ORD-OUTLINE-EVALUATION::variant-12",
      "O/ORD-OUTLINE-EVALUATION::variant-13",
      "O/ORD-OUTLINE-EVALUATION::variant-14",
      "O/ORD-OUTLINE-EVALUATION::variant-15",
      "O/ORD-OUTLINE-EVALUATION::variant-16",
      "O/ORD-OUTLINE-EVALUATION::variant-17",
      "O/ORD-OUTLINE-EVALUATION::variant-18",
      "O/ORD-OUTLINE-EVALUATION::variant-19",
      "O/ORD-OUTLINE-EVALUATION::variant-20",
      "O/ORD-OUTLINE-EVALUATION::variant-21",
      "O/ORD-OUTLINE-EVALUATION::variant-22",
      "O/ORD-OUTLINE-EVALUATION::variant-23",
      "O/ORD-OUTLINE-EVALUATION::variant-24",
      "O/ORD-OUTLINE-EVALUATION::variant-25",
      "O/ORD-OUTLINE-EVALUATION::variant-26"
    ],
    "identifier initializer false": [
      "O/OL-B01::base",
      "O/ORD-OUTLINE-EVALUATION::variant-24"
    ]
  }
};
