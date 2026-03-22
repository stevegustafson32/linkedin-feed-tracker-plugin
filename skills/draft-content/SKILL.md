---
name: draft-content
description: >
  Draft LinkedIn posts based on network trends and content gaps. Use this skill when the user says
  "draft me a post," "write a LinkedIn post," "help me post about," "content ideas," "what should
  I post," "draft content," "LinkedIn draft," or any request to create LinkedIn post content
  informed by their network's activity. Also triggers when the user says "ghost write" or
  "write something about [topic]."
version: 1.0.0
---

# Draft LinkedIn Content

Generate LinkedIn post drafts informed by what the user's network is actually talking about.

## Process

### Step 1 — Understand Context

Query the database at `${CLAUDE_PLUGIN_ROOT}/scripts/data/feeds.db` for:
- Recent high-engagement posts in the relevant topic area
- The user's own recent posts (to avoid repetition)
- Current trending themes from the last 7 days

### Step 2 — Draft Strategy

Before writing, determine:
- **Topic**: What the post is about (from user request or identified gap)
- **Angle**: What makes this timely based on network trends
- **Format**: Best format for this content (story, listicle, hot take, question, how-to)
- **Hook**: Opening line that stops the scroll

### Step 3 — Write the Draft

Create 2-3 draft options, each with:
- A compelling hook (first line is everything on LinkedIn)
- Body content that provides value
- A closing CTA or question to drive engagement
- Appropriate length (most high-engagement posts are 150-300 words)

### Step 4 — Explain the Why

For each draft, briefly explain: why this topic now (what data supports it), which format was chosen and why, and what engagement pattern it targets.

## Writing Guidelines

- Match the user's voice (read their recent posts for tone)
- No corporate buzzwords unless the user uses them
- Specific > generic. "I talked to 12 founders this week" beats "Many entrepreneurs agree"
- Line breaks between ideas (LinkedIn formatting)
- No hashtags unless the user requests them
- No emoji unless the user's style includes them
