//! Line-oriented `tasks.md` grammar, entry blocks, and the task model.
//!
//! The parser is pure: it takes a document's text and returns the source lines
//! plus the task entries they declare, with no filesystem access and no
//! failures. Grammar defects are classified by `validate`, never by turning a
//! whole document into an error.
//!
//! Every source line keeps the terminator it was read with, so a document can
//! be reassembled byte for byte by [`TaskDocument::to_bytes`]. An entry block
//! runs from its task line to the first blank line, next checkbox candidate, or
//! ATX heading, and carries the indented metadata bullets and continuation
//! prose written beneath it.

use crate::error::MutationError;

/// The state encoded by a task line's checkbox.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskState {
    /// `[ ]`.
    Pending,
    /// `[x]`.
    Completed,
    /// `[!]`.
    Blocked,
}

impl TaskState {
    /// The state name used in human and machine output.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Blocked => "blocked",
        }
    }

    /// Derive a state from the character between the checkbox brackets.
    fn from_marker(marker: char) -> Option<Self> {
        match marker {
            ' ' => Some(Self::Pending),
            'x' => Some(Self::Completed),
            '!' => Some(Self::Blocked),
            _ => None,
        }
    }
}

/// One entry's canonical dotted number and its position in the numbering tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskId {
    /// Canonical identifier: `<n>` for a major entry, `<n>.<m>` for a subtask.
    pub text: String,
    /// Numbering depth: `1` for a major entry, `2` for a subtask.
    pub level: u8,
    /// The canonical major identifier this subtask belongs to.
    pub parent: Option<String>,
}

/// The metadata bullet kinds a task block may carry.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MetadataKind {
    /// `_Requirements:` — resolved against `requirements.md` by validation.
    Requirements,
    /// `_Boundary:` — preserved, not interpreted.
    Boundary,
    /// `_Depends:` — preserved, not interpreted.
    Depends,
    /// `_Blocked:` — the reason bullet of a blocked entry.
    Blocked,
}

/// One indented metadata bullet and the line span it occupies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetadataBullet {
    kind: MetadataKind,
    line: usize,
    last_line: usize,
    payload: String,
}

impl MetadataBullet {
    /// The metadata kind named by the bullet.
    pub fn kind(&self) -> MetadataKind {
        self.kind
    }

    /// The 1-based line of the bullet itself.
    pub fn line(&self) -> usize {
        self.line
    }

    /// The 1-based line of the bullet's last continuation line.
    pub fn last_line(&self) -> usize {
        self.last_line
    }

    /// The bullet body with continuation lines joined and one trailing `_`
    /// removed.
    pub fn payload(&self) -> &str {
        &self.payload
    }
}

/// One continuation line inside an entry block.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContinuationLine {
    line: usize,
    text: String,
}

impl ContinuationLine {
    /// The 1-based source line.
    pub fn line(&self) -> usize {
        self.line
    }

    /// The line's text with surrounding whitespace removed.
    pub fn text(&self) -> &str {
        &self.text
    }
}

/// The source range and metadata attached to one task entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskBlock {
    start: usize,
    end: usize,
    metadata: Vec<MetadataBullet>,
    prose: Vec<ContinuationLine>,
}

impl TaskBlock {
    /// The 1-based line of the task line that opens the block.
    pub fn first_line(&self) -> usize {
        self.start + 1
    }

    /// The 1-based line of the block's last source line.
    pub fn last_line(&self) -> usize {
        self.end
    }

    /// The metadata bullets in document order.
    pub fn metadata(&self) -> &[MetadataBullet] {
        &self.metadata
    }

    /// The block's non-metadata continuation prose in document order.
    pub fn prose(&self) -> &[ContinuationLine] {
        &self.prose
    }
}

/// One parsed task entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskEntry {
    /// Canonical identifier, numbering level, and parent.
    pub id: TaskId,
    /// The trimmed text after the identifier.
    pub description: String,
    /// The state derived from the checkbox character.
    pub state: TaskState,
    /// Whether the checkbox carried the `*` optional marker.
    pub optional: bool,
    /// The joined `_Blocked:` body when the entry is blocked.
    pub blocked_reason: Option<String>,
    /// The 1-based line of the task line.
    pub line: usize,
    /// Whether at least one subtask names this entry as its parent.
    pub has_children: bool,
    /// The block this entry owns, including attached metadata and prose.
    pub block: TaskBlock,
}

/// One source line, retaining the terminator it was read with.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceLine {
    text: String,
    terminator: Terminator,
}

impl SourceLine {
    /// The line without its terminator.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// The terminator that followed the line.
    pub fn terminator(&self) -> Terminator {
        self.terminator
    }
}

/// The line terminator a source line was read with.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Terminator {
    /// `\n`.
    Lf,
    /// `\r\n`.
    CrLf,
    /// The final line carried no terminator.
    None,
}

impl Terminator {
    /// The bytes that reproduce this terminator.
    pub const fn bytes(self) -> &'static [u8] {
        match self {
            Self::Lf => b"\n",
            Self::CrLf => b"\r\n",
            Self::None => b"",
        }
    }
}

/// Aggregate task counts by state.
///
/// `completed + pending + blocked` always equals `total`; `optional_pending`
/// is a subset of `pending`, not an additional state.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TaskCounts {
    /// Every parsed entry, whatever its state.
    pub total: usize,
    /// Entries whose checkbox is `[x]`.
    pub completed: usize,
    /// Entries whose checkbox is `[ ]`.
    pub pending: usize,
    /// Entries whose checkbox is `[!]`.
    pub blocked: usize,
    /// Pending entries that carried the `*` optional marker.
    pub optional_pending: usize,
}

/// A parsed `tasks.md` document: its source lines and its task entries.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskDocument {
    lines: Vec<SourceLine>,
    entries: Vec<TaskEntry>,
}

impl TaskDocument {
    /// Every parsed task entry, in document order.
    pub fn entries(&self) -> &[TaskEntry] {
        &self.entries
    }

    /// Every source line, in document order.
    pub fn source_lines(&self) -> &[SourceLine] {
        &self.lines
    }

    /// The text of a 1-based source line.
    pub fn line_text(&self, line: usize) -> Option<&str> {
        self.lines
            .get(line.checked_sub(1)?)
            .map(|source| source.text())
    }

    /// Reassemble the document exactly as it was read, terminators included.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        for line in &self.lines {
            bytes.extend_from_slice(line.text().as_bytes());
            bytes.extend_from_slice(line.terminator().bytes());
        }
        bytes
    }

    /// Count every entry by state and count the optional pending subset.
    ///
    /// The three state counts sum to `total` because every entry has exactly
    /// one state.
    pub fn counts(&self) -> TaskCounts {
        let mut counts = TaskCounts {
            total: self.entries.len(),
            ..TaskCounts::default()
        };
        for entry in &self.entries {
            match entry.state {
                TaskState::Completed => counts.completed += 1,
                TaskState::Pending => {
                    counts.pending += 1;
                    if entry.optional {
                        counts.optional_pending += 1;
                    }
                }
                TaskState::Blocked => counts.blocked += 1,
            }
        }
        counts
    }

    /// The first entry in document order that is not completed and owns no
    /// subtasks.
    ///
    /// A grouping entry is never selected, even while it is unchecked: its
    /// children carry the actionable work. When every childless entry is
    /// completed there is no next task, so an unchecked grouping alone yields
    /// `None`.
    pub fn next_actionable(&self) -> Option<&TaskEntry> {
        self.entries
            .iter()
            .find(|entry| entry.state != TaskState::Completed && !entry.has_children)
    }

    /// Resolve one canonical `N` or `N.M` identifier to its entry.
    ///
    /// One trailing `.` is accepted, matching the CLI's identifier grammar.
    /// Anything else that is not already canonical, any identifier with no
    /// matching entry, and any identifier shared by more than one entry is
    /// refused with a conflict naming the identifier.
    pub fn find_unique(&self, id: &str) -> Result<&TaskEntry, MutationError> {
        let canonical = canonical_identifier(id).ok_or_else(|| {
            MutationError::conflict(id, "invalid task identifier; expected N or N.M")
        })?;
        let mut matches = self
            .entries
            .iter()
            .filter(|entry| entry.id.text == canonical);
        let first = matches
            .next()
            .ok_or_else(|| MutationError::conflict(id, "no task matches this identifier"))?;
        let occurrences = 1 + matches.count();
        if occurrences > 1 {
            return Err(MutationError::conflict(
                id,
                format!("identifier matches more than one entry ({occurrences} occurrences)"),
            ));
        }
        Ok(first)
    }
}

/// Parse one `tasks.md` document.
///
/// Candidate checkboxes are recognized only at column zero. Fenced code blocks
/// are skipped, so a checkbox, heading, or metadata bullet inside one never
/// starts an entry or ends a block. Parsing is total: a checkbox that does not
/// match a numbered form is simply not an entry.
pub fn parse_tasks(text: &str) -> TaskDocument {
    let lines = split_lines(text);
    let mut entries = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].text();
        if let Some((marker, length)) = fence {
            if closes_fence(line, marker, length) {
                fence = None;
            }
            index += 1;
            continue;
        }
        if let Some(opening) = opening_fence(line) {
            fence = Some(opening);
            index += 1;
            continue;
        }
        if candidate(line).is_some() {
            let end = block_end(&lines, index);
            if let Some(entry) = build_entry(&lines, index, end) {
                entries.push(entry);
            }
            index = end;
            continue;
        }
        index += 1;
    }
    mark_parents(&mut entries);
    TaskDocument { lines, entries }
}

/// One checkbox line that could open an entry, split into its parts.
struct Candidate<'a> {
    marker: char,
    optional: bool,
    rest: &'a str,
}

/// Recognize an unindented checkbox followed by a space.
///
/// The optional marker is the `*` immediately after the closing bracket; it is
/// not part of the identifier or the description.
fn candidate(line: &str) -> Option<Candidate<'_>> {
    let rest = line.strip_prefix("- [")?;
    let mut characters = rest.chars();
    let marker = characters.next()?;
    if !matches!(marker, ' ' | 'x' | '!') {
        return None;
    }
    if characters.next()? != ']' {
        return None;
    }
    let optional = characters.as_str().starts_with('*');
    let after_marker = if optional {
        &characters.as_str()[1..]
    } else {
        characters.as_str()
    };
    let rest = after_marker.strip_prefix(' ')?;
    Some(Candidate {
        marker,
        optional,
        rest,
    })
}

/// Parse the identifier and description that follow a checkbox.
///
/// The subtask form `<n>.<m>` is tried first so `1.2` is never read as major
/// `1` with the description `2 ...`. Both forms require whitespace and at
/// least one non-whitespace character after the identifier.
fn parse_identifier(text: &str) -> Option<(TaskId, String)> {
    let major_length = text
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if major_length == 0 {
        return None;
    }
    let after_major_dot = text[major_length..].strip_prefix('.')?;
    let minor_length = after_major_dot
        .bytes()
        .take_while(|byte| byte.is_ascii_digit())
        .count();
    if minor_length > 0 {
        if let Some(description) = description_after(&after_major_dot[minor_length..]) {
            let parent = canonical_number(&text[..major_length]);
            let identifier = format!(
                "{parent}.{}",
                canonical_number(&after_major_dot[..minor_length])
            );
            return Some((
                TaskId {
                    text: identifier,
                    level: 2,
                    parent: Some(parent),
                },
                description,
            ));
        }
    }
    let description = description_after(after_major_dot)?;
    Some((
        TaskId {
            text: canonical_number(&text[..major_length]),
            level: 1,
            parent: None,
        },
        description,
    ))
}

/// Consume the whitespace after an identifier and return the trimmed
/// description, or `None` when nothing is left.
fn description_after(text: &str) -> Option<String> {
    let rest = text.strip_prefix(char::is_whitespace)?;
    let description = rest.trim();
    if description.is_empty() {
        None
    } else {
        Some(description.to_string())
    }
}

/// Strip leading zeroes so `01` and `1` share one canonical identifier.
fn canonical_number(digits: &str) -> String {
    let trimmed = digits.trim_start_matches('0');
    if trimmed.is_empty() {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Canonicalise a user-supplied identifier, accepting one trailing `.`.
///
/// Only identifiers the parser can report are matchable, so each numeric
/// segment must already be canonical: `1` and `1.2` resolve, while `01` and
/// `1.02` are refused rather than silently rewritten.
fn canonical_identifier(value: &str) -> Option<String> {
    let core = value.strip_suffix('.').unwrap_or(value);
    let mut parts = core.split('.');
    let major = canonical_segment(parts.next()?)?;
    match (parts.next(), parts.next()) {
        (None, _) => Some(major.to_string()),
        (Some(minor), None) => Some(format!("{major}.{}", canonical_segment(minor)?)),
        (Some(_), Some(_)) => None,
    }
}

/// A numeric identifier segment that is already in canonical form.
fn canonical_segment(text: &str) -> Option<&str> {
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if text.len() > 1 && text.starts_with('0') {
        return None;
    }
    Some(text)
}

/// The 0-based exclusive end of the block that starts at `start`.
///
/// A block ends at the first blank line, next checkbox candidate, or ATX
/// heading that is not inside a fenced code block. An unterminated fence runs
/// to the end of the document.
fn block_end(lines: &[SourceLine], start: usize) -> usize {
    let mut fence: Option<(char, usize)> = None;
    let mut index = start + 1;
    while index < lines.len() {
        let text = lines[index].text();
        if let Some((marker, length)) = fence {
            if closes_fence(text, marker, length) {
                fence = None;
            }
            index += 1;
            continue;
        }
        if let Some(opening) = opening_fence(text) {
            fence = Some(opening);
            index += 1;
            continue;
        }
        if text.trim().is_empty() || heading_level(text).is_some() || candidate(text).is_some() {
            return index;
        }
        index += 1;
    }
    lines.len()
}

/// Build the entry that starts at `start`, if the line is a numbered entry.
fn build_entry(lines: &[SourceLine], start: usize, end: usize) -> Option<TaskEntry> {
    let parsed = candidate(lines[start].text())?;
    let (id, description) = parse_identifier(parsed.rest)?;
    let state = TaskState::from_marker(parsed.marker)?;
    let block = build_block(lines, start, end);
    let blocked_reason = if state == TaskState::Blocked {
        block
            .metadata()
            .iter()
            .find(|bullet| bullet.kind() == MetadataKind::Blocked)
            .map(|bullet| bullet.payload().to_string())
    } else {
        None
    };
    Some(TaskEntry {
        id,
        description,
        state,
        optional: parsed.optional,
        blocked_reason,
        line: start + 1,
        has_children: false,
        block,
    })
}

/// Attach the metadata bullets and continuation prose of one block.
fn build_block(lines: &[SourceLine], start: usize, end: usize) -> TaskBlock {
    let mut metadata = Vec::new();
    let mut prose = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut index = start + 1;
    while index < end {
        let text = lines[index].text();
        if let Some((marker, length)) = fence {
            if closes_fence(text, marker, length) {
                fence = None;
            }
            prose.push(continuation(index, text));
            index += 1;
            continue;
        }
        if let Some(opening) = opening_fence(text) {
            fence = Some(opening);
            prose.push(continuation(index, text));
            index += 1;
            continue;
        }
        if let Some((kind, payload, indent)) = metadata_bullet(text) {
            let bullet_index = index;
            let mut parts = vec![payload.trim().to_string()];
            index += 1;
            while index < end {
                let next = lines[index].text();
                if metadata_bullet(next).is_some()
                    || opening_fence(next).is_some()
                    || leading_indent(next) <= indent
                {
                    break;
                }
                parts.push(next.trim().to_string());
                index += 1;
            }
            let joined = parts
                .iter()
                .filter(|part| !part.is_empty())
                .cloned()
                .collect::<Vec<_>>()
                .join(" ");
            let payload = joined
                .strip_suffix('_')
                .unwrap_or(&joined)
                .trim_end()
                .to_string();
            metadata.push(MetadataBullet {
                kind,
                line: bullet_index + 1,
                last_line: index,
                payload,
            });
            continue;
        }
        prose.push(continuation(index, text));
        index += 1;
    }
    TaskBlock {
        start,
        end,
        metadata,
        prose,
    }
}

/// One non-metadata line inside a block.
fn continuation(index: usize, text: &str) -> ContinuationLine {
    ContinuationLine {
        line: index + 1,
        text: text.trim().to_string(),
    }
}

/// The metadata bullet prefixes the task grammar recognizes.
const METADATA_PREFIXES: [(&str, MetadataKind); 4] = [
    ("_Requirements:", MetadataKind::Requirements),
    ("_Boundary:", MetadataKind::Boundary),
    ("_Depends:", MetadataKind::Depends),
    ("_Blocked:", MetadataKind::Blocked),
];

/// Recognize an indented metadata bullet and return its kind, raw body, and
/// indentation width.
fn metadata_bullet(line: &str) -> Option<(MetadataKind, &str, usize)> {
    let indent = leading_indent(line);
    if indent == 0 {
        return None;
    }
    let rest = line[indent..].strip_prefix("- ")?;
    METADATA_PREFIXES.iter().find_map(|(prefix, kind)| {
        rest.strip_prefix(prefix)
            .map(|payload| (*kind, payload, indent))
    })
}

/// The number of leading spaces and tabs on a line.
fn leading_indent(line: &str) -> usize {
    line.len() - line.trim_start_matches([' ', '\t']).len()
}

/// The ATX heading level of a column-zero heading, if the line is one.
fn heading_level(line: &str) -> Option<usize> {
    let hashes = line.bytes().take_while(|byte| *byte == b'#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    match line[hashes..].chars().next() {
        Some(character) if character.is_whitespace() => Some(hashes),
        _ => None,
    }
}

/// The fence marker and run length when a line opens a fenced code block.
fn opening_fence(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let length = trimmed.chars().take_while(|value| *value == marker).count();
    if length >= 3 {
        Some((marker, length))
    } else {
        None
    }
}

/// Whether a line closes a fence of the given marker and minimum run length.
fn closes_fence(line: &str, marker: char, length: usize) -> bool {
    let trimmed = line.trim_start();
    let run = trimmed.chars().take_while(|value| *value == marker).count();
    run >= length && trimmed.chars().skip(run).all(|value| value.is_whitespace())
}

/// Mark every entry whose canonical identifier is a subtask's parent.
fn mark_parents(entries: &mut [TaskEntry]) {
    let parents: std::collections::BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| entry.id.parent.clone())
        .collect();
    for entry in entries {
        entry.has_children = entry.id.parent.is_none() && parents.contains(&entry.id.text);
    }
}

/// Split text into lines that retain their original terminators.
fn split_lines(text: &str) -> Vec<SourceLine> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let (end, terminator) = if index > start && bytes[index - 1] == b'\r' {
            (index - 1, Terminator::CrLf)
        } else {
            (index, Terminator::Lf)
        };
        lines.push(SourceLine {
            text: text[start..end].to_string(),
            terminator,
        });
        start = index + 1;
    }
    if start < bytes.len() {
        lines.push(SourceLine {
            text: text[start..].to_string(),
            terminator: Terminator::None,
        });
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;

    const BASIC: &str = "\
# Implementation Plan

- [ ] 1. Foundation
- [ ] 1.2 Pin inputs
- [x] 2. Finished work
- [!] 3. Blocked work
";

    fn entry(document: &TaskDocument, index: usize) -> &TaskEntry {
        document
            .entries()
            .get(index)
            .unwrap_or_else(|| panic!("entry {index} must exist"))
    }

    #[test]
    fn lexes_major_and_subtask_entries_in_document_order() {
        let document = parse_tasks(BASIC);

        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.id.text.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "1.2", "2", "3"],
            "entries must appear in document order with canonical identifiers"
        );
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.line)
                .collect::<Vec<_>>(),
            vec![3, 4, 5, 6],
            "line numbers must be 1-based"
        );
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.description.as_str())
                .collect::<Vec<_>>(),
            vec!["Foundation", "Pin inputs", "Finished work", "Blocked work"]
        );
    }

    #[test]
    fn records_level_parent_and_state_per_entry() {
        let document = parse_tasks(BASIC);

        let major = entry(&document, 0);
        assert_eq!(major.id.level, 1);
        assert_eq!(major.id.parent, None);
        assert_eq!(major.state, TaskState::Pending);
        assert!(major.has_children, "entry 1 owns subtask 1.2");

        let subtask = entry(&document, 1);
        assert_eq!(subtask.id.level, 2);
        assert_eq!(subtask.id.parent.as_deref(), Some("1"));
        assert_eq!(subtask.state, TaskState::Pending);
        assert!(!subtask.has_children);

        assert_eq!(entry(&document, 2).state, TaskState::Completed);
        assert_eq!(entry(&document, 3).state, TaskState::Blocked);
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.state.as_str())
                .collect::<Vec<_>>(),
            vec!["pending", "pending", "completed", "blocked"]
        );
    }

    #[test]
    fn consumes_the_optional_marker_in_every_state() {
        let text = "\
- [ ]* 1.1 Optional pending
- [x]* 1.2 Optional completed
- [!]* 1.3 Optional blocked
- [ ] 1.4 Required pending
";
        let document = parse_tasks(text);

        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.id.text.as_str())
                .collect::<Vec<_>>(),
            vec!["1.1", "1.2", "1.3", "1.4"],
            "the optional marker is not part of the identifier"
        );
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.optional)
                .collect::<Vec<_>>(),
            vec![true, true, true, false]
        );
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.description.as_str())
                .collect::<Vec<_>>(),
            vec![
                "Optional pending",
                "Optional completed",
                "Optional blocked",
                "Required pending",
            ],
            "the optional marker is not part of the description"
        );
        assert_eq!(document.to_bytes(), text.as_bytes());
    }

    #[test]
    fn adjacent_entries_end_the_previous_block_without_a_blank_line() {
        let text = "\
- [ ] 1. First
  - Attached prose
- [ ] 2. Second
  - _Requirements: 1.1_
";
        let document = parse_tasks(text);

        assert_eq!(document.entries().len(), 2);
        let first = entry(&document, 0);
        assert_eq!(first.block.last_line(), 2);
        assert!(first.block.metadata().is_empty());
        assert_eq!(
            first
                .block
                .prose()
                .iter()
                .map(ContinuationLine::text)
                .collect::<Vec<_>>(),
            vec!["- Attached prose"]
        );

        let second = entry(&document, 1);
        assert_eq!(second.line, 3);
        assert_eq!(second.block.first_line(), 3);
        assert_eq!(second.block.last_line(), 4);
        assert_eq!(
            second
                .block
                .metadata()
                .iter()
                .map(|bullet| (bullet.kind(), bullet.line(), bullet.payload()))
                .collect::<Vec<_>>(),
            vec![(MetadataKind::Requirements, 4, "1.1")]
        );
    }

    #[test]
    fn attaches_multi_line_metadata_and_continuation_prose() {
        let text = "\
- [!] 1. Work
  - Lead-in prose
  - _Requirements: 1.2, 1.4_
  - _Boundary: the parser boundary_
  - _Depends: 1, 2.1_
  - _Blocked: needs credentials and
    a decision from the operator_
  - trailing prose
";
        let document = parse_tasks(text);
        let task = entry(&document, 0);

        assert_eq!(task.block.last_line(), 8);
        assert_eq!(
            task.block
                .metadata()
                .iter()
                .map(|bullet| bullet.kind())
                .collect::<Vec<_>>(),
            vec![
                MetadataKind::Requirements,
                MetadataKind::Boundary,
                MetadataKind::Depends,
                MetadataKind::Blocked,
            ]
        );
        assert_eq!(
            task.block
                .metadata()
                .iter()
                .map(|bullet| bullet.payload())
                .collect::<Vec<_>>(),
            vec![
                "1.2, 1.4",
                "the parser boundary",
                "1, 2.1",
                "needs credentials and a decision from the operator",
            ]
        );
        assert_eq!(task.block.metadata()[0].line(), 3);
        let blocked = &task.block.metadata()[3];
        assert_eq!(blocked.line(), 6);
        assert_eq!(
            blocked.last_line(),
            7,
            "a bullet spans its own line and every continuation line"
        );
        assert_eq!(
            task.blocked_reason.as_deref(),
            Some("needs credentials and a decision from the operator")
        );

        assert_eq!(
            task.block
                .prose()
                .iter()
                .map(|line| (line.line(), line.text()))
                .collect::<Vec<_>>(),
            vec![(2, "- Lead-in prose"), (8, "- trailing prose")]
        );
    }

    #[test]
    fn fenced_code_blocks_hide_candidates_headings_and_metadata() {
        let text = "\
- [ ] 1. Real task
  - _Requirements: 1.1_
  ```
  - [ ] 9. Not a task
  # not a heading
  - _Requirements: 9.9_
  ```
  - _Boundary: real boundary after fence_

- [ ] 2. Second task
";
        let document = parse_tasks(text);

        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.id.text.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "2"],
            "checkbox-looking lines inside a fence are not entries"
        );
        let first = entry(&document, 0);
        assert_eq!(
            first
                .block
                .metadata()
                .iter()
                .map(|bullet| (bullet.kind(), bullet.payload()))
                .collect::<Vec<_>>(),
            vec![
                (MetadataKind::Requirements, "1.1"),
                (MetadataKind::Boundary, "real boundary after fence"),
            ],
            "metadata bullets inside a fence stay prose"
        );
        assert!(
            first
                .block
                .prose()
                .iter()
                .any(|line| line.text() == "- [ ] 9. Not a task"),
            "fenced checkbox text is retained as prose"
        );
        assert_eq!(entry(&document, 1).line, 10);
    }

    #[test]
    fn headings_end_the_entry_block() {
        let text = "\
- [ ] 1. First
  - _Requirements: 1.1_
## Notes

- [ ] 2. Second
";
        let document = parse_tasks(text);

        let first = entry(&document, 0);
        assert_eq!(first.block.last_line(), 2);
        assert_eq!(first.block.metadata().len(), 1);
        assert_eq!(entry(&document, 1).line, 5);
    }

    #[test]
    fn a_blank_line_ends_the_entry_block() {
        let text = "\
- [ ] 1. One
  - _Requirements: 1.1_

  - _Boundary: outside the block_
";
        let document = parse_tasks(text);

        let first = entry(&document, 0);
        assert_eq!(first.block.last_line(), 2);
        assert_eq!(first.block.metadata().len(), 1);
        assert_eq!(first.block.metadata()[0].kind(), MetadataKind::Requirements);
    }

    #[test]
    fn unnumbered_checkboxes_are_not_task_entries() {
        let text = "\
- [x] `nix fmt` clean
- [ ] 1. Real task
";
        let document = parse_tasks(text);

        assert_eq!(document.entries().len(), 1);
        assert_eq!(document.entries()[0].id.text, "1");
        assert_eq!(document.entries()[0].line, 2);
    }

    #[test]
    fn trims_the_description_but_keeps_internal_spacing() {
        let text = "- [ ] 1.   Spaced   description  \n";
        let document = parse_tasks(text);

        assert_eq!(document.entries()[0].description, "Spaced   description");
    }

    #[test]
    fn round_trips_source_bytes_including_crlf_and_missing_final_newline() {
        let cases = [
            "- [ ] 1. One\r\n  - _Requirements: 1.1_\r\n\r\n- [x] 2. Two\r\n",
            "- [ ] 1. One\r\n  - _Requirements: 1.1_\r\n\r\n- [x] 2. Two",
            "# Plan",
            "- [ ] 1. One",
            "",
            "\n\n",
        ];
        for text in cases {
            let document = parse_tasks(text);
            assert_eq!(
                document.to_bytes(),
                text.as_bytes(),
                "{text:?} must round-trip byte for byte"
            );
        }

        let crlf = parse_tasks(cases[0]);
        assert_eq!(crlf.entries().len(), 2);
        assert_eq!(crlf.entries()[0].line, 1);
        assert_eq!(crlf.entries()[1].line, 4);
    }

    #[test]
    fn derives_state_from_the_checkbox_character_for_all_six_markers() {
        let text = "\
- [ ] 1.1 Pending required
- [ ]* 1.2 Pending optional
- [x] 1.3 Completed required
- [x]* 1.4 Completed optional
- [!] 1.5 Blocked required
- [!]* 1.6 Blocked optional
  - _Blocked: waiting on review_
";
        let document = parse_tasks(text);

        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.state)
                .collect::<Vec<_>>(),
            vec![
                TaskState::Pending,
                TaskState::Pending,
                TaskState::Completed,
                TaskState::Completed,
                TaskState::Blocked,
                TaskState::Blocked,
            ],
            "only the checkbox character decides the state"
        );
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.optional)
                .collect::<Vec<_>>(),
            vec![false, true, false, true, false, true],
            "the optional marker survives in every state"
        );
        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.blocked_reason.as_deref())
                .collect::<Vec<_>>(),
            vec![None, None, None, None, None, Some("waiting on review")],
            "only the blocked entry reports a reason"
        );
    }

    #[test]
    fn ignores_a_blocked_bullet_on_non_blocked_entries() {
        let text = "\
- [ ] 1. Pending
  - _Blocked: stale note_
- [x] 2. Completed
  - _Blocked: another stale note_
- [!] 3. Blocked
  - _Blocked: real reason_
";
        let document = parse_tasks(text);

        assert_eq!(
            document
                .entries()
                .iter()
                .map(|entry| entry.blocked_reason.as_deref())
                .collect::<Vec<_>>(),
            vec![None, None, Some("real reason")],
            "state comes from the checkbox, not from a `_Blocked:` bullet"
        );
    }

    #[test]
    fn counts_every_state_and_the_optional_pending_subset() {
        let text = "\
- [ ] 1. Group
- [ ]* 1.1 Optional pending
- [x] 1.2 Completed
- [x]* 1.3 Optional completed
- [!] 1.4 Blocked
- [!]* 1.5 Optional blocked
- [ ]* 2. Optional pending major
";
        let document = parse_tasks(text);
        let counts = document.counts();

        assert_eq!(counts.total, 7);
        assert_eq!(
            counts.pending, 3,
            "grouping and optional pending entries are pending"
        );
        assert_eq!(counts.completed, 2);
        assert_eq!(counts.blocked, 2);
        assert_eq!(
            counts.completed + counts.pending + counts.blocked,
            counts.total,
            "state counts must sum to the total"
        );
        assert_eq!(
            counts.optional_pending, 2,
            "only pending optional entries count as optional pending"
        );
    }

    #[test]
    fn an_empty_document_counts_nothing_and_selects_nothing() {
        let document = parse_tasks("# Implementation Plan\n");

        assert_eq!(
            document.counts(),
            TaskCounts {
                total: 0,
                completed: 0,
                pending: 0,
                blocked: 0,
                optional_pending: 0,
            }
        );
        assert!(document.next_actionable().is_none());
        assert!(document.find_unique("1").is_err());
    }

    #[test]
    fn next_actionable_is_the_first_pending_childless_entry() {
        let text = "\
- [ ] 1. Group
- [x] 1.1 Completed child
- [ ] 1.2 Next child
- [ ] 2. Separate major
";
        let document = parse_tasks(text);
        let next = document
            .next_actionable()
            .expect("a childless pending entry exists");

        assert_eq!(
            next.id.text, "1.2",
            "grouping entries are skipped in document order"
        );
    }

    #[test]
    fn next_actionable_reports_a_blocked_entry_with_its_reason() {
        let text = "\
- [x] 1. Completed
- [!] 2. Blocked work
  - _Blocked: needs credentials_
- [ ] 3. Later work
";
        let document = parse_tasks(text);
        let next = document
            .next_actionable()
            .expect("the blocked entry is not completed");

        assert_eq!(next.id.text, "2");
        assert_eq!(next.state, TaskState::Blocked);
        assert_eq!(next.blocked_reason.as_deref(), Some("needs credentials"));
    }

    #[test]
    fn next_actionable_leaves_unchecked_groupings_unselected() {
        let text = "\
- [ ] 1. Group
- [x] 1.1 Done child
- [x]* 1.2 Done optional child
- [x] 2. Done major
";
        let document = parse_tasks(text);

        assert!(
            document.next_actionable().is_none(),
            "an unchecked grouping with no unfinished child is never selected"
        );
    }

    #[test]
    fn next_actionable_treats_majors_without_subtasks_as_actionable() {
        let text = "\
- [ ] 1. First major
- [ ] 2. Second major
";
        let document = parse_tasks(text);

        assert_eq!(
            document
                .next_actionable()
                .map(|entry| entry.id.text.as_str()),
            Some("1")
        );
    }

    #[test]
    fn find_unique_resolves_canonical_ids_and_one_trailing_dot() {
        let document = parse_tasks(BASIC);

        for (query, expected) in [
            ("1", "1"),
            ("1.2", "1.2"),
            ("2", "2"),
            ("1.", "1"),
            ("1.2.", "1.2"),
        ] {
            let entry = document
                .find_unique(query)
                .unwrap_or_else(|error| panic!("{query} must resolve: {error}"));
            assert_eq!(entry.id.text, expected, "query {query}");
        }
    }

    #[test]
    fn find_unique_refuses_malformed_identifiers() {
        let document = parse_tasks(BASIC);

        for query in [
            "", ".", "..", "1..2", ".1", "1.2.3", "x", "1.x", " 1", "1 ", "-1", "01", "1.02",
        ] {
            let error = document
                .find_unique(query)
                .expect_err(&format!("{query:?} is not a canonical identifier"));
            assert_eq!(error.category(), ErrorCategory::Conflict, "{query:?}");
            assert_eq!(error.category().exit_code(), 1, "{query:?}");
            assert_eq!(error.context(), query, "{query:?}");
        }
    }

    #[test]
    fn find_unique_names_an_unknown_identifier() {
        let document = parse_tasks(BASIC);

        for query in ["9", "1.9"] {
            let error = document
                .find_unique(query)
                .expect_err(&format!("{query:?} matches no entry"));
            assert_eq!(error.category(), ErrorCategory::Conflict, "{query:?}");
            assert_eq!(error.context(), query, "{query:?}");
            assert!(
                error.detail().contains("no task"),
                "{query:?}: {:?}",
                error.detail()
            );
        }
    }

    #[test]
    fn find_unique_refuses_ambiguous_identifiers() {
        let text = "\
- [ ] 1. First
- [x] 1. Duplicate major
- [ ] 1.1 Child
- [x] 1.1 Duplicate child
- [ ] 2. Unique
";
        let document = parse_tasks(text);

        for query in ["1", "1.1"] {
            let error = document
                .find_unique(query)
                .expect_err(&format!("{query} matches more than one entry"));
            assert_eq!(error.category(), ErrorCategory::Conflict, "{query}");
            assert_eq!(error.category().exit_code(), 1, "{query}");
            assert_eq!(error.context(), query);
            assert!(
                error.detail().contains("more than one"),
                "{query}: {:?}",
                error.detail()
            );
        }
        assert_eq!(
            document
                .find_unique("2")
                .expect("identifier is unique")
                .id
                .text,
            "2"
        );
    }
}
