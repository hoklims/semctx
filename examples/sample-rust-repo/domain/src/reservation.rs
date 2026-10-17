use crate::capacity::remaining_capacity;

pub enum Confirmation {
    Accepted,
    Full,
}

#[doc = "@capability reservation-confirmation: confirm a reservation"]
#[doc = "@invariant confirmed-never-exceeds-capacity: confirmed seats never exceed total capacity"]
#[doc = "@contract confirmation-result: a full venue refuses confirmation"]
pub fn confirm(total: u32, confirmed: u32) -> Confirmation {
    if remaining_capacity(total, confirmed) > 0 {
        Confirmation::Accepted
    } else {
        Confirmation::Full
    }
}
