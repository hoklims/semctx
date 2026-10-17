#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[doc = "@invariant discovery-fixture-only: accepted amounts are positive"]
pub struct Amount(pub u32);

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Accepted(Amount),
    Rejected,
}

pub trait Quote {
    fn quote(&self, amount: Amount) -> Outcome;
}
