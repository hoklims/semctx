use indexing_domain::{
    calculations::{quote_dyn, FixedQuote},
    make_amount, quote_alias, Amount, Outcome,
};

#[test]
fn generic_and_dynamic_dispatch_preserve_amounts_and_reject_zero() {
    let provider = FixedQuote::new();
    assert_eq!(
        quote_alias(&provider, make_amount!(9)),
        Outcome::Accepted(Amount(9))
    );
    assert_eq!(
        quote_dyn(&provider, Amount(9)),
        Outcome::Accepted(Amount(9))
    );
    assert_eq!(quote_alias(&provider, Amount(0)), Outcome::Rejected);
    assert_eq!(quote_dyn(&provider, Amount(0)), Outcome::Rejected);
}
