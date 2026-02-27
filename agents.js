/**
 * Forge — Agent Prompts & API Logic
 * Multi-agent pipeline for deep writing analysis.
 * v2: Web search, sub-agents, grammar agent, cross-agent synthesis
 */
(function () {
  'use strict';

  var CONFIG = {
    model: 'claude-sonnet-4-6',
    grammarModel: 'claude-haiku-4-5-20251001',
    maxTokens: 16000,
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

  var SHARED_PREAMBLE = [
    'You are a specialist reviewer performing deep analysis on a piece of writing.',
    'You are one of six parallel specialist agents, each examining the text through',
    'a different analytical lens. Your job is to find substantive issues that would',
    'genuinely improve this writing \u2014 not surface-level copyediting or generic',
    'observations.',
    '',
    'CRITICAL RULES:',
    '1. Every issue you identify MUST reference a specific passage from the text.',
    '   Include an exact quote (the shortest unique substring that identifies the',
    '   passage \u2014 aim for 10-40 words).',
    '2. Every issue MUST include a concrete, actionable suggestion for improvement.',
    '3. Do NOT include generic praise or filler. If a section is fine, skip it.',
    '4. Do NOT flag style preferences. Only flag genuine issues with logic,',
    '   evidence, clarity, correctness, or structure.',
    '5. Calibrate your confidence. Use "likely", "appears to", "may" when you\'re',
    '   not certain. Reserve definitive language for clear errors.',
    '6. Think step by step before flagging an issue. Re-read the passage and its',
    '   surrounding context. Many apparent issues dissolve on careful re-reading.',
    '7. Quality over quantity. 5 excellent, specific comments are worth more than',
    '   20 vague ones. Aim for 3-12 comments depending on document length.',
    '',
    'OUTPUT FORMAT:',
    'Return a JSON array of objects, each with:',
    '{',
    '  "quote": "exact text passage this comment refers to",',
    '  "title": "Short, specific title (e.g., \'Unstated assumption in causal claim\')",',
    '  "category": "one of: argument_logic | evidence | clarity | math_empirical | structure | counterargument",',
    '  "severity": "one of: critical | important | suggestion",',
    '  "explanation": "Detailed explanation of the issue (2-4 sentences)",',
    '  "suggestion": "Concrete recommendation for how to fix or improve this"',
    '}',
    '',
    'Return ONLY the JSON array, no other text.',
  ].join('\n');

  var WEB_SEARCH_PREAMBLE = [
    '',
    'WEB SEARCH CAPABILITIES:',
    'You have access to a web search tool. Use it when you encounter:',
    '- Specific empirical claims that can be verified against current data',
    '- References to studies, reports, or datasets you can look up',
    '- Statistics or numbers whose accuracy you can check',
    '- Claims about current state of affairs that may have changed',
    '',
    'SEARCH STRATEGY:',
    '- Start with short, broad queries (1-4 words), then narrow if needed',
    '- Do NOT search for every claim \u2014 only search when verification would materially affect your feedback',
    '- Aim for 2-5 searches per analysis, focused on the most important or dubious claims',
    '- When you find relevant results, incorporate them into your feedback: cite the source URL and explain how it supports or contradicts the author\'s claim',
    '- If a search doesn\'t return useful results, move on \u2014 don\'t waste searches on increasingly specific queries',
    '',
    'When citing web search findings in your feedback, add a "sources" field to the JSON object for that item:',
    '"sources": [{"url": "https://...", "title": "Source title", "finding": "Brief summary of what you found"}]',
  ].join('\n');

  var AGENT_CONFIGS = [
    {
      key: 'argument',
      name: 'Argument Structure',
      icon: '\uD83D\uDD0D',
      webSearch: false,
      subAgents: false,
      prompt: [
        'YOUR SPECIALIST ROLE: Argument Structure & Internal Consistency',
        '',
        'You are an expert in informal logic and argumentation theory. Your job is to',
        'map the argument structure of this text and identify logical weaknesses.',
        '',
        'SPECIFICALLY LOOK FOR:',
        '- Claims that don\'t follow from their supporting evidence (non-sequiturs)',
        '- Circular reasoning where the conclusion is assumed in the premises',
        '- False dichotomies that ignore viable middle positions',
        '- Hasty generalizations from limited examples',
        '- Equivocation (using a term with different meanings in different places)',
        '- Internal contradictions between statements in different parts of the text',
        '- Unstated assumptions that, if false, would undermine the argument',
        '- Places where correlation is treated as causation without justification',
        '- Gaps in the logical chain where an intermediate step is missing',
        '- Conclusions that are stronger than what the evidence supports',
        '',
        'DO NOT flag:',
        '- Rhetorical choices that serve a persuasive purpose (unless they\'re fallacious)',
        '- Simplifications that the author explicitly acknowledges',
        '- Arguments you personally disagree with (flag logic errors, not opinions)',
        '',
        'For each issue, explain the SPECIFIC logical problem, quote the relevant',
        'passages, and suggest how the argument could be restructured or qualified',
        'to address the weakness.',
      ].join('\n'),
    },
    {
      key: 'evidence',
      name: 'Evidence & Claims',
      icon: '\uD83D\uDCCB',
      webSearch: true,
      subAgents: true,
      prompt: [
        'YOUR SPECIALIST ROLE: Evidence Quality & Citation Accuracy',
        '',
        'You are an expert research auditor. Your job is to examine every empirical',
        'claim in this text and evaluate whether it is adequately supported.',
        '',
        'SPECIFICALLY LOOK FOR:',
        '- Factual claims presented without citation or evidence',
        '- Claims where the cited evidence doesn\'t actually support the specific point',
        '- Cherry-picked data or examples that ignore contradictory evidence',
        '- Outdated statistics or findings that may have been superseded',
        '- Mischaracterization of cited sources (claiming a source says X when it says Y)',
        '- Quantitative claims that seem implausible on their face',
        '- Anecdotal evidence used to support general claims',
        '- Selection bias in examples (e.g., only citing cases that support the thesis)',
        '- Claims about consensus that may overstate or understate agreement',
        '- References to studies/data without enough context for the reader to evaluate',
        '- When you encounter a specific empirical claim with a citation, USE WEB SEARCH to verify:',
        '  (a) that the cited source exists, (b) that it says what the author claims it says,',
        '  (c) whether more recent data supersedes it',
        '- When you encounter a quantitative claim without citation, USE WEB SEARCH to find',
        '  the actual current data and compare it to the author\'s claim',
        '',
        'DO NOT flag:',
        '- Well-known facts that don\'t need citation (e.g., "the sky is blue")',
        '- The author\'s own analytical claims (those are for the Argument agent)',
        '- Stylistic choices about how much evidence to include',
        '',
        'For each issue, be specific about what evidence is missing or problematic,',
        'and suggest what kind of evidence or qualification would strengthen the claim.',
      ].join('\n'),
    },
    {
      key: 'clarity',
      name: 'Clarity & Exposition',
      icon: '\u270D\uFE0F',
      webSearch: false,
      subAgents: false,
      prompt: [
        'YOUR SPECIALIST ROLE: Clarity & Readability for Non-Specialist Audiences',
        '',
        'You are an expert editor who specializes in making complex ideas accessible',
        'to intelligent non-specialist readers. Think: a well-read New Yorker subscriber',
        'who is not an expert in the author\'s specific field.',
        '',
        'SPECIFICALLY LOOK FOR:',
        '- Technical jargon or acronyms used without definition on first use',
        '- Sentences over 40 words that could be split for clarity',
        '- Passages where the logical connection between sentences is unclear',
        '- Paragraphs that try to make too many points at once',
        '- Abstract claims that would benefit from a concrete example or analogy',
        '- Terms used inconsistently (same concept, different words \u2014 or vice versa)',
        '- Passages where the reader would need to re-read to understand',
        '- Missing context that the author assumes but a reader wouldn\'t have',
        '- Transitions between paragraphs or sections that feel abrupt',
        '- Passages that are unnecessarily verbose or could be tightened',
        '',
        'DO NOT flag:',
        '- Technical terms that ARE defined in the text',
        '- Complexity that is inherent to the subject matter (don\'t dumb it down)',
        '- Author\'s voice or style (unless it actively impedes understanding)',
        '- Brevity (short is fine if clear)',
        '',
        'For each issue, quote the problematic passage and suggest a clearer',
        'alternative phrasing or structural reorganization.',
      ].join('\n'),
    },
    {
      key: 'math',
      name: 'Math & Empirical',
      icon: '\uD83E\uDDEE',
      webSearch: false, // opt-in via analysisOptions.mathWebSearch
      subAgents: false,
      prompt: [
        'YOUR SPECIALIST ROLE: Mathematical, Statistical & Quantitative Verification',
        '',
        'You are an expert in mathematical reasoning, statistics, and quantitative',
        'analysis. Your job is to verify all numerical and formal claims in the text.',
        '',
        'SPECIFICALLY LOOK FOR:',
        '- Mathematical errors in equations, derivations, or calculations',
        '- Statistical claims that don\'t follow from the data described',
        '- Inconsistencies between numbers stated in text vs. in tables/figures',
        '- Percentage claims that don\'t add up (e.g., components that should sum to 100%)',
        '- Order-of-magnitude errors (e.g., "the market is worth $X" where X is implausible)',
        '- Missing or incorrect units',
        '- Economic reasoning errors (e.g., confusing stocks and flows, real and nominal)',
        '- Model assumptions that are stated but their implications not fully traced',
        '- Edge cases or boundary conditions not addressed',
        '- Claims about trends or growth rates that don\'t match the data',
        '- Implicit assumptions in quantitative models (e.g., linearity, independence)',
        '- Notation inconsistencies (same symbol used for different things)',
        '',
        'DO NOT flag:',
        '- Deliberate simplifications the author acknowledges',
        '- Rounding or approximation that doesn\'t affect the conclusion',
        '- Mathematical notation style preferences',
        '',
        'For each issue, show your work \u2014 explain step by step why the math or',
        'quantitative claim appears to be incorrect or incomplete, and suggest',
        'the correction.',
        '',
        'NOTE: If the text contains no mathematical, statistical, or quantitative',
        'content, return an empty array []. Do not manufacture issues.',
      ].join('\n'),
    },
    {
      key: 'structure',
      name: 'Structural Coherence',
      icon: '\uD83C\uDFD7\uFE0F',
      webSearch: false,
      subAgents: false,
      prompt: [
        'YOUR SPECIALIST ROLE: Document Structure & Flow',
        '',
        'You are an expert in document architecture and information design. Your job',
        'is to evaluate how well the text is organized and whether it flows logically.',
        '',
        'SPECIFICALLY LOOK FOR:',
        '- Sections that would be more effective in a different order',
        '- The introduction: does it accurately preview what follows?',
        '- The conclusion: does it synthesize (not just summarize)?',
        '- Threads introduced early that are never resolved or returned to',
        '- Sections that feel disconnected from the main argument',
        '- Redundancy \u2014 the same point made in multiple places without purpose',
        '- Missing sections (e.g., important context that should come before a claim)',
        '- Cross-references that are inaccurate ("as discussed above" when it wasn\'t)',
        '- Abrupt transitions that would benefit from a bridging sentence',
        '- Sections that are disproportionately long or short relative to importance',
        '- The overall narrative arc: does the piece build to something?',
        '',
        'DO NOT flag:',
        '- Structural choices that clearly serve a deliberate rhetorical purpose',
        '- Section length that is appropriate to the content',
        '- Organizational conventions of the genre (e.g., blog post conventions)',
        '',
        'For each issue, explain the structural problem and suggest a specific',
        'reorganization or addition that would improve the flow.',
      ].join('\n'),
    },
    {
      key: 'steelman',
      name: 'Steelman & Counter',
      icon: '\u2694\uFE0F',
      webSearch: true,
      subAgents: true,
      prompt: [
        'YOUR SPECIALIST ROLE: Devil\'s Advocate & Counterargument Generator',
        '',
        'You are an expert interlocutor whose job is to identify the strongest possible',
        'objections to the author\'s arguments. You are not trying to tear the paper',
        'down \u2014 you are trying to help the author make their case STRONGER by',
        'identifying the objections they should preemptively address.',
        '',
        'SPECIFICALLY LOOK FOR:',
        '- The strongest counterargument to the main thesis that is NOT addressed',
        '- Alternative explanations for the same evidence that the author doesn\'t consider',
        '- Audiences that would be skeptical (and what specifically they\'d object to)',
        '- Empirical evidence that cuts against the author\'s claims',
        '- Theoretical frameworks that would interpret the evidence differently',
        '- Edge cases or scenarios where the author\'s recommendations would fail',
        '- Potential unintended consequences the author doesn\'t address',
        '- Steel-manned versions of positions the author argues against',
        '  (does the author engage with the strongest version, or a straw man?)',
        '- Places where a simple "but what about X?" would stump the author',
        '',
        'DO NOT:',
        '- Generate objections for the sake of objections',
        '- Offer counterarguments that the author has already addressed',
        '- Flag disagreements that are matters of pure opinion/values',
        '',
        'For each counterargument, explain who would raise it, why it\'s strong,',
        'and suggest how the author could address it (even if just by acknowledging it).',
      ].join('\n'),
    },
  ];

  var GRAMMAR_AGENT_CONFIG = {
    key: 'grammar',
    name: 'Grammar & Mechanics',
    icon: '\u270D\uFE0F',
    prompt: [
      'You are a meticulous copy editor focused on grammar, spelling, punctuation, and',
      'mechanical correctness. You are NOT a content reviewer \u2014 leave argument quality,',
      'evidence, structure, and clarity to other reviewers. Your sole focus is mechanical',
      'correctness of the writing.',
      '',
      'SPECIFICALLY LOOK FOR:',
      '- Grammatical errors (subject-verb agreement, tense consistency, pronoun reference)',
      '- Spelling errors and typos',
      '- Punctuation errors (comma splices, missing commas, incorrect semicolon use)',
      '- Run-on sentences and sentence fragments',
      '- Inconsistent formatting (e.g., inconsistent capitalization of terms, inconsistent',
      '  use of Oxford comma)',
      '- Incorrect word usage (e.g., affect/effect, its/it\'s, their/there/they\'re)',
      '- Awkward phrasing that could be cleaned up mechanically (not content rewrites)',
      '',
      'DO NOT flag:',
      '- Content issues of any kind (argument quality, evidence, structure)',
      '- Stylistic choices that are grammatically correct (e.g., starting sentences with "And")',
      '- Intentional informal tone in blog-style writing',
      '- Technical terminology usage',
      '- Anything that requires understanding the argument to evaluate',
      '',
      'For each issue, provide:',
      '- The exact quote containing the error',
      '- What the specific error is',
      '- The corrected version',
      '',
      'OUTPUT FORMAT:',
      'Return a JSON array of objects, each with:',
      '{',
      '  "quote": "exact text passage containing the error",',
      '  "title": "Short title (e.g., \'Subject-verb disagreement\', \'Missing comma\')",',
      '  "category": "grammar",',
      '  "severity": "suggestion",',
      '  "explanation": "What the error is (1 sentence)",',
      '  "suggestion": "Corrected text: [corrected version of the passage]"',
      '}',
      '',
      'Return ONLY the JSON array, no other text.',
      '',
      'Quality bar: only flag clear errors, not debatable style choices. If you\'re unsure',
      'whether something is an error, skip it.',
    ].join('\n'),
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

  var AGGREGATOR_PROMPT = [
    'You are the Aggregation Agent. You receive the output from specialist',
    'analysis agents who have each examined a piece of writing through a different',
    'lens. Your job is to merge, deduplicate, and structure their feedback into',
    'a single coherent list.',
    '',
    'INSTRUCTIONS:',
    '1. Combine all feedback items from all agents into one list.',
    '2. MERGE items that refer to the same issue from different angles.',
    '   When merging, keep the strongest explanation and most specific quote.',
    '   Note which specialist perspectives contributed (e.g., "Identified by',
    '   both the argument logic and evidence specialists").',
    '3. DEDUPLICATE items that are substantively identical.',
    '4. For each item, ensure it has:',
    '   - "id": sequential integer starting from 1',
    '   - "quote": the exact shortest unique substring from the original text',
    '     that anchors this comment (10-40 words preferred)',
    '   - "title": clear, specific, 3-8 word title',
    '   - "category": primary category (argument_logic | evidence | clarity |',
    '     math_empirical | structure | counterargument)',
    '   - "severity": critical | important | suggestion',
    '   - "explanation": substantive explanation (2-5 sentences)',
    '   - "suggestion": concrete, actionable recommendation (1-3 sentences)',
    '   - "agents": array of which specialist agents flagged this',
    '5. Order by severity (critical first), then by position in the document.',
    '6. If two items conflict, keep both but note the disagreement.',
    '',
    'CROSS-AGENT EVIDENCE SYNTHESIS:',
    'When merging feedback, pay special attention to cases where multiple agents have',
    'found related information about the same underlying issue from different angles.',
    'For example:',
    '- If the Evidence Auditor found that a cited statistic is outdated AND the',
    '  Steelman Agent found a more recent study with different conclusions, MERGE',
    '  these into a single powerful feedback item that presents both the "this is',
    '  outdated" finding and the "here\'s what current evidence says" finding together.',
    '- If the Math Verifier found a calculation error AND the Argument Logic Analyst',
    '  found that the conclusion based on that calculation is a non-sequitur, MERGE',
    '  these into one item showing the cascading impact.',
    '- When merging items with web search sources, consolidate all source URLs into',
    '  the combined item\'s "sources" array.',
    '',
    'The goal is to produce feedback items that tell a complete story about an issue,',
    'drawing on every agent\'s perspective, rather than fragmenting related findings',
    'into separate items the author has to mentally connect.',
    '',
    'If any input feedback items contain a "sources" field (an array of objects with',
    'url, title, and finding), preserve these in the merged output. When merging items,',
    'concatenate their sources arrays and deduplicate by URL.',
    '',
    'OUTPUT: A JSON array of merged, deduplicated, structured feedback items.',
    'Return ONLY the JSON array.',
  ].join('\n');

  var CRITIC_PROMPT = [
    'You are the Quality Critic Agent. You receive aggregated feedback about a',
    'piece of writing and your job is to FILTER OUT low-quality feedback and',
    'STRENGTHEN good feedback. You are the last line of defense against slop.',
    '',
    'You will receive:',
    '1. The original text',
    '2. The aggregated feedback items (JSON array)',
    '',
    'For EACH feedback item, evaluate:',
    '',
    'REMOVE if any of these are true:',
    '- The comment is vague enough to apply to any piece of writing',
    '  (e.g., "consider adding more evidence" without specifying WHERE or WHAT)',
    '- The comment is based on a misreading of the text (re-read the quoted',
    '  passage IN CONTEXT \u2014 does the author actually say what the comment claims?)',
    '- The comment is purely about style preference with no substantive impact',
    '- The comment is redundant with a higher-quality item already in the list',
    '- The comment flags something the author explicitly addresses elsewhere in the text',
    '- The comment\'s suggestion would actually make the writing worse',
    '',
    'STRENGTHEN (edit in place) if:',
    '- The explanation is correct but could be more specific',
    '- The suggestion is generic when it could be concrete',
    '- The severity is miscalibrated (e.g., a clear error marked as "suggestion")',
    '',
    'KEEP AS-IS if:',
    '- The comment is specific, accurate, well-calibrated, and actionable',
    '',
    'If any items contain a "sources" field with web search citations, preserve it.',
    '',
    'OUTPUT: The filtered and refined JSON array. Include ONLY items that survive',
    'the filter. Each item should have the same schema as the input.',
    'Renumber the "id" fields sequentially from 1.',
    '',
    'CRITICAL: Be aggressive about filtering. A feedback report with 8 excellent',
    'comments is far more valuable than one with 25 mediocre ones. The user is',
    'an analytical writer who will be annoyed by obvious or generic feedback.',
    'Aim for the quality bar of "comments an excellent research assistant would',
    'produce by studying your work for days."',
    '',
    'Return ONLY the JSON array.',
  ].join('\n');

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
   * Handles web search and tool-use responses that have multiple content blocks.
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
   */
  async function callClaude(connConfig, systemPrompt, userMessage, attempt) {
    var data = await callClaudeRaw(connConfig, {
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }, attempt);

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
   */
  async function runAgentWithTools(connConfig, systemPrompt, userMessage, tools, agentName, onStatus) {
    var messages = [{ role: 'user', content: userMessage }];
    var agentSubAgentCount = 0;

    while (true) {
      var data = await callClaudeRaw(connConfig, {
        model: CONFIG.model,
        max_tokens: CONFIG.maxTokens,
        system: systemPrompt,
        messages: messages,
        tools: tools,
      });

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
   * @param {object} analysisOptions - { webSearch, deepResearch, grammar, mathWebSearch }
   */
  async function runPhase1(connConfig, document, onAgentUpdate, analysisOptions) {
    if (!analysisOptions) analysisOptions = {};

    // Build agent tasks (but don't start them yet)
    function buildAgentTask(agent) {
      var tools = [];
      var useWebSearch = false;
      var useSubAgents = false;

      if (analysisOptions.webSearch) {
        if (agent.webSearch) useWebSearch = true;
        if (agent.key === 'math' && analysisOptions.mathWebSearch) useWebSearch = true;
      }
      if (analysisOptions.mathWebSearch && agent.key === 'math') {
        useWebSearch = true;
      }
      if (analysisOptions.deepResearch && agent.subAgents) {
        useSubAgents = true;
      }

      if (useWebSearch) tools.push(WEB_SEARCH_TOOL);
      if (useSubAgents) tools.push(SUBAGENT_TOOL);

      var systemPrompt = SHARED_PREAMBLE + '\n\n' + agent.prompt;
      if (useWebSearch) {
        systemPrompt += WEB_SEARCH_PREAMBLE;
      }

      return { agent: agent, tools: tools, systemPrompt: systemPrompt, useWebSearch: useWebSearch, useSubAgents: useSubAgents };
    }

    function runSingleAgent(task) {
      var agent = task.agent;
      var tools = task.tools;
      var systemPrompt = task.systemPrompt;
      var useWebSearch = task.useWebSearch;
      var useSubAgents = task.useSubAgents;

      onAgentUpdate(agent.key, 'running', null);
      var startTime = Date.now();

      var agentPromise;
      if (tools.length > 0) {
        var statusLabel = [];
        if (useWebSearch) statusLabel.push('web search');
        if (useSubAgents) statusLabel.push('sub-agents');
        onAgentUpdate(agent.key, 'running', { tools: statusLabel });

        agentPromise = runAgentWithTools(
          connConfig, systemPrompt,
          'Here is the text to analyze:\n\n' + document,
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
          }
        ).then(function (text) {
          var feedback = parseJSON(text);
          var elapsed = Math.round((Date.now() - startTime) / 1000);
          onAgentUpdate(agent.key, 'complete', { items: feedback.length, elapsed: elapsed });
          return { key: agent.key, name: agent.name, status: 'fulfilled', feedback: feedback, error: null };
        });
      } else {
        agentPromise = callClaude(
          connConfig, systemPrompt,
          'Here is the text to analyze:\n\n' + document
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

      var grammarResult = await callClaudeRaw(connConfig, {
        model: CONFIG.grammarModel,
        max_tokens: CONFIG.maxTokens,
        system: GRAMMAR_AGENT_CONFIG.prompt,
        messages: [{ role: 'user', content: 'Here is the text to check for grammar, spelling, and punctuation errors:\n\n' + document }],
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

  async function runPhase2(connConfig, document, phase1Results) {
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

    var result = await callClaude(connConfig, AGGREGATOR_PROMPT, userMessage);
    return parseJSON(result.text);
  }

  async function runPhase3(connConfig, document, aggregated) {
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

    var result = await callClaude(connConfig, CRITIC_PROMPT, userMessage);
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
      clarity: 'Clarity & Exposition',
      math_empirical: 'Math & Empirical',
      structure: 'Structure & Coherence',
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
