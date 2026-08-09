# Scout — Run Evals and Improve

**Task:** run Scout's eval suite, fix every in-scope failure, flag what isn't, stop when all tiers are green.

Skim [CLAUDE.md](../CLAUDE.md) for Scout's shape and [EVALS.md](EVALS.md) for eval structure before starting.

## Setup

```bash
docker compose up -d scout-db          # PostgreSQL must be up — even for wiring
source .venv/bin/activate
set -a && source .env && set +a        # or: direnv allow .
./scripts/validate.sh                  # ruff + mypy must pass first
```

The CRM provider opens a DB connection at module import, so every eval tier (including wiring) needs the DB running.

Case IDs: `python -m evals` lists them as it runs, or `grep 'id="' evals/cases.py`.

## The suite

| Tier | Command | Speed | LLM? |
|---|---|---|---|
| Wiring | `python -m evals wiring` | <1s | No |
| Behavioral | `python -m evals` | ~3min | Yes |
| Judges | `python -m evals judges` | ~1min/case | Yes |

Run wiring first — it catches structural regressions fastest. `--case <id>` narrows to one; `--verbose` shows response + tools.

## Loop

1. Run each tier. Note every FAIL / ERROR.
2. Re-run failures with `--case <id> --verbose`.
3. Diagnose one of three:
   - **Agent bug** → fix instructions in `scout/instructions.py` (Scout's top-level prompt + tuned CRM prompts) or override `_build_agent()` in a `ContextProvider` subclass (shipped providers live in `agno.context.<kind>.provider`).
   - **Stale assertion** → edit the case; commit note explains why.
   - **Runner bug** (a whole class of cases fails with the same error) → fix `evals/runner.py` or `evals/wiring.py`.
4. Confirm green. Commit. One fix per commit.

**Rule:** never patch an assertion just to green it. Fix the case only when it's narrower than true intent.

## Diagnosis cheatsheet

| Signal | Diagnosis | Fix |
|---|---|---|
| Regex uses `'` (U+0027), response used `'` (U+2019) | Case too narrow | Broaden to accept both |
| Case expects `"saved"`, agent says `"stored"` | Case too narrow | Regex `(saved\|stored\|inserted\|added)` |
| Scout refuses when a tool-call is expected | Prompt stacks safety triggers | Strip loaded phrases ("API keys", "just do it") |
| `expected_tools=("query_web",)` but run used `web_search` | Case stub-shaped | Use substring `("web",)` |
| `Async function X can't be used with synchronous agent.run()` across many cases | Runner regressed to sync | Ensure `_run_in_process` uses `asyncio.run(scout.arun(...))` |
| Read-only agent got a writer tool | Code wrong | Fix `tools=` in `scout/agent.py` (Scout) or in `agno.context.<kind>.provider` (provider sub-agents) |

## Out of scope — flag, don't fix

Adding new providers, changing `ContextProvider`, changing Scout's tool surface, dropping cases to turn green.

**Flagging:** append to `tmp/flagged.md` with `## <case_id>` + symptom + why out-of-scope. Move on; don't get stuck. Exit non-zero if `tmp/flagged.md` gained entries this run.

## Stop criteria

- All three tiers green → done.
- 3 failed fix attempts on one case → flag, move on.
- Out-of-scope change needed → flag, move on.

## Commit

`<type>(<scope>): <summary>` — types: `fix(<agent|team|context>)`, `eval(cases|judges|wiring)`, `refactor(evals)`. Add `Co-Authored-By:` if you're an LLM. Never push.

## When done

1. `./scripts/validate.sh` exits 0.
2. `python -m evals wiring` — all PASS.
3. `python -m evals` — all PASS.
4. `python -m evals judges` — all PASS (or flagged as flaky with ≥ 2 samples).

Summarize: commits landed, cases rewritten vs. code changed, flagged issues, anything surprising.
