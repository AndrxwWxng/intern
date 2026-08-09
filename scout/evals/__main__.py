"""Scout evals CLI.

    python -m evals                        # behavioral cases
    python -m evals --case <id>            # single case
    python -m evals --verbose              # show responses + tool previews

    python -m evals wiring                 # structural invariants (no LLM)
    python -m evals judges                 # LLM-scored quality tier
    python -m evals judges --case <id>

Exit 0 if all PASS, non-zero if any FAIL or ERROR.
"""

from __future__ import annotations

import typer
from rich.console import Console

app = typer.Typer(add_completion=False, no_args_is_help=False, pretty_exceptions_show_locals=False)
console = Console()

_STATUS_STYLE = {"PASS": "green", "FAIL": "red", "ERROR": "red"}


def _tag(status: str) -> str:
    style = _STATUS_STYLE.get(status, "")
    return f"[{style}]{status:<7}[/{style}]" if style else f"{status:<7}"


# ---------------------------------------------------------------------------
# Behavioral (default)
# ---------------------------------------------------------------------------


@app.callback(invoke_without_command=True)
def behavioral(
    ctx: typer.Context,
    case: str | None = typer.Option(None, "--case", help="Run only this case id"),
    verbose: bool = typer.Option(False, "--verbose", help="Show response + tool previews"),
) -> None:
    """Behavioral cases (default when no subcommand given)."""
    if ctx.invoked_subcommand is not None:
        return

    from evals.cases import CASES, get
    from evals.runner import CaseResult, run_case

    cases = [get(case)] if case else list(CASES)
    results: list[CaseResult] = []
    for i, c in enumerate(cases, 1):
        console.print(f"\n[bold][{i}/{len(cases)}][/bold] {c.id}  [dim]{c.prompt[:60]!r}[/dim]")
        r = run_case(c)
        _print_case(r, verbose)
        results.append(r)

    _print_summary(results)
    raise typer.Exit(1 if any(r.status in ("FAIL", "ERROR") for r in results) else 0)


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------


@app.command()
def wiring() -> None:
    """Structural invariants — no LLM, runs in under a second."""
    from evals.wiring import run_all

    results = run_all()
    for r in results:
        console.print(f"[{_tag('PASS' if r.passed else 'FAIL')}] {r.id} {r.name}")
        if not r.passed:
            console.print(f"            [red]- {r.detail}[/red]")

    passed = sum(1 for r in results if r.passed)
    failed = len(results) - passed
    _print_bar(f"wiring: {passed} passed, {failed} failed")
    raise typer.Exit(0 if failed == 0 else 1)


# ---------------------------------------------------------------------------
# Judges
# ---------------------------------------------------------------------------


@app.command()
def judges(
    case: str | None = typer.Option(None, "--case", help="Run only this judged case id"),
    verbose: bool = typer.Option(False, "--verbose"),
) -> None:
    """LLM-scored quality tier."""
    from evals.judges import run_all_judged

    results = run_all_judged(case_id=case)
    for r in results:
        score = f" score={r.score}" if r.score is not None else ""
        console.print(f"[{_tag(r.status)}] {r.id:<40} ({r.duration_s:.1f}s){score}")
        if r.reason and r.status != "PASS":
            console.print(f"            [dim]reason:[/dim] {r.reason[:200]}")
        for f in r.failures:
            console.print(f"            [red]- {f}[/red]")
        if verbose and r.response:
            preview = r.response.replace("\n", " ")[:200]
            console.print(f"            [dim]response:[/dim] {preview}")

    passed = sum(1 for r in results if r.status == "PASS")
    failed = sum(1 for r in results if r.status in ("FAIL", "ERROR"))
    _print_bar(f"judges: {passed}/{len(results)} passed, {failed} failed")
    raise typer.Exit(0 if failed == 0 else 1)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _print_case(r, verbose: bool) -> None:
    console.print(f"[{_tag(r.status)}] {r.case_id:<40} ({r.duration_s:.1f}s)")
    for f in r.failures:
        console.print(f"            [red]- {f}[/red]")
    if verbose and r.response:
        preview = r.response.replace("\n", " ")[:200]
        console.print(f"            [dim]response:[/dim] {preview}")
        if r.tool_names:
            console.print(f"            [dim]tools:[/dim] {r.tool_names}")


def _print_summary(results: list) -> None:
    counts = {s: sum(1 for r in results if r.status == s) for s in ("PASS", "FAIL", "ERROR")}
    total_s = round(sum(r.duration_s for r in results), 1)
    _print_bar(
        f"[green]{counts['PASS']} passed[/green], "
        f"[red]{counts['FAIL']} failed[/red], "
        f"[red]{counts['ERROR']} errored[/red]  [dim]({total_s}s)[/dim]"
    )


def _print_bar(line: str) -> None:
    bar = "=" * 60
    console.print(f"\n{bar}\n{line}\n{bar}\n")


if __name__ == "__main__":
    app()
