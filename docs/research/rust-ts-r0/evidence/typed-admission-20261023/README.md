# Typed process-receipt admission successor

The review found that two evidence readers accepted boolean or floating-point
zero as an integer process exit, and accepted similarly mistyped byte counts.
Commit `92fc7a186b465c9c401880920be097b264366c23` adds strict integer checks to
`property_assessor.assess_final.parsed_outcome` and
`supplement.public_runtime.compare_native`. The valid integer-zero path remains
accepted. Eight poisoned carriers fail the regression assertions against the
previous sources and are refused by the corrected readers.

This directory preserves separately frozen evaluator successors. It does not
replace the previous packages, native captures, assertions or results. It adds
no native observation, qualification credit or R0 decision.

| Package | Source scope | ZIP SHA256 |
| --- | --- | --- |
| `legacy-source-corrected-reader.zip` | Historical 139-source map `309fbbd74141eaa0d383f340247802cd283c892a6048902adaf29e9e6c18c4c3`, for existing source-96 captures | `efcc74d7da31a5df6e1fbcc3e6a7124ea130540c851ace809bc794964d230b2c` |
| `current-native-reader.zip` | Corrected source map `de5cd5a5221210db688b39a0d5b300cbf498c018d7c3186e7112149a14b22c8f` | `7b8f1fbe8dfe3c23381447bbedc8a90f57eeda2a56350d1a7b003ea84dbc0e09` |
| `current-windows-reader.zip` | Same corrected source map, with the existing Windows transport adaptations | `d19e63e0cae45b03000087f2c09cbf438af6f12f4f700d0540c528dc531df78a` |

The current Windows transport protocol is
`2f13aff31c0faf0249c70dde69d2b22779a45c1e32c0c8f5d9b211a7aea46fc0`.
Both its scope-map SHA256 and its Windows protocol SHA256 must be supplied to the
packaged evaluator. The predecessor Windows protocol `5067e4e5…` and ZIP
`7b596e81…` remain historical artifacts and cannot evaluate the corrected
candidate's source relation by assumption.

The frozen semantic payload is identical: 395 properties, 51 supports, 590 check
definitions, 1,386 case files, and the complete recipes and expectations. The
139-source inventory has the same members. Of those source pins, 138 retain
their previous bytes; `supplement/public_runtime.py` changes from `9cd48fad…` to
`881e27fc…`. Native and Windows successor packages contain the same 139-source
map. Their content pin records the committed correction rather than asserting
that all old verifier bytes still equal the corrected candidate.

The legacy successor keeps scope `309fbbd7…` for the original source-96 capture
manifests and adds the corrected `parsed_outcome` admission checks. Its frozen
public module is used for `project_operation`; the historical
`compare_native` implementation is not repaired or represented as repaired by
that legacy package. Re-evaluations must retain their original capture source,
record the actual successor reader/package pins, and receive their own results.
No existing PASS result is automatically promoted.

README files inside the ZIPs retain their predecessor's historical preparation
instructions. This record and the successor manifests supply the current
identities; use their explicit scope and Windows protocol pins when evaluating
the corrected candidate.

`source-freeze-receipt.json` records the exact source delta and committed content
identity. Its SHA256 is
`ec7ced18f35c0bfe7237b24a2447ce126461e8d493ba69be3006d831daf3f1a8`.
`offline-validation.json` records the completed package-hash checks, Windows
package verification and two explicit source/corpus preflights against `92fc7a18`.
Its SHA256 is
`23c0c614e5930e61939327e7619e709de897e78924bc9c7038ee51259969cf27`.
Those preflights read 139 Git sources and 1,386 public case files; they execute
no candidate. They do not establish final Windows results or terminal
qualification. The repository reader's default scope remains the historical
map; use the appropriate separately frozen package and explicit scope pin.
