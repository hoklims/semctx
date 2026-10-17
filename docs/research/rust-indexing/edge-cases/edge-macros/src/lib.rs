use proc_macro::TokenStream;

#[proc_macro]
pub fn define_procedural(_: TokenStream) -> TokenStream {
    "pub fn procedural() -> u32 { 11 }".parse().unwrap()
}
