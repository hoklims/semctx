#[test]
fn combines_macro_generated_function_value_and_active_world() {
    #[cfg(all(unix, not(feature = "alternate")))]
    let expected = 40;
    #[cfg(all(unix, feature = "alternate"))]
    let expected = 41;
    #[cfg(all(windows, not(feature = "alternate")))]
    let expected = 41;
    #[cfg(all(windows, feature = "alternate"))]
    let expected = 42;
    assert_eq!(semctx_rust_edge_cases::evaluate(), expected);
}
