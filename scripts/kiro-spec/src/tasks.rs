use crate::error::MutationError;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Line {
    text: String,
    terminator: String,
}

impl Line {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn terminator(&self) -> &str {
        &self.terminator
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MetadataKind {
    Requirements,
    Boundary,
    Depends,
    Blocked,
}

impl MetadataKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Requirements => "Requirements",
            Self::Boundary => "Boundary",
            Self::Depends => "Depends",
            Self::Blocked => "Blocked",
        }
    }

    fn from_name(name: &str) -> Option<Self> {
        match name {
            "Requirements" => Some(Self::Requirements),
            "Boundary" => Some(Self::Boundary),
            "Depends" => Some(Self::Depends),
            "Blocked" => Some(Self::Blocked),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataBullet {
    kind: MetadataKind,
    line: usize,
    body: String,
}

impl MetadataBullet {
    pub fn kind(&self) -> MetadataKind {
        self.kind
    }

    pub fn line(&self) -> usize {
        self.line
    }

    pub fn body(&self) -> &str {
        &self.body
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskBlock {
    start: usize,
    end: usize,
    metadata: Vec<MetadataBullet>,
}

impl TaskBlock {
    pub fn start(&self) -> usize {
        self.start
    }

    pub fn end(&self) -> usize {
        self.end
    }

    pub fn metadata(&self) -> &[MetadataBullet] {
        &self.metadata
    }

    pub fn metadata_for(&self, kind: MetadataKind) -> impl Iterator<Item = &MetadataBullet> + '_ {
        self.metadata
            .iter()
            .filter(move |bullet| bullet.kind == kind)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskState {
    Pending,
    Completed,
    Blocked,
}

impl TaskState {
    fn from_marker(marker: char) -> Self {
        match marker {
            'x' => Self::Completed,
            '!' => Self::Blocked,
            _ => Self::Pending,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TaskCounts {
    pub total: usize,
    pub completed: usize,
    pub pending: usize,
    pub blocked: usize,
    pub optional_pending: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskEntry {
    id: String,
    level: u8,
    parent: Option<String>,
    description: String,
    marker: char,
    optional: bool,
    line: usize,
    block: TaskBlock,
    has_children: bool,
    blocked_reason: Option<String>,
}

impl TaskEntry {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn level(&self) -> u8 {
        self.level
    }

    pub fn parent(&self) -> Option<&str> {
        self.parent.as_deref()
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn marker(&self) -> char {
        self.marker
    }

    pub fn state(&self) -> TaskState {
        TaskState::from_marker(self.marker)
    }

    pub fn blocked_reason(&self) -> Option<&str> {
        self.blocked_reason.as_deref()
    }

    pub fn optional(&self) -> bool {
        self.optional
    }

    pub fn line(&self) -> usize {
        self.line
    }

    pub fn block(&self) -> &TaskBlock {
        &self.block
    }

    pub fn has_children(&self) -> bool {
        self.has_children
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TaskDocument {
    lines: Vec<Line>,
    entries: Vec<TaskEntry>,
}

impl TaskDocument {
    pub fn lines(&self) -> &[Line] {
        &self.lines
    }

    pub fn entries(&self) -> &[TaskEntry] {
        &self.entries
    }

    pub fn counts(&self) -> TaskCounts {
        let mut counts = TaskCounts {
            total: self.entries.len(),
            ..TaskCounts::default()
        };
        for entry in &self.entries {
            match entry.state() {
                TaskState::Completed => counts.completed += 1,
                TaskState::Pending => {
                    counts.pending += 1;
                    if entry.optional() {
                        counts.optional_pending += 1;
                    }
                }
                TaskState::Blocked => counts.blocked += 1,
            }
        }
        counts
    }

    pub fn next_actionable(&self) -> Option<&TaskEntry> {
        self.entries
            .iter()
            .find(|entry| entry.state() != TaskState::Completed && !entry.has_children)
    }

    pub fn find_unique(&self, id: &str) -> Result<&TaskEntry, MutationError> {
        let canonical = normalize_lookup_id(id).ok_or_else(|| {
            MutationError::conflict(
                "tasks.md",
                format!("malformed task identifier `{id}`"),
            )
        })?;
        let matches: Vec<&TaskEntry> = self
            .entries
            .iter()
            .filter(|entry| entry.id == canonical)
            .collect();
        match matches.len() {
            0 => Err(MutationError::conflict(
                "tasks.md",
                format!("unknown task identifier `{id}`"),
            )),
            1 => Ok(matches[0]),
            count => Err(MutationError::conflict(
                "tasks.md",
                format!("ambiguous task identifier `{id}` (matches {count} entries)"),
            )),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for line in &self.lines {
            bytes.extend_from_slice(line.text.as_bytes());
            bytes.extend_from_slice(line.terminator.as_bytes());
        }
        bytes
    }
}

pub fn parse_tasks(text: &str) -> TaskDocument {
    let lines = split_lines(text);
    let kinds = classify_lines(&lines);
    let mut entries = Vec::new();

    for index in 0..lines.len() {
        if kinds[index] != LineKind::Candidate {
            continue;
        }
        let Some((marker, optional, rest)) = candidate(lines[index].text()) else {
            continue;
        };
        let Some(parsed) = parse_identifier(rest) else {
            continue;
        };
        let end = block_end(&kinds, index);
        let metadata = collect_metadata(&lines, &kinds, index, end);
        let block = TaskBlock {
            start: index + 1,
            end: end + 1,
            metadata,
        };
        let blocked_reason = if marker == '!' {
            block
                .metadata_for(MetadataKind::Blocked)
                .next()
                .map(|bullet| bullet.body.clone())
        } else {
            None
        };
        entries.push(TaskEntry {
            id: parsed.id,
            level: parsed.level,
            parent: parsed.parent,
            description: parsed.description,
            marker,
            optional,
            line: index + 1,
            block,
            has_children: false,
            blocked_reason,
        });
    }

    for index in 0..entries.len() {
        if entries[index].level != 1 {
            continue;
        }
        let id = entries[index].id.clone();
        let has_children = entries
            .iter()
            .any(|entry| entry.parent.as_deref() == Some(id.as_str()));
        entries[index].has_children = has_children;
    }

    TaskDocument { lines, entries }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum LineKind {
    Blank,
    Heading,
    Candidate,
    Fence,
    Other,
}

fn split_lines(text: &str) -> Vec<Line> {
    let mut lines = Vec::new();
    let mut rest = text;

    while !rest.is_empty() {
        match rest.find('\n') {
            Some(index) => {
                let raw = &rest[..index];
                let (content, terminator) = match raw.strip_suffix('\r') {
                    Some(content) => (content, "\r\n"),
                    None => (raw, "\n"),
                };
                lines.push(Line {
                    text: content.to_owned(),
                    terminator: terminator.to_owned(),
                });
                rest = &rest[index + 1..];
            }
            None => {
                lines.push(Line {
                    text: rest.to_owned(),
                    terminator: String::new(),
                });
                rest = "";
            }
        }
    }

    lines
}

fn classify_lines(lines: &[Line]) -> Vec<LineKind> {
    let mut kinds = Vec::with_capacity(lines.len());
    let mut in_fence = false;

    for line in lines {
        let text = line.text();
        if is_fence(text) {
            in_fence = !in_fence;
            kinds.push(LineKind::Fence);
            continue;
        }
        if in_fence {
            kinds.push(LineKind::Fence);
            continue;
        }
        kinds.push(if text.trim().is_empty() {
            LineKind::Blank
        } else if is_heading(text) {
            LineKind::Heading
        } else if candidate(text).is_some() {
            LineKind::Candidate
        } else {
            LineKind::Other
        });
    }

    kinds
}

fn is_fence(text: &str) -> bool {
    text.trim_start().starts_with("```")
}

fn is_heading(text: &str) -> bool {
    let hashes = text.bytes().take_while(|byte| *byte == b'#').count();
    if hashes == 0 || hashes > 6 {
        return false;
    }
    let rest = &text[hashes..];
    rest.starts_with(' ') || rest.starts_with('\t')
}

fn candidate(text: &str) -> Option<(char, bool, &str)> {
    let rest = text.strip_prefix("- [")?;
    let mut chars = rest.chars();
    let marker = chars.next()?;
    if !matches!(marker, ' ' | 'x' | '!') {
        return None;
    }
    let rest = chars.as_str().strip_prefix(']')?;
    let (optional, rest) = match rest.strip_prefix('*') {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let rest = rest.strip_prefix(' ')?;
    Some((marker, optional, rest))
}

struct ParsedIdentifier {
    id: String,
    level: u8,
    parent: Option<String>,
    description: String,
}

fn parse_identifier(text: &str) -> Option<ParsedIdentifier> {
    let (major, after_major) = leading_digits(text)?;
    let after_dot = after_major.strip_prefix('.')?;

    if let Some((minor, after_minor)) = leading_digits(after_dot) {
        if let Some(description) = whitespace_prefix(after_minor) {
            let description = description.trim_end();
            if !description.is_empty() {
                return Some(ParsedIdentifier {
                    id: format!("{major}.{minor}"),
                    level: 2,
                    parent: Some(major.to_owned()),
                    description: description.to_owned(),
                });
            }
        }
    }

    let description = whitespace_prefix(after_dot)?.trim_end();
    if description.is_empty() {
        return None;
    }
    Some(ParsedIdentifier {
        id: major.to_owned(),
        level: 1,
        parent: None,
        description: description.to_owned(),
    })
}

fn leading_digits(value: &str) -> Option<(&str, &str)> {
    let count = value
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if count == 0 {
        None
    } else {
        Some((&value[..count], &value[count..]))
    }
}

fn normalize_lookup_id(input: &str) -> Option<String> {
    let canonical = input.strip_suffix('.').unwrap_or(input);
    let parts: Vec<&str> = canonical.split('.').collect();
    if parts.is_empty() || parts.len() > 2 {
        return None;
    }
    let valid = parts
        .iter()
        .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()));
    if !valid {
        return None;
    }
    Some(canonical.to_owned())
}

fn whitespace_prefix(value: &str) -> Option<&str> {
    let trimmed = value.trim_start();
    if trimmed.len() == value.len() {
        None
    } else {
        Some(trimmed)
    }
}

fn block_end(kinds: &[LineKind], start: usize) -> usize {
    let mut end = start;
    for index in start + 1..kinds.len() {
        match kinds[index] {
            LineKind::Blank | LineKind::Heading | LineKind::Candidate => break,
            LineKind::Fence | LineKind::Other => end = index,
        }
    }
    end
}

fn collect_metadata(
    lines: &[Line],
    kinds: &[LineKind],
    start: usize,
    end: usize,
) -> Vec<MetadataBullet> {
    let mut metadata = Vec::new();
    let mut current: Option<usize> = None;

    for index in start + 1..=end {
        if kinds[index] != LineKind::Other {
            current = None;
            continue;
        }
        let text = lines[index].text();
        if let Some((kind, body)) = metadata_bullet(text) {
            metadata.push(MetadataBullet {
                kind,
                line: index + 1,
                body: body.trim_end().to_owned(),
            });
            current = Some(metadata.len() - 1);
        } else if is_indented_bullet(text) {
            current = None;
        } else if let Some(position) = current {
            append_continuation(&mut metadata[position].body, text);
        }
    }

    for bullet in &mut metadata {
        bullet.body = normalize_body(&bullet.body);
    }

    metadata
}

fn metadata_bullet(text: &str) -> Option<(MetadataKind, &str)> {
    let trimmed = text.trim_start();
    if trimmed.len() == text.len() {
        return None;
    }
    let rest = trimmed.strip_prefix("- ")?;
    let rest = rest.strip_prefix('_')?;
    let (label, rest) = rest.split_once(':')?;
    let kind = MetadataKind::from_name(label)?;
    Some((kind, rest.trim_start()))
}

fn is_indented_bullet(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.len() < text.len() && trimmed.starts_with("- ")
}

fn append_continuation(body: &mut String, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if !body.is_empty() {
        body.push(' ');
    }
    body.push_str(trimmed);
}

fn normalize_body(body: &str) -> String {
    let body = body.trim_end();
    let body = body.strip_suffix('_').unwrap_or(body);
    body.trim_end().to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> TaskDocument {
        parse_tasks(text)
    }

    #[test]
    fn parses_major_entries_with_line_numbers_and_markers() {
        let document = parse(
            "# Implementation Plan\n\n- [ ] 1. First task\n  - _Requirements: 1.1_\n- [x] 2. Second task\n  - _Boundary: first boundary_\n- [!] 3. Third task\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].id(), "1");
        assert_eq!(entries[0].level(), 1);
        assert_eq!(entries[0].parent(), None);
        assert_eq!(entries[0].description(), "First task");
        assert_eq!(entries[0].marker(), ' ');
        assert!(!entries[0].optional());
        assert_eq!(entries[0].line(), 3);
        assert_eq!(entries[0].block().start(), 3);
        assert_eq!(entries[0].block().end(), 4);
        assert_eq!(entries[0].block().metadata().len(), 1);
        assert_eq!(
            entries[0].block().metadata()[0].kind(),
            MetadataKind::Requirements
        );
        assert_eq!(entries[0].block().metadata()[0].line(), 4);
        assert_eq!(entries[0].block().metadata()[0].body(), "1.1");

        assert_eq!(entries[1].id(), "2");
        assert_eq!(entries[1].marker(), 'x');
        assert_eq!(entries[1].line(), 5);
        assert_eq!(entries[1].block().end(), 6);

        assert_eq!(entries[2].id(), "3");
        assert_eq!(entries[2].marker(), '!');
        assert_eq!(entries[2].line(), 7);
        assert_eq!(entries[2].block().start(), 7);
        assert_eq!(entries[2].block().end(), 7);
        assert!(entries[2].block().metadata().is_empty());
    }

    #[test]
    fn subtask_form_is_tried_before_the_major_form() {
        let document =
            parse("- [ ] 1. Build\n- [ ] 1.2 Detail\n- [ ] 1.10 Another\n- [ ] 2. Next major\n");
        let entries = document.entries();

        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].id(), "1");
        assert!(entries[0].has_children());
        assert_eq!(entries[1].id(), "1.2");
        assert_eq!(entries[1].level(), 2);
        assert_eq!(entries[1].parent(), Some("1"));
        assert_eq!(entries[1].description(), "Detail");
        assert!(!entries[1].has_children());
        assert_eq!(entries[2].id(), "1.10");
        assert_eq!(entries[2].level(), 2);
        assert_eq!(entries[2].parent(), Some("1"));
        assert_eq!(entries[3].id(), "2");
        assert_eq!(entries[3].level(), 1);
        assert!(!entries[3].has_children());
    }

    #[test]
    fn optional_marker_is_consumed_in_every_state() {
        let document = parse(
            "- [ ]* 1. Optional pending\n- [x]* 1.2 Optional completed\n- [!]* 2. Optional blocked\n- [ ] 3. *literal star in description\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 4);
        assert!(entries[0].optional());
        assert_eq!(entries[0].marker(), ' ');
        assert_eq!(entries[0].description(), "Optional pending");
        assert!(entries[1].optional());
        assert_eq!(entries[1].marker(), 'x');
        assert_eq!(entries[1].description(), "Optional completed");
        assert!(entries[2].optional());
        assert_eq!(entries[2].marker(), '!');
        assert_eq!(entries[2].description(), "Optional blocked");
        assert!(!entries[3].optional());
        assert_eq!(entries[3].description(), "*literal star in description");
    }

    #[test]
    fn adjacent_entries_end_the_previous_block() {
        let document = parse(
            "- [ ] 1. First\n  - _Requirements: 1.1_\n- [ ] 2. Second\n  - _Boundary: second boundary_\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].block().start(), 1);
        assert_eq!(entries[0].block().end(), 2);
        assert_eq!(entries[0].block().metadata().len(), 1);
        assert_eq!(entries[1].block().start(), 3);
        assert_eq!(entries[1].block().end(), 4);
        assert_eq!(entries[1].block().metadata().len(), 1);
        assert_eq!(
            entries[1].block().metadata()[0].kind(),
            MetadataKind::Boundary
        );
        assert_eq!(entries[1].block().metadata()[0].body(), "second boundary");
    }

    #[test]
    fn metadata_bullets_and_continuation_lines_attach_to_the_entry_block() {
        let document = parse(
            "- [ ] 4. Metadata task\n  - _Requirements: 3.1, 3.5, 3.7, 11.1_\n  - _Boundary: scripts/kiro-spec/src/tasks.rs_\n  - _Depends: 2.3_\n  - _Blocked: needs operator input\n    before the review can proceed_\n",
        );
        let entry = &document.entries()[0];
        let metadata = entry.block().metadata();

        assert_eq!(entry.block().start(), 1);
        assert_eq!(entry.block().end(), 6);
        assert_eq!(metadata.len(), 4);
        assert_eq!(metadata[0].kind(), MetadataKind::Requirements);
        assert_eq!(metadata[0].line(), 2);
        assert_eq!(metadata[0].body(), "3.1, 3.5, 3.7, 11.1");
        assert_eq!(metadata[1].kind(), MetadataKind::Boundary);
        assert_eq!(metadata[1].line(), 3);
        assert_eq!(metadata[1].body(), "scripts/kiro-spec/src/tasks.rs");
        assert_eq!(metadata[2].kind(), MetadataKind::Depends);
        assert_eq!(metadata[2].line(), 4);
        assert_eq!(metadata[2].body(), "2.3");
        assert_eq!(metadata[3].kind(), MetadataKind::Blocked);
        assert_eq!(metadata[3].line(), 5);
        assert_eq!(
            metadata[3].body(),
            "needs operator input before the review can proceed"
        );
        assert_eq!(entry.block().metadata_for(MetadataKind::Blocked).count(), 1);
    }

    #[test]
    fn prose_continuation_stays_in_the_block_but_out_of_metadata() {
        let document = parse(
            "- [ ] 1. Task\n  - First prose line\n    continues here.\n  - _Requirements: 1.1_\n",
        );
        let entry = &document.entries()[0];

        assert_eq!(entry.block().start(), 1);
        assert_eq!(entry.block().end(), 4);
        assert_eq!(entry.block().metadata().len(), 1);
        assert_eq!(entry.block().metadata()[0].line(), 4);
        assert_eq!(entry.block().metadata()[0].body(), "1.1");
    }

    #[test]
    fn a_blank_line_ends_the_block() {
        let document = parse(
            "- [ ] 1. First\n  - _Requirements: 1.1_\n\n  - _Boundary: detached_\n\n- [ ] 2. Second\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].block().end(), 2);
        assert_eq!(entries[0].block().metadata().len(), 1);
        assert_eq!(entries[1].line(), 6);
        assert!(entries[1].block().metadata().is_empty());
    }

    #[test]
    fn an_atx_heading_ends_the_block() {
        let document = parse(
            "- [ ] 1. First\n  - _Requirements: 1.1_\n## Detached section\n  - _Boundary: detached_\n- [ ] 2. Second\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].block().end(), 2);
        assert_eq!(entries[0].block().metadata().len(), 1);
        assert_eq!(entries[1].line(), 5);
        assert!(entries[1].block().metadata().is_empty());
    }

    #[test]
    fn fenced_code_is_skipped_for_checkboxes_metadata_and_headings() {
        let document = parse(
            "- [ ] 1. First\n  - _Requirements: 1.1_\n  ```\n- [ ] 2. Fenced checkbox\n## Fenced heading\n  - _Blocked: fenced reason_\n  ```\n- [ ] 3. Real\n  - _Boundary: real boundary_\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id(), "1");
        assert_eq!(entries[0].block().end(), 7);
        assert_eq!(entries[0].block().metadata().len(), 1);
        assert_eq!(
            entries[0].block().metadata()[0].kind(),
            MetadataKind::Requirements
        );
        assert_eq!(entries[1].id(), "3");
        assert_eq!(entries[1].line(), 8);
        assert_eq!(entries[1].block().metadata().len(), 1);
        assert_eq!(
            entries[1].block().metadata()[0].kind(),
            MetadataKind::Boundary
        );
    }

    #[test]
    fn metadata_looking_lines_outside_a_block_are_ignored() {
        let document = parse("- _Requirements: 1.1_\n  - _Boundary: outside_\n\n- [ ] 1. Task\n");
        let entries = document.entries();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].line(), 4);
        assert!(entries[0].block().metadata().is_empty());
    }

    #[test]
    fn an_unnumbered_checkbox_ends_the_block_without_becoming_an_entry() {
        let document = parse(
            "- [ ] 1. Numbered\n  - _Requirements: 1.1_\n- [ ] Has no identifier\n  - _Boundary: detached_\n- [ ] 2. Next\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id(), "1");
        assert_eq!(entries[0].block().end(), 2);
        assert_eq!(entries[0].block().metadata().len(), 1);
        assert_eq!(entries[1].id(), "2");
        assert_eq!(entries[1].line(), 5);
        assert!(entries[1].block().metadata().is_empty());
    }

    #[test]
    fn indented_checkboxes_are_not_candidates() {
        let document = parse("  - [ ] 1. Indented\n\t- [ ] 2. Tabbed\n- [ ] 3. Real\n");
        let entries = document.entries();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id(), "3");
        assert_eq!(entries[0].line(), 3);
    }

    #[test]
    fn descriptions_keep_internal_spacing_and_strip_trailing_whitespace() {
        let text = "- [ ] 1.   Spaced   description   \n";
        let document = parse(text);

        assert_eq!(document.entries()[0].description(), "Spaced   description");
        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn crlf_line_terminators_are_preserved_and_lines_are_one_based() {
        let text = "# Plan\r\n\r\n- [ ] 1. Task\r\n  - _Requirements: 1.1_\r\n";
        let document = parse(text);
        let entry = &document.entries()[0];

        assert_eq!(entry.line(), 3);
        assert_eq!(entry.block().metadata()[0].line(), 4);
        assert_eq!(document.lines()[0].terminator(), "\r\n");
        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn a_missing_final_newline_round_trips() {
        let text = "- [ ] 1. Task\n  - _Requirements: 1.1_";
        let document = parse(text);

        assert_eq!(document.lines().len(), 2);
        assert_eq!(document.lines()[1].terminator(), "");
        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn lf_document_round_trips_byte_for_byte() {
        let text = "- [ ] 1. Task\n  - _Requirements: 1.1_\n- [x] 2. Done\n";
        let document = parse(text);

        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn an_empty_document_has_no_entries_and_round_trips() {
        let document = parse("");

        assert!(document.lines().is_empty());
        assert!(document.entries().is_empty());
        assert!(document.to_bytes().is_empty());
    }

    #[test]
    fn malformed_identifiers_are_skipped_without_panicking() {
        let document = parse(
            "- [ ] 1.2.3 Too deep\n- [ ] 1.\n- [ ] 1 Trailing\n- [ ] 1.2\n- [ ] 1. Still fine\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id(), "1");
        assert_eq!(entries[0].description(), "Still fine");
    }

    #[test]
    fn state_matrix_follows_the_checkbox_character_and_keeps_optional() {
        let document = parse(
            "- [ ] 1. Pending\n- [ ]* 2. Optional pending\n- [x] 3. Completed\n- [x]* 4. Optional completed\n- [!] 5. Blocked\n- [!]* 6. Optional blocked\n",
        );
        let entries = document.entries();

        assert_eq!(entries.len(), 6);
        assert_eq!(entries[0].state(), TaskState::Pending);
        assert!(!entries[0].optional());
        assert_eq!(entries[1].state(), TaskState::Pending);
        assert!(entries[1].optional());
        assert_eq!(entries[2].state(), TaskState::Completed);
        assert!(!entries[2].optional());
        assert_eq!(entries[3].state(), TaskState::Completed);
        assert!(entries[3].optional());
        assert_eq!(entries[4].state(), TaskState::Blocked);
        assert!(!entries[4].optional());
        assert_eq!(entries[5].state(), TaskState::Blocked);
        assert!(entries[5].optional());
    }

    #[test]
    fn blocked_reason_joins_continuations_and_removes_one_trailing_underscore() {
        let document = parse(
            "- [!] 1. Blocked\n  - _Blocked: waiting on credentials,\n    then rerun the suite_\n- [!] 2. Still blocked\n  - _Blocked: ends with two underscores__\n- [!] 3. No note\n- [ ] 4. Pending\n  - _Blocked: not a blocked entry_\n",
        );
        let entries = document.entries();

        assert_eq!(
            entries[0].blocked_reason(),
            Some("waiting on credentials, then rerun the suite")
        );
        assert_eq!(
            entries[1].blocked_reason(),
            Some("ends with two underscores_")
        );
        assert_eq!(entries[2].blocked_reason(), None);
        assert_eq!(entries[3].blocked_reason(), None);
        assert_eq!(entries[3].state(), TaskState::Pending);
    }

    #[test]
    fn counts_sum_to_total_and_track_optional_pending() {
        let document = parse(
            "- [ ] 1. Pending\n- [ ]* 2. Optional pending\n- [x] 3. Completed\n- [x]* 4. Optional completed\n- [!] 5. Blocked\n- [!]* 6. Optional blocked\n",
        );
        let counts = document.counts();

        assert_eq!(counts.total, 6);
        assert_eq!(counts.completed, 2);
        assert_eq!(counts.pending, 2);
        assert_eq!(counts.blocked, 2);
        assert_eq!(counts.optional_pending, 1);
        assert_eq!(
            counts.completed + counts.pending + counts.blocked,
            counts.total
        );
    }

    #[test]
    fn counts_are_zero_for_an_empty_document() {
        let counts = parse("").counts();

        assert_eq!(counts, TaskCounts::default());
        assert_eq!(counts.total, 0);
    }

    #[test]
    fn next_actionable_skips_groupings_and_completed_entries() {
        let document = parse(
            "- [ ] 1. Group\n- [x] 1.1 Done child\n- [x] 2. Completed\n- [ ] 3. Next work\n",
        );

        assert_eq!(document.next_actionable().map(|entry| entry.id()), Some("3"));
    }

    #[test]
    fn next_actionable_selects_a_major_entry_when_it_has_no_children() {
        let document = parse("- [ ] 1. Only major\n- [x] 2. Done\n");

        assert_eq!(document.next_actionable().map(|entry| entry.id()), Some("1"));
    }

    #[test]
    fn next_actionable_reports_a_blocked_entry_with_its_reason() {
        let document = parse(
            "- [x] 1. Done\n- [!] 2. Blocked work\n  - _Blocked: waiting on review_\n",
        );
        let entry = document.next_actionable().expect("blocked candidate");

        assert_eq!(entry.id(), "2");
        assert_eq!(entry.state(), TaskState::Blocked);
        assert_eq!(entry.blocked_reason(), Some("waiting on review"));
    }

    #[test]
    fn next_actionable_is_none_for_a_fully_completed_spec() {
        let document = parse(
            "- [x] 1. Group\n- [x] 1.1 Child\n- [x]* 2. Optional done\n",
        );

        assert!(document.next_actionable().is_none());
    }

    #[test]
    fn unchecked_groupings_stay_unselected_when_children_are_complete() {
        let document = parse("- [ ] 1. Group\n- [x] 1.1 Child\n");

        assert!(document.next_actionable().is_none());
    }

    #[test]
    fn find_unique_accepts_canonical_and_single_trailing_dot_forms() {
        let document = parse("- [ ] 1. Major\n- [ ] 1.2 Child\n- [ ] 2. Other\n");

        assert_eq!(document.find_unique("1").unwrap().id(), "1");
        assert_eq!(document.find_unique("1.").unwrap().id(), "1");
        assert_eq!(document.find_unique("1.2").unwrap().id(), "1.2");
        assert_eq!(document.find_unique("1.2.").unwrap().id(), "1.2");
        assert_eq!(document.find_unique("2").unwrap().id(), "2");
    }

    #[test]
    fn find_unique_rejects_malformed_identifiers() {
        let document = parse("- [ ] 1. Major\n- [ ] 1.2 Child\n");

        for id in ["", ".", "a", "1.2.3", "1..2", "1..", "1.a", "1.2.a", " 1", "1 "] {
            let error = document.find_unique(id).expect_err(id);
            assert_eq!(
                error.category(),
                crate::error::ErrorCategory::MutationConflict,
                "{id:?}"
            );
            assert!(
                error.detail().contains("malformed"),
                "{id:?}: {}",
                error.detail()
            );
            assert!(error.detail().contains(id), "{id:?}: {}", error.detail());
        }
    }

    #[test]
    fn find_unique_rejects_unknown_identifiers() {
        let document = parse("- [ ] 1. Major\n- [ ] 1.2 Child\n");

        for id in ["2", "1.3", "3."] {
            let error = document.find_unique(id).expect_err(id);
            assert_eq!(
                error.category(),
                crate::error::ErrorCategory::MutationConflict,
                "{id:?}"
            );
            assert!(
                error.detail().contains("unknown"),
                "{id:?}: {}",
                error.detail()
            );
            assert!(error.detail().contains(id), "{id:?}: {}", error.detail());
        }
    }

    #[test]
    fn find_unique_refuses_duplicated_identifiers() {
        let document = parse("- [ ] 1. First\n- [ ] 1. Second\n- [ ] 2. Child holder\n- [ ] 2.1 Child\n");

        for id in ["1", "1."] {
            let error = document.find_unique(id).expect_err(id);
            assert_eq!(
                error.category(),
                crate::error::ErrorCategory::MutationConflict,
                "{id:?}"
            );
            assert!(
                error.detail().contains("ambiguous") || error.detail().contains("duplicate"),
                "{id:?}: {}",
                error.detail()
            );
            assert!(error.detail().contains(id), "{id:?}: {}", error.detail());
        }
        assert_eq!(document.find_unique("2.1").unwrap().id(), "2.1");
    }
}
