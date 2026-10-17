mod model;

#[path = "operations.rs"]
pub mod calculations;

pub use calculations::quote as quote_alias;
pub use model::{Amount, Outcome, Quote};

#[macro_export]
macro_rules! make_amount {
    ($value:expr) => {
        $crate::Amount($value)
    };
}

#[cfg(feature = "extra")]
pub fn extra_quote() -> Amount {
    Amount(42)
}

#[cfg(test)]
mod tests {
    use super::{calculations::FixedQuote, Amount, Outcome, Quote};

    #[test]
    fn concrete_quote_accepts_positive_amounts() {
        assert_eq!(
            FixedQuote::new().quote(Amount(7)),
            Outcome::Accepted(Amount(7))
        );
    }
}
