# Product improvements

## Included in 1.8.0

- Native private backup and guided restore with integrity checks, a preview, a recovery copy and protection against concurrent writers.
- Item change history for deadlines, priorities, status, explanations and task-selection visibility, recorded from this version onward.
- A searchable command menu with keyboard navigation and focus return.
- Exact-account connection recovery and a setup summary that distinguishes configured sources from successful reads.
- Manual update checks against the official release, with no account data sent.
- Faster initial archive indexing, a repeatable 50,000-message benchmark, and an offline synthetic AI evaluation corpus.

## Included in 1.7.1

- Save draft edits before desktop reload and quit; preserve failed edits across card refreshes.
- Complete desktop shutdown so Zelos can reopen after quitting.
- Reliable repeated Command-F focus and useful external-link failure guidance.
- Chronological month-view appointments and consistent sample clash descriptions.

## Included in 1.7.0

- Task activity reconciliation after complete Todoist and Linear selections, with searchable history and clear historical labels.
- Persistent source health with last attempt, last successful read, and recovery guidance.
- A consistent tagged release: four desktop installers, source archive, checksums, and a matching website demo.
- Setup retry feedback, accessible Restore/Reopen actions, and custom snooze validation.
- Reliable draft autosave/discard, source-change reassessment, and interrupted-answer notices.
- Honest board-snapshot naming and full-folder backup guidance.

## Next product work

1. **Publisher signing and provider registrations.** Register the application with Apple/Microsoft and configure signing credentials; complete provider reviews before advertising a warning-free install or shared OAuth sign-in. These depend on the publisher's accounts and approvals.
2. **Live provider acceptance.** Exercise real Gmail, Microsoft, iCloud and task-provider accounts through expiry, revocation and reconnect; synthetic connector tests cannot establish provider acceptance.
3. **Live model evaluation.** Run the synthetic assessment cases with the models people use, then review missed work, invented claims and wording alongside the structured results.
4. **Automatic updates.** The updater is built (`desktop/updater.js`, no npm dependencies) and trusts releases signed with the Zelos update key rather than Apple or Microsoft certificates. It switches on once a key is generated and its public half is in `updates.publicKeys` (see RELEASING.md). What remains is generating the key and an end-to-end test across two releases on each platform. Item 1's certificates would still remove first-install warnings, and `updates.windowsPublisher` adds an Authenticode check once a Windows certificate exists.

Automatic sending and cloud synchronization require separate product and permission decisions. Zelos continues to read connected sources and lets the user decide what to do.
