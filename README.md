# Forge — Deep AI Writing Analysis

A multi-agent AI tool that performs deep, reviewer-grade analysis on essays, blog posts, and analytical papers. Inspired by [Refine.ink](https://www.refine.ink/) and the [ICLR 2025 Review Feedback Agent](https://arxiv.org/abs/2504.09737) architecture.

**Live:** [tedfoley.github.io/refine-forge](https://tedfoley.github.io/refine-forge/)

## How It Works

Forge runs a 3-phase pipeline using Claude:

### Phase 1: Parallel Specialist Analysis (6-7 agents)
All run simultaneously, each examining the full document through a different lens:

| Agent | Focus | Web Search | Sub-Agents |
|-------|-------|:----------:|:----------:|
| Argument Structure | Logical fallacies, non-sequiturs, circular reasoning, unstated assumptions | | |
| Evidence & Claims | Unsupported claims, cherry-picked data, outdated statistics | Yes | Yes |
| Clarity & Exposition | Jargon, readability, unclear passages, missing context | | |
| Math & Empirical | Mathematical errors, statistical inconsistencies, implausible numbers | Opt-in | |
| Structural Coherence | Document flow, redundancy, missing sections, narrative arc | | |
| Steelman & Counter | Strongest objections, alternative explanations, unaddressed counterarguments | Yes | Yes |
| Grammar & Mechanics* | Grammar, spelling, punctuation, mechanical correctness (Haiku) | | |

*Grammar agent is optional and bypasses the aggregator/critic pipeline.

### Phase 2: Aggregation
Merges overlapping feedback, deduplicates, and synthesizes cross-agent evidence into unified feedback items.

### Phase 3: Quality Filtering
Aggressively removes vague, generic, or incorrect feedback. Only specific, actionable comments survive.

## Features

- **Bidirectional navigation** — click highlighted text to jump to feedback; click a quote in feedback to jump to the passage
- **Category & severity filtering** — filter by type (Argument, Evidence, Clarity, etc.) and severity (Critical, Important, Suggestion)
- **Sort by relevance or position** — switch between severity-first ordering and document-position ordering
- **Accept/dismiss feedback** — triage each item as accepted or dismissed; state persists in localStorage
- **Web search** — Evidence and Steelman agents verify claims against the live web (opt-in for Math agent)
- **Deep research mode** — agents can spawn sub-agents for thorough multi-source verification
- **Grammar check** — optional 7th agent (Haiku) for grammar, spelling, and punctuation
- **Model picker** — choose between Sonnet 4.6 (default), Opus 4.6, or Haiku 4.5; uses `-latest` aliases so versions auto-update
- **Pre-analysis options** — toggle web search, deep research, grammar, and math web search before analyzing
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
- Anthropic Messages API (Claude)
- Anthropic Web Search Tool (`web_search_20250305`)
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

Using Sonnet 4.6 with default options (web search on):

| Configuration | Tokens | Estimated Cost |
|--------------|--------|---------------|
| Base (no toggles) | ~50-60K | ~$0.15-0.30 |
| With web search | ~60-80K | ~$0.20-0.50 |
| With deep research | ~80-150K | ~$0.50-2.00 |
| Grammar check add-on | +~5-10K | +~$0.02-0.05 |

Token usage, web search count, and sub-agent count are displayed in the bottom bar after each analysis.
