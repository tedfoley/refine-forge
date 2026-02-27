# Forge — Deep AI Writing Analysis

A multi-agent AI tool that performs deep, reviewer-grade analysis on essays, blog posts, and analytical papers. Inspired by [Refine.ink](https://www.refine.ink/) and the [ICLR 2025 Review Feedback Agent](https://arxiv.org/abs/2504.09737) architecture.

**Live:** [tedfoley.github.io/refine-forge](https://tedfoley.github.io/refine-forge/)

## How It Works

Forge runs a 3-phase pipeline using Claude:

### Phase 1: Parallel Specialist Analysis (6-7 agents)
All run simultaneously, each examining the full document through a different lens:

| Agent | Focus | Web Search | Sub-Agents |
|-------|-------|:----------:|:----------:|
| Argument Logic & Reasoning | Logical fallacies, non-sequiturs, circular reasoning, unstated assumptions, internal contradictions | | |
| Evidence & Claims Auditor | Unsupported claims, citation quality, evidence-conclusion alignment, outdated information | Yes | Yes |
| Clarity & Precision | Ambiguity, explanatory gaps, confusing passages, imprecise key claims | | |
| Math & Empirical Verifier | Arithmetic errors, statistical reasoning, data interpretation, methodological issues | Opt-in | |
| Structure & Flow | Document architecture, paragraph flow, pacing, redundancy, reader experience | | |
| Steelman & Counterargument | Strongest objections, weak steelmanning, missing perspectives, intellectual humility gaps | Yes | Yes |
| Grammar & Mechanics* | Grammar, spelling, punctuation, mechanical correctness (Haiku) | | |

*Grammar agent is optional and bypasses the aggregator/critic pipeline.

All agents receive a shared preamble calibrated to the selected **document type** (essay, blog post, academic paper, report, or other). Each agent has its own detailed specialist prompt, and agents with web search or sub-agent capabilities receive per-agent addendums describing how to use those tools effectively.

### Phase 2: Aggregation
Merges overlapping feedback, deduplicates, and synthesizes cross-agent evidence into unified feedback items. Prioritizes high-value merges where multiple agents found related information about the same underlying issue from different angles.

### Phase 3: Quality Filtering
Ruthlessly filters the aggregated list — removes nitpicky, subjective, wrong, redundant, or out-of-scope feedback. Only specific, actionable comments that are worth the author's time survive.

## Features

- **Persistent analysis history** — past analyses are saved to localStorage and listed in the input view; click any previous session to reload its full results with highlights and resolutions intact
- **Document type selector** — choose essay, blog post, academic paper, report, or other to calibrate agent expectations
- **Bidirectional navigation** — click highlighted text to jump to feedback; click a quote in feedback to jump to the passage
- **Category & severity filtering** — filter by type (Argument, Evidence, Clarity, etc.) and severity (Critical, Important, Suggestion)
- **Sort by relevance or position** — switch between severity-first ordering and document-position ordering
- **Accept/dismiss feedback** — triage each item as accepted or dismissed; state persists across sessions
- **Web search** — Evidence and Steelman agents verify claims against the live web (opt-in for Math agent)
- **Deep research mode** — agents can spawn sub-agents for thorough multi-source verification
- **Extended thinking** — enable reasoning models for deeper analysis (adds `thinking` with 10K token budget to Agents 1-6, Aggregator, and Critic)
- **Grammar check** — optional 7th agent (Haiku) for grammar, spelling, and punctuation
- **Select all** — one toggle to enable every analysis option at once
- **Model picker** — choose between Sonnet 4, Opus 4.6, Sonnet 4.6, or Haiku 4.5
- **Pre-analysis options** — toggle web search, deep research, grammar, math web search, and extended thinking before analyzing
- **Cost estimation** — estimated cost range shown based on selected options
- **Markdown support** — paste Markdown and it renders properly in the text panel
- **Export** — download feedback as a `.md` file or copy to clipboard
- **Cloudflare Worker proxy** — API key stays server-side, never touches the browser

## Setup

### Quick Start (Direct API Key)
1. Open the [live site](https://tedfoley.github.io/refine-forge/)
2. Switch to "Direct API Key" mode
3. Enter your Anthropic API key
4. Paste your text and click Analyze

### Recommended (Cloudflare Worker Proxy)
Your API key stays on the server and is never sent to the browser.

1. Create a [Cloudflare account](https://dash.cloudflare.com) (free)
2. Go to **Workers** → **Create Worker**
3. Paste the contents of [`worker.js`](worker.js) and deploy
4. Add your Anthropic API key as an encrypted secret named `ANTHROPIC_API_KEY`
5. Enter your Worker URL in the app (e.g. `https://forge-proxy.your-name.workers.dev`)

## Tech Stack

- React 18 (via CDN, no build step)
- Tailwind CSS (via CDN)
- Babel Standalone (in-browser JSX)
- Marked.js (Markdown rendering)
- Anthropic Messages API (Claude Sonnet 4 default, with Haiku 4.5 for grammar)
- Anthropic Web Search Tool (`web_search_20250305`)
- Extended Thinking API support
- Hosted on GitHub Pages as static files

## File Structure

```
├── index.html      # Entry point, loads all dependencies
├── agents.js       # Agent prompts, API calls, pipeline logic
├── matching.js     # Fuzzy quote matching & highlight injection
├── app.js          # React application (JSX)
├── styles.css      # Custom styles
├── worker.js       # Cloudflare Worker proxy (deploy separately)
└── .nojekyll       # GitHub Pages config
```

## Cost Estimates

Using Sonnet 4 with default options (web search on):

| Configuration | Estimated Cost |
|--------------|---------------|
| Base (no toggles) | ~$0.15-0.30 |
| With web search | ~$0.20-0.50 |
| With deep research | ~$0.50-2.00 |
| With extended thinking | +~$0.35-1.20 |
| Grammar check add-on | +~$0.02-0.05 |
| All options enabled | ~$1.00-3.50 |

Token usage, web search count, and sub-agent count are displayed in the bottom bar after each analysis.
