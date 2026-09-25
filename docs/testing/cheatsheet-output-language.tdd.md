# Cheatsheet output language — TDD evidence

## Behaviour

- `zh-CN` makes both the per-source digest and final cheatsheet request Chinese explanations.
- PTE, IPA, English spelling/pronunciation examples, code, formulas, and proper names stay intact.
- Canonical top-level section names stay in English so existing composition and UI localization continue to work.
- English and missing language settings keep English output.

## Red

`cargo test cheatsheet_language_tests` failed to compile because
`cheatsheet_language_instruction` did not exist. This demonstrated that the
generation pipeline had no language policy derived from the saved setting.

## Green

`cargo test cheatsheet_language_tests`

Result: 2 passed, 0 failed. The assertions cover the Chinese policy, preserved
learning terms, canonical section-name contract, and English/default policy.

## Coverage note

The language selector's Chinese and default branches are both exercised. This
targeted test does not call a live model, so provider adherence still depends on
the selected model following its system prompt.
