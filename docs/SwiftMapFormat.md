# SwiftMap File Format

This document specifies the `.swiftmap` text format used to store SwiftMap mind maps.

## Overview

A `.swiftmap` file is a UTF-8 plain text file containing one tree. Each non-empty line represents one node. The line indentation defines parent-child relationships.

A document has exactly one root node. The root is the first non-empty line and must not be indented.

## Canonical Form

SwiftMap writes files in canonical form:

- Line endings may be LF (`\n`) or CRLF (`\r\n`).
- Each node is written on one line.
- Each child level is indented by two spaces.
- Empty lines are omitted.
- Flags are emitted in this order: `Done`, `Rejected`, `Question`, `Task`, `Idea`, `Low priority`, `Medium priority`, `High priority`.
- Node names are trimmed and cannot contain line breaks.
- The file does not require a trailing newline.

## Line Structure

Each node line has this structure:

```text
INDENT STATUS SPACE FLAGS [SPACE NAME]
```

Where:

- `INDENT` is zero or more indentation characters. In canonical form this is two spaces per depth level.
- `STATUS` is `+` for expanded or `-` for collapsed.
- `FLAGS` is a square-bracketed comma-separated list of zero or more flags.
- `NAME` is optional single-line text after the flags token.

Examples:

```text
+ [] Root
  + [Done] Finished task
  - [Rejected,Question,Task] Needs review
```

## Canonical Grammar

This grammar describes the canonical serialized form.

```ebnf
document    = node-line { line-break node-line } [ line-break ] ;
node-line   = indent status space flags [ space name ] ;
indent      = { "  " } ;
status      = "+" | "-" ;
flags       = "[" [ flag-list ] "]" ;
flag-list   = flag { "," flag } ;
flag        = "Done" | "Rejected" | "Question" | "Task" | "Idea" | "Low priority" | "Medium priority" | "High priority" ;
name        = { name-character } ;
line-break  = "\n" | "\r\n" ;
space       = " " ;
```

`name-character` is any Unicode scalar value except carriage return (`\r`) or line feed (`\n`). Implementations should trim leading and trailing whitespace from node names when reading or writing. A document should use one line ending style consistently.

## Tree Construction

The tree is constructed by processing non-empty lines from top to bottom:

1. The first non-empty line creates the root node and must have depth `0`.
2. A later line becomes a child of the nearest preceding line with a lower indentation depth.
3. Sibling order is the same as line order.
4. In canonical form, a line can increase depth by at most one level relative to the preceding non-empty line.

Canonical depth is computed as the number of leading spaces divided by two. A canonical file must not use odd numbers of leading spaces.

## Flags

The supported flags are:

| Flag | Meaning |
| --- | --- |
| `Done` | Completed item |
| `Rejected` | Rejected or discarded item |
| `Question` | Item requiring a decision |
| `Task` | Actionable task |
| `Idea` | Idea or proposal |
| `Low priority` | Low-priority item |
| `Medium priority` | Medium-priority item |
| `High priority` | High-priority item |

Flag lists must follow these rules:

- Use `[]` for no flags.
- Do not include spaces around commas inside the brackets.
- Do not repeat a flag.
- Write flags in this exact order: `Done`, `Rejected`, `Question`, `Task`, `Idea`, `Low priority`, `Medium priority`, `High priority`.

Valid examples:

```text
[]
[Done]
[Done,Task]
[Done,Rejected,Question,Task,Idea,Low priority,Medium priority,High priority]
```

Invalid examples:

```text
[Idea,Done]
[High priority,Task]
[Done, Done]
[Done,Done]
[Unknown]
```

## Names

Node names are plain text:

- Names are single-line.
- Names have no inline formatting syntax.
- Leading and trailing whitespace is ignored.
- Empty names are valid.

Because every node line starts with `STATUS FLAGS`, a name may contain characters that look like flags, punctuation, or additional spaces after the first name character.

## Reader Compatibility

The current SwiftMap extension reader accepts a small superset of the canonical form:

- Empty files are treated as a single expanded root node named `Root`.
- Blank lines are ignored.
- Tabs in indentation are treated as two spaces.
- Child indentation is based on relative indentation width, so non-canonical indentation may still parse if each child line is more indented than its parent line.
- Empty node names may be written either as `+ []` or with a trailing separator space as `+ [] `.

Writers should still emit canonical form.

## Complete Example

```text
+ [] Project Planning
  + [Done] Scope
    + [Done] Identify goals
    + [Done,Task,Idea] Define success metrics
  + [Idea] Discovery
    + [] Interview users
  - [Rejected] Deprecated Ideas
    + [Rejected] Build custom sync engine
  + [Task,High priority] Delivery
```
