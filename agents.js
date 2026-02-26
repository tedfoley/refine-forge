/**
 * Forge — Agent Prompts & API Logic
 * Multi-agent pipeline for deep writing analysis.
 */
(function () {
  'use strict';

  var CONFIG = {
    model: 'claude-sonnet-4-6-20250627',
    maxTokens: 16000,
    directApiUrl: 'https://api.anthropic.com/v1/messages',
    retryDelay: 2000,
    maxRetries: 1,
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

  var AGENT_CONFIGS = [
    {
      key: 'argument',
      name: 'Argument Structure',
      icon: '\uD83D\uDD0D',
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

  var AGGREGATOR_PROMPT = [
    'You are the Aggregation Agent. You receive the output from 6 specialist',
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

  function resetUsage() {
    totalUsage = { input_tokens: 0, output_tokens: 0 };
  }

  function getUsage() {
    return { input_tokens: totalUsage.input_tokens, output_tokens: totalUsage.output_tokens };
  }

  /**
   * Call the Anthropic Messages API.
   * @param {object} connConfig - { mode: 'proxy'|'direct', workerUrl?, apiKey? }
   */
  async function callClaude(connConfig, systemPrompt, userMessage, attempt) {
    if (!attempt) attempt = 0;

    var useProxy = connConfig.mode === 'proxy';
    var url = useProxy
      ? connConfig.workerUrl.replace(/\/+$/, '') + '/v1/messages'
      : CONFIG.directApiUrl;

    var headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (useProxy) {
      // Proxy injects the API key server-side; no key needed here
    } else {
      headers['x-api-key'] = connConfig.apiKey;
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
    }

    var response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          model: CONFIG.model,
          max_tokens: CONFIG.maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });
    } catch (err) {
      if (attempt < CONFIG.maxRetries) {
        await delay(CONFIG.retryDelay);
        return callClaude(connConfig, systemPrompt, userMessage, attempt + 1);
      }
      throw new Error('Network error: ' + err.message);
    }

    if (!response.ok) {
      var errBody = {};
      try { errBody = await response.json(); } catch (_) {}
      var errMsg = (errBody.error && errBody.error.message) || ('API error: ' + response.status);

      if ((response.status >= 500 || response.status === 429) && attempt < CONFIG.maxRetries) {
        await delay(CONFIG.retryDelay);
        return callClaude(connConfig, systemPrompt, userMessage, attempt + 1);
      }
      throw new Error(errMsg);
    }

    var data = await response.json();
    var text = data.content && data.content[0] && data.content[0].text || '';
    var usage = data.usage || { input_tokens: 0, output_tokens: 0 };

    totalUsage.input_tokens += usage.input_tokens;
    totalUsage.output_tokens += usage.output_tokens;

    return { text: text, usage: usage };
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

  async function runPhase1(connConfig, document, onAgentUpdate) {
    var promises = AGENT_CONFIGS.map(function (agent) {
      onAgentUpdate(agent.key, 'running', null);
      var startTime = Date.now();

      return callClaude(
        connConfig,
        SHARED_PREAMBLE + '\n\n' + agent.prompt,
        'Here is the text to analyze:\n\n' + document
      ).then(function (result) {
        var feedback = parseJSON(result.text);
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        onAgentUpdate(agent.key, 'complete', { items: feedback.length, elapsed: elapsed });
        return {
          key: agent.key,
          name: agent.name,
          status: 'fulfilled',
          feedback: feedback,
          error: null,
        };
      }).catch(function (err) {
        var elapsed = Math.round((Date.now() - startTime) / 1000);
        onAgentUpdate(agent.key, 'error', { error: err.message, elapsed: elapsed });
        return {
          key: agent.key,
          name: agent.name,
          status: 'rejected',
          feedback: [],
          error: err.message,
        };
      });
    });

    return Promise.all(promises);
  }

  async function runPhase2(connConfig, document, phase1Results) {
    var agentOutputs = phase1Results
      .filter(function (r) { return r.feedback.length > 0; })
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
  ];

  var PHASE2_MESSAGES = [
    'Merging overlapping insights from specialist agents\u2026',
    'Deduplicating feedback across all six specialists\u2026',
    'Reconciling different analytical perspectives\u2026',
    'Structuring feedback by severity and category\u2026',
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
    runPhase1: runPhase1,
    runPhase2: runPhase2,
    runPhase3: runPhase3,
    parseJSON: parseJSON,
    exportToMarkdown: exportToMarkdown,
    resetUsage: resetUsage,
    getUsage: getUsage,
    THINKING_MESSAGES: THINKING_MESSAGES,
    PHASE2_MESSAGES: PHASE2_MESSAGES,
    PHASE3_MESSAGES: PHASE3_MESSAGES,
  };
})();
