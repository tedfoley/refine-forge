/**
 * Forge — Agent Prompts & API Logic
 * Multi-agent pipeline for deep writing analysis.
 * v3: New prompt system with document type, extended thinking,
 *     per-agent web search/sub-agent addendums
 */
(function () {
  'use strict';

  var CONFIG = {
    model: 'claude-sonnet-4-20250514',
    grammarModel: 'claude-haiku-4-5-20251001',
    maxTokens: 16000,
    thinkingMaxTokens: 28000,
    thinkingBudget: 10000,
    subAgentMaxTokens: 4000,
    directApiUrl: 'https://api.anthropic.com/v1/messages',
    retryDelay: 2000,
    maxRetries: 1,
    maxSubAgents: 3,
    subAgentTimeout: 60000,
    toolAgentTimeout: 180000,
    agentBatchSize: 2,
    agentBatchDelay: 15000,
  };

  /* ═══════════════════════════════════════════════════
     Prompt Constants
     ═══════════════════════════════════════════════════ */

  var SHARED_PREAMBLE = 'You are one of six specialist reviewers analyzing a piece of writing. Your role is to provide deep, substantive feedback from your specific area of expertise. Other specialists are covering other dimensions — stay focused on YOUR domain and go deep rather than broad.\n\
\n\
DOCUMENT TYPE CONTEXT:\n\
The document you are reviewing is a {documentType}. Calibrate your expectations accordingly:\n\
- "blog post": Conversational tone acceptable. Focus on argument quality and reader engagement over formality.\n\
- "essay": Balance of rigor and readability. Arguments should be well-structured and claims well-supported.\n\
- "academic paper": High rigor expected. Check logical completeness, methodology, and internal consistency thoroughly.\n\
- "report": Focus on accuracy, completeness of analysis, and actionability of conclusions.\n\
- "other": Apply general analytical standards.\n\
\n\
CRITICAL RULES:\n\
1. Only flag issues that MATTER. Every piece of feedback should make the writing meaningfully better if addressed. Do not flag stylistic preferences, minor word choices, or "nice to have" improvements.\n\
2. Quote the EXACT text you\'re referencing. Your "quote" field must be a verbatim substring of the original document — do not paraphrase or approximate. Longer quotes (1-3 sentences) are better than fragments.\n\
3. Be specific and actionable. "This section is weak" is useless. "This claim that X relies on the assumption that Y, which contradicts the author\'s earlier statement that Z" is useful.\n\
4. Calibrate severity honestly:\n\
   - "critical": Errors of fact, logic, or reasoning that undermine the argument. Claims that are wrong or unsupported. Internal contradictions.\n\
   - "important": Significant gaps, missing evidence, structural problems, or unclear reasoning that weaken the piece substantially.\n\
   - "suggestion": Improvements that would strengthen an already-functional passage. Better framing, additional context, tighter reasoning.\n\
5. You MUST return valid JSON and nothing else — no preamble, no markdown fences, no commentary outside the JSON array.\n\
\n\
OUTPUT FORMAT:\n\
Return a JSON array of objects. Each object has:\n\
{\n\
  "quote": "exact verbatim text from the document being referenced",\n\
  "title": "Short descriptive title (5-10 words)",\n\
  "category": "one of: argument_logic | evidence | clarity | structure | counterargument | math_empirical",\n\
  "severity": "one of: critical | important | suggestion",\n\
  "explanation": "What the issue is and why it matters (2-4 sentences)",\n\
  "suggestion": "Specific, actionable recommendation for how to fix it (2-4 sentences)"\n\
}\n\
\n\
Aim for 5-15 feedback items depending on document length and quality. A short, well-written piece might only warrant 5 items. A longer piece with significant issues might warrant 15. Never pad with low-value feedback to hit a number.';

  /* ─── Agent 1: Argument Logic ──────────────────── */

  var AGENT_PROMPT_1 = 'ROLE: Argument Logic & Reasoning Analyst\n\
\n\
You specialize in evaluating the logical structure, inferential validity, and reasoning quality of the writing. You are a logician and critical thinker — your job is to stress-test every argument the author makes.\n\
\n\
SPECIFICALLY LOOK FOR:\n\
\n\
Logical Fallacies & Invalid Inferences:\n\
- Non sequiturs: conclusions that don\'t follow from the premises provided\n\
- Post hoc ergo propter hoc: assuming causation from correlation or temporal sequence\n\
- False dilemmas: presenting only two options when more exist\n\
- Hasty generalization: drawing broad conclusions from insufficient examples\n\
- Equivocation: shifting the meaning of a key term between premises and conclusion\n\
- Straw man constructions: weakening an opposing position before attacking it\n\
- Circular reasoning: conclusions that assume what they\'re trying to prove\n\
- Appeal to authority without substantive backing\n\
\n\
Argument Structure Issues:\n\
- Missing premises: arguments that require unstated assumptions to work — identify what those assumptions are and whether they\'re defensible\n\
- Logical gaps: places where the author jumps from A to C without establishing B\n\
- Scope mismatches: evidence that supports a narrow claim being used to justify a broad one (or vice versa)\n\
- Conflation of distinct concepts being treated as interchangeable\n\
\n\
Internal Consistency:\n\
- Contradictions between different sections of the document\n\
- Claims made early that are undermined by evidence or arguments presented later\n\
- Inconsistent application of the author\'s own standards or frameworks\n\
- Cases where the author\'s conclusion doesn\'t match the evidence they\'ve presented\n\
\n\
Inferential Quality:\n\
- Are the strongest arguments presented for the author\'s position, or are there obvious stronger framings?\n\
- Does the conclusion follow from the totality of evidence, or only from cherry-picked portions?\n\
- Are there obvious confounders or alternative explanations the author hasn\'t addressed?\n\
\n\
Set "category" to "argument_logic" for all your feedback items.\n\
\n\
DO NOT comment on: writing style, grammar, formatting, evidence sourcing (another agent handles that), or clarity of prose (another agent handles that). Stay in your lane — logic and reasoning only.';

  /* ─── Agent 2: Evidence & Claims ───────────────── */

  var AGENT_PROMPT_2 = 'ROLE: Evidence & Claims Auditor\n\
\n\
You specialize in evaluating the evidential foundation of the writing. Your job is to audit every factual claim, statistic, citation, and piece of evidence the author uses. You are a fact-checker and evidence evaluator — skeptical but fair.\n\
\n\
SPECIFICALLY LOOK FOR:\n\
\n\
Unsupported Claims:\n\
- Assertions presented as fact without any evidence, citation, or reasoning\n\
- Quantitative claims (numbers, percentages, statistics) without sources\n\
- Causal claims without supporting evidence or mechanism\n\
- Sweeping generalizations ("most experts agree," "it\'s well known that") without specifics\n\
- Claims about trends or patterns without data\n\
\n\
Citation & Source Quality:\n\
- Are cited sources real and do they say what the author claims?\n\
- Are sources authoritative for the claims being made? (e.g., a blog post cited for a medical claim)\n\
- Are sources current, or has more recent evidence superseded them?\n\
- Are sources being cited accurately, or is the author misrepresenting findings?\n\
- Selection bias in sourcing: is the author only citing evidence that supports their view while ignoring contradictory evidence?\n\
\n\
Evidence-Conclusion Alignment:\n\
- Does the evidence actually support the specific claim being made, or a weaker/different version of it?\n\
- Is the author over-interpreting results? (e.g., treating a correlation study as establishing causation)\n\
- Are there important caveats in the cited evidence that the author has omitted?\n\
- Is the sample size, methodology, or scope of cited evidence adequate for the claims being built on it?\n\
\n\
Outdated or Superseded Information:\n\
- Statistics or data points that may have changed significantly since publication\n\
- Claims about "current" state of affairs that may no longer be accurate\n\
- References to policies, positions, or situations that have evolved\n\
\n\
Set "category" to "evidence" for all your feedback items.\n\
\n\
DO NOT comment on: writing style, argument structure (another agent handles that), or prose clarity. Focus exclusively on whether claims are supported, whether evidence is accurate, and whether sources are credible.';

  var WEB_SEARCH_ADDENDUM_2 = 'WEB SEARCH CAPABILITIES:\n\
You have access to a web search tool. This is a critical part of your role — use it to ground your audit in reality rather than relying solely on your training data.\n\
\n\
USE WEB SEARCH WHEN YOU ENCOUNTER:\n\
- A specific empirical claim with a citation: VERIFY that the cited source exists, that it says what the author claims, and whether more recent data supersedes it\n\
- A quantitative claim without citation: SEARCH for the actual current data from authoritative sources and compare it to the author\'s claim\n\
- A claim about current state of affairs: CHECK whether the situation has changed\n\
- A reference to a study, report, or dataset: LOOK IT UP to verify accuracy\n\
- A claim that feels dubious or surprising: SEARCH for contradicting evidence\n\
\n\
SEARCH STRATEGY:\n\
- Start with short, broad queries (1-4 words), then narrow if needed\n\
- Prioritize authoritative sources: government data, peer-reviewed research, established institutions, official reports\n\
- When you find a discrepancy between the author\'s claim and current evidence, this is a HIGH-VALUE finding — present it clearly with the source URL\n\
- Aim for 3-7 searches per analysis, focused on the most consequential claims\n\
- Don\'t search for every claim — prioritize claims that are (a) central to the argument, (b) quantitative, or (c) dubious\n\
\n\
When citing web search findings, add a "sources" field to the feedback item:\n\
"sources": [{"url": "https://...", "title": "Source title", "finding": "Brief summary of what you found and how it relates to the author\'s claim"}]';

  var SUBAGENT_ADDENDUM_2 = 'SUB-AGENT CAPABILITIES:\n\
You have access to a research_subagent tool that spawns a focused research assistant to deeply investigate specific claims. Use this for claims that require more than a quick web search — cases where you need to cross-reference multiple sources, trace a claim to its original study, or build a comprehensive evidence picture.\n\
\n\
WHEN TO USE SUB-AGENTS (vs. direct web search):\n\
- Direct web search: Quick factual lookups, checking a single statistic, verifying a citation exists\n\
- Sub-agent: Complex verification requiring multiple sources, tracing an evidence chain, researching the full evidence landscape on a contested claim\n\
\n\
You can spawn up to 3 sub-agents. Use them on the highest-stakes claims in the document. Write detailed objectives — vague instructions produce poor results.\n\
\n\
Example good objective: "The author claims that \'global lithium production increased 300% between 2015 and 2023.\' Verify this specific claim by finding authoritative production data from USGS, IEA, or industry sources. Check both the baseline (2015) and recent (2023) figures. If the 300% figure is wrong, determine the actual percentage change. Also check if there are important caveats (e.g., does the figure include brine extraction?)."\n\
\n\
Example bad objective: "Check the lithium claim."';

  /* ─── Agent 3: Clarity & Precision ─────────────── */

  var AGENT_PROMPT_3 = 'ROLE: Clarity & Precision Analyst\n\
\n\
You specialize in evaluating whether the writing communicates its ideas clearly and precisely. You are an expert reader who flags passages where meaning is ambiguous, explanations are confusing, or the reader is likely to get lost. You are NOT a copy editor — you care about conceptual clarity, not grammatical correctness.\n\
\n\
SPECIFICALLY LOOK FOR:\n\
\n\
Ambiguity & Vagueness:\n\
- Sentences or passages that can be read in multiple ways, where the intended meaning is unclear\n\
- Vague quantifiers ("many," "significant," "substantial") where precision would strengthen the point\n\
- Pronoun references that are ambiguous (what does "this" refer to when there are multiple possible antecedents?)\n\
- Terms that are used without definition when the audience may not share the author\'s understanding\n\
\n\
Explanatory Gaps:\n\
- Concepts introduced without sufficient explanation for the target audience\n\
- Logical leaps where the author assumes background knowledge the reader may not have\n\
- Jargon or technical terms used without definition or context\n\
- Analogies or metaphors that obscure rather than clarify\n\
\n\
Confusing Passages:\n\
- Sentences that require multiple re-reads to parse (not because of complexity of ideas, but because of how they\'re expressed)\n\
- Paragraphs where the main point is buried or unclear\n\
- Sections where the relationship between sentences is hard to follow\n\
- Passages where the author contradicts themselves within a short span due to imprecise language\n\
\n\
Precision of Key Claims:\n\
- Central claims that are stated too loosely — where tightening the language would make the argument stronger and more defensible\n\
- Places where hedging language ("might," "could," "seems to") is appropriate but missing (or present when it shouldn\'t be)\n\
- Definitions of key terms that are inconsistent across the document\n\
\n\
Set "category" to "clarity" for all your feedback items.\n\
\n\
DO NOT comment on: grammar, spelling, argument logic (another agent handles that), evidence quality (another agent handles that), or document structure. Focus on whether a careful reader would understand exactly what the author means.';

  /* ─── Agent 4: Math & Empirical ────────────────── */

  var AGENT_PROMPT_4 = 'ROLE: Math & Empirical Verifier\n\
\n\
You specialize in checking mathematical claims, calculations, statistical reasoning, and empirical methodology in the writing. If the document contains numbers, formulas, percentages, data interpretations, or quantitative reasoning, you audit them rigorously. If the document has no quantitative content, return an empty array [].\n\
\n\
SPECIFICALLY LOOK FOR:\n\
\n\
Arithmetic & Calculation Errors:\n\
- Verify any math the author has done: do the numbers actually add up?\n\
- Check percentage calculations, growth rates, ratios, and conversions\n\
- Verify that derived figures are consistent with the source data cited\n\
- Check unit conversions and order-of-magnitude claims\n\
\n\
Statistical Reasoning:\n\
- Misinterpretation of statistical measures (confusing mean/median, misunderstanding confidence intervals, etc.)\n\
- Inappropriate comparisons (comparing absolute numbers when per-capita would be appropriate, or vice versa)\n\
- Simpson\'s paradox or other aggregation issues\n\
- Base rate neglect in probabilistic reasoning\n\
- Confusion of statistical significance with practical significance\n\
\n\
Data Interpretation:\n\
- Are charts, tables, or data points interpreted correctly?\n\
- Does the author draw conclusions that the data actually supports?\n\
- Are there cherry-picked time periods, subgroups, or metrics that make the data look more favorable?\n\
- Are ranges, error bars, or uncertainty properly acknowledged?\n\
\n\
Methodological Issues:\n\
- If the author describes a methodology (survey, experiment, analysis), are there obvious flaws?\n\
- Selection bias, survivorship bias, or other systematic biases in the data\n\
- Confounding variables that could explain the results without the author\'s proposed mechanism\n\
- Extrapolation beyond the range of the data\n\
\n\
Numerical Consistency:\n\
- Are the same figures quoted consistently throughout the document?\n\
- Do summary statistics match the detailed data?\n\
- Are there internal contradictions in the numbers?\n\
\n\
Set "category" to "math_empirical" for all your feedback items.\n\
\n\
If the document contains no mathematical, statistical, or quantitative content, return: []\n\
\n\
DO NOT comment on: writing quality, argument logic beyond the quantitative claims, or sourcing of non-numerical claims.';

  var WEB_SEARCH_ADDENDUM_4 = 'WEB SEARCH CAPABILITIES:\n\
You have access to a web search tool. Use it specifically to:\n\
- Look up current versions of statistics the author cites (GDP figures, population data, market sizes, etc.)\n\
- Verify that calculations based on public data use the correct source numbers\n\
- Find the original data source when the author references specific datasets or studies\n\
- Check whether quantitative claims match authoritative data\n\
\n\
Aim for 2-4 targeted searches focused on the most important numerical claims.\n\
\n\
When citing findings, add a "sources" field:\n\
"sources": [{"url": "https://...", "title": "Source title", "finding": "The actual figure and how it compares to the author\'s claim"}]';

  /* ─── Agent 5: Structure & Flow ────────────────── */

  var AGENT_PROMPT_5 = 'ROLE: Structure & Flow Analyst\n\
\n\
You specialize in evaluating the organizational structure, flow, and architecture of the writing. You assess whether the document is structured in a way that effectively serves its argument and its audience.\n\
\n\
SPECIFICALLY LOOK FOR:\n\
\n\
Document Architecture:\n\
- Does the overall structure serve the argument? Would a different ordering of sections be more effective?\n\
- Is there a clear thesis or central claim that the document is organized around?\n\
- Do sections build on each other logically, or do they feel disconnected?\n\
- Is the introduction effective at framing what follows? Does the conclusion actually conclude?\n\
- Are there sections that feel misplaced — material that would be stronger earlier or later?\n\
\n\
Paragraph-Level Flow:\n\
- Are there abrupt topic shifts between paragraphs without transitions?\n\
- Do paragraphs follow a logical progression, or do they feel randomly ordered within a section?\n\
- Are there paragraphs that try to do too much (multiple unrelated points crammed together)?\n\
- Are there paragraphs that are too thin (a single sentence making a claim that deserves development)?\n\
\n\
Pacing & Proportionality:\n\
- Does the document spend proportional time on things relative to their importance?\n\
- Are there sections that go into excessive detail on minor points while rushing through critical ones?\n\
- Does the piece front-load important context, or does the reader have to wait too long for essential information?\n\
- Is the length appropriate for the content? Are there sections that could be cut without losing anything?\n\
\n\
Redundancy & Gaps:\n\
- Are there points made in multiple places that should be consolidated?\n\
- Are there gaps where the reader expects coverage of a topic that never appears?\n\
- Does the piece set up expectations (in the intro or framing) that it fails to deliver on?\n\
\n\
Reader Experience:\n\
- Where is the reader likely to get lost, bored, or confused due to structural issues (not prose quality)?\n\
- Is the "so what" clear? Does the reader understand why each section matters for the overall argument?\n\
- For longer pieces: is there a clear enough throughline that the reader can maintain the thread?\n\
\n\
Set "category" to "structure" for all your feedback items.\n\
\n\
DO NOT comment on: sentence-level clarity (another agent handles that), argument logic (another agent handles that), evidence quality, or grammar. Focus on the architecture and organization of the piece.';

  /* ─── Agent 6: Steelman & Counterargument ──────── */

  var AGENT_PROMPT_6 = 'ROLE: Steelman & Counterargument Analyst\n\
\n\
You specialize in identifying the strongest possible objections to the author\'s arguments, and evaluating whether the author has adequately addressed them. You are the adversarial reader — the smartest, most knowledgeable critic who genuinely disagrees with the author\'s position. Your job is NOT to nitpick, but to find the strongest challenges to the author\'s central claims.\n\
\n\
SPECIFICALLY LOOK FOR:\n\
\n\
Unaddressed Counterarguments:\n\
- What would the most informed, thoughtful critic say in response to the author\'s central claims?\n\
- Are there well-known opposing positions in this domain that the author ignores?\n\
- Are there empirical findings that cut against the author\'s thesis?\n\
- Are there real-world examples or case studies that contradict the author\'s claims?\n\
- What would a domain expert who disagrees point to as the author\'s biggest blind spot?\n\
\n\
Weak Steelmanning:\n\
- When the author DOES address counterarguments, do they engage with the strongest version or a weakened version?\n\
- Are opposing positions presented fairly, or are they caricatured?\n\
- Does the author dismiss counterarguments with insufficient reasoning?\n\
- Are there "yes, but" responses where the "but" doesn\'t actually address the core of the objection?\n\
\n\
Missing Perspectives:\n\
- Whose perspective is absent from this piece? (affected groups, dissenting experts, alternative schools of thought)\n\
- Are there important tradeoffs the author doesn\'t acknowledge?\n\
- Does the author consider second-order effects and unintended consequences?\n\
- Is there a selection bias in which counterarguments the author chooses to address?\n\
\n\
Intellectual Humility Gaps:\n\
- Where should the author acknowledge more uncertainty than they do?\n\
- Are there confident claims that the evidence only weakly supports?\n\
- Does the author distinguish between what they\'ve demonstrated and what they\'re speculating?\n\
\n\
For each counterargument you raise:\n\
- Present the strongest version of the objection (steelman it)\n\
- Explain why a thoughtful critic would find it compelling\n\
- Suggest how the author could address it (if possible) — or acknowledge it as a genuine limitation\n\
\n\
Set "category" to "counterargument" for all your feedback items.\n\
\n\
DO NOT generate fabricated counterarguments that no real expert would make. Every counterargument should be one that a knowledgeable person in the relevant domain would actually raise.';

  var WEB_SEARCH_ADDENDUM_6 = 'WEB SEARCH CAPABILITIES:\n\
You have access to a web search tool. Use it to find REAL counterarguments and opposing evidence rather than generating hypothetical ones from training data.\n\
\n\
USE WEB SEARCH TO:\n\
- Find published critiques or opposing viewpoints on the author\'s topic\n\
- Find empirical evidence that contradicts the author\'s claims\n\
- Find expert opinions from people who hold opposing positions\n\
- Find alternative frameworks or interpretations for the phenomena the author discusses\n\
\n\
SEARCH STRATEGY:\n\
- Search for the specific debate or disagreement: "[topic] criticism" or "[topic] alternative view" or "[claim] evidence against"\n\
- Look for responses from specific stakeholder groups who might disagree\n\
- Find the most authoritative opposing voices, not random blog posts\n\
- Aim for 2-5 searches focused on the author\'s most important and most contestable claims\n\
\n\
When citing findings, add a "sources" field:\n\
"sources": [{"url": "https://...", "title": "Source title", "finding": "What this source argues and why it challenges the author\'s position"}]';

  var SUBAGENT_ADDENDUM_6 = 'SUB-AGENT CAPABILITIES:\n\
You have access to a research_subagent tool that spawns a focused research assistant. Use it to deeply investigate the strongest counterarguments to the author\'s most important claims.\n\
\n\
WHEN TO USE SUB-AGENTS:\n\
- When you\'ve identified a major contestable claim and want to find the best published critique\n\
- When you need to research an alternative framework or school of thought in depth\n\
- When you want to build the strongest possible version of an objection using real evidence\n\
\n\
You can spawn up to 3 sub-agents. Write detailed objectives that specify:\n\
- What the author claims\n\
- What kind of opposing evidence or arguments to look for\n\
- What domain or field to search within\n\
- What format to return results in\n\
\n\
Example good objective: "The author argues that remote work increases productivity based on the 2023 Stanford study. Research the strongest counterarguments to this claim. Look for: (1) critiques of the Stanford study\'s methodology, (2) other studies showing negative productivity effects, (3) arguments about selection bias in remote work research. Focus on published research and expert commentary, not opinion pieces."';

  /* ─── Agent 7: Grammar (standalone, no preamble) ── */

  var GRAMMAR_PROMPT = 'You are a meticulous copy editor focused on grammar, spelling, punctuation, and mechanical correctness. You are NOT a content reviewer — leave argument quality, evidence, structure, and clarity to other reviewers. Your sole focus is the mechanical correctness of the writing.\n\
\n\
DOCUMENT TYPE CONTEXT:\n\
The document is a {documentType}. Calibrate your expectations:\n\
- "blog post": Relaxed standards. Sentence fragments for effect are fine. Contractions are fine. Conversational tone is intentional, not an error.\n\
- "essay": Moderate standards. Semi-formal writing expected but not stiff.\n\
- "academic paper": High standards. Formal conventions should be followed.\n\
- "report": Professional standards. Clear, correct, unambiguous language.\n\
\n\
SPECIFICALLY LOOK FOR:\n\
- Grammatical errors: subject-verb agreement, tense consistency, dangling modifiers, pronoun-antecedent disagreement, faulty parallelism\n\
- Spelling errors and typos (including correctly-spelled wrong words: "form" when "from" was intended)\n\
- Punctuation errors: comma splices, missing commas after introductory clauses, incorrect semicolon use, apostrophe errors\n\
- Run-on sentences and sentence fragments (unless clearly intentional for style in blog/essay context)\n\
- Inconsistent formatting: inconsistent capitalization of recurring terms, inconsistent use of Oxford comma, inconsistent number formatting (switching between "10" and "ten")\n\
- Commonly confused words: affect/effect, its/it\'s, their/there/they\'re, principal/principle, complement/compliment, discrete/discreet, further/farther\n\
- Redundant or awkward phrasing that has a clean mechanical fix (not content rewrites)\n\
\n\
DO NOT FLAG:\n\
- Content issues of any kind\n\
- Stylistic choices that are grammatically correct (starting with "And," one-sentence paragraphs for emphasis, etc.)\n\
- Intentional informal tone in blog-style writing\n\
- Technical terminology that may look unusual but is domain-correct\n\
- Anything that requires understanding the argument to evaluate\n\
- Debatable style preferences (Oxford comma vs. no Oxford comma — only flag if the author is INCONSISTENT)\n\
\n\
OUTPUT FORMAT:\n\
Return a JSON array of objects:\n\
{\n\
  "quote": "exact text containing the error — include enough context for identification",\n\
  "title": "Short title (e.g., \'Subject-verb disagreement\', \'Missing comma after introductory clause\')",\n\
  "category": "grammar",\n\
  "severity": "suggestion",\n\
  "explanation": "What the specific error is (1 sentence, be precise)",\n\
  "suggestion": "Corrected version: [the passage with the error fixed]"\n\
}\n\
\n\
QUALITY BAR: Only flag clear errors, not debatable style choices. If you\'re genuinely unsure whether something is an error, skip it. Aim for precision over recall — 5 real errors are worth more than 15 items where half are questionable.\n\
\n\
Return ONLY the JSON array, no other text.';

  /* ─── Aggregator (Phase 2) ─────────────────────── */

  var AGGREGATOR_PROMPT = 'You are the Aggregator for a multi-agent writing review system. Six specialist agents have independently analyzed a document, each from their own perspective: Argument Logic, Evidence & Claims, Clarity & Precision, Math & Empirical, Structure & Flow, and Steelman & Counterargument.\n\
\n\
Your job is to synthesize their feedback into a unified, non-redundant set of comments. You are an editor-in-chief — you merge overlapping feedback, eliminate true duplicates, and ensure the final set is coherent and non-repetitive.\n\
\n\
INPUT:\n\
You will receive the raw JSON output from each specialist agent, labeled by agent name.\n\
\n\
ABSOLUTE RULE — ONE ITEM PER PASSAGE:\n\
The final output MUST NOT contain two or more feedback items that reference the same sentence, the same line, or overlapping passages in the document. If multiple agents flagged the same passage (even from completely different angles — e.g., one flags a clarity issue and another flags a logic issue on the same sentence), you MUST merge them into a SINGLE feedback item. The merged item should:\n\
- Use the quote that best captures the shared passage\n\
- Combine all perspectives into one comprehensive explanation (e.g., "This sentence has both a clarity problem and a logical gap: [clarity issue]. Additionally, [logic issue].")\n\
- Pick the most relevant primary category, but note secondary categories in the explanation\n\
- Use the highest applicable severity\n\
- Combine all suggestions into one actionable recommendation\n\
\n\
To enforce this: after generating your output, scan for any two items whose quotes overlap or reference the same 1-2 sentences. If you find any, merge them before returning.\n\
\n\
YOUR TASKS:\n\
\n\
1. DEDUPLICATE AND MERGE BY PASSAGE: Group all input items by the passage they reference. Any items touching the same sentence or adjacent sentences about the same topic MUST become one item. This is your most important task.\n\
\n\
2. CROSS-AGENT EVIDENCE SYNTHESIS:\n\
Pay special attention to cases where multiple agents have found RELATED information about the same underlying issue from different angles. These are your highest-value merges:\n\
- If the Evidence Auditor found that a cited statistic is outdated AND the Steelman Agent found a more recent study with different conclusions → MERGE into a single powerful item presenting both findings together\n\
- If the Math Verifier found a calculation error AND the Argument Logic Analyst found that the conclusion based on that calculation doesn\'t follow → MERGE to show the cascading impact\n\
- If the Clarity Analyst flagged a term as ambiguous AND the Logic Analyst found a reasoning error that depends on that ambiguity → MERGE to show how the clarity issue enables the logic error\n\
- When merging items with web search sources, consolidate all "sources" arrays and deduplicate by URL\n\
\n\
The goal is feedback items that tell a COMPLETE STORY about an issue, drawing on every relevant agent\'s findings, rather than fragmenting related discoveries.\n\
\n\
3. RESOLVE CONFLICTS: If two agents give contradictory feedback about the same passage, use your judgment to determine which is correct, or synthesize both perspectives into a nuanced comment.\n\
\n\
4. ASSIGN FINAL SEVERITY: After merging, reassess severity for each item:\n\
   - "critical": The piece has a meaningful error, logical flaw, or unsupported central claim that undermines the argument\n\
   - "important": A significant gap, weakness, or problem that noticeably weakens the piece\n\
   - "suggestion": A genuine improvement that would strengthen an already-functional aspect\n\
\n\
5. PRESERVE SOURCES: If any input feedback items contain a "sources" field (array of objects with url, title, finding), preserve these in the merged output. When merging items, concatenate their sources arrays and deduplicate by URL.\n\
\n\
OUTPUT FORMAT:\n\
Return a JSON array of objects, each with:\n\
{\n\
  "id": sequential integer starting at 1,\n\
  "quote": "exact verbatim text from the original document",\n\
  "title": "Concise descriptive title",\n\
  "category": "the PRIMARY category — pick the most relevant from: argument_logic | evidence | clarity | structure | counterargument | math_empirical",\n\
  "severity": "critical | important | suggestion",\n\
  "explanation": "Merged explanation incorporating insights from ALL agents that flagged this passage. If multiple categories apply, address each perspective.",\n\
  "suggestion": "Specific, actionable recommendation that addresses all identified issues in this passage",\n\
  "sources": [{"url": "...", "title": "...", "finding": "..."}]  // only if sources exist\n\
}\n\
\n\
Order the output by severity (critical first, then important, then suggestion), with items of equal severity ordered by their position in the document.\n\
\n\
Quality target: The final set should typically be 30-50% smaller than the combined input (due to merging and deduplication), but every surviving item should be substantive and non-redundant. Aim for 8-20 final items depending on document length and quality. NEVER output two items about the same passage.\n\
\n\
Return ONLY the JSON array.';

  /* ─── Critic (Phase 3) ─────────────────────────── */

  var CRITIC_PROMPT = 'You are the Critic — the final quality gate in a multi-agent writing review system. The Aggregator has produced a merged set of feedback items. Your job is to ruthlessly filter this list, keeping only feedback that is genuinely valuable to the author.\n\
\n\
You are the author\'s advocate. The author\'s time is precious. Every feedback item that makes it through your filter will demand the author\'s attention. Your job is to ensure that attention is well-spent.\n\
\n\
INPUT:\n\
A JSON array of aggregated feedback items, plus the original document text.\n\
\n\
FILTER CRITERIA — REMOVE items that are:\n\
\n\
1. NITPICKY: Minor stylistic preferences disguised as substantive feedback. If the original text is clear and correct, don\'t suggest rewording just because the reviewer would have phrased it differently.\n\
\n\
2. SUBJECTIVE WITHOUT SUBSTANCE: "This section could be stronger" or "Consider expanding on this" without a specific, concrete issue identified. If the feedback can\'t point to a specific problem, it shouldn\'t survive.\n\
\n\
3. WRONG: Verify each feedback item against the original text. Does the quoted passage actually exist? Does the feedback accurately describe the issue? Sometimes agents misread or misinterpret passages — catch those errors.\n\
\n\
4. REDUNDANT OR OVERLAPPING: Even after aggregation, some items may make essentially the same point or reference the same passage. If two items quote the same sentence or overlapping text, MERGE them into one item combining both perspectives — do NOT keep both. The final output must have at most one item per passage.\n\
\n\
5. OUTSIDE THE AUTHOR\'S SCOPE: Suggestions to write a different piece than the one the author wrote. If the author is writing about X, don\'t keep feedback that says "you should also discuss Y" unless Y is clearly essential to the argument about X.\n\
\n\
6. DISPROPORTIONATE: Feedback whose severity is miscalibrated. A minor clarity issue marked "critical" should be downgraded or removed. A genuinely important finding marked "suggestion" should be upgraded.\n\
\n\
PRESERVE items that are:\n\
\n\
1. FACTUALLY IMPORTANT: Any item backed by web search evidence showing the author is wrong about something — these are extremely high value. Always keep.\n\
\n\
2. LOGICALLY SIGNIFICANT: Genuine reasoning errors, internal contradictions, or unsupported central claims. These are what make writing review valuable.\n\
\n\
3. ACTIONABLE AND SPECIFIC: Items where the author can clearly see what\'s wrong and how to fix it.\n\
\n\
4. PROPORTIONATE: The severity matches the actual impact on the piece.\n\
\n\
YOUR TASKS:\n\
\n\
1. Review each feedback item against the original document.\n\
2. Remove items that fail the filter criteria above.\n\
3. Adjust severity if miscalibrated (you may upgrade or downgrade).\n\
4. Improve the wording of explanations/suggestions if they\'re unclear (but preserve the substance).\n\
5. Ensure quotes are accurate — if a quote doesn\'t appear verbatim in the document, fix it or remove the item.\n\
6. Renumber IDs sequentially starting from 1.\n\
\n\
OUTPUT FORMAT:\n\
Return a JSON array of objects with the same schema as the input:\n\
{\n\
  "id": sequential integer starting at 1,\n\
  "quote": "verified exact verbatim text from the original document",\n\
  "title": "Concise descriptive title",\n\
  "category": "argument_logic | evidence | clarity | structure | counterargument | math_empirical",\n\
  "severity": "critical | important | suggestion",\n\
  "explanation": "Clear, accurate explanation",\n\
  "suggestion": "Specific, actionable recommendation",\n\
  "sources": [...]  // preserve if present\n\
}\n\
\n\
Target: Remove 20-40% of input items. If the Aggregator did a good job, you might only remove 20%. If the input is padded with low-value items, remove more aggressively. The final list should be tight — every item worth the author\'s time.\n\
\n\
Return ONLY the JSON array.';

  /* ═══════════════════════════════════════════════════
     Agent Configs
     ═══════════════════════════════════════════════════ */

  var AGENT_PROMPTS = {
    1: AGENT_PROMPT_1,
    2: AGENT_PROMPT_2,
    3: AGENT_PROMPT_3,
    4: AGENT_PROMPT_4,
    5: AGENT_PROMPT_5,
    6: AGENT_PROMPT_6,
  };

  var WEB_SEARCH_ADDENDUMS = {
    2: WEB_SEARCH_ADDENDUM_2,
    4: WEB_SEARCH_ADDENDUM_4,
    6: WEB_SEARCH_ADDENDUM_6,
  };

  var SUBAGENT_ADDENDUMS = {
    2: SUBAGENT_ADDENDUM_2,
    6: SUBAGENT_ADDENDUM_6,
  };

  /**
   * Build the full system prompt for a given agent number.
   * Agent 7 (Grammar) uses its own standalone prompt (no shared preamble).
   * Agents 1-6 get: sharedPreamble + agentPrompt + conditional addendums.
   */
  function buildSystemPrompt(agentNumber, documentType, options) {
    if (agentNumber === 7) {
      return GRAMMAR_PROMPT.replace(/{documentType}/g, documentType);
    }

    var prompt = SHARED_PREAMBLE.replace(/{documentType}/g, documentType);
    prompt += '\n\n' + AGENT_PROMPTS[agentNumber];

    // Web search addendum for Agents 2 and 6 (when web search enabled)
    if (options.webSearch && WEB_SEARCH_ADDENDUMS[agentNumber]) {
      prompt += '\n\n' + WEB_SEARCH_ADDENDUMS[agentNumber];
    }
    // Math web search addendum for Agent 4
    if (options.mathWebSearch && agentNumber === 4) {
      prompt += '\n\n' + WEB_SEARCH_ADDENDUMS[4];
    }
    // Sub-agent addendum for Agents 2 and 6 (when deep research enabled)
    if (options.deepResearch && SUBAGENT_ADDENDUMS[agentNumber]) {
      prompt += '\n\n' + SUBAGENT_ADDENDUMS[agentNumber];
    }

    return prompt;
  }

  /**
   * Build the user message sent to each specialist agent.
   */
  function buildUserMessage(documentType, documentText) {
    return 'Please analyze the following ' + documentType + ' and provide your specialist feedback.\n\nDOCUMENT:\n---\n' + documentText + '\n---\n\nReturn ONLY a valid JSON array of feedback objects. No other text.';
  }

  var AGENT_CONFIGS = [
    { key: 'argument',  name: 'Argument Logic',      icon: '\uD83D\uDD0D', agentNumber: 1, webSearch: false, subAgents: false },
    { key: 'evidence',  name: 'Evidence & Claims',    icon: '\uD83D\uDCCB', agentNumber: 2, webSearch: true,  subAgents: true },
    { key: 'clarity',   name: 'Clarity & Precision',  icon: '\u270D\uFE0F', agentNumber: 3, webSearch: false, subAgents: false },
    { key: 'math',      name: 'Math & Empirical',     icon: '\uD83E\uDDEE', agentNumber: 4, webSearch: false, subAgents: false },
    { key: 'structure', name: 'Structure & Flow',     icon: '\uD83C\uDFD7\uFE0F', agentNumber: 5, webSearch: false, subAgents: false },
    { key: 'steelman', name: 'Steelman & Counter',    icon: '\u2694\uFE0F', agentNumber: 6, webSearch: true,  subAgents: true },
  ];

  var GRAMMAR_AGENT_CONFIG = {
    key: 'grammar',
    name: 'Grammar & Mechanics',
    icon: '\u270D\uFE0F',
    agentNumber: 7,
  };

  var SUBAGENT_TOOL = {
    name: 'research_subagent',
    description: 'Spawn a focused research sub-agent to investigate a specific claim, find evidence, or explore a question in depth. The sub-agent has web search access and will return a detailed research report. Use this for claims that require deep verification beyond a simple web search \u2014 e.g., when you need to cross-reference multiple sources, trace a claim back to its original study, or build a comprehensive picture of the evidence landscape on a specific point. Do NOT use for simple factual lookups (use web_search directly for those). Limit to 3 sub-agents per analysis.',
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'A detailed description of what the sub-agent should research. Be specific: include the exact claim to verify, the context from the document, what kind of evidence to look for, and what format to return results in. Vague objectives produce poor results.',
        },
        return_format: {
          type: 'string',
          description: 'What the sub-agent should return. E.g., "A summary of the current evidence for and against this claim, with source URLs" or "The actual current statistic from the most authoritative source, with citation"',
        },
      },
      required: ['objective', 'return_format'],
    },
  };

  var WEB_SEARCH_TOOL = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 5,
  };

  /* ═══════════════════════════════════════════════════
     API / Pipeline Logic
     ═══════════════════════════════════════════════════ */

  var totalUsage = { input_tokens: 0, output_tokens: 0 };
  var webSearchCount = 0;
  var subAgentCount = 0;

  function resetUsage() {
    totalUsage = { input_tokens: 0, output_tokens: 0 };
    webSearchCount = 0;
    subAgentCount = 0;
  }

  function getUsage() {
    return {
      input_tokens: totalUsage.input_tokens,
      output_tokens: totalUsage.output_tokens,
      webSearches: webSearchCount,
      subAgents: subAgentCount,
    };
  }

  /**
   * Extract text from a potentially multi-block API response.
   * Handles web search, tool-use, and extended thinking responses.
   * Thinking blocks (type: 'thinking') are automatically skipped.
   */
  function extractTextFromResponse(data) {
    if (!data || !data.content) return '';
    return data.content
      .filter(function (block) { return block.type === 'text'; })
      .map(function (block) { return block.text; })
      .join('\n');
  }

  /**
   * Raw API call — returns full response data (for tool-use loops).
   */
  async function callClaudeRaw(connConfig, body, attempt) {
    if (!attempt) attempt = 0;

    var useProxy = connConfig.mode === 'proxy';
    var url = useProxy
      ? connConfig.workerUrl.replace(/\/+$/, '') + '/v1/messages'
      : CONFIG.directApiUrl;

    var headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    // Add beta header if request uses web search tool
    var hasWebSearch = body.tools && body.tools.some(function (t) {
      return t.type === 'web_search_20250305';
    });
    if (hasWebSearch) {
      headers['anthropic-beta'] = 'web-search-2025-03-05';
    }

    if (useProxy) {
      // Proxy injects the API key server-side
    } else {
      headers['x-api-key'] = connConfig.apiKey;
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    var response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt < CONFIG.maxRetries) {
        await delay(CONFIG.retryDelay);
        return callClaudeRaw(connConfig, body, attempt + 1);
      }
      throw new Error('Network error: ' + err.message);
    }

    if (!response.ok) {
      var errBody = {};
      try { errBody = await response.json(); } catch (_) {}
      var errMsg = (errBody.error && errBody.error.message) || ('API error: ' + response.status);

      if ((response.status >= 500 || response.status === 429) && attempt < CONFIG.maxRetries) {
        await delay(CONFIG.retryDelay);
        return callClaudeRaw(connConfig, body, attempt + 1);
      }
      throw new Error(errMsg);
    }

    var data = await response.json();
    var usage = data.usage || { input_tokens: 0, output_tokens: 0 };
    totalUsage.input_tokens += usage.input_tokens;
    totalUsage.output_tokens += usage.output_tokens;

    return data;
  }

  /**
   * Simple API call — returns text string (for non-tool-use calls).
   * Supports optional extended thinking.
   */
  async function callClaude(connConfig, systemPrompt, userMessage, options) {
    var body = {
      model: (options && options.model) || CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    };

    // Extended thinking support
    if (options && options.thinking) {
      body.max_tokens = CONFIG.thinkingMaxTokens;
      body.thinking = { type: 'enabled', budget_tokens: CONFIG.thinkingBudget };
      // Temperature must not be set when thinking is enabled
      delete body.temperature;
    }

    var data = await callClaudeRaw(connConfig, body);
    return { text: extractTextFromResponse(data), usage: data.usage };
  }

  /**
   * Handle a sub-agent tool call — spawns a research sub-agent with web search.
   */
  async function handleSubAgentTool(connConfig, toolInput, parentAgentName) {
    var systemPrompt = [
      'You are a focused research sub-agent spawned by the ' + parentAgentName + ' specialist.',
      'Your task is to research a specific question and return a concise, evidence-based report.',
      '',
      'INSTRUCTIONS:',
      '1. Use web search to find relevant, authoritative sources',
      '2. Cross-reference multiple sources when possible',
      '3. Be specific about what you found and what the evidence says',
      '4. Include source URLs for all claims',
      '5. Keep your report focused and concise (under 500 words)',
      '6. If you can\'t find reliable information, say so \u2014 don\'t speculate',
      '',
      'OBJECTIVE: ' + toolInput.objective,
      '',
      'RETURN FORMAT: ' + toolInput.return_format,
    ].join('\n');

    var data = await callClaudeRaw(connConfig, {
      model: CONFIG.model,
      max_tokens: CONFIG.subAgentMaxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: 'Execute the research task described in your instructions. Return your findings as plain text.' }],
      tools: [WEB_SEARCH_TOOL],
    });

    subAgentCount++;
    return extractTextFromResponse(data);
  }

  /**
   * Run an agent with tool-use loop (web search + sub-agents).
   * Supports optional extended thinking on first turn.
   */
  async function runAgentWithTools(connConfig, systemPrompt, userMessage, tools, agentName, onStatus, options) {
    var messages = [{ role: 'user', content: userMessage }];
    var agentSubAgentCount = 0;
    var firstTurn = true;

    while (true) {
      var body = {
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        system: systemPrompt,
        messages: messages,
        tools: tools,
      };

      // Extended thinking on first turn only
      if (firstTurn && options && options.thinking) {
        body.max_tokens = CONFIG.thinkingMaxTokens;
        body.thinking = { type: 'enabled', budget_tokens: CONFIG.thinkingBudget };
        delete body.temperature;
      }
      firstTurn = false;

      var data = await callClaudeRaw(connConfig, body);

      // Count web searches from response
      if (data.content) {
        data.content.forEach(function (block) {
          if (block.type === 'server_tool_use' && block.name === 'web_search') {
            webSearchCount++;
          }
        });
      }

      var toolUseBlocks = (data.content || []).filter(function (b) {
        return b.type === 'tool_use';
      });

      if (toolUseBlocks.length === 0 || data.stop_reason === 'end_turn') {
        return extractTextFromResponse(data);
      }

      // Process tool calls
      var toolResults = [];
      for (var i = 0; i < toolUseBlocks.length; i++) {
        var toolUse = toolUseBlocks[i];
        if (toolUse.name === 'research_subagent' && agentSubAgentCount < CONFIG.maxSubAgents) {
          agentSubAgentCount++;
          if (onStatus) {
            onStatus('sub-agent', {
              count: agentSubAgentCount,
              objective: toolUse.input.objective,
            });
          }

          try {
            var result = await handleSubAgentTool(connConfig, toolUse.input, agentName);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });
          } catch (err) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'Sub-agent failed: ' + err.message + '. Please complete your analysis with the information already gathered.',
              is_error: true,
            });
          }

          if (onStatus) {
            onStatus('sub-agent-done', { count: agentSubAgentCount });
          }
        } else if (toolUse.name === 'research_subagent') {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Sub-agent limit reached (max ' + CONFIG.maxSubAgents + '). Please complete your analysis with the information already gathered.',
            is_error: true,
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'assistant', content: data.content });
        messages.push({ role: 'user', content: toolResults });
      } else {
        // No tool results to return, agent should be done
        return extractTextFromResponse(data);
      }
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function parseJSON(text) {
    if (!text) return [];
    try { return JSON.parse(text); } catch (_) {}

    var jsonBlock = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlock) {
      try { return JSON.parse(jsonBlock[1]); } catch (_) {}
    }

    var codeBlock = text.match(/```\s*([\s\S]*?)\s*```/);
    if (codeBlock) {
      try { return JSON.parse(codeBlock[1]); } catch (_) {}
    }

    var first = text.indexOf('[');
    var last = text.lastIndexOf(']');
    if (first !== -1 && last !== -1 && last > first) {
      try { return JSON.parse(text.substring(first, last + 1)); } catch (_) {}
    }

    console.warn('Forge: Failed to parse JSON from agent response:', text.substring(0, 300));
    return [];
  }

  /**
   * Phase 1: Run specialist agents in parallel.
   * @param {object} analysisOptions - { webSearch, deepResearch, grammar, mathWebSearch, extendedThinking, documentType }
   */
  async function runPhase1(connConfig, document, onAgentUpdate, analysisOptions) {
    if (!analysisOptions) analysisOptions = {};
    var documentType = analysisOptions.documentType || 'essay';

    // Build agent tasks (but don't start them yet)
    function buildAgentTask(agent) {
      var tools = [];
      var useWebSearch = false;
      var useSubAgents = false;

      if (analysisOptions.webSearch) {
        if (agent.webSearch) useWebSearch = true;
      }
      if (analysisOptions.mathWebSearch && agent.key === 'math') {
        useWebSearch = true;
      }
      if (analysisOptions.deepResearch && agent.subAgents) {
        useSubAgents = true;
      }

      if (useWebSearch) tools.push(WEB_SEARCH_TOOL);
      if (useSubAgents) tools.push(SUBAGENT_TOOL);

      var systemPrompt = buildSystemPrompt(agent.agentNumber, documentType, {
        webSearch: useWebSearch,
        mathWebSearch: analysisOptions.mathWebSearch && agent.key === 'math',
        deepResearch: useSubAgents,
      });

      return {
        agent: agent,
        tools: tools,
        systemPrompt: systemPrompt,
        useWebSearch: useWebSearch,
        useSubAgents: useSubAgents,
        thinking: !!analysisOptions.extendedThinking,
      };
    }

    function runSingleAgent(task) {
      var agent = task.agent;
      var tools = task.tools;
      var systemPrompt = task.systemPrompt;
      var useWebSearch = task.useWebSearch;
      var useSubAgents = task.useSubAgents;

      onAgentUpdate(agent.key, 'running', null);
      var startTime = Date.now();
      var userMessage = buildUserMessage(documentType, document);

      var agentPromise;
      if (tools.length > 0) {
        var statusLabel = [];
        if (useWebSearch) statusLabel.push('web search');
        if (useSubAgents) statusLabel.push('sub-agents');
        onAgentUpdate(agent.key, 'running', { tools: statusLabel });

        agentPromise = runAgentWithTools(
          connConfig, systemPrompt, userMessage,
          tools, agent.name,
          function (type, detail) {
            if (type === 'sub-agent') {
              onAgentUpdate(agent.key, 'running', {
                subAgent: detail.objective.substring(0, 60),
                subAgentCount: detail.count, tools: statusLabel,
              });
            } else if (type === 'sub-agent-done') {
              onAgentUpdate(agent.key, 'running', {
                subAgentCount: detail.count, subAgentDone: true, tools: statusLabel,
              });
            }
          },
          { thinking: task.thinking }
        ).then(function (text) {
          var feedback = parseJSON(text);
          var elapsed = Math.round((Date.now() - startTime) / 1000);
          onAgentUpdate(agent.key, 'complete', { items: feedback.length, elapsed: elapsed });
          return { key: agent.key, name: agent.name, status: 'fulfilled', feedback: feedback, error: null };
        });
      } else {
        agentPromise = callClaude(
          connConfig, systemPrompt, userMessage,
          { thinking: task.thinking }
        ).then(function (result) {
          var feedback = parseJSON(result.text);
          var elapsed = Math.round((Date.now() - startTime) / 1000);
          onAgentUpdate(agent.key, 'complete', { items: feedback.length, elapsed: elapsed });
          return { key: agent.key, name: agent.name, status: 'fulfilled', feedback: feedback, error: null };
        });
      }

      return agentPromise.catch(function (err) {
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        onAgentUpdate(agent.key, 'error', { error: err.message, elapsed: elapsed });
        return { key: agent.key, name: agent.name, status: 'rejected', feedback: [], error: err.message };
      });
    }

    // Launch agents in staggered batches of 2 to avoid rate limits
    var tasks = AGENT_CONFIGS.map(buildAgentTask);
    var batchSize = CONFIG.agentBatchSize;
    var batchDelay = CONFIG.agentBatchDelay;
    var allResults = [];

    for (var i = 0; i < tasks.length; i += batchSize) {
      var batch = tasks.slice(i, i + batchSize);
      var batchPromises = batch.map(runSingleAgent);
      var batchResults = await Promise.all(batchPromises);
      allResults = allResults.concat(batchResults);

      // Delay before next batch (skip delay after last batch)
      if (i + batchSize < tasks.length) {
        await delay(batchDelay);
      }
    }

    // Grammar agent (optional, runs after specialists to avoid rate limit)
    if (analysisOptions.grammar) {
      await delay(batchDelay);
      onAgentUpdate('grammar', 'running', null);
      var grammarStart = Date.now();
      var grammarPrompt = buildSystemPrompt(7, documentType, {});
      var grammarUserMsg = buildUserMessage(documentType, document);

      var grammarResult = await callClaudeRaw(connConfig, {
        model: CONFIG.grammarModel,
        max_tokens: CONFIG.maxTokens,
        system: grammarPrompt,
        messages: [{ role: 'user', content: grammarUserMsg }],
      }).then(function (data) {
        var text = extractTextFromResponse(data);
        var feedback = parseJSON(text);
        var elapsed = Math.round((Date.now() - grammarStart) / 1000);
        onAgentUpdate('grammar', 'complete', { items: feedback.length, elapsed: elapsed });
        return { key: 'grammar', name: 'Grammar & Mechanics', status: 'fulfilled', feedback: feedback, error: null, isGrammar: true };
      }).catch(function (err) {
        var elapsed = Math.round((Date.now() - grammarStart) / 1000);
        onAgentUpdate('grammar', 'error', { error: err.message, elapsed: elapsed });
        return { key: 'grammar', name: 'Grammar & Mechanics', status: 'rejected', feedback: [], error: err.message, isGrammar: true };
      });

      allResults.push(grammarResult);
    }

    return allResults;
  }

  /**
   * Phase 2: Aggregator — merges and deduplicates specialist feedback.
   * Supports optional extended thinking.
   */
  async function runPhase2(connConfig, document, phase1Results, analysisOptions) {
    var agentOutputs = phase1Results
      .filter(function (r) { return r.feedback.length > 0 && !r.isGrammar; })
      .map(function (r) {
        return '=== ' + r.name + ' Agent ===\n' + JSON.stringify(r.feedback, null, 2);
      })
      .join('\n\n');

    if (!agentOutputs) return [];

    var userMessage = [
      'ORIGINAL TEXT:',
      '"""',
      document,
      '"""',
      '',
      'SPECIALIST AGENT OUTPUTS:',
      agentOutputs,
    ].join('\n');

    var options = {};
    if (analysisOptions && analysisOptions.extendedThinking) {
      options.thinking = true;
    }

    var result = await callClaude(connConfig, AGGREGATOR_PROMPT, userMessage, options);
    return parseJSON(result.text);
  }

  /**
   * Phase 3: Critic — final quality filter.
   * Supports optional extended thinking.
   */
  async function runPhase3(connConfig, document, aggregated, analysisOptions) {
    if (!aggregated || aggregated.length === 0) return [];

    var userMessage = [
      'ORIGINAL TEXT:',
      '"""',
      document,
      '"""',
      '',
      'AGGREGATED FEEDBACK:',
      JSON.stringify(aggregated, null, 2),
    ].join('\n');

    var options = {};
    if (analysisOptions && analysisOptions.extendedThinking) {
      options.thinking = true;
    }

    var result = await callClaude(connConfig, CRITIC_PROMPT, userMessage, options);
    return parseJSON(result.text);
  }

  function exportToMarkdown(feedbackItems) {
    var lines = ['# Forge Analysis Report', ''];

    var byCategory = {};
    feedbackItems.forEach(function (item) {
      var cat = item.category || 'other';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(item);
    });

    var categoryNames = {
      argument_logic: 'Argument & Logic',
      evidence: 'Evidence & Claims',
      clarity: 'Clarity & Precision',
      math_empirical: 'Math & Empirical',
      structure: 'Structure & Flow',
      counterargument: 'Counterarguments',
      grammar: 'Grammar & Mechanics',
    };

    var severityEmoji = {
      critical: '\u274C',
      important: '\u26A0\uFE0F',
      suggestion: '\uD83D\uDCA1',
    };

    Object.keys(byCategory).forEach(function (cat) {
      lines.push('## ' + (categoryNames[cat] || cat));
      lines.push('');

      byCategory[cat].forEach(function (item) {
        var sev = severityEmoji[item.severity] || '';
        lines.push('### ' + sev + ' ' + (item.title || 'Untitled'));
        lines.push('**Severity:** ' + (item.severity || 'unknown'));
        lines.push('');
        if (item.quote) {
          lines.push('> ' + item.quote.replace(/\n/g, '\n> '));
          lines.push('');
        }
        if (item.explanation) {
          lines.push(item.explanation);
          lines.push('');
        }
        if (item.suggestion) {
          lines.push('**Suggestion:** ' + item.suggestion);
          lines.push('');
        }
        if (item.sources && item.sources.length > 0) {
          lines.push('**Sources:**');
          item.sources.forEach(function (src) {
            lines.push('- [' + (src.title || src.url) + '](' + src.url + ')' + (src.finding ? ' \u2014 ' + src.finding : ''));
          });
          lines.push('');
        }
        lines.push('---');
        lines.push('');
      });
    });

    lines.push('*Generated by Forge \u2014 Deep AI Writing Analysis*');
    return lines.join('\n');
  }

  var THINKING_MESSAGES = [
    'Examining argument structure for logical consistency\u2026',
    'Cross-referencing claims against stated evidence\u2026',
    'Checking mathematical derivations step by step\u2026',
    'Mapping the narrative arc of your document\u2026',
    'Generating the strongest objections to your thesis\u2026',
    'Identifying jargon that needs definition\u2026',
    'Looking for unstated assumptions\u2026',
    'Checking if conclusions follow from premises\u2026',
    'Hunting for internal contradictions\u2026',
    'Evaluating readability for non-specialist audiences\u2026',
    'Tracing the logical chain link by link\u2026',
    'Checking for cherry-picked evidence\u2026',
    'Searching for the strongest counterarguments\u2026',
    'Analyzing paragraph transitions for coherence\u2026',
    'Verifying quantitative claims for plausibility\u2026',
    'Searching the web for current data\u2026',
    'Spawning research sub-agents for deep verification\u2026',
  ];

  var PHASE2_MESSAGES = [
    'Merging overlapping insights from specialist agents\u2026',
    'Deduplicating feedback across all specialists\u2026',
    'Reconciling different analytical perspectives\u2026',
    'Structuring feedback by severity and category\u2026',
    'Synthesizing cross-agent evidence\u2026',
  ];

  var PHASE3_MESSAGES = [
    'Filtering out generic feedback \u2014 only the good stuff survives\u2026',
    'Quality-checking every comment against the original text\u2026',
    'Removing anything vague or unhelpful\u2026',
    'Strengthening suggestions to be more actionable\u2026',
    'Almost there \u2014 polishing the final feedback\u2026',
  ];

  window.ForgeAgents = {
    CONFIG: CONFIG,
    AGENT_CONFIGS: AGENT_CONFIGS,
    GRAMMAR_AGENT_CONFIG: GRAMMAR_AGENT_CONFIG,
    buildSystemPrompt: buildSystemPrompt,
    buildUserMessage: buildUserMessage,
    runPhase1: runPhase1,
    runPhase2: runPhase2,
    runPhase3: runPhase3,
    parseJSON: parseJSON,
    extractTextFromResponse: extractTextFromResponse,
    exportToMarkdown: exportToMarkdown,
    resetUsage: resetUsage,
    getUsage: getUsage,
    THINKING_MESSAGES: THINKING_MESSAGES,
    PHASE2_MESSAGES: PHASE2_MESSAGES,
    PHASE3_MESSAGES: PHASE3_MESSAGES,
  };
})();
