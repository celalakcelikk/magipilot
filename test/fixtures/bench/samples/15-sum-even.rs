/// Statistics helpers for the metrics module.

pub fn sum_of_even(values: &[i64]) -> i64 {
    <FILL>values.iter().filter(|v| *v % 2 == 0).sum()</FILL>
}

pub fn mean(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    Some(values.iter().sum::<f64>() / values.len() as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sums_even_values() {
        assert_eq!(sum_of_even(&[1, 2, 3, 4]), 6);
    }

    #[test]
    fn mean_of_empty_is_none() {
        assert_eq!(mean(&[]), None);
    }
}
