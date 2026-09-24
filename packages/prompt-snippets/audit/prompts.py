#!/usr/bin/env python3
"""Read-only, bounded audit of user prompts and prompt-snippet application events.

Prompt extraction is inspired by Amos Blomqvist's analyze-sessions/prompts.py:
https://github.com/amosblomqvist/pi-config/tree/main/skills/analyze-sessions
"""

import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import sys

USAGE_TYPE = "prompt-snippets:usage"


def timestamp(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (AttributeError, ValueError, TypeError):
        return None


def records(path):
    try:
        with path.open(encoding="utf-8", errors="replace") as stream:
            for line in stream:
                try:
                    item = json.loads(line)
                    if isinstance(item, dict):
                        yield item
                except json.JSONDecodeError:
                    continue
    except OSError as error:
        print(f"Skipping {path}: {error}", file=sys.stderr)


def extract(path, cutoff, cwd, min_chars, max_chars):
    stream = records(path)
    header = next(stream, None)
    if not header or header.get("type") != "session":
        return None
    started = timestamp(header.get("timestamp"))
    if started is None or started < cutoff:
        return None
    project = header.get("cwd", "")
    if not isinstance(project, str) or (cwd and cwd.casefold() not in project.casefold()):
        return None
    prompts, uses = [], []
    for item in stream:
        if item.get("type") == "custom" and item.get("customType") == USAGE_TYPE:
            data = item.get("data")
            if isinstance(data, dict) and isinstance(data.get("snippets"), list):
                for snippet in data["snippets"]:
                    if isinstance(snippet, dict) and isinstance(snippet.get("id"), str):
                        uses.append({"session_id": header.get("id"), "cwd": project,
                                     "timestamp": item.get("timestamp"), "id": snippet["id"],
                                     "source": snippet.get("source")})
            continue
        message = item.get("message")
        if item.get("type") != "message" or not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            text = "\n".join(block["text"] for block in content if isinstance(block, dict)
                             and block.get("type") == "text" and isinstance(block.get("text"), str))
        else:
            continue
        text = text.strip()
        if text.startswith("[prompt-snippets audit request]"):
            continue
        if min_chars <= len(text) <= max_chars:
            prompts.append({"session_id": header.get("id"), "cwd": project,
                            "timestamp": item.get("timestamp") or message.get("timestamp"), "text": text})
    return started, prompts, uses


def count_groups(rows, key):
    groups = defaultdict(lambda: {"appearances": 0, "sessions": set(), "projects": set(), "session_ids": set()})
    for row in rows:
        group = groups[key(row)]
        group["appearances"] += 1
        group["sessions"].add(row["session_id"])
        group["projects"].add(row["cwd"])
        group["session_ids"].add(row["session_id"])
    return groups


def summary(group):
    return {"appearances": group["appearances"], "sessions": len(group["sessions"]),
            "projects": len(group["projects"]), "example_sessions": sorted(group["session_ids"])[:3]}


def candidate_texts(text):
    # Exact repeat baseline for full prompts AND recurring lines inside task prompts.
    # Deduplicate within each prompt so a repeated line counts once per appearance.
    normalized = lambda value: re.sub(r"\s+", " ", value).strip().casefold()
    candidates = {normalized(text)}
    if "\n" in text:
        candidates.update(normalized(line) for line in text.splitlines() if 20 <= len(line.strip()) <= 400)
    return {candidate for candidate in candidates if candidate}


def report(prompts, uses, scanned, max_candidates):
    candidate_rows = [dict(prompt, candidate=text) for prompt in prompts for text in candidate_texts(prompt["text"])]
    candidates = count_groups(candidate_rows, lambda p: p["candidate"])
    repeated = sorted(((text, group) for text, group in candidates.items() if len(group["sessions"]) > 1),
                      key=lambda pair: (-len(pair[1]["sessions"]), -pair[1]["appearances"], pair[0]))
    usage = count_groups(uses, lambda u: u["id"])
    return {
        "scope": {"sessions_scanned": scanned, "prompts_sampled": len(prompts),
                  "usage_events_sampled": len(uses)},
        "repeated_prompts": [{"text": text, **summary(group)} for text, group in repeated[:max_candidates]],
        "snippet_usage": [{"id": id, **summary(group),
                           "sources": sorted({str(u.get("source")) for u in uses if u["id"] == id})}
                          for id, group in sorted(usage.items(), key=lambda pair: (-pair[1]["appearances"], pair[0]))],
        "limits": "Exact whitespace/case-normalized prompts or lines only; semantic variants need review. Usage counts start when tracking was installed and include branch alternatives.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sessions-dir", type=Path, default=Path.home() / ".pi/agent/sessions")
    parser.add_argument("--since-days", type=int, default=30)
    parser.add_argument("--cwd", help="Case-insensitive substring of the project path")
    parser.add_argument("--max-sessions", type=int, default=30)
    parser.add_argument("--max-prompts", type=int, default=60)
    parser.add_argument("--min-chars", type=int, default=20)
    parser.add_argument("--max-chars", type=int, default=1200)
    parser.add_argument("--max-candidates", type=int, default=20)
    parser.add_argument("--format", choices=["report", "jsonl"], default="report")
    args = parser.parse_args()
    if min(args.since_days, args.max_sessions, args.max_prompts, args.min_chars,
           args.max_chars, args.max_candidates) < 1:
        parser.error("all numeric limits must be positive")
    if args.min_chars > args.max_chars:
        parser.error("--min-chars must not exceed --max-chars")
    if not args.sessions_dir.is_dir():
        parser.error(f"session directory not found: {args.sessions_dir}")

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.since_days)
    # Main sessions live one directory below the sessions root; deeper paths
    # contain subagent transcripts with agent-authored 'user' tasks.
    selected = []
    for path in args.sessions_dir.glob("*/*.jsonl"):
        result = extract(path, cutoff, args.cwd, args.min_chars, args.max_chars)
        if result:
            selected.append(result)
    selected.sort(key=lambda entry: entry[0], reverse=True)
    selected = selected[:args.max_sessions]
    prompts = [p for _, rows, _ in selected for p in rows][:args.max_prompts]
    uses = [u for _, _, rows in selected for u in rows]
    if args.format == "jsonl":
        for prompt in prompts:
            print(json.dumps(prompt, ensure_ascii=False))
    else:
        print(json.dumps(report(prompts, uses, len(selected), args.max_candidates), ensure_ascii=False, indent=2))
    print(f"Scanned {len(selected)} main sessions, sampled {len(prompts)} prompts and {len(uses)} applications "
          f"from sessions started in the last {args.since_days} days.", file=sys.stderr)


if __name__ == "__main__":
    main()
