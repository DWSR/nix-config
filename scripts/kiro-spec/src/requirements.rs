use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RequirementsIndex {
    requirements: BTreeMap<u32, BTreeSet<u32>>,
}

impl RequirementsIndex {
    pub fn parse(text: &str) -> Self {
        let mut requirements: BTreeMap<u32, BTreeSet<u32>> = BTreeMap::new();
        let mut current: Option<u32> = None;

        for line in text.lines() {
            if let Some(level) = heading_level(line) {
                if level <= 3 {
                    current = if level == 3 {
                        requirement_number(line)
                    } else {
                        None
                    };
                    if let Some(number) = current {
                        requirements.entry(number).or_default();
                    }
                }
                continue;
            }

            if let Some(requirement) = current {
                if let Some(criterion) = criterion_number(line) {
                    requirements
                        .entry(requirement)
                        .or_default()
                        .insert(criterion);
                }
            }
        }

        Self { requirements }
    }

    pub fn has_requirement(&self, number: u32) -> bool {
        self.requirements.contains_key(&number)
    }

    pub fn has_criterion(&self, requirement: u32, criterion: u32) -> bool {
        self.requirements
            .get(&requirement)
            .is_some_and(|criteria| criteria.contains(&criterion))
    }

    pub fn criteria(&self, requirement: u32) -> Option<&BTreeSet<u32>> {
        self.requirements.get(&requirement)
    }

    pub fn requirements(&self) -> impl Iterator<Item = u32> + '_ {
        self.requirements.keys().copied()
    }

    pub fn resolve(&self, token: &ReferenceToken) -> ReferenceOutcome {
        match token.value() {
            Some(ReferenceValue::Requirement(requirement)) => {
                if self.has_requirement(requirement) {
                    ReferenceOutcome::Resolved
                } else {
                    ReferenceOutcome::Unresolved
                }
            }
            Some(ReferenceValue::Criterion {
                requirement,
                criterion,
            }) => {
                if self.has_criterion(requirement, criterion) {
                    ReferenceOutcome::Resolved
                } else {
                    ReferenceOutcome::Unresolved
                }
            }
            None => ReferenceOutcome::Malformed,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceValue {
    Requirement(u32),
    Criterion { requirement: u32, criterion: u32 },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReferenceToken {
    raw: String,
    value: Option<ReferenceValue>,
}

impl ReferenceToken {
    pub fn new(raw: impl Into<String>) -> Self {
        let raw = raw.into();
        let value = parse_reference(trim_markup(&raw));
        Self { raw, value }
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }

    pub fn value(&self) -> Option<ReferenceValue> {
        self.value
    }

    pub fn is_malformed(&self) -> bool {
        self.value.is_none()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceOutcome {
    Resolved,
    Unresolved,
    Malformed,
}

pub fn tokenize_references(payload: &str) -> Vec<ReferenceToken> {
    payload
        .split(|character: char| character == ',' || character.is_whitespace())
        .filter(|token| !token.is_empty())
        .map(ReferenceToken::new)
        .collect()
}

fn heading_level(line: &str) -> Option<u8> {
    let trimmed = line.trim_start();
    let hashes = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &trimmed[hashes..];
    if !rest.is_empty() && !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    Some(hashes as u8)
}

fn requirement_number(line: &str) -> Option<u32> {
    let trimmed = line.trim_start();
    let rest = trimmed
        .strip_prefix("### ")
        .or_else(|| trimmed.strip_prefix("###\t"))?;
    let rest = rest.trim_start().strip_prefix("Requirement ")?;
    let digits: String = rest
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let after = &rest[digits.len()..];
    if !(after.is_empty() || after.starts_with(':') || after.starts_with(char::is_whitespace)) {
        return None;
    }
    digits.parse().ok()
}

fn criterion_number(line: &str) -> Option<u32> {
    let trimmed = line.trim_start();
    let digits: String = trimmed
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let after = trimmed[digits.len()..].strip_prefix('.')?;
    if !after.chars().next().is_some_and(char::is_whitespace) {
        return None;
    }
    digits.parse().ok()
}

fn trim_markup(token: &str) -> &str {
    token.trim_matches(|character: char| matches!(character, '_' | '`' | '*'))
}

fn parse_reference(token: &str) -> Option<ReferenceValue> {
    let (requirement, criterion) = match token.split_once('.') {
        Some((requirement, criterion)) => (requirement, Some(criterion)),
        None => (token, None),
    };
    if !is_all_digits(requirement) {
        return None;
    }
    let requirement = requirement.parse().ok()?;
    match criterion {
        None => Some(ReferenceValue::Requirement(requirement)),
        Some(criterion) => {
            if !is_all_digits(criterion) {
                return None;
            }
            Some(ReferenceValue::Criterion {
                requirement,
                criterion: criterion.parse().ok()?,
            })
        }
    }
}

fn is_all_digits(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOCUMENT: &str = "\
# Requirements Document

## Introduction

1. This numbered item is outside any requirement.

### Requirement 1: One binary

**Objective:** Something.

#### Acceptance Criteria

1. When the binary is built, it shall exist.
2. When it runs, it shall not need the network.

### Requirement 2: Explicit resolution

#### Acceptance Criteria

1. When a spec is supplied, it shall be resolved.

## Boundary Context

1. This numbered item is outside any requirement again.
";

    #[test]
    fn indexes_requirements_and_their_numbered_criteria() {
        let index = RequirementsIndex::parse(DOCUMENT);

        assert!(index.has_requirement(1));
        assert!(index.has_requirement(2));
        assert!(index.has_criterion(1, 1));
        assert!(index.has_criterion(1, 2));
        assert!(index.has_criterion(2, 1));
        assert!(!index.has_criterion(1, 3));
        assert!(!index.has_criterion(2, 2));
    }

    #[test]
    fn requirement_without_criteria_has_an_empty_criterion_set() {
        let text = "\
### Requirement 9: Still being written

## Next section

1. Ignored.
";
        let index = RequirementsIndex::parse(text);

        assert!(index.has_requirement(9));
        assert_eq!(index.criteria(9).map(|set| set.len()), Some(0));
        assert!(!index.has_criterion(9, 1));
    }

    #[test]
    fn content_outside_requirement_sections_is_ignored() {
        let index = RequirementsIndex::parse(DOCUMENT);
        let first: Vec<u32> = index.criteria(1).unwrap().iter().copied().collect();
        let second: Vec<u32> = index.criteria(2).unwrap().iter().copied().collect();

        assert_eq!(first, vec![1, 2]);
        assert_eq!(second, vec![1]);
        assert_eq!(index.requirements().count(), 2);
    }

    #[test]
    fn a_non_requirement_heading_of_level_three_ends_the_section() {
        let text = "\
### Requirement 1: One

#### Acceptance Criteria

1. Kept.

### Notes

2. Ignored.
";
        let index = RequirementsIndex::parse(text);

        assert!(index.has_criterion(1, 1));
        assert!(!index.has_criterion(1, 2));
    }

    #[test]
    fn non_requirement_headings_are_not_indexed() {
        let text = "\
## Requirements

1. Ignored.

#### Requirement 3: Too deep

1. Ignored.

### Requirement X: Not numeric

1. Ignored.

### Requirement:

1. Ignored.
";
        let index = RequirementsIndex::parse(text);

        assert!(!index.has_requirement(3));
        assert_eq!(index.requirements().count(), 0);
    }

    #[test]
    fn criterion_lookup_fails_when_the_requirement_is_missing() {
        let index = RequirementsIndex::parse(DOCUMENT);

        assert!(!index.has_criterion(3, 1));
        assert_eq!(index.criteria(3), None);
    }

    #[test]
    fn resolves_requirement_and_criterion_tokens() {
        let index = RequirementsIndex::parse(DOCUMENT);

        assert_eq!(
            index.resolve(&ReferenceToken::new("1")),
            ReferenceOutcome::Resolved
        );
        assert_eq!(
            index.resolve(&ReferenceToken::new("1.1")),
            ReferenceOutcome::Resolved
        );
        assert_eq!(
            index.resolve(&ReferenceToken::new("2.1")),
            ReferenceOutcome::Resolved
        );
    }

    #[test]
    fn reports_unresolved_well_formed_references() {
        let index = RequirementsIndex::parse(DOCUMENT);

        assert_eq!(
            index.resolve(&ReferenceToken::new("3")),
            ReferenceOutcome::Unresolved
        );
        assert_eq!(
            index.resolve(&ReferenceToken::new("1.3")),
            ReferenceOutcome::Unresolved
        );
        assert_eq!(
            index.resolve(&ReferenceToken::new("2.2")),
            ReferenceOutcome::Unresolved
        );
    }

    #[test]
    fn malformed_tokens_are_classified_as_malformed() {
        let index = RequirementsIndex::parse(DOCUMENT);

        for raw in ["1.2.3", "1-2", "1..2", "Req 1", "1.x", "1.", ".2", "v2"] {
            let token = ReferenceToken::new(raw);
            assert!(token.is_malformed(), "{raw} should be malformed");
            assert_eq!(index.resolve(&token), ReferenceOutcome::Malformed);
        }
    }

    #[test]
    fn tokenizes_references_on_commas_and_whitespace() {
        let tokens = tokenize_references("1.4, 11.6_\n1.2 `6.19`");

        let raw: Vec<&str> = tokens.iter().map(ReferenceToken::raw).collect();
        assert_eq!(raw, vec!["1.4", "11.6_", "1.2", "`6.19`"]);
        assert_eq!(
            tokens[1].value(),
            Some(ReferenceValue::Criterion {
                requirement: 11,
                criterion: 6
            })
        );
        assert_eq!(
            tokens[3].value(),
            Some(ReferenceValue::Criterion {
                requirement: 6,
                criterion: 19
            })
        );
    }

    #[test]
    fn empty_payload_yields_no_tokens() {
        assert!(tokenize_references("").is_empty());
        assert!(tokenize_references("  \n\t ").is_empty());
        assert!(tokenize_references(" , , ").is_empty());
    }

    #[test]
    fn criterion_sets_are_sorted_deterministically() {
        let text = "\
### Requirement 1: One

#### Acceptance Criteria

3. Third.
1. First.
2. Second.
";
        let index = RequirementsIndex::parse(text);
        let criteria: Vec<u32> = index.criteria(1).unwrap().iter().copied().collect();

        assert_eq!(criteria, vec![1, 2, 3]);
    }
}
