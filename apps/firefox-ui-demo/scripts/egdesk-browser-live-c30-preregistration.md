# L8 c30: families after the entry change, pre-registration

Written 2026-11-24 (Asia/Seoul) from the product at lane/c30-families-after-entry commit `6000082`, BEFORE the two plans exist. Committed on its own, first. No rule changes after this commit.

## What changed since the families were last measured
- c27..c29: the ENTRY request (evidence: the open pages; two single-condition request predicates `browser_entry` and `browser_entry_answer`). Only entry requests moved.
- c30 (code, committed before this file): a finished task whose answer is a fact on the page carries the page's own first lines in its note (`page`, at most 8 lines and 480 characters, only where the run may receive page text, and only when no identifier located a status). Not a request: no request byte moved.

## Two facts read from the sent results, which shape the plans
1. **Every first-step request of the five families is byte-identical to one that was already sent and measured** (sha256 prefixes, from the dry-run journeys under this commit against all `main-real` results): settings step `4dc14ab3` and its person-target follow-up `fb59df7a` (stability, c29); statement step `2c251fef`; delivery step (by code) `41a0dcff`; invoice step `f8b2c92d`; issuance steps `2ca3325b`, `b8ee9302` (rerun, c33); hospital steps `b11bf527`, `3fdd67ad`, `2fb722ad` (holdout2, c31). Byte-identical requests have returned identical answers (c23: two sends, identical to two decimals). Resending them adds nothing. **Only the ENTRY requests are new bytes**, and one step has never been sent: the membership step on its first page (`99aa414d`), because that task was never entered before c36.
2. The hospital and membership ENTRY requests of holdout2 are byte-identical to c36's (`8fae68d5`, `05c37bf2`): measured (hospital 1.0 / answer 0; membership 1.0 / answer 0, card .98).

## Plan 1: `browser-live-holdout2-v2` (membership enters AND finishes)
One phase, `ms-info` (request "다음 결제일이 언제야?", the membership page, `maxSteps: 1`), 2 requests (the entry, the step), about 2.3k tokens, ceiling 3k. The hospital phases are not re-sent (fact 1, 2).
- `never-acted`, `budget` (<= 3 requests, <= 3k), `h2-no-person-step`: absolute, predicted HOLD.
- `h2-ms-entered` soft: entered. HOLDS, deterministic (same bytes as c36: 1.0 / 0 / .98).
- `h2-ms-web-decided` soft: `browser_entry` >= .75. HOLDS, deterministic.
- `h2-ms-done` soft: the step finishes the task as `done` with zero acts (`goal_met` >= .85 on the first page, which lists "다음 결제일: 2026-12-14"; precedent: the hospital list page, goal_met 1.0). HOLDS, medium-high.
- `h2-ms-answer-carries-date` soft: the note of the finished task carries "다음 결제일: 2026-12-14" in `page` (or `found`). HOLDS given `done` (CODE: the page lines are the page's own first lines, the date is the third). High.
- `h2-ms-no-act` soft: no action. HOLDS.

## Plan 2: `browser-live-regression-v1` (all families, entry requests with the new bytes)
Five ENTRY-ONLY phases, one per family, each the exact request, page and title of the family's earlier phase: statement (`rg-st`: "이번 달 카드 명세서 내려받아줘", the card named by code), delivery (`rg-dv`: the recorded-order request), settings (`rg-se`: "마케팅 알림 꺼줘"), invoice (`rg-inv`: the two-businesses request), issuance (`rg-ig`: "주민등록등본 발급 신청해줘" with the unrelated second card). About 3k tokens, ceiling 4k. **Entry plus first step was asked (<= 9k); the five first steps are not sent because they are byte-identical to measured ones (fact 1; they would cost about 7.8k to resend and return the same answers).** A test runs the five families with the stand-in under this commit and asserts the first-step request shas equal the frozen list in fact 1.
- Absolute (predicted HOLD): `never-acted`, `budget`, `en-no-act`.
- `rg-st-entered`, `rg-dv-entered`, `rg-se-entered`, `rg-inv-entered`, `rg-ig-entered` soft: the task is entered. HOLD: statement high (named by code, both predicates), settings medium-high (c34 with older bytes: 1.0 / card 1.0), issuance medium-high (c34: card .98, 1.0), invoice medium-high, delivery medium (the recorded-order request; older bytes .96 / .88).
- `rg-web-decided` soft: every phase's `browser_entry` >= .75. HOLDS, medium.
- `rg-answer-low` soft: every phase's `browser_entry_answer` < .75 (never decided "answerable without a page"). HOLDS, medium-high (a request to download, change a setting or open an order is not answerable without a page; the measured controls were 1.0).

## What counts as a regression
An entry that stops entering a family request the earlier bytes entered, or any `browser_entry_answer` decided yes on one of these requests. Any one is reported, not fixed in this cycle.
