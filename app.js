/* ═══════════════════════════════════════════════════
   Forge — Main React Application
   ═══════════════════════════════════════════════════ */

const { useState, useEffect, useRef, useCallback, useMemo } = React;

const CATEGORY_META = {
  argument_logic: { label: 'Argument', color: '#2563EB', cls: 'argument_logic' },
  evidence:       { label: 'Evidence', color: '#D97706', cls: 'evidence' },
  clarity:        { label: 'Clarity',  color: '#059669', cls: 'clarity' },
  math_empirical: { label: 'Math',     color: '#7C3AED', cls: 'math_empirical' },
  structure:      { label: 'Structure', color: '#475569', cls: 'structure' },
  counterargument:{ label: 'Counter',  color: '#E11D48', cls: 'counterargument' },
};

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
  const [view, setView] = useState('input');
  const [inputText, setInputText] = useState('');
  const [phase, setPhase] = useState(null);
  const [agentStatuses, setAgentStatuses] = useState({});
  const [feedbackItems, setFeedbackItems] = useState([]);
  const [activeFeedbackId, setActiveFeedbackId] = useState(null);
  const [totalTime, setTotalTime] = useState(0);
  const [error, setError] = useState(null);
  const [thinkingMsg, setThinkingMsg] = useState('');
  const [filters, setFilters] = useState({ severity: 'all', category: 'all' });
  const [showExport, setShowExport] = useState(false);

  useEffect(() => {
    localStorage.setItem('forge-conn-mode', connMode);
  }, [connMode]);
  useEffect(() => {
    if (workerUrl) localStorage.setItem('forge-worker-url', workerUrl);
  }, [workerUrl]);
  useEffect(() => {
    if (apiKey) localStorage.setItem('forge-api-key', apiKey);
  }, [apiKey]);

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

  const handleAnalyze = useCallback(async () => {
    if (!inputText.trim() || !isConnReady) return;

    setView('analyzing');
    setError(null);
    setFeedbackItems([]);
    setActiveFeedbackId(null);
    setFilters({ severity: 'all', category: 'all' });
    ForgeAgents.resetUsage();

    const startTime = Date.now();
    const initStatuses = {};
    ForgeAgents.AGENT_CONFIGS.forEach(a => {
      initStatuses[a.key] = { status: 'pending', elapsed: 0, items: 0, error: null };
    });
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
            },
          }));
        }
      );

      const successCount = phase1Results.filter(r => r.status === 'fulfilled').length;
      if (successCount === 0) {
        throw new Error('All specialist agents failed. Please check your connection settings and try again.');
      }

      // Phase 2
      setPhase('phase2');
      let aggregated;
      try {
        aggregated = await ForgeAgents.runPhase2(connConfig, inputText, phase1Results);
      } catch (err) {
        console.warn('Aggregator failed, using raw specialist output:', err);
        aggregated = [];
        let id = 1;
        phase1Results.forEach(r => {
          r.feedback.forEach(item => {
            aggregated.push({ ...item, id: id++, agents: [r.name] });
          });
        });
      }

      if (aggregated.length === 0) {
        setFeedbackItems([]);
        setTotalTime(Math.round((Date.now() - startTime) / 1000));
        setPhase(null);
        setView('results');
        return;
      }

      // Phase 3
      setPhase('phase3');
      let finalFeedback;
      try {
        finalFeedback = await ForgeAgents.runPhase3(connConfig, inputText, aggregated);
      } catch (err) {
        console.warn('Critic failed, using aggregated output:', err);
        finalFeedback = aggregated;
      }

      finalFeedback = finalFeedback.map((item, idx) => ({ ...item, id: idx + 1 }));

      setFeedbackItems(finalFeedback);
      setTotalTime(Math.round((Date.now() - startTime) / 1000));
      setPhase(null);
      setView('results');

    } catch (err) {
      setError(err.message);
      setView('input');
      setPhase(null);
    }
  }, [inputText, connConfig, isConnReady]);

  const handleNewAnalysis = useCallback(() => {
    setView('input');
    setFeedbackItems([]);
    setActiveFeedbackId(null);
    setPhase(null);
    setError(null);
    setFilters({ severity: 'all', category: 'all' });
  }, []);

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
        />
      )}

      {view === 'analyzing' && (
        <ProgressView
          phase={phase}
          agentStatuses={agentStatuses}
          thinkingMsg={thinkingMsg}
        />
      )}

      {view === 'results' && (
        <ResultsView
          text={inputText}
          feedbackItems={feedbackItems}
          activeFeedbackId={activeFeedbackId}
          onActiveFeedbackChange={setActiveFeedbackId}
          filters={filters}
          onFiltersChange={setFilters}
          totalTime={totalTime}
          onExport={() => setShowExport(true)}
        />
      )}

      {showExport && (
        <ExportModal
          feedbackItems={feedbackItems}
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

function InputView({ text, onTextChange, onAnalyze, connMode, onConnModeChange, workerUrl, onWorkerUrlChange, apiKey, onApiKeyChange, isConnReady }) {
  const canAnalyze = text.trim().length > 50 && isConnReady;

  return (
    <div className="input-view">
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
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
            ~{Math.round(text.split(/\s+/).length)} words &middot; 6 specialist agents will analyze your text
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── Progress View ────────────────────────────── */

function ProgressView({ phase, agentStatuses, thinkingMsg }) {
  const phaseLabels = { phase1: 'Phase 1 of 3', phase2: 'Phase 2 of 3', phase3: 'Phase 3 of 3' };
  const phaseTitles = { phase1: 'Specialist Analysis', phase2: 'Aggregation & Deduplication', phase3: 'Quality Filtering' };

  const agents = ForgeAgents.AGENT_CONFIGS;
  const completeCount = agents.filter(a => agentStatuses[a.key]?.status === 'complete').length;
  const errorCount = agents.filter(a => agentStatuses[a.key]?.status === 'error').length;
  const runningCount = agents.filter(a => agentStatuses[a.key]?.status === 'running').length;

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
                    {st.status === 'running' && <><span className="spinner-inline" /><span>Analyzing...</span></>}
                    {st.status === 'complete' && <><span className="check">&#10003;</span><span>Complete ({st.items} item{st.items !== 1 ? 's' : ''})</span></>}
                    {st.status === 'error' && <span style={{ color: '#DC2626' }}>Failed</span>}
                  </div>
                </div>
              );
            })}
          </div>
          <p style={{ textAlign: 'center', fontSize: 14, color: '#6B7280' }}>
            {completeCount + errorCount} of 6 agents complete
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
}) {
  const filteredItems = useMemo(() => {
    return feedbackItems.filter(item => {
      if (filters.severity !== 'all' && item.severity !== filters.severity) return false;
      if (filters.category !== 'all' && item.category !== filters.category) return false;
      return true;
    });
  }, [feedbackItems, filters]);

  const counts = useMemo(() => {
    const c = { total: feedbackItems.length, critical: 0, important: 0, suggestion: 0 };
    feedbackItems.forEach(item => { if (c[item.severity] !== undefined) c[item.severity]++; });
    return c;
  }, [feedbackItems]);

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
      <SummaryBar counts={counts} />
      <FilterBar filters={filters} onFiltersChange={onFiltersChange} categories={presentCategories} />

      <div className="split-panel">
        <div className="text-panel">
          <TextPanel text={text} feedbackItems={filteredItems} onHighlightClick={scrollToFeedback} />
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
              />
            ))
          )}
        </div>
      </div>

      <div className="stats-bar">
        <span>
          Analysis complete &middot; 6 agents &middot; {formatTime(totalTime)}
          {totalTokens > 0 && ` \u00b7 ~${formatTokens(totalTokens)} tokens`}
        </span>
        <button onClick={onExport}>Export Markdown</button>
      </div>
    </div>
  );
}

/* ─── Summary Bar ──────────────────────────────── */

function SummaryBar({ counts }) {
  return (
    <div className="summary-bar">
      <div className="summary-stats">
        <span style={{ fontWeight: 600 }}>{counts.total} comment{counts.total !== 1 ? 's' : ''}</span>
        {counts.critical > 0 && <span className="summary-stat"><span className="stat-dot" style={{ background: '#DC2626' }} />{counts.critical} critical</span>}
        {counts.important > 0 && <span className="summary-stat"><span className="stat-dot" style={{ background: '#D97706' }} />{counts.important} important</span>}
        {counts.suggestion > 0 && <span className="summary-stat"><span className="stat-dot" style={{ background: '#9CA3AF' }} />{counts.suggestion} suggestion{counts.suggestion !== 1 ? 's' : ''}</span>}
      </div>
    </div>
  );
}

/* ─── Filter Bar ───────────────────────────────── */

function FilterBar({ filters, onFiltersChange, categories }) {
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
    </div>
  );
}

/* ─── Text Panel ───────────────────────────────── */

function TextPanel({ text, feedbackItems, onHighlightClick }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current || !text) return;
    const html = marked.parse(text, { breaks: true, gfm: true });
    containerRef.current.innerHTML = html;

    if (feedbackItems && feedbackItems.length > 0) {
      ForgeMatching.injectHighlights(containerRef.current, feedbackItems, onHighlightClick);
    }
  }, [text, feedbackItems, onHighlightClick]);

  return <div ref={containerRef} className="text-panel-content" />;
}

/* ─── Feedback Card ────────────────────────────── */

function FeedbackCard({ item, isActive, onQuoteClick }) {
  const catMeta = CATEGORY_META[item.category] || { label: item.category, cls: '' };

  return (
    <div id={`feedback-${item.id}`} className={`feedback-card severity-${item.severity} ${isActive ? 'active' : ''}`}>
      <div className="feedback-card-header">
        <span className="feedback-id">{item.id}</span>
        <span className="feedback-title">{item.title}</span>
        <span className={`severity-badge ${item.severity}`}>{item.severity}</span>
        <span className={`category-badge ${catMeta.cls}`}>{catMeta.label}</span>
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
