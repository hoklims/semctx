mod left {
    pub fn shared() -> u32 {
        1
    }
}

mod right {
    pub fn shared() -> u32 {
        2
    }
}

use left::*;
use right::*;

pub fn ambiguous() -> u32 {
    shared()
}

pub fn missing() -> u32 {
    nonexistent_346()
}
