#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
TOPIC="$(echo "$INPUT" | jq -r '.topic // empty')"

[[ -z "$TOPIC" ]] && { echo "missing: topic" >&2; exit 2; }

# Return a structured teaching plan. The agent (Opus) is responsible for
# actually doing the research via web_search and producing the lesson.
# Keeping this skill logic-free means no external deps, no timeout risk,
# and no drift between what the plan says and what the agent does.
jq -n --arg t "$TOPIC" '{
  topic: $t,
  plan: [
    "Step 1: Call web_search with a specific query about \($t). Use 1-3 searches if the topic has multiple facets. Prefer authoritative primary sources.",
    "Step 2: Synthesize (do NOT copy-paste). Cross-check facts across sources when they conflict.",
    "Step 3: Write ONE markdown lesson with these exact H2 sections in order: 核心概念 / 关键机制 / 类比 / 常见误区 / 一个练习题 / 参考来源.",
    "Step 4: 参考来源 must list each source as `- [标题](URL)`. No naked URLs.",
    "Step 5: 一个练习题 must be answerable with the material you just covered. Include a one-line hint, NOT the answer."
  ],
  style: {
    length: "Aim for 400-800 words total. Cut ruthlessly.",
    language: "Chinese with English technical terms. No filler openers like '\''这是一个非常有趣的话题'\''.",
    hierarchy: "One H1 with the topic. H2 for each section. No H3 unless truly needed."
  }
}'
