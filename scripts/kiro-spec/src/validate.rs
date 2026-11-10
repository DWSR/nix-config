use std::cmp::Ordering;

pub const SPEC_JSON_FILE: &str = "spec.json";
pub const TASKS_MD_FILE: &str = "tasks.md";
pub const REQUIREMENTS_MD_FILE: &str = "requirements.md";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Finding {
    pub severity: Severity,
    pub code: &'static str,
    pub message: String,
    pub file: String,
    pub line: Option<usize>,
}

impl Finding {
    pub fn error(
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self::new(Severity::Error, code, message, file, line)
    }

    pub fn warning(
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self::new(Severity::Warning, code, message, file, line)
    }

    fn new(
        severity: Severity,
        code: &'static str,
        message: impl Into<String>,
        file: impl Into<String>,
        line: Option<usize>,
    ) -> Self {
        Self {
            severity,
            code,
            message: message.into(),
            file: file.into(),
            line,
        }
    }

    pub fn sort_key(&self) -> (&str, (u8, usize), &str, &str) {
        let line_key = match self.line {
            None => (0, 0),
            Some(line) => (1, line),
        };
        (&self.file, line_key, self.code, &self.message)
    }
}

pub fn compare_findings(left: &Finding, right: &Finding) -> Ordering {
    left.sort_key().cmp(&right.sort_key())
}

pub fn sort_findings(findings: &mut [Finding]) {
    findings.sort_by(compare_findings);
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ValidationReport {
    pub findings: Vec<Finding>,
}

impl ValidationReport {
    pub fn new(mut findings: Vec<Finding>) -> Self {
        sort_findings(&mut findings);
        Self { findings }
    }

    pub fn push(&mut self, finding: Finding) {
        let index = self
            .findings
            .partition_point(|existing| compare_findings(existing, &finding) != Ordering::Greater);
        self.findings.insert(index, finding);
    }

    pub fn extend(&mut self, findings: impl IntoIterator<Item = Finding>) {
        self.findings.extend(findings);
        sort_findings(&mut self.findings);
    }

    pub fn has_errors(&self) -> bool {
        self.findings
            .iter()
            .any(|finding| finding.severity == Severity::Error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(code: &'static str, message: &str, file: &str, line: Option<usize>) -> Finding {
        Finding::error(code, message, file, line)
    }

    fn keys(findings: &[Finding]) -> Vec<(&str, Option<usize>, &str, &str)> {
        findings
            .iter()
            .map(|finding| {
                (
                    finding.file.as_str(),
                    finding.line,
                    finding.code,
                    finding.message.as_str(),
                )
            })
            .collect()
    }

    fn sample_findings() -> Vec<Finding> {
        vec![
            finding("tasks.line.unnumbered", "c", TASKS_MD_FILE, Some(2)),
            finding("spec.field.missing", "b", SPEC_JSON_FILE, None),
            finding(
                "requirements.ref.unresolved",
                "a",
                REQUIREMENTS_MD_FILE,
                Some(3),
            ),
            finding("spec.field.type", "b", SPEC_JSON_FILE, Some(1)),
            finding("tasks.id.depth", "a", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.duplicate", "a", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.depth", "a", TASKS_MD_FILE, None),
        ]
    }

    #[test]
    fn spec_relative_file_names_are_the_documented_constants() {
        assert_eq!(SPEC_JSON_FILE, "spec.json");
        assert_eq!(TASKS_MD_FILE, "tasks.md");
        assert_eq!(REQUIREMENTS_MD_FILE, "requirements.md");
    }

    #[test]
    fn sort_orders_by_file_then_line_then_code_then_message() {
        let mut findings = sample_findings();
        sort_findings(&mut findings);
        assert_eq!(
            keys(&findings),
            vec![
                (
                    "requirements.md",
                    Some(3),
                    "requirements.ref.unresolved",
                    "a"
                ),
                ("spec.json", None, "spec.field.missing", "b"),
                ("spec.json", Some(1), "spec.field.type", "b"),
                ("tasks.md", None, "tasks.id.depth", "a"),
                ("tasks.md", Some(1), "tasks.id.depth", "a"),
                ("tasks.md", Some(1), "tasks.id.duplicate", "a"),
                ("tasks.md", Some(2), "tasks.line.unnumbered", "c"),
            ]
        );
    }

    #[test]
    fn a_missing_line_sorts_before_line_one() {
        let mut findings = vec![
            finding("tasks.line.malformed", "line one", TASKS_MD_FILE, Some(1)),
            finding("tasks.line.malformed", "no line", TASKS_MD_FILE, None),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].line, None);
        assert_eq!(findings[1].line, Some(1));
    }

    #[test]
    fn line_one_sorts_before_line_two() {
        let mut findings = vec![
            finding("tasks.line.malformed", "line two", TASKS_MD_FILE, Some(2)),
            finding("tasks.line.malformed", "line one", TASKS_MD_FILE, Some(1)),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].line, Some(1));
        assert_eq!(findings[1].line, Some(2));
    }

    #[test]
    fn code_breaks_a_tie_on_file_and_line() {
        let mut findings = vec![
            finding("tasks.line.malformed", "same", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.depth", "same", TASKS_MD_FILE, Some(1)),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].code, "tasks.id.depth");
        assert_eq!(findings[1].code, "tasks.line.malformed");
    }

    #[test]
    fn message_breaks_a_tie_on_file_line_and_code() {
        let mut findings = vec![
            finding("tasks.id.duplicate", "beta", TASKS_MD_FILE, Some(1)),
            finding("tasks.id.duplicate", "alpha", TASKS_MD_FILE, Some(1)),
        ];
        sort_findings(&mut findings);
        assert_eq!(findings[0].message, "alpha");
        assert_eq!(findings[1].message, "beta");
    }

    #[test]
    fn sorting_does_not_depend_on_input_order() {
        let mut forward = sample_findings();
        sort_findings(&mut forward);

        let mut reversed = sample_findings();
        reversed.reverse();
        sort_findings(&mut reversed);

        assert_eq!(forward, reversed);
        assert_eq!(forward, ValidationReport::new(sample_findings()).findings);
    }

    #[test]
    fn new_sorts_findings_before_exposing_them() {
        let report = ValidationReport::new(vec![
            finding("b", "second", TASKS_MD_FILE, Some(2)),
            finding("a", "first", SPEC_JSON_FILE, None),
        ]);
        assert_eq!(
            report
                .findings
                .iter()
                .map(|finding| finding.file.as_str())
                .collect::<Vec<_>>(),
            vec!["spec.json", "tasks.md"]
        );
    }

    #[test]
    fn push_keeps_findings_sorted() {
        let mut report = ValidationReport::default();
        report.push(finding("b", "second", TASKS_MD_FILE, Some(2)));
        report.push(finding("a", "first", SPEC_JSON_FILE, None));
        report.push(finding("a", "first", TASKS_MD_FILE, Some(1)));
        report.push(finding("a", "first", TASKS_MD_FILE, None));
        assert_eq!(
            keys(&report.findings),
            vec![
                ("spec.json", None, "a", "first"),
                ("tasks.md", None, "a", "first"),
                ("tasks.md", Some(1), "a", "first"),
                ("tasks.md", Some(2), "b", "second"),
            ]
        );
    }

    #[test]
    fn extend_merges_new_findings_and_keeps_the_order() {
        let mut report =
            ValidationReport::new(vec![finding("b", "second", TASKS_MD_FILE, Some(2))]);
        report.extend(vec![
            finding("a", "first", SPEC_JSON_FILE, None),
            finding("a", "first", TASKS_MD_FILE, None),
        ]);
        assert_eq!(
            keys(&report.findings),
            vec![
                ("spec.json", None, "a", "first"),
                ("tasks.md", None, "a", "first"),
                ("tasks.md", Some(2), "b", "second"),
            ]
        );
    }

    #[test]
    fn has_errors_is_true_for_a_report_with_an_error() {
        let report = ValidationReport::new(vec![finding("a", "error", SPEC_JSON_FILE, None)]);
        assert!(report.has_errors());
    }

    #[test]
    fn has_errors_is_false_for_a_warning_only_report() {
        let report = ValidationReport::new(vec![Finding::warning(
            "tasks.line.unnumbered",
            "warning",
            TASKS_MD_FILE,
            Some(1),
        )]);
        assert!(!report.has_errors());
    }

    #[test]
    fn has_errors_is_false_for_an_empty_report() {
        assert!(!ValidationReport::default().has_errors());
    }

    #[test]
    fn has_errors_is_true_when_warnings_and_errors_are_mixed() {
        let report = ValidationReport::new(vec![
            Finding::warning("a", "warning", TASKS_MD_FILE, Some(1)),
            finding("b", "error", SPEC_JSON_FILE, None),
        ]);
        assert!(report.has_errors());
    }
}
