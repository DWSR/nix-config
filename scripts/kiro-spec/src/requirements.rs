//! `requirements.md` index and `_Requirements:_` reference resolution.
//!
//! Validation resolves the identifiers in a task's `_Requirements:_` bullet
//! against the requirements document. The index records only what
//! `requirements.md` declares: a `### Requirement N:` section and the
//! acceptance criteria numbered beneath it. Everything outside those sections
//! is ignored, so numbered lists in an introduction or an appendix never make
//! a reference resolve.
//!
//! The module is pure: it takes text and returns data, with no filesystem
//! access and no validation findings. `validate` owns the finding codes and
//! the line numbers.

use std::collections::{BTreeMap, BTreeSet};

/// One token from a `_Requirements:_` payload.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Reference {
    text: String,
    kind: ReferenceKind,
}

/// How one tokenised reference was classified.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceKind {
    /// `N`: a whole requirement.
    Requirement(u32),
    /// `N.M`: acceptance criterion `M` of requirement `N`.
    Criterion(u32, u32),
    /// The token is not `N` or `N.M`.
    Malformed,
}

impl Reference {
    /// The token as written, trimmed and with internal whitespace runs
    /// collapsed so a multi-line payload yields a single diagnostic line.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// How the token was classified.
    pub fn kind(&self) -> ReferenceKind {
        self.kind
    }

    /// Whether the token is neither `N` nor `N.M`.
    pub fn is_malformed(&self) -> bool {
        matches!(self.kind, ReferenceKind::Malformed)
    }

    /// Classify one trimmed token, keeping its text for the diagnostic.
    fn classify(text: String) -> Self {
        let kind = match text.split_once('.') {
            Some((requirement, criterion)) => match (number(requirement), number(criterion)) {
                (Some(requirement), Some(criterion)) => {
                    ReferenceKind::Criterion(requirement, criterion)
                }
                _ => ReferenceKind::Malformed,
            },
            None => match number(&text) {
                Some(requirement) => ReferenceKind::Requirement(requirement),
                None => ReferenceKind::Malformed,
            },
        };
        Self { text, kind }
    }
}

/// Why a reference is not satisfied by the index.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReferenceProblem {
    /// The token is not `N` or `N.M`.
    Malformed,
    /// The token is well formed but names a missing requirement or criterion.
    Unresolved,
}

/// Every requirement number and acceptance-criterion number declared by
/// `requirements.md`.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RequirementsIndex {
    requirements: BTreeMap<u32, BTreeSet<u32>>,
}

impl RequirementsIndex {
    /// Index `### Requirement N:` sections and the criteria numbered beneath
    /// them.
    ///
    /// A section opens at a level-three Requirement heading and closes at the
    /// next heading of level three or above, so deeper headings such as
    /// `#### Acceptance Criteria` stay inside it. Numbered list items at
    /// column zero are acceptance criteria; indented nested items and every
    /// numbered line outside a requirement section are ignored.
    pub fn build(text: &str) -> Self {
        let mut index = Self::default();
        let mut current = None;
        for line in text.lines() {
            if let Some(requirement) = requirement_heading(line) {
                index.requirements.entry(requirement).or_default();
                current = Some(requirement);
                continue;
            }
            if let Some(level) = heading_level(line) {
                if level <= 3 {
                    current = None;
                }
                continue;
            }
            if let Some(requirement) = current {
                if let Some(criterion) = criterion_item(line) {
                    index
                        .requirements
                        .entry(requirement)
                        .or_default()
                        .insert(criterion);
                }
            }
        }
        index
    }

    /// Whether a `### Requirement N:` section exists.
    pub fn contains_requirement(&self, number: u32) -> bool {
        self.requirements.contains_key(&number)
    }

    /// Whether acceptance criterion `criterion` is listed under requirement
    /// `requirement`.
    pub fn contains_criterion(&self, requirement: u32, criterion: u32) -> bool {
        self.requirements
            .get(&requirement)
            .is_some_and(|criteria| criteria.contains(&criterion))
    }

    /// Resolve one tokenised reference against the index.
    ///
    /// A whole-requirement reference resolves when its heading exists even if
    /// the section has no criteria yet; a criterion reference additionally
    /// needs that criterion number beneath the heading.
    pub fn resolve(&self, reference: &Reference) -> Result<(), ReferenceProblem> {
        match reference.kind {
            ReferenceKind::Malformed => Err(ReferenceProblem::Malformed),
            ReferenceKind::Requirement(requirement) => {
                if self.contains_requirement(requirement) {
                    Ok(())
                } else {
                    Err(ReferenceProblem::Unresolved)
                }
            }
            ReferenceKind::Criterion(requirement, criterion) => {
                if self.contains_criterion(requirement, criterion) {
                    Ok(())
                } else {
                    Err(ReferenceProblem::Unresolved)
                }
            }
        }
    }
}

/// Split one `_Requirements:_` payload into references.
///
/// References are comma separated; the closing `_` of the italic bullet is
/// not part of the last token, and empty segments (a trailing comma or a bare
/// `_` payload) are skipped. A segment that is not exactly `N` or `N.M` is
/// kept as a malformed reference so the caller can name it, which is how
/// prose and ranges such as `18.1-18.9` are reported.
pub fn tokenize(payload: &str) -> Vec<Reference> {
    let trimmed = payload.trim();
    let without_close = trimmed.strip_suffix('_').unwrap_or(trimmed).trim_end();
    without_close
        .split(',')
        .filter_map(|segment| {
            let text = segment.split_whitespace().collect::<Vec<_>>().join(" ");
            if text.is_empty() {
                None
            } else {
                Some(Reference::classify(text))
            }
        })
        .collect()
}

/// The ATX heading level of a line, if the line is a heading at all.
///
/// A heading is one to six `#` characters followed by whitespace, matching the
/// grammar the task parser uses.
fn heading_level(line: &str) -> Option<usize> {
    let trimmed = line.trim_start();
    let hashes = trimmed
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    match trimmed[hashes..].chars().next() {
        Some(character) if character.is_whitespace() => Some(hashes),
        _ => None,
    }
}

/// The requirement number of a `### Requirement N:` heading.
fn requirement_heading(line: &str) -> Option<u32> {
    if heading_level(line) != Some(3) {
        return None;
    }
    let body = line.trim_start().trim_start_matches('#').trim_start();
    let rest = body.strip_prefix("Requirement ")?;
    let (number_text, _) = rest.split_once(':')?;
    number(number_text)
}

/// The criterion number of a column-zero numbered list item with text.
fn criterion_item(line: &str) -> Option<u32> {
    if line.starts_with(char::is_whitespace) {
        return None;
    }
    let (number_text, rest) = line.split_once('.')?;
    if !rest.starts_with(char::is_whitespace) || rest.trim().is_empty() {
        return None;
    }
    number(number_text)
}

/// Parse a non-empty run of ASCII digits as a reference number.
fn number(text: &str) -> Option<u32> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUIREMENTS: &str = "\
# Requirements Document

## Introduction

1. This list is outside every requirement section.

### Requirement 1: One binary

**Objective:** ...

#### Acceptance Criteria

1. When each host is built, the configuration provides the executable.
2. The CLI shall operate offline.

#### Notes

- Not a criterion.

### Requirement 2: Validation

#### Acceptance Criteria

1. Findings are sorted.

## Appendix

1. This item is outside every requirement section.
";

    fn kinds(payload: &str) -> Vec<ReferenceKind> {
        tokenize(payload)
            .into_iter()
            .map(|token| token.kind())
            .collect()
    }

    fn single(payload: &str) -> Reference {
        let mut tokens = tokenize(payload);
        assert_eq!(
            tokens.len(),
            1,
            "{payload:?} must tokenise to exactly one reference"
        );
        tokens.remove(0)
    }

    #[test]
    fn build_indexes_requirement_headings_and_their_criteria() {
        let index = RequirementsIndex::build(REQUIREMENTS);

        for number in [1, 2] {
            assert!(
                index.contains_requirement(number),
                "requirement {number} must be indexed"
            );
        }
        assert!(!index.contains_requirement(3));

        for (requirement, criterion) in [(1, 1), (1, 2), (2, 1)] {
            assert!(
                index.contains_criterion(requirement, criterion),
                "criterion {requirement}.{criterion} must be indexed"
            );
        }
        assert!(!index.contains_criterion(1, 3));
        assert!(!index.contains_criterion(2, 2));
    }

    #[test]
    fn build_ignores_content_outside_requirement_sections() {
        let index = RequirementsIndex::build(REQUIREMENTS);

        assert_eq!(
            index.resolve(&single("3")),
            Err(ReferenceProblem::Unresolved),
            "the appendix numbering must not create requirement 3"
        );
        assert_eq!(
            index.resolve(&single("3.1")),
            Err(ReferenceProblem::Unresolved),
            "the introduction numbering must not create criterion 3.1"
        );
    }

    #[test]
    fn build_ignores_headings_that_are_not_requirement_sections() {
        let text = "\
### Requirement: no number

1. ignored

#### Requirement 4: deeper heading

1. ignored

### Requirement 5.1: dotted

1. ignored

### Requirement 6: accepted

1. counted
";
        let index = RequirementsIndex::build(text);

        for number in [1, 4, 5] {
            assert!(
                !index.contains_requirement(number),
                "requirement {number} must not be indexed from a near-miss heading"
            );
        }
        assert!(index.contains_requirement(6));
        assert!(index.contains_criterion(6, 1));
    }

    #[test]
    fn build_indexes_a_requirement_that_has_no_criteria() {
        let index = RequirementsIndex::build("### Requirement 7: Empty\n\nNo criteria here.\n");

        assert!(index.contains_requirement(7));
        assert!(!index.contains_criterion(7, 1));
    }

    #[test]
    fn tokenize_accepts_requirement_and_criterion_ids() {
        assert_eq!(
            kinds("1.1, 1.2, 6.20_"),
            vec![
                ReferenceKind::Criterion(1, 1),
                ReferenceKind::Criterion(1, 2),
                ReferenceKind::Criterion(6, 20),
            ]
        );
        assert_eq!(kinds("7"), vec![ReferenceKind::Requirement(7)]);
        assert_eq!(
            kinds(" 12 , 3.4 , "),
            vec![
                ReferenceKind::Requirement(12),
                ReferenceKind::Criterion(3, 4),
            ]
        );

        let tokens = tokenize("1.2, 1.4_");
        assert_eq!(tokens[0].text(), "1.2");
        assert_eq!(tokens[0].kind(), ReferenceKind::Criterion(1, 2));
        assert!(!tokens[0].is_malformed());
        assert_eq!(tokens[1].text(), "1.4");
    }

    #[test]
    fn tokenize_separates_malformed_tokens_and_names_them() {
        assert_eq!(kinds("18.1-18.9_"), vec![ReferenceKind::Malformed]);

        for payload in ["1.", "1.2.3", "3.x", "abc"] {
            assert_eq!(
                kinds(payload),
                vec![ReferenceKind::Malformed],
                "{payload:?} is not a requirement or criterion reference"
            );
        }

        let tokens = tokenize("18.1-18.9_");
        assert_eq!(tokens[0].text(), "18.1-18.9");
        assert!(tokens[0].is_malformed());
        assert_eq!(tokens[0].kind(), ReferenceKind::Malformed);
    }

    #[test]
    fn tokenize_handles_multiline_payloads_and_prose() {
        let tokens = tokenize(
            "1.2, 1.4, 7.6 (revisit — install-time\n    invariant violated under the original layout)_",
        );
        assert_eq!(
            tokens.iter().map(Reference::kind).collect::<Vec<_>>(),
            vec![
                ReferenceKind::Criterion(1, 2),
                ReferenceKind::Criterion(1, 4),
                ReferenceKind::Malformed,
            ]
        );
        assert_eq!(
            tokens[2].text(),
            "7.6 (revisit — install-time invariant violated under the original layout)"
        );

        let prose = tokenize("implied by repo conventions; lint-pass gate for landing_");
        assert_eq!(prose.len(), 1);
        assert_eq!(prose[0].kind(), ReferenceKind::Malformed);
        assert_eq!(
            prose[0].text(),
            "implied by repo conventions; lint-pass gate for landing"
        );
    }

    #[test]
    fn tokenize_returns_nothing_for_an_empty_payload() {
        for payload in ["", "   ", "_", " , , "] {
            assert!(
                tokenize(payload).is_empty(),
                "{payload:?} carries no references"
            );
        }
    }

    #[test]
    fn resolve_accepts_requirements_and_criteria() {
        let index = RequirementsIndex::build(REQUIREMENTS);

        for payload in ["1", "2", "1.1", "1.2", "2.1"] {
            assert_eq!(
                index.resolve(&single(payload)),
                Ok(()),
                "{payload} must resolve against the index"
            );
        }
    }

    #[test]
    fn resolve_reports_unresolved_and_malformed_references() {
        let index = RequirementsIndex::build(REQUIREMENTS);

        for payload in ["9", "1.3", "2.2"] {
            assert_eq!(
                index.resolve(&single(payload)),
                Err(ReferenceProblem::Unresolved),
                "{payload} does not name an indexed requirement or criterion"
            );
        }
        for payload in ["18.1-18.9", "1.", "abc"] {
            assert_eq!(
                index.resolve(&single(payload)),
                Err(ReferenceProblem::Malformed),
                "{payload} is not a well-formed reference"
            );
        }
    }

    #[test]
    fn resolve_uses_the_tokens_produced_by_tokenize() {
        let index = RequirementsIndex::build(REQUIREMENTS);
        let payload = "1.1, 9.4, 18.1-18.9_";

        let problems = tokenize(payload)
            .iter()
            .map(|token| index.resolve(token))
            .collect::<Vec<_>>();

        assert_eq!(
            problems,
            vec![
                Ok(()),
                Err(ReferenceProblem::Unresolved),
                Err(ReferenceProblem::Malformed),
            ]
        );
    }
}
