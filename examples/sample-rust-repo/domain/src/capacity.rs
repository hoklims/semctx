pub struct Capacity {
    pub total: u32,
    pub confirmed: u32,
}

impl Capacity {
    pub fn remaining(&self) -> u32 {
        self.total.saturating_sub(self.confirmed)
    }
}

#[doc = "@capability capacity-accounting: compute remaining capacity"]
pub fn remaining_capacity(total: u32, confirmed: u32) -> u32 {
    Capacity { total, confirmed }.remaining()
}

#[cfg(test)]
mod tests {
    use super::remaining_capacity;

    #[test]
    fn exhausted_capacity() {
        let remaining = remaining_capacity(3, 3);
        assert_eq!(remaining, 0);
    }
}
