---
type: playbook
title: Organize
description: Survey the vault, propose a structure, move notes, index them, and record the rules
---
# Organize

Tidy the vault's notes and docs. Use the marq tools: list_notes to see the vault, search_notes and read_note to understand notes, create_folder and move_note to reorganize (move_note keeps relative links working). Leave sessions/ alone. Use the glossary's preferred terms for tags. Never delete a note; if one looks like a duplicate or is stale, report it instead.

## survey

Do not move anything yet. Read the vault's outline and a sample of notes in each area. Find notes that are in the wrong place or have no folder, duplicates and near-duplicates, inconsistent names, and notes with no tags or no links.

End your reply with the current structure in a few lines and the problems found, each with the notes it concerns.

## propose

Do not move anything yet. From the survey, propose the target structure: the folders to create and, for each move, from and to. Keep the change small: fix what is clearly wrong and leave the rest. Prefer existing folders and names over new ones.

End your reply with the list of moves and new folders, and anything you chose to leave alone and why.

## move

Make the moves from the proposal with create_folder and move_note, in small batches. Do not add moves that were not proposed. Do not index or tag yet.

End your reply with what moved and anything that did not go as proposed.

## index

Make the vault easy to find in. Do not move anything now.

- For each folder you touched, write an `index.md` (type: note, with a few tags) that lists the notes in it as `[[Title]]` with a one-line description each. Keep an existing index.md's own text and update only its list.
- Add `tags:` and `aliases:` to notes that lack them, in their frontmatter, using the glossary's preferred terms. Do not change a note's body. If a useful term is missing from glossary.md, add it there with its aliases.
- Use note_links to find orphans: notes nothing links to. Link each from the index of its folder or from the most related note, as `[[Title]]`. Report the ones you could not place.

End your reply with the indexes written, the notes tagged, the glossary terms added, and the orphans and what you did with them.

## verify

Check the result: run list_notes again, and use note_links on the moved notes to confirm nothing that linked to them is left broken. Fix any broken link you find.

Last, record the rules you settled on (where each kind of note goes, how notes are named, which tags and glossary terms to use) with append_learning, so later sessions follow them.

End your reply with the new structure, what you fixed, and the rules you recorded.
