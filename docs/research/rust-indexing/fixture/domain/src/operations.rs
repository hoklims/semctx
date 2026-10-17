use crate::{Amount, Outcome, Quote};

pub struct FixedQuote;

impl FixedQuote {
    pub fn new() -> Self {
        Self
    }
}

impl Quote for FixedQuote {
    fn quote(&self, amount: Amount) -> Outcome {
        if amount.0 == 0 {
            return Outcome::Rejected;
        }
        Outcome::Accepted(amount)
    }
}

pub fn quote<Q: Quote>(provider: &Q, amount: Amount) -> Outcome {
    provider.quote(amount)
}

pub fn quote_dyn(provider: &dyn Quote, amount: Amount) -> Outcome {
    provider.quote(amount)
}
