# Case-insensitive coordinate source successor

Commit `fc0283e2ec6f521fa0cdd7192495e02f6e6de172` fixes ordinary
target, import and owner coordinates when a case-insensitive host supplies
different repository-prefix casing. Qualified callback ownership now uses the
existing normalized, strictly confined repository-path helper with the same
case flag. Case-sensitive coordinates retain their exact comparison.

The correction has independent, separately frozen development witnesses.
Against the preceding production source, three assertions fail for the wrong
ordinary target, missing call edge and unsupported callback owner; the
case-sensitive control passes. All four pass after correction. The formatted
binary's 267 unit tests pass. These are development regression results, with
no T00 qualification credit or R0 decision.

These evaluator packages update exactly four of the existing 139 source pins:
`src/ordinary.rs`, `src/qualified.rs`, `tests/unit/ordinary.rs` and
`tests/unit/qualified.rs`, all under `tools/rust-ts-r0/`. The other 135 source
pins and all non-source scope fields retain their preceding values. Evaluator
Python code is byte-identical to the typed admission predecessor. The original
354 units and 240 obligations, the 395 property definitions, 51 supports,
590 check definitions and 1,386 case files remain intact. The packaged scope
also retains its existing 446 observation rows.

| Package | ZIP SHA256 |
| --- | --- |
| `current-native-reader.zip` | `4b477a8ddbe3ba531c93b3502ba1a932979c788a03643ed37ad17bf815be7061` |
| `current-windows-reader.zip` | `6961edebfe8b271061e601f49b458cef2ed77d615c3c5e912fd62d929d621ba8` |

Both packages use scope-map SHA256
`7e7f98ccd15668d7b38fccbe59e5df1a7e5c4e368aed7be20507ed6c5b3f34a7`.
The Windows transport protocol SHA256 is
`2535c75211e6b784daa06c79d37244af2adc0ac566824e1095b201b5bb75798c`.
Supply both explicit pins to the Windows evaluator. Its source content head is
the correction commit; the actual acquisition must use the later final
packaging commit as its exact expected head and verify all 139 source bytes
there. The acquisition driver is unchanged.

`source-freeze-receipt.json` has SHA256
`dc10c9c0bde7f489cae099dd5b1a0da300dc057e26f003aa765977d4b878e50f`.
`offline-validation.json` has SHA256
`d21fc46273f2d8acf4ce53cad1cc50fdd4c5a3127ff7ec156470bb4d7737fc4b`.
Completed offline checks authenticate the two ZIPs, package manifests,
unchanged evaluator code, Windows transport package and the explicit source
and corpus preflights against `fc0283`. They perform no candidate execution.

The packages and captures in `typed-admission-20261023/` and earlier evidence
directories keep their historical identities. The separately frozen legacy
reader remains available there for source-96 capture manifests. Old Mac/Linux
observations require a finite source-role and applicability justification
before reuse with the corrected candidate. No existing outcome is promoted
automatically. README files inside the ZIPs retain historical preparation
instructions; use the explicit identities in this record and the successor
manifests for this source successor.

Final Windows observation, independent aggregate proof admission, terminal
qualification and the R0 decision remain pending.
