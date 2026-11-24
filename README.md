# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Xipli69/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Xipli69/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write, in all four formats they write them in: unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls. It finds the lines an edit names at the first of three matching tiers — exact, trailing-whitespace drift, then indentation drift with re-indenting — and writes every change or none, printing what changed or why each edit failed. Files keep their own line breaks (LF or CRLF) and their final-newline state; created files are written with LF.

## Run it

```sh
node main.ts [--format=unified|search-replace|v4a|json|auto] [--check] [--strict] [PATCH]
```

With no `PATCH` (or `-`) the patch is read from standard input. `--check` reports what would change without writing; `--strict` matches lines exactly only. Node 22, standard library alone.

Entry for the [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty on make.fun.

---

<sub>Entered on [make.fun](https://make.fun/?ref=p1xmxtz0&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
