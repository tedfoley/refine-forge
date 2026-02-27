/* ═══════════════════════════════════════════════════
   Forge — Main React Application
   v2: Sort, accept/dismiss, grammar, web search,
       sub-agents, pre-analysis options, cost estimation
   ═══════════════════════════════════════════════════ */

const { useState, useEffect, useRef, useCallback, useMemo } = React;

const MODEL_OPTIONS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Fast, cost-effective' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Most capable, slower' },
  { id: 'claude-sonnet-4-20250514', label: 'Sonnet 4', desc: 'Previous gen' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', desc: 'Fastest, cheapest' },
];

const CATEGORY_META = {
  argument_logic: { label: 'Argument', color: '#2563EB', cls: 'argument_logic' },
  evidence:       { label: 'Evidence', color: '#D97706', cls: 'evidence' },
  clarity:        { label: 'Clarity',  color: '#059669', cls: 'clarity' },
  math_empirical: { label: 'Math',     color: '#7C3AED', cls: 'math_empirical' },
  structure:      { label: 'Structure', color: '#475569', cls: 'structure' },
  counterargument:{ label: 'Counter',  color: '#E11D48', cls: 'counterargument' },
  grammar:        { label: 'Grammar',  color: '#64748B', cls: 'grammar' },
};

const SEVERITY_ORDER = { critical: 0, important: 1, suggestion: 2 };

const VALID_MODEL_IDS = new Set(MODEL_OPTIONS.map(m => m.id));

function getValidModel() {
  const stored = localStorage.getItem('forge-model');
  if (stored && VALID_MODEL_IDS.has(stored)) return stored;
  return MODEL_OPTIONS[0].id;
}

/* ─── Utility: simple hash for localStorage keys ── */
function simpleHash(str) {
  var hash = 0;
  var sub = str.substring(0, 100);
  for (var i = 0; i < sub.length; i++) {
    hash = ((hash << 5) - hash) + sub.charCodeAt(i);
    hash |= 0;
  }
  return 'forge-res-' + Math.abs(hash).toString(36);
}

/* ─── App Component ────────────────────────────── */

function App() {
  const [connMode, setConnMode] = useState(
    () => localStorage.getItem('forge-conn-mode') || 'proxy'
  );
  const [workerUrl, setWorkerUrl] = useState(
    () => localStorage.getItem('forge-worker-url') || 'https://refine-forge-proxy.tedfoley7.workers.dev'
  );
  const [apiKey, setApiKey] = useState(
    () => localStorage.getItem('forge-api-key') || ''
  );
  const [model, setModel] = useState(
    () => getValidModel()
  );
  const [view, setView] = useState('input');
  const [inputText, setInputText] = useState('');
  const [phase, setPhase] = useState(null);
  const [agentStatuses, setAgentStatuses] = useState({});
  const [feedbackItems, setFeedbackItems] = useState([]);
  const [grammarItems, setGrammarItems] = useState([]);
  const [activeFeedbackId, setActiveFeedbackId] = useState(null);
  const [totalTime, setTotalTime] = useState(0);
  const [error, setError] = useState(null);
  const [thinkingMsg, setThinkingMsg] = useState('');
  const [filters, setFilters] = useState({ severity: 'all', category: 'all' });
  const [showExport, setShowExport] = useState(false);

  // v2 state
  const [sortMode, setSortMode] = useState('relevance'); // 'relevance' | 'position'
  const [resolutions, setResolutions] = useState({}); // { id: 'accepted'|'dismissed'|null }
  const [showResolved, setShowResolved] = useState(false);
  const [documentPositions, setDocumentPositions] = useState({}); // { id: charOffset }
  const [analysisOptions, setAnalysisOptions] = useState({
    webSearch: true,
    deepResearch: false,
    grammar: false,
    mathWebSearch: false,
  });

  useEffect(() => {
    localStorage.setItem('forge-conn-mode', connMode);
  }, [connMode]);
  useEffect(() => {
    if (workerUrl) localStorage.setItem('forge-worker-url', workerUrl);
  }, [workerUrl]);
  useEffect(() => {
    if (apiKey) localStorage.setItem('forge-api-key', apiKey);
  }, [apiKey]);
  useEffect(() => {
    localStorage.setItem('forge-model', model);
    ForgeAgents.CONFIG.model = model;
  }, [model]);

  const connConfig = useMemo(() => {
    if (connMode === 'proxy') {
      return { mode: 'proxy', workerUrl: workerUrl.trim() };
    }
    return { mode: 'direct', apiKey: apiKey.trim() };
  }, [connMode, workerUrl, apiKey]);

  const isConnReady = connMode === 'proxy'
    ? workerUrl.trim().length > 0
    : apiKey.trim().length > 0 && apiKey !== 'REPLACE_WITH_YOUR_KEY';

  useEffect(() => {
    if (view !== 'analyzing') return;
    let msgs;
    if (phase === 'phase1') msgs = ForgeAgents.THINKING_MESSAGES;
    else if (phase === 'phase2') msgs = ForgeAgents.PHASE2_MESSAGES;
    else if (phase === 'phase3') msgs = ForgeAgents.PHASE3_MESSAGES;
    else return;

    let idx = 0;
    setThinkingMsg(msgs[0]);
    const interval = setInterval(() => {
      idx = (idx + 1) % msgs.length;
      setThinkingMsg(msgs[idx]);
    }, 4000);
    return () => clearInterval(interval);
  }, [view, phase]);

  // Load resolutions from localStorage when results are set
  useEffect(() => {
    if (feedbackItems.length === 0 || !inputText) return;
    const key = simpleHash(inputText);
    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        setResolutions(JSON.parse(stored));
      }
    } catch (_) {}
  }, [feedbackItems, inputText]);

  // Save resolutions to localStorage when they change
  useEffect(() => {
    if (feedbackItems.length === 0 || !inputText) return;
    const key = simpleHash(inputText);
    try {
      localStorage.setItem(key, JSON.stringify(resolutions));
    } catch (_) {}
  }, [resolutions, feedbackItems, inputText]);

  const handleAnalyze = useCallback(async () => {
    if (!inputText.trim() || !isConnReady) return;

    setView('analyzing');
    setError(null);
    setFeedbackItems([]);
    setGrammarItems([]);
    setActiveFeedbackId(null);
    setFilters({ severity: 'all', category: 'all' });
    setSortMode('relevance');
    setResolutions({});
    setShowResolved(false);
    setDocumentPositions({});
    ForgeAgents.resetUsage();

    const startTime = Date.now();
    const initStatuses = {};
    ForgeAgents.AGENT_CONFIGS.forEach(a => {
      initStatuses[a.key] = { status: 'pending', elapsed: 0, items: 0, error: null };
    });
    if (analysisOptions.grammar) {
      initStatuses['grammar'] = { status: 'pending', elapsed: 0, items: 0, error: null };
    }
    setAgentStatuses(initStatuses);

    try {
      // Phase 1
      setPhase('phase1');
      const phase1Results = await ForgeAgents.runPhase1(
        connConfig,
        inputText,
        (agentKey, status, detail) => {
          setAgentStatuses(prev => ({
            ...prev,
            [agentKey]: {
              status,
              elapsed: detail?.elapsed || prev[agentKey]?.elapsed || 0,
              items: detail?.items || 0,
              error: detail?.error || null,
              tools: detail?.tools || null,
              subAgent: detail?.subAgent || null,
              subAgentCount: detail?.subAgentCount || 0,
              subAgentDone: detail?.subAgentDone || false,
            },
          }));
        },
        analysisOptions
      );

      // Separate grammar results from specialist results
      const specialistResults = phase1Results.filter(r => !r.isGrammar);
      const grammarResult = phase1Results.find(r => r.isGrammar);

      const successCount = specialistResults.filter(r => r.status === 'fulfilled').length;
      if (successCount === 0) {
        throw new Error('All specialist agents failed. Please check your connection settings and try again.');
      }

      // Phase 2
      setPhase('phase2');
      let aggregated;
      try {
        aggregated = await ForgeAgents.runPhase2(connConfig, inputText, specialistResults);
      } catch (err) {
        console.warn('Aggregator failed, using raw specialist output:', err);
        aggregated = [];
        let id = 1;
        specialistResults.forEach(r => {
          r.feedback.forEach(item => {
            aggregated.push({ ...item, id: id++, agents: [r.name] });
          });
        });
      }

      if (aggregated.length === 0 && (!grammarResult || grammarResult.feedback.length === 0)) {
        setFeedbackItems([]);
        setTotalTime(Math.round((Date.now() - startTime) / 1000));
        setPhase(null);
        setView('results');
        return;
      }

      // Phase 3
      setPhase('phase3');
      let finalFeedback;
      if (aggregated.length > 0) {
        try {
          finalFeedback = await ForgeAgents.runPhase3(connConfig, inputText, aggregated);
        } catch (err) {
          console.warn('Critic failed, using aggregated output:', err);
          finalFeedback = aggregated;
        }
      } else {
        finalFeedback = [];
      }

      // Renumber feedback
      finalFeedback = finalFeedback.map((item, idx) => ({ ...item, id: idx + 1 }));

      // Append grammar items with continuing IDs (bypasses aggregator/critic)
      let grammarFeedback = [];
      if (grammarResult && grammarResult.feedback.length > 0) {
        const startId = finalFeedback.length + 1;
        grammarFeedback = grammarResult.feedback.map((item, idx) => ({
          ...item,
          id: startId + idx,
          category: 'grammar',
          severity: 'suggestion',
        }));
      }

      const allItems = finalFeedback.concat(grammarFeedback);

      // Compute document positions
      const positions = ForgeMatching.computeDocumentPositions(inputText, allItems);

      setFeedbackItems(finalFeedback);
      setGrammarItems(grammarFeedback);
      setDocumentPositions(positions);
      setTotalTime(Math.round((Date.now() - startTime) / 1000));

      // Load existing resolutions for this text
      const resKey = simpleHash(inputText);
      try {
        const stored = localStorage.getItem(resKey);
        if (stored) setResolutions(JSON.parse(stored));
      } catch (_) {}

      setPhase(null);
      setView('results');

    } catch (err) {
      setError(err.message);
      setView('input');
      setPhase(null);
    }
  }, [inputText, connConfig, isConnReady, analysisOptions]);

  const handleNewAnalysis = useCallback(() => {
    setView('input');
    setFeedbackItems([]);
    setGrammarItems([]);
    setActiveFeedbackId(null);
    setPhase(null);
    setError(null);
    setFilters({ severity: 'all', category: 'all' });
    setSortMode('relevance');
    setResolutions({});
    setShowResolved(false);
    setDocumentPositions({});
  }, []);

  const handleResolve = useCallback((id, resolution) => {
    setResolutions(prev => {
      const current = prev[id];
      const next = current === resolution ? null : resolution;
      return { ...prev, [id]: next };
    });
  }, []);

  // Combined feedback + grammar items
  const allFeedbackItems = useMemo(() => {
    return feedbackItems.concat(grammarItems);
  }, [feedbackItems, grammarItems]);

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Header showNewButton={view === 'results'} onNewAnalysis={handleNewAnalysis} />

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}

      {view === 'input' && (
        <InputView
          text={inputText}
          onTextChange={setInputText}
          onAnalyze={handleAnalyze}
          connMode={connMode}
          onConnModeChange={setConnMode}
          workerUrl={workerUrl}
          onWorkerUrlChange={setWorkerUrl}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          isConnReady={isConnReady}
          model={model}
          onModelChange={setModel}
          analysisOptions={analysisOptions}
          onAnalysisOptionsChange={setAnalysisOptions}
          wordCount={inputText.trim().length > 0 ? inputText.trim().split(/\s+/).length : 0}
        />
      )}

      {view === 'analyzing' && (
        <ProgressView
          phase={phase}
          agentStatuses={agentStatuses}
          thinkingMsg={thinkingMsg}
          analysisOptions={analysisOptions}
        />
      )}

      {view === 'results' && (
        <ResultsView
          text={inputText}
          feedbackItems={allFeedbackItems}
          activeFeedbackId={activeFeedbackId}
          onActiveFeedbackChange={setActiveFeedbackId}
          filters={filters}
          onFiltersChange={setFilters}
          totalTime={totalTime}
          onExport={() => setShowExport(true)}
          sortMode={sortMode}
          onSortModeChange={setSortMode}
          resolutions={resolutions}
          onResolve={handleResolve}
          showResolved={showResolved}
          onShowResolvedChange={setShowResolved}
          documentPositions={documentPositions}
          grammarCount={grammarItems.length}
        />
      )}

      {showExport && (
        <ExportModal
          feedbackItems={allFeedbackItems}
          onClose={() => setShowExport(false)}
        />
      )}
    </div>
  );
}

/* ─── Header ───────────────────────────────────── */

function Header({ showNewButton, onNewAnalysis }) {
  return (
    <header className="forge-header">
      <h1>
        FORGE
        <span>Deep AI Writing Analysis</span>
      </h1>
      {showNewButton && (
        <button
          onClick={onNewAnalysis}
          className="btn-secondary"
          style={{ padding: '8px 20px', fontSize: '13px', fontWeight: 500, borderRadius: '6px', cursor: 'pointer', fontFamily: "'DM Sans', sans-serif" }}
        >
          New Analysis
        </button>
      )}
    </header>
  );
}

/* ─── Input View ───────────────────────────────── */

function InputView({
  text, onTextChange, onAnalyze, connMode, onConnModeChange, workerUrl, onWorkerUrlChange,
  apiKey, onApiKeyChange, isConnReady, model, onModelChange,
  analysisOptions, onAnalysisOptionsChange, wordCount,
}) {
  const canAnalyze = text.trim().length > 50 && isConnReady;

  const toggleOption = (key) => {
    onAnalysisOptionsChange(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Cost estimation
  const costEstimate = useMemo(() => {
    let low = 0.15, high = 0.30;
    if (analysisOptions.webSearch) { low = 0.20; high = 0.50; }
    if (analysisOptions.deepResearch) { low = 0.50; high = 2.00; }
    if (analysisOptions.grammar) { low += 0.02; high += 0.05; }
    if (analysisOptions.mathWebSearch) { low += 0.02; high += 0.10; }
    return '$' + low.toFixed(2) + '-' + high.toFixed(2);
  }, [analysisOptions]);

  return (
    <div className="input-view">
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className={`filter-pill ${connMode === 'proxy' ? 'active' : ''}`}
            onClick={() => onConnModeChange('proxy')}
            style={{ fontSize: 13 }}
          >Proxy (recommended)</button>
          <button
            className={`filter-pill ${connMode === 'direct' ? 'active' : ''}`}
            onClick={() => onConnModeChange('direct')}
            style={{ fontSize: 13 }}
          >Direct API Key</button>

          <span style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0, margin: '0 4px' }} />

          <label style={{ fontSize: 13, fontWeight: 600, color: '#6B7280' }}>Model:</label>
          <select
            value={model}
            onChange={e => onModelChange(e.target.value)}
            style={{
              fontSize: 13, padding: '5px 10px', borderRadius: 6,
              border: '1px solid rgba(0,0,0,0.1)', background: 'white',
              fontFamily: "'DM Sans', sans-serif", cursor: 'pointer',
            }}
          >
            {MODEL_OPTIONS.map(m => (
              <option key={m.id} value={m.id}>{m.label} — {m.desc}</option>
            ))}
          </select>
        </div>

        {connMode === 'proxy' ? (
          <>
            <div className="api-key-inner">
              <label>Worker URL</label>
              <input
                type="text"
                value={workerUrl}
                onChange={e => onWorkerUrlChange(e.target.value)}
                placeholder="https://forge-proxy.your-name.workers.dev"
                spellCheck={false}
              />
            </div>
            {!workerUrl.trim() && (
              <p style={{ fontSize: 13, color: '#6B7280', margin: '8px 0 0', lineHeight: 1.5 }}>
                Enter the URL of your Cloudflare Worker proxy. Your API key stays server-side and is never sent to the browser. See <code style={{ fontSize: 12, background: '#F3F4F6', padding: '1px 4px', borderRadius: 3 }}>worker.js</code> in the repo for setup instructions.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="api-key-inner">
              <label>Anthropic API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={e => onApiKeyChange(e.target.value)}
                placeholder="sk-ant-..."
                spellCheck={false}
              />
            </div>
            {!isConnReady && (
              <p style={{ fontSize: 13, color: '#DC2626', margin: '8px 0 0', lineHeight: 1.4 }}>
                Enter your Anthropic API key. It is stored only in your browser's localStorage and sent directly to the Anthropic API.
              </p>
            )}
          </>
        )}
      </div>

      <textarea
        value={text}
        onChange={e => onTextChange(e.target.value)}
        placeholder={"Paste your essay, blog post, or analytical paper here...\n\nSupports plain text and Markdown. For best results, include the full text \u2014 the analysis agents examine the entire document holistically."}
        spellCheck={false}
      />

      {/* Pre-analysis options */}
      <div className="analysis-options">
        <div className="analysis-options-title">Analysis Options</div>

        <ToggleOption
          checked={analysisOptions.webSearch}
          onChange={() => toggleOption('webSearch')}
          label="Web Search"
          subtitle="Verify claims against the web (recommended)"
        />
        <ToggleOption
          checked={analysisOptions.deepResearch}
          onChange={() => toggleOption('deepResearch')}
          label="Deep Research Mode"
          subtitle="Agents can spawn sub-agents for deeper verification"
        />
        <ToggleOption
          checked={analysisOptions.grammar}
          onChange={() => toggleOption('grammar')}
          label="Grammar Check"
          subtitle="Also check grammar, spelling & punctuation"
        />
        <ToggleOption
          checked={analysisOptions.mathWebSearch}
          onChange={() => toggleOption('mathWebSearch')}
          label="Math Verifier Web Search"
          subtitle="Enable web search for quantitative verification"
        />

        <div style={{ fontSize: 12, color: '#9CA3AF', marginTop: 8 }}>
          Estimated cost: {costEstimate} based on selected options
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <button className="analyze-btn" onClick={onAnalyze} disabled={!canAnalyze}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Analyze
        </button>
        {text.trim().length > 0 && text.trim().length <= 50 && (
          <span style={{ fontSize: 13, color: '#9CA3AF' }}>
            Please enter at least 50 characters of text
          </span>
        )}
        {canAnalyze && (
          <span style={{ fontSize: 13, color: '#9CA3AF' }}>
            ~{wordCount} words &middot; {analysisOptions.grammar ? '7' : '6'} agents will analyze your text
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── Toggle Option ─────────────────────────────── */

function ToggleOption({ checked, onChange, label, subtitle }) {
  return (
    <label className="toggle-option">
      <div className="toggle-option-text">
        <span className="toggle-option-label">{label}</span>
        <span className="toggle-option-subtitle">{subtitle}</span>
      </div>
      <div className={`toggle-switch ${checked ? 'active' : ''}`} onClick={onChange}>
        <div className="toggle-knob" />
      </div>
    </label>
  );
}

/* ─── Progress View ────────────────────────────── */

function ProgressView({ phase, agentStatuses, thinkingMsg, analysisOptions }) {
  const phaseLabels = { phase1: 'Phase 1 of 3', phase2: 'Phase 2 of 3', phase3: 'Phase 3 of 3' };
  const phaseTitles = { phase1: 'Specialist Analysis', phase2: 'Aggregation & Deduplication', phase3: 'Quality Filtering' };

  const agents = ForgeAgents.AGENT_CONFIGS;
  const allAgentKeys = agents.map(a => a.key).concat(analysisOptions.grammar ? ['grammar'] : []);

  const completeCount = allAgentKeys.filter(k => agentStatuses[k]?.status === 'complete').length;
  const errorCount = allAgentKeys.filter(k => agentStatuses[k]?.status === 'error').length;
  const runningCount = allAgentKeys.filter(k => agentStatuses[k]?.status === 'running').length;
  const totalAgents = allAgentKeys.length;

  return (
    <div className="progress-view">
      <p className="phase-label">{phaseLabels[phase] || 'Analyzing'}</p>
      <h2 className="phase-title">{phaseTitles[phase] || 'Processing...'}</h2>

      {phase === 'phase1' && (
        <>
          <div className="agent-grid">
            {agents.map(agent => {
              const st = agentStatuses[agent.key] || { status: 'pending' };
              return (
                <div key={agent.key} className={`agent-card ${st.status}`}>
                  <div className="agent-card-icon">{agent.icon}</div>
                  <div className="agent-card-name">{agent.name}</div>
                  <div className="agent-card-status">
                    {st.status === 'pending' && <span style={{ color: '#9CA3AF' }}>&mdash; Pending</span>}
                    {st.status === 'running' && (
                      <>
                        <span className="spinner-inline" />
                        <span>
                          Analyzing{st.tools ? ' (with ' + st.tools.join(', ') + ')' : ''}...
                        </span>
                      </>
                    )}
                    {st.status === 'complete' && <><span className="check">&#10003;</span><span>Complete ({st.items} item{st.items !== 1 ? 's' : ''})</span></>}
                    {st.status === 'error' && <span style={{ color: '#DC2626' }}>Failed</span>}
                  </div>
                  {st.subAgent && st.status === 'running' && (
                    <div className="sub-agent-indicator">
                      <span>&#8627; Sub-agent researching: {st.subAgent}...</span>
                      <span className="sub-agent-count">{st.subAgentCount} of 3 sub-agents used</span>
                    </div>
                  )}
                  {st.subAgentDone && !st.subAgent && st.subAgentCount > 0 && st.status === 'running' && (
                    <div className="sub-agent-indicator">
                      <span>&#8627; Sub-agent complete &#10003;</span>
                      <span className="sub-agent-count">{st.subAgentCount} of 3 sub-agents used</span>
                    </div>
                  )}
                </div>
              );
            })}
            {analysisOptions.grammar && (
              <div className={`agent-card ${(agentStatuses['grammar'] || {}).status || 'pending'}`} style={{ borderStyle: 'dashed' }}>
                <div className="agent-card-icon">{ForgeAgents.GRAMMAR_AGENT_CONFIG.icon}</div>
                <div className="agent-card-name">{ForgeAgents.GRAMMAR_AGENT_CONFIG.name}</div>
                <div className="agent-card-status">
                  {(() => {
                    const st = agentStatuses['grammar'] || { status: 'pending' };
                    if (st.status === 'pending') return <span style={{ color: '#9CA3AF' }}>&mdash; Pending</span>;
                    if (st.status === 'running') return <><span className="spinner-inline" /><span>Checking grammar...</span></>;
                    if (st.status === 'complete') return <><span className="check">&#10003;</span><span>Complete ({st.items} item{st.items !== 1 ? 's' : ''})</span></>;
                    if (st.status === 'error') return <span style={{ color: '#DC2626' }}>Failed</span>;
                    return null;
                  })()}
                </div>
              </div>
            )}
          </div>
          <p style={{ textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
            {completeCount + errorCount} of {totalAgents} agents complete
            {runningCount > 0 ? ` \u00b7 ${runningCount} running` : ''}
          </p>
        </>
      )}

      {(phase === 'phase2' || phase === 'phase3') && (
        <div className="simple-progress">
          <div className="spinner-inline" style={{ width: 28, height: 28, borderWidth: 3, margin: '0 auto 16px' }} />
          <p style={{ fontSize: 15, color: '#374151', fontWeight: 500 }}>
            {phase === 'phase2'
              ? 'Merging and deduplicating specialist feedback...'
              : 'Quality-filtering and strengthening feedback...'}
          </p>
        </div>
      )}

      <p className="thinking-message">{thinkingMsg}</p>
    </div>
  );
}

/* ─── Results View ─────────────────────────────── */

function ResultsView({
  text, feedbackItems, activeFeedbackId, onActiveFeedbackChange,
  filters, onFiltersChange, totalTime, onExport,
  sortMode, onSortModeChange, resolutions, onResolve,
  showResolved, onShowResolvedChange, documentPositions, grammarCount,
}) {
  const filteredItems = useMemo(() => {
    let items = feedbackItems.filter(item => {
      if (filters.severity !== 'all' && item.severity !== filters.severity) return false;
      if (filters.category !== 'all' && item.category !== filters.category) return false;
      // Hide resolved items when showResolved is off
      if (!showResolved && resolutions[item.id]) return false;
      return true;
    });

    // Sort
    if (sortMode === 'position') {
      items = items.slice().sort((a, b) => {
        const posA = documentPositions[a.id] !== undefined ? documentPositions[a.id] : Infinity;
        const posB = documentPositions[b.id] !== undefined ? documentPositions[b.id] : Infinity;
        return posA - posB;
      });
    } else {
      // Relevance: severity first, then document position
      items = items.slice().sort((a, b) => {
        const sevA = SEVERITY_ORDER[a.severity] !== undefined ? SEVERITY_ORDER[a.severity] : 3;
        const sevB = SEVERITY_ORDER[b.severity] !== undefined ? SEVERITY_ORDER[b.severity] : 3;
        if (sevA !== sevB) return sevA - sevB;
        const posA = documentPositions[a.id] !== undefined ? documentPositions[a.id] : Infinity;
        const posB = documentPositions[b.id] !== undefined ? documentPositions[b.id] : Infinity;
        return posA - posB;
      });
    }

    return items;
  }, [feedbackItems, filters, sortMode, documentPositions, showResolved, resolutions]);

  // Items shown in text panel (includes resolved if showResolved is on)
  const textPanelItems = useMemo(() => {
    return feedbackItems.filter(item => {
      if (filters.severity !== 'all' && item.severity !== filters.severity) return false;
      if (filters.category !== 'all' && item.category !== filters.category) return false;
      return true;
    });
  }, [feedbackItems, filters]);

  const counts = useMemo(() => {
    const substantive = feedbackItems.filter(i => i.category !== 'grammar');
    const c = { total: substantive.length, critical: 0, important: 0, suggestion: 0, grammar: grammarCount };
    substantive.forEach(item => { if (c[item.severity] !== undefined) c[item.severity]++; });
    return c;
  }, [feedbackItems, grammarCount]);

  const resolvedCount = useMemo(() => {
    return Object.values(resolutions).filter(v => v === 'accepted' || v === 'dismissed').length;
  }, [resolutions]);

  const visibleCount = filteredItems.length;
  const totalCount = feedbackItems.length;

  const scrollToFeedback = useCallback((id) => {
    onActiveFeedbackChange(id);
    const el = document.getElementById('feedback-' + id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('active');
      setTimeout(() => el.classList.remove('active'), 2000);
    }
  }, [onActiveFeedbackChange]);

  const scrollToText = useCallback((id) => {
    onActiveFeedbackChange(id);
    const el = document.getElementById('text-anchor-' + id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('pulse');
      setTimeout(() => el.classList.remove('pulse'), 1000);
    }
  }, [onActiveFeedbackChange]);

  const usage = ForgeAgents.getUsage();
  const totalTokens = usage.input_tokens + usage.output_tokens;

  const presentCategories = useMemo(() => {
    const cats = new Set();
    feedbackItems.forEach(item => cats.add(item.category));
    return Array.from(cats);
  }, [feedbackItems]);

  return (
    <div className="results-view">
      <SummaryBar counts={counts} resolvedCount={resolvedCount} visibleCount={visibleCount} totalCount={totalCount} showResolved={showResolved} />
      <FilterBar
        filters={filters}
        onFiltersChange={onFiltersChange}
        categories={presentCategories}
        sortMode={sortMode}
        onSortModeChange={onSortModeChange}
        showResolved={showResolved}
        onShowResolvedChange={onShowResolvedChange}
        resolvedCount={resolvedCount}
      />

      <div className="split-panel">
        <div className="text-panel">
          <TextPanel text={text} feedbackItems={textPanelItems} onHighlightClick={scrollToFeedback} resolutions={showResolved ? {} : resolutions} />
        </div>
        <div className="feedback-panel">
          {filteredItems.length === 0 ? (
            <div className="no-feedback">
              {feedbackItems.length === 0
                ? 'No issues found. Your writing passed all checks.'
                : 'No items match the current filters.'}
            </div>
          ) : (
            filteredItems.map(item => (
              <FeedbackCard
                key={item.id}
                item={item}
                isActive={activeFeedbackId === item.id}
                onQuoteClick={() => scrollToText(item.id)}
                resolution={resolutions[item.id] || null}
                onResolve={onResolve}
              />
            ))
          )}
        </div>
      </div>

      <div className="stats-bar">
        <span>
          Analysis complete &middot; {presentCategories.includes('grammar') ? '7' : '6'} agents
          {usage.subAgents > 0 ? ', ' + usage.subAgents + ' sub-agent' + (usage.subAgents !== 1 ? 's' : '') : ''}
          {' \u00b7 '}{formatTime(totalTime)}
          {totalTokens > 0 && ` \u00b7 ~${formatTokens(totalTokens)} tokens`}
          {usage.webSearches > 0 && `, ${usage.webSearches} web search${usage.webSearches !== 1 ? 'es' : ''}`}
        </span>
        <button onClick={onExport}>Export Markdown</button>
      </div>
    </div>
  );
}

/* ─── Summary Bar ──────────────────────────────── */

function SummaryBar({ counts, resolvedCount, visibleCount, totalCount, showResolved }) {
  return (
    <div className="summary-bar">
      <div className="summary-stats">
        <span style={{ fontWeight: 600 }}>
          {counts.total} comment{counts.total !== 1 ? 's' : ''}
          {counts.grammar > 0 && <span style={{ fontWeight: 400, color: '#64748B' }}> + {counts.grammar} grammar</span>}
        </span>
        {counts.critical > 0 && <span className="summary-stat"><span className="stat-dot" style={{ background: '#DC2626' }} />{counts.critical} critical</span>}
        {counts.important > 0 && <span className="summary-stat"><span className="stat-dot" style={{ background: '#D97706' }} />{counts.important} important</span>}
        {counts.suggestion > 0 && <span className="summary-stat"><span className="stat-dot" style={{ background: '#9CA3AF' }} />{counts.suggestion} suggestion{counts.suggestion !== 1 ? 's' : ''}</span>}
        {resolvedCount > 0 && !showResolved && (
          <span style={{ fontSize: 12, color: '#9CA3AF' }}>
            ({visibleCount} of {totalCount} shown)
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── Filter Bar ───────────────────────────────── */

function FilterBar({ filters, onFiltersChange, categories, sortMode, onSortModeChange, showResolved, onShowResolvedChange, resolvedCount }) {
  const toggleSeverity = (sev) => {
    onFiltersChange(prev => ({ ...prev, severity: prev.severity === sev ? 'all' : sev }));
  };
  const toggleCategory = (cat) => {
    onFiltersChange(prev => ({ ...prev, category: prev.category === cat ? 'all' : cat }));
  };

  return (
    <div className="filter-bar">
      <span style={{ fontSize: 12, fontWeight: 600, color: '#9CA3AF', marginRight: 4 }}>Filter:</span>
      <button
        className={`filter-pill ${filters.severity === 'all' && filters.category === 'all' ? 'active' : ''}`}
        onClick={() => onFiltersChange({ severity: 'all', category: 'all' })}
      >All</button>

      <span style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />

      {['critical', 'important', 'suggestion'].map(sev => (
        <button key={sev} className={`filter-pill ${filters.severity === sev ? 'active' : ''}`} onClick={() => toggleSeverity(sev)}>
          {sev.charAt(0).toUpperCase() + sev.slice(1)}
        </button>
      ))}

      <span style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />

      {categories.map(cat => {
        const meta = CATEGORY_META[cat];
        if (!meta) return null;
        return (
          <button key={cat} className={`filter-pill cat-${meta.cls} ${filters.category === cat ? 'active' : ''}`} onClick={() => toggleCategory(cat)}>
            {meta.label}
          </button>
        );
      })}

      <span style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />

      {/* Sort controls */}
      <span style={{ fontSize: 12, fontWeight: 600, color: '#9CA3AF', marginRight: 2 }}>Sort:</span>
      <button
        className={`filter-pill ${sortMode === 'relevance' ? 'active' : ''}`}
        onClick={() => onSortModeChange('relevance')}
      >Relevance</button>
      <button
        className={`filter-pill ${sortMode === 'position' ? 'active' : ''}`}
        onClick={() => onSortModeChange('position')}
      >Position</button>

      {/* Show resolved toggle */}
      {resolvedCount > 0 && (
        <>
          <span style={{ width: 1, height: 20, background: '#E5E7EB', flexShrink: 0 }} />
          <button
            className={`filter-pill ${showResolved ? 'active' : ''}`}
            onClick={() => onShowResolvedChange(!showResolved)}
          >
            Show resolved ({resolvedCount})
          </button>
        </>
      )}
    </div>
  );
}

/* ─── Text Panel ───────────────────────────────── */

function TextPanel({ text, feedbackItems, onHighlightClick, resolutions }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !text) return;
    // Strip leading indentation (4+ spaces) so Markdown doesn't render code blocks
    const cleaned = text.replace(/^[ \t]+/gm, (match) => {
      // Keep up to 3 spaces (safe for Markdown), collapse anything more
      const spaces = match.replace(/\t/g, '    ').length;
      return spaces >= 4 ? '   ' : match;
    });
    const html = marked.parse(cleaned, { breaks: true, gfm: true });
    containerRef.current.innerHTML = html;

    if (feedbackItems && feedbackItems.length > 0) {
      ForgeMatching.injectHighlights(containerRef.current, feedbackItems, onHighlightClick, resolutions);
    }
  }, [text, feedbackItems, onHighlightClick, resolutions]);

  return <div ref={containerRef} className="text-panel-content" />;
}

/* ─── Feedback Card ────────────────────────────── */

function FeedbackCard({ item, isActive, onQuoteClick, resolution, onResolve }) {
  const catMeta = CATEGORY_META[item.category] || { label: item.category, cls: '' };
  const isGrammar = item.category === 'grammar';
  const isAccepted = resolution === 'accepted';
  const isDismissed = resolution === 'dismissed';

  const cardClasses = [
    'feedback-card',
    'severity-' + item.severity,
    isActive ? 'active' : '',
    isGrammar ? 'grammar-card' : '',
    isAccepted ? 'resolved-accepted' : '',
    isDismissed ? 'resolved-dismissed' : '',
  ].filter(Boolean).join(' ');

  return (
    <div id={`feedback-${item.id}`} className={cardClasses}>
      <div className="feedback-card-header">
        <span className="feedback-id">{item.id}</span>
        <span className="feedback-title">
          {isAccepted && <span style={{ color: '#059669', marginRight: 4 }}>&#10003;</span>}
          {item.title}
        </span>
        <span className={`severity-badge ${item.severity}`}>{item.severity}</span>
        <span className={`category-badge ${catMeta.cls}`}>{catMeta.label}</span>

        {/* Accept/Dismiss buttons */}
        <div className="resolve-buttons">
          <button
            className={`resolve-btn accept ${isAccepted ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onResolve(item.id, 'accepted'); }}
            title="Accept"
          >&#10003;</button>
          <button
            className={`resolve-btn dismiss ${isDismissed ? 'active' : ''}`}
            onClick={(e) => { e.stopPropagation(); onResolve(item.id, 'dismissed'); }}
            title="Dismiss"
          >&times;</button>
        </div>
      </div>

      {item.quote && (
        <div className="feedback-quote" onClick={onQuoteClick} title="Click to jump to this passage">
          &ldquo;{item.quote}&rdquo;
        </div>
      )}

      {item.explanation && <div className="feedback-explanation">{item.explanation}</div>}

      {item.suggestion && (
        <div className="feedback-suggestion">
          <strong>Suggestion:</strong> {item.suggestion}
        </div>
      )}

      {item.sources && item.sources.length > 0 && (
        <div className="feedback-sources">
          <span className="feedback-sources-label">Sources:</span>
          {item.sources.map((src, idx) => (
            <div key={idx} className="feedback-source">
              <a href={src.url} target="_blank" rel="noopener noreferrer">
                {src.title || src.url}
              </a>
              {src.finding && <span> &mdash; {src.finding}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Export Modal ─────────────────────────────── */

function ExportModal({ feedbackItems, onClose }) {
  const markdown = useMemo(() => ForgeAgents.exportToMarkdown(feedbackItems), [feedbackItems]);

  const handleCopy = () => {
    navigator.clipboard.writeText(markdown).then(() => {
      alert('Copied to clipboard!');
    }).catch(() => {
      const pre = document.querySelector('.modal-body pre');
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
      }
    });
  };

  const handleDownload = () => {
    const blob = new Blob([markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'forge-analysis.md';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Export Analysis</h3>
          <button onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <pre>{markdown}</pre>
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={handleCopy}>Copy to Clipboard</button>
          <button className="btn-primary" onClick={handleDownload}>Download .md</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Utilities ────────────────────────────────── */

function formatTime(seconds) {
  if (seconds < 60) return seconds + 's';
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return min + 'm ' + sec + 's';
}

function formatTokens(n) {
  if (n < 1000) return String(n);
  return Math.round(n / 1000) + 'K';
}

/* ─── Mount ────────────────────────────────────── */

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
