use booking_domain::confirm;
use booking_domain::reservation::Confirmation;

#[test]
fn full_venue_refuses_confirmation() {
    let result = confirm(3, 3);
    assert!(matches!(result, Confirmation::Full));
}
