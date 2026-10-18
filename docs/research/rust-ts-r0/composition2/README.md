# C2 native checker experiment

C2 uses Ezno 0.0.18 and its own native parser/checker. It is distinct from C1
and has no C1, JavaScript or Go semantic fallback. The [registration](registration.json)
precedes build and execution. The TypeScript 5.9.3 oracle is verifier-only.

The [initial immutable producer](initial/README.md) panicked after six SDK reads.
A source-backed cross-file range-map collision motivated the registered first
correction. [Its native source and DEV evidence](pass1-producer/README.md)
preserve the explicit two-statement local patch, original registry archive,
exact dependency pins and Cargo.lock. The shared declaration root is retained.
The SDK bytes,63file selection, initial order and expected targets are unchanged.

[The independent pass1 replay](pass1-replay/report.json) made one supervised
invocation: process success/exit0,63SDK reads,274unchanged bound identities.
The compiler reported734errors and7warnings, including12parser/lexer rejections.
It loaded no project module and produced no expression mapping. The alias and
String.trim witnesses remain unexercised. This is no semantic or R0 pass.

[The second and final correction](pass2-producer/README.md) records native parser,
tuple/binding and bounded captured-resolution changes,188frozen source files,
exact pins/lock and33passing macOS DEV tests. [The single final replay](pass2-replay/report.json)
reads all63unchanged SDK files in the independently verified TypeScript5.9.3
priority order. All458bound identities remain unchanged. The process exits0 in
357ms but initialization produces541errors and17warnings and returns before any
project read,module,mapping or target witness. No parser/lexer rejection or panic
was classified; this does not qualify all TS grammar.

[The final correction closure](pass2-replay/correction-closure.json) is NONPASS.
No correction remains. Both original carriers and independent targets are
unchanged; native SDK errors are not suppressed. The baseline skipLibCheck and
nullability-policy differences remain explicit, so these diagnostics alone are
not a universal semantic impossibility proof. No reserved input was accessed.

[The consolidated R0 decision](../final/README.md) is STOP_BUDGET because both
compositions and their two correction passes are exhausted without R0. No
READY_TS_NATIVE,T01 or substantial port follows. C2 has only macOS ARM64 DEV
evidence; the independently checked Windows/Linux C1 vectors do not qualify C2.
