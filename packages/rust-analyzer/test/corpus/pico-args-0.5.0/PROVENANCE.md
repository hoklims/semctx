# pico-args 0.5.0 corpus

This is the complete small, dependency-free source snapshot used for the Rust analyzer's real-code regression. It is copied from the pinned [pico-args 0.5.0 commit](https://github.com/RazrFalcon/pico-args/tree/56e8872fa31f168fd87e84fdc5f24bd60875daea). The MIT license is preserved verbatim. Discovery used the same pinned bytes in `docs/research/rust-indexing/corpus/pico-args-0.5.0/`.

| File | SHA-256 |
| --- | --- |
| `Cargo.toml.snapshot` | `1a8913f660858e58d226ae45c7ca24913137e2777219eca5f59cbac591af87bc` |
| `Cargo.lock` | `75cd0f239642eff79c97ba50539842ff886dc5c19ff0998a42f55e83b4d6ee4f` |
| `LICENSE` | `be8e392dd41994a6df38da0dd0e61a131d30179ce3e4c287f49311e6b8f6b2b8` |
| `README.md` | `003d937d623b9556736f046059e44530aabf954d725e6fb35e48da3b19af91cc` |
| `src/lib.rs` | `a3bec80854f4b259944720f3d984de4da19b230e24010e1fac374f6f32cc6865` |

Only `src/lib.rs` is parsed in the corpus test. The unchanged manifest bytes are retained as a `.snapshot` to keep this upstream fixture outside the native product crate gate. The manifest and lockfile document its Rust 2018 Cargo world. The test asserts a few independently identifiable public declarations and parser limits; it does not claim full semantic resolution or execution of upstream tests.
