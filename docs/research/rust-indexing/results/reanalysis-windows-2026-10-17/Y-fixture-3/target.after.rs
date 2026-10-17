use indexing_domain::{
    Amount, Outcome, Quote,
    calculations::{FixedQuote, quote_dyn},
    make_amount, quote_alias as dispatch_quote,
};

fn main() {
    let provider = FixedQuote::new();
    let direct = provider.quote(Amount(7));
    let generic = dispatch_quote(&provider, make_amount!(7));
    let dynamic = quote_dyn(&provider, Amount(7));
    assert_eq!(direct, Outcome::Accepted(Amount(7)));
    assert_eq!(generic, dynamic);
}

pub fn semctx_reindex_probe() -> usize { 17 }
