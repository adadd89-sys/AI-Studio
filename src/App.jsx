import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight,
  CircleHelp, Code2, Command, FolderKanban, GitBranch, LayoutDashboard,
  MessageSquare, Plus, Send, Settings2, ShieldCheck, Sparkles, Terminal,
  Users, Workflow, Zap, FileText, Save, RefreshCw, GitCommit, X, Gauge, BarChart3, MessageCircle
} from 'lucide-react';

const navigation = [
  { label: 'Обзор', icon: LayoutDashboard },
  { label: 'Проекты', icon: FolderKanban },
  { label: 'Команда ИИ', icon: Users },
  { label: 'Процессы', icon: Workflow },
  { label: 'Код и файлы', icon: Code2 },
  { label: 'Активность', icon: Activity },
  { label: 'Расход ресурсов', icon: BarChart3 }
];

const agents = [
  { name: 'Gemini 4 Hydrogen', model: 'Google Gemini API · резерв: Gemini 3.8 Flash', role: 'Руководитель и координатор', tone: 'blue', initials: 'Ge', key: 'gemini', detail: 'Разбирает запрос, формирует техническое задание, распределяет работу и объединяет результаты.' },
  { name: 'Gemma 4 26B', model: 'Cloudflare Workers AI · @cf/google/gemma-4-26b-a4b-it', role: 'Аналитик и контроль качества', tone: 'green', initials: 'G', key: 'gemma', detail: 'Независимо проверяет планы и код, выявляет риски, ошибки и недостающие тесты.' },
  { name: 'Qwen 3.8 27B', model: 'Cloudflare Workers AI · @cf/qwen/qwen3.8-27b', role: 'Основной разработчик', tone: 'violet', initials: 'Q', key: 'qwen', detail: 'Проектирует архитектуру, пишет и исправляет код.' },
  { name: 'Cohere North Mini Code', model: 'OpenRouter · cohere/north-mini-code:free', role: 'Дополнительный разработчик', tone: 'orange', initials: 'N', key: 'north', detail: 'Резервный кодовый агент. Нужен бесплатный ключ OpenRouter в секретах Cloudflare.' }
];


function CodeWorkspace() {
  const [branch, setBranch] = useState('main');
  const [branches, setBranches] = useState([]);
  const [files, setFiles] = useState([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [fileContent, setFileContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [fileSha, setFileSha] = useState(null);
  const [newBranch, setNewBranch] = useState('ai-studio/my-changes');
  const [newFilePath, setNewFilePath] = useState('');
  const [creatingFile, setCreatingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);

  async function api(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Ошибка GitHub API.');
    return data;
  }

  async function loadWorkspace(nextBranch = branch) {
    setLoading(true);
    setError('');
    try {
      const [branchData, treeData] = await Promise.all([
        api('/api/github/branches'),
        api('/api/github/tree?ref=' + encodeURIComponent(nextBranch))
      ]);
      setBranches(branchData.branches || []);
      setFiles(treeData.files || []);
      setBranch(nextBranch);
      if (selectedPath && !(treeData.files || []).some(file => file.path === selectedPath)) {
        setSelectedPath('');
        setFileContent('');
        setFileSha(null);
      }
    } catch (err) {
      setError(err.message || 'Не удалось загрузить репозиторий.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadWorkspace('main'); }, []);

  async function openFile(path) {
    setSelectedPath(path);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await api('/api/github/file?ref=' + encodeURIComponent(branch) + '&path=' + encodeURIComponent(path));
      setFileContent(data.content);
      setOriginalContent(data.content);
      setShowDiff(false);
      setFileSha(data.sha);
    } catch (err) {
      setError(err.message || 'Не удалось открыть файл.');
    } finally {
      setBusy(false);
    }
  }

  async function createBranch() {
    const name = newBranch.trim();
    if (!name || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/github/branch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branch: name })
      });
      setNotice('Ветка создана. Теперь можно редактировать файлы, не затрагивая main.');
      await loadWorkspace(name);
    } catch (err) {
      setError(err.message || 'Не удалось создать ветку.');
    } finally {
      setBusy(false);
    }
  }

  async function saveFile() {
    if (!selectedPath || branch === 'main' || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await api('/api/github/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, branch, content: fileContent, sha: fileSha, message: 'Update ' + selectedPath })
      });
      setFileSha(data.sha);
      setOriginalContent(fileContent);
      setShowDiff(false);
      setNotice('Изменения сохранены в ветку ' + branch + '. Коммит: ' + (data.commit || '').slice(0, 7));
      await loadWorkspace(branch);
    } catch (err) {
      setError(err.message || 'Не удалось сохранить файл.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile() {
    if (!selectedPath || branch === 'main' || busy) return;
    if (!window.confirm('Удалить файл ' + selectedPath + ' из ветки ' + branch + '?')) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/github/file', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, branch, sha: fileSha })
      });
      setNotice('Файл ' + selectedPath + ' удалён из ветки ' + branch + '.');
      setSelectedPath('');
      setFileContent('');
      setOriginalContent('');
      setFileSha(null);
      setShowDiff(false);
      await loadWorkspace(branch);
    } catch (err) {
      setError(err.message || 'Не удалось удалить файл.');
    } finally {
      setBusy(false);
    }
  }

  async function createFile() {
    const path = newFilePath.trim();
    if (!path || branch === 'main' || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api('/api/github/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, branch, content: '', sha: null, message: 'Create ' + path })
      });
      setNewFilePath('');
      setCreatingFile(false);
      setNotice('Новый файл создан в ветке ' + branch + '.');
      await loadWorkspace(branch);
      await openFile(path);
    } catch (err) {
      setError(err.message || 'Не удалось создать файл.');
    } finally {
      setBusy(false);
    }
  }

  return <section className="code-workspace">
    <div className="code-workspace-heading">
      <div><div className="eyebrow">GITHUB WORKSPACE</div><h2>Код и файлы</h2><p>adadd89-sys / AI-Studio · изменения сохраняются отдельными коммитами</p></div>
      <button className="subtle-button" onClick={() => loadWorkspace(branch)} disabled={loading || busy}><RefreshCw size={14}/> Обновить</button>
    </div>
    <div className="repo-toolbar">
      <label><GitBranch size={15}/> Ветка
        <select value={branch} onChange={event => loadWorkspace(event.target.value)} disabled={busy}>
          {(branches.includes('main') ? branches : ['main', ...branches]).map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
      <div className="branch-create"><input value={newBranch} onChange={event => setNewBranch(event.target.value)} aria-label="Название новой ветки"/><button onClick={createBranch} disabled={busy || !newBranch.trim()}><GitPlus size={14}/> Создать ветку</button></div>
    </div>
    {branch === 'main' && <div className="main-protection"><ShieldCheck size={15}/> Ветка main доступна только для чтения. Создайте отдельную ветку перед сохранением изменений.</div>}
    {error && <div className="task-error" role="alert">{error}</div>}
    {notice && <div className="workspace-notice">{notice}</div>}
    {loading ? <div className="workspace-empty">Загружаем список файлов GitHub…</div> :
      <div className="code-layout">
        <aside className="file-browser">
          <div className="file-browser-heading"><strong><FolderKanban size={14}/> Файлы репозитория</strong><button title="Создать файл" onClick={() => setCreatingFile(value => !value)} disabled={branch === 'main'}><Plus size={15}/></button></div>
          {creatingFile && <div className="new-file-row"><input value={newFilePath} onChange={event => setNewFilePath(event.target.value)} placeholder="папка/файл.js"/><button onClick={createFile} disabled={busy || !newFilePath.trim()}>Создать</button></div>}
          <div className="file-list">{files.map(file => <button key={file.path} className={selectedPath === file.path ? 'file-item selected' : 'file-item'} onClick={() => openFile(file.path)}><FileText size={13}/><span>{file.path}</span><small>{file.size ? Math.ceil(file.size / 1024) + ' KB' : ''}</small></button>)}</div>
          {!files.length && <div className="workspace-empty">Файлы не найдены.</div>}
        </aside>
        <section className="code-editor">
          <div className="editor-toolbar"><strong>{selectedPath || 'Выберите файл слева'}</strong><div className="editor-actions"><button onClick={() => setShowDiff(value => !value)} disabled={!selectedPath || busy}>{showDiff ? 'Редактор' : 'Сравнить'}</button><button className="delete-file-button" onClick={deleteFile} disabled={!selectedPath || branch === 'main' || busy}><X size={14}/> Удалить</button><button onClick={saveFile} disabled={!selectedPath || branch === 'main' || busy}><Save size={14}/> Сохранить в GitHub</button></div></div>
          {selectedPath ? (showDiff ? <div className="diff-view"><div className="diff-column"><strong>Версия в GitHub</strong><pre>{originalContent || ' '}</pre></div><div className="diff-column"><strong>Текущая версия</strong><pre>{fileContent || ' '}</pre></div></div> : <textarea spellCheck="false" value={fileContent} onChange={event => setFileContent(event.target.value)} readOnly={branch === 'main'} aria-label="Содержимое файла"/>) : <div className="workspace-empty editor-empty">Выберите текстовый файл, чтобы просмотреть или отредактировать его.</div>}
          {busy && <div className="editor-busy">Выполняем запрос…</div>}
        </section>
      </div>}
    <div className="workspace-footnote"><GitCommit size={13}/> Доступны просмотр, сравнение версий, создание, редактирование и удаление файлов, а также коммиты только в отдельной ветке.</div>
  </section>;
}

const DEFAULT_TEAM_SETTINGS = { intensity: 60, mode: 'normal', agents: { gemini: true, qwen: true, gemma: true, north: false } };

function readTeamSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('ai-studio-team-settings') || 'null');
    return { ...DEFAULT_TEAM_SETTINGS, ...(saved || {}), agents: { ...DEFAULT_TEAM_SETTINGS.agents, ...(saved?.agents || {}) } };
  } catch { return DEFAULT_TEAM_SETTINGS; }
}

function App() {
  const [active, setActive] = useState('Обзор');
  const [task, setTask] = useState('');
  const [tasks, setTasks] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ai-studio-tasks') || '[]').slice(0, 100); } catch { return []; }
  });
  const pollingJobs = useRef(new Set());
  const [showAll, setShowAll] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [lastPlan, setLastPlan] = useState(null);
  const [geminiHealth, setGeminiHealth] = useState(null);
  const [geminiCallStatus, setGeminiCallStatus] = useState(null);
  const [authState, setAuthState] = useState('checking');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [gemmaReview, setGemmaReview] = useState(null);
  const [qwenReview, setQwenReview] = useState(null);
  const [executionResult, setExecutionResult] = useState(null);
  const [reviewStatus, setReviewStatus] = useState('');
  const [teamSettings, setTeamSettings] = useState(readTeamSettings);
  const [usageEvents, setUsageEvents] = useState(() => {
    try { return JSON.parse(localStorage.getItem('ai-studio-usage-events') || '[]'); } catch { return []; }
  });
  const [usagePeriod, setUsagePeriod] = useState('today');
  const [chatMessages, setChatMessages] = useState([]);

  useEffect(() => {
    localStorage.setItem('ai-studio-team-settings', JSON.stringify(teamSettings));
  }, [teamSettings]);

  useEffect(() => {
    localStorage.setItem('ai-studio-tasks', JSON.stringify(tasks.slice(0, 100)));
  }, [tasks]);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    let cancelled = false;
    async function refreshPendingTasks() {
      const pending = tasks.filter(item => item.jobId && ['queued', 'running'].includes(item.state));
      for (const item of pending) {
        if (cancelled || pollingJobs.current.has(item.jobId)) continue;
        pollingJobs.current.add(item.jobId);
        try {
          const response = await fetch('/api/execute/' + encodeURIComponent(item.jobId));
          const statusData = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(statusData.error || 'Не удалось восстановить статус задачи.');
          if (cancelled) return;
          if (statusData.status === 'complete') {
            const data = statusData.output?.data || null;
            const error = statusData.output?.httpStatus >= 400 || data?.error
              ? (data?.error || 'Команда ИИ завершилась с ошибкой.') : null;
            setTasks(current => current.map(task => task.jobId === item.jobId ? {
              ...task, state: error ? 'failed' : 'complete',
              status: error ? 'Ошибка выполнения' : data?.branch ? 'Код подготовлен' : 'Задача завершена',
              result: error ? null : data, error
            } : task));
          } else if (['errored', 'terminated'].includes(statusData.status)) {
            const message = statusData.error?.message || 'Асинхронная задача завершилась с ошибкой.';
            setTasks(current => current.map(task => task.jobId === item.jobId ? { ...task, state: 'failed', status: 'Ошибка выполнения', error: message } : task));
          } else {
            const nextState = statusData.status === 'queued' ? 'queued' : 'running';
            const nextLabel = nextState === 'queued' ? 'В очереди' : 'Выполняется';
            if (item.state !== nextState || item.status !== nextLabel) {
              setTasks(current => current.map(task => task.jobId === item.jobId ? { ...task, state: nextState, status: nextLabel } : task));
            }
          }
        } catch (error) {
          if (!cancelled) setTasks(current => current.map(task => task.jobId === item.jobId ? { ...task, lastStatusError: error.message } : task));
        } finally {
          pollingJobs.current.delete(item.jobId);
        }
      }
    }
    refreshPendingTasks();
    const timer = setInterval(refreshPendingTasks, 4000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [authState, tasks]);

  useEffect(() => {
    localStorage.setItem('ai-studio-usage-events', JSON.stringify(usageEvents.slice(0, 300)));
  }, [usageEvents]);

  function updateTeamSetting(key, value) {
    setTeamSettings(current => ({ ...current, [key]: value }));
  }

  function toggleAgent(key, enabled) {
    setTeamSettings(current => ({ ...current, agents: { ...current.agents, [key]: enabled } }));
  }

  useEffect(() => {
    const telegram = window.Telegram?.WebApp;
    if (telegram) { telegram.ready(); telegram.expand(); }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/api/health').then(response => response.ok ? response.json() : Promise.reject(new Error('Health check failed'))),
      fetch('/api/session').then(response => response.ok ? response.json() : Promise.reject(new Error('Session check failed')))
    ]).then(async ([health, session]) => {
      if (!active) return;
      setGeminiHealth(health);
      if (session.authenticated) { setAuthState('authenticated'); return; }
      const telegram = window.Telegram?.WebApp;
      if (telegram?.initData && health.telegramAuthConfigured) {
        try {
          const response = await fetch('/api/telegram-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: telegram.initData }) });
          if (response.ok) { if (active) setAuthState('authenticated'); return; }
        } catch { /* Fall back to the existing password login. */ }
      }
      if (active) setAuthState(health.passwordAuthConfigured ? 'login' : health.telegramAuthConfigured ? 'error' : 'setup');
    }).catch(() => { if (active) { setGeminiHealth({ ok: false, modelConfigured: false }); setAuthState('error'); } });
    return () => { active = false; };
  }, []);

  const greeting = useMemo(() => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date()), []);

  async function login(event) {
    event.preventDefault();
    if (!loginPassword || isLoggingIn) return;
    setIsLoggingIn(true);
    setLoginError('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: loginPassword }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось войти.');
      setLoginPassword('');
      setAuthState('authenticated');
    } catch (error) { setLoginError(error.message || 'Ошибка входа.'); }
    finally { setIsLoggingIn(false); }
  }

  async function submitTask(event) {
    event.preventDefault();
    const value = task.trim();
    if (!value || isSubmitting) return;
    setIsSubmitting(true);
    setTaskError('');
    if (teamSettings.mode === 'chat') {
      try {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: value, history: chatMessages, teamSettings }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Не удалось получить ответ агента.');
        setLastPlan(null);
        setExecutionResult(null);
        setChatMessages(current => [...current, { role: 'user', content: value }, { role: 'assistant', content: data.reply, agent: data.agent }].slice(-24));
        setUsageEvents(current => [{ id: Date.now(), at: new Date().toISOString(), mode: 'chat', intensity: teamSettings.intensity, agents: data.agentsUsed || [data.agent], requests: data.usage?.requests ?? 1, neurons: null, task: value.slice(0,160) }, ...current].slice(0,300));
        setTask('');
        setReviewStatus('Ответ получен от ' + data.agent + '. В режиме общения разработка и GitHub не запускаются.');
      } catch (error) { setTaskError(error.message || 'Не удалось получить ответ.'); }
      finally { setIsSubmitting(false); }
      return;
    }
    setLastPlan(null);
    setExecutionResult(null);
    setGemmaReview(null);
    setQwenReview(null);
    setReviewStatus(teamSettings.agents.gemini ? 'Gemini анализирует задачу и готовит технический план…' : 'Разработчик готовит изменения по базовому плану…');
    setGeminiCallStatus(null);
    try {
      const response = await fetch('/api/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: value, teamSettings })
      });
      const started = await response.json();
      if (!response.ok) throw new Error(started.error || 'Не удалось запустить задачу.');
      if (!started.jobId) throw new Error('Сервер не вернул идентификатор задачи.');

      const jobRecord = {
        id: started.jobId, jobId: started.jobId, title: value,
        status: 'В очереди', state: 'queued', time: 'Только что',
        createdAt: new Date().toISOString(), teamSettings
      };
      setTasks(current => [jobRecord, ...current.filter(item => item.jobId !== started.jobId)].slice(0, 100));
      let data = null;
      let completed = false;
      for (let attempt = 0; attempt < 300; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const statusResponse = await fetch('/api/execute/' + encodeURIComponent(started.jobId));
        const statusData = await statusResponse.json().catch(() => ({}));
        if (!statusResponse.ok) throw new Error(statusData.error || 'Не удалось получить статус задачи.');
        if (statusData.status === 'complete') {
          data = statusData.output?.data || null;
          if (!data) throw new Error('Workflow завершился без результата выполнения.');
          if (statusData.output?.httpStatus >= 400 || data.error) throw new Error(data.error || 'Команда ИИ не смогла выполнить задачу.');
          completed = true;
          break;
        }
        if (statusData.status === 'errored' || statusData.status === 'terminated') {
          throw new Error(statusData.error?.message || 'Асинхронная задача завершилась с ошибкой.');
        }
        const nextState = statusData.status === 'queued' ? 'queued' : 'running';
        setTasks(current => current.map(item => item.jobId === started.jobId ? {
          ...item, state: nextState, status: nextState === 'queued' ? 'В очереди' : 'Выполняется'
        } : item));
        const activeNames = [];
        if (teamSettings.agents.gemini) activeNames.push('Gemini');
        if (teamSettings.agents.qwen) activeNames.push('Qwen');
        else activeNames.push('Cohere North Mini Code');
        if (teamSettings.agents.gemma && teamSettings.intensity >= 50) activeNames.push('Gemma');
        if (teamSettings.agents.north && teamSettings.agents.qwen && teamSettings.intensity >= 50) activeNames.push('North · ревью');
        setReviewStatus(statusData.status === 'queued'
          ? 'Задача в очереди Cloudflare Workflows…'
          : activeNames.join(', ') + ' выполняют задачу. Это может занять несколько минут…');
      }
      if (!completed) {
        setReviewStatus('Задача продолжает выполняться в фоне. Она сохранена в разделе «Процессы» и будет восстановлена при следующем открытии.');
        throw new Error('Задача продолжает выполняться в фоне. Её можно отслеживать в разделе «Процессы».');
      }
      const actualAgents = Array.isArray(data.agentsUsed) ? data.agentsUsed : [];
      setGeminiCallStatus(actualAgents.includes('gemini') ? true : null);
      const plan = data.plan || { summary: data.summary || 'Задача проанализирована', steps: [], risks: [], questions: [] };
      setLastPlan({
        title: value,
        ...plan,
        model: data.model || 'Gemini',
        primaryModel: data.primaryModel || data.model || 'Gemini',
        fallbackUsed: Boolean(data.fallbackUsed)
      });
      setExecutionResult(data);
      setUsageEvents(current => [{
        id: Date.now(), at: new Date().toISOString(), mode: teamSettings.mode,
        intensity: teamSettings.intensity, agents: actualAgents,
        requests: data.usage?.requests ?? null, neurons: data.usage?.neurons ?? null,
        task: value.slice(0, 160)
      }, ...current].slice(0, 300));
      setQwenReview(actualAgents.includes('qwen') || actualAgents.includes('north') ? { ok: true, review: data.qwenReview || 'Изменения подготовлены.' } : null);
      setGemmaReview(actualAgents.includes('gemma') ? { ok: true, review: data.gemmaReview || 'Проверка завершена.' } : null);
      const count = (data.filesChanged || []).length;
      const developerName = actualAgents.includes('qwen') ? 'Qwen' : actualAgents.includes('north') ? 'Cohere North Mini Code' : 'разработчик';
      setReviewStatus(data.branch
        ? 'Проверка пройдена. ' + developerName + ' подготовил ' + count + ' файл(ов) в отдельной GitHub-ветке.'
        : 'Анализ завершён. Изменения файлов не потребовались.');
      setTasks(current => current.map(item => item.jobId === started.jobId ? {
        ...item, state: 'complete', status: data.branch ? 'Код подготовлен' : 'Задача завершена',
        result: data, error: null
      } : item));
      setTask('');
      setActive('Процессы');
    } catch (error) {
      setGeminiCallStatus(null);
      setTasks(current => current.map(item => item.jobId && item.state !== 'complete' && item.state !== 'failed' && item.title === value && item.createdAt
        ? { ...item, state: error.message?.includes('продолжает выполняться') ? 'running' : 'failed',
            status: error.message?.includes('продолжает выполняться') ? 'Выполняется' : 'Ошибка выполнения',
            error: error.message || 'Не удалось связаться с командой ИИ.' }
        : item));
      setTaskError(error.message || 'Не удалось связаться с командой ИИ.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const title = active === 'Обзор' ? 'Рабочее пространство' : active;
  const usageCutoff = usagePeriod === 'today' ? new Date(new Date().setHours(0,0,0,0)) : usagePeriod === 'week' ? new Date(Date.now() - 7 * 86400000) : new Date(Date.now() - 30 * 86400000);
  const visibleUsage = usageEvents.filter(item => new Date(item.at) >= usageCutoff);
  const trackedRequests = visibleUsage.reduce((sum, item) => sum + (Number.isFinite(item.requests) ? item.requests : (item.agents?.length || 0)), 0);
  const trackedNeurons = visibleUsage.reduce((sum, item) => sum + (Number.isFinite(item.neurons) ? item.neurons : 0), 0);
  if (authState !== 'authenticated') {
    return <div className="login-screen"><form className="login-card" onSubmit={login}><div className="brand-mark"><BrainCircuit size={22} /></div><div className="eyebrow">ЗАЩИЩЁННЫЙ ДОСТУП</div><h1>AI Studio</h1><p>{authState === 'checking' ? 'Проверяем авторизацию…' : authState === 'setup' ? 'Авторизация ещё не настроена. Добавьте APP_PASSWORD и SESSION_SECRET в секреты Cloudflare Worker.' : authState === 'error' ? 'Не удалось подтвердить Telegram-вход. Откройте Mini App через Telegram или настройте парольный вход.' : 'Введите личный пароль, чтобы открыть рабочее пространство.'}</p>{authState === 'login' && <><input type="password" autoComplete="current-password" value={loginPassword} onChange={event => setLoginPassword(event.target.value)} placeholder="Пароль доступа" /><button className="primary-button" type="submit" disabled={!loginPassword || isLoggingIn}>{isLoggingIn ? 'Входим…' : 'Войти'} <Send size={15} /></button></>}{loginError && <div className="task-error">{loginError}</div>}</form></div>;
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><BrainCircuit size={21} /></div>
          <div><strong>AI STUDIO</strong><span>Команда цифровых решений</span></div>
        </div>
        <div className="workspace-switch">
          <div className="workspace-icon">A</div>
          <div className="workspace-name"><strong>Моя студия</strong><span>Личное пространство</span></div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-caption">РАБОЧЕЕ ПРОСТРАНСТВО</div>
        <nav className="navigation">
          {navigation.map(item => {
            const Icon = item.icon;
            return <button key={item.label} className={active === item.label ? 'nav-item active' : 'nav-item'} onClick={() => setActive(item.label)}>
              <Icon size={17} /><span>{item.label}</span>{item.label === 'Процессы' && tasks.length > 0 && <i>{tasks.length}</i>}
            </button>;
          })}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setActive('Настройки')}><Settings2 size={17} /><span>Настройки</span></button>
          <div className="github-card">
            <div className="github-top"><GitBranch size={15} /><span>GitHub workspace</span><span className="online-dot" /></div>
            <strong>adadd89-sys / AI-Studio</strong>
            <small>Ветка main</small>
          </div>
          <div className="profile"><div className="profile-avatar">Р</div><div><strong>Руководитель</strong><span>Владелец студии</span></div><ChevronDown size={15} /></div>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumbs"><span>AI Studio</span><ChevronRight size={14} /><strong>{title}</strong></div>
          <div className="topbar-right"><span className="date-label">{greeting}</span><button className="icon-button" aria-label="Помощь"><CircleHelp size={17} /></button><div className="top-avatar">Р</div></div>
        </header>

        <div className="page-content">
          {active === 'Процессы' ? <section className="processes-page">
            <div className="section-heading"><div><div className="eyebrow">ИСТОРИЯ И ВЫПОЛНЕНИЕ</div><h2>Задачи и процессы</h2></div><button className="subtle-button" onClick={() => setActive('Обзор')}>Новая задача <Plus size={15}/></button></div>
            {tasks.length === 0 ? <div className="settings-card"><strong>История пока пуста</strong><p className="settings-note">Запущенные задачи будут автоматически сохраняться на этом устройстве. Если закрыть Telegram, после возвращения AI Studio восстановит проверку их статусов.</p></div> :
              <div className="process-list">{tasks.map(item => <article className="process-card" key={item.id}>
                <div className="process-card-heading"><div><strong>{item.title}</strong><small>{item.createdAt ? new Date(item.createdAt).toLocaleString('ru-RU') : item.time}</small></div>
                  <span className={'process-state ' + (item.state === 'complete' ? 'success' : item.state === 'failed' ? 'error' : 'pending')}>{item.status}</span>
                </div>
                {item.error && <p className="process-error">{item.error}</p>}
                {item.result?.summary && <p className="process-summary">{item.result.summary}</p>}
                {item.result?.branch && <div className="process-links"><a href={'https://github.com/adadd89-sys/AI-Studio/tree/' + item.result.branch} target="_blank" rel="noreferrer">Открыть ветку GitHub ↗</a><a href={'https://github.com/adadd89-sys/AI-Studio/compare/main...' + item.result.branch} target="_blank" rel="noreferrer">Сравнить изменения ↗</a></div>}
                {item.jobId && ['queued','running'].includes(item.state) && <small className="process-hint">ID: {item.jobId} · Статус обновляется автоматически</small>}
              </article>)}</div>}
            <p className="settings-note">История хранится локально в браузере Telegram на этом устройстве. Очистка данных приложения или переход на другое устройство не переносит эту историю.</p>
          </section> : active === 'Код и файлы' ? <CodeWorkspace /> : active === 'Настройки' ? <section className="settings-page">
            <div className="section-heading"><div><div className="eyebrow">УПРАВЛЕНИЕ КОМАНДОЙ</div><h2>Настройки AI Studio</h2></div><Gauge size={22}/></div>
            <div className="settings-card"><div className="settings-title"><div><strong>Интенсивность работы</strong><span>Влияет на длину ответов и глубину проверки. Число вызовов зависит от включённых агентов.</span></div><b>{teamSettings.intensity}%</b></div>
              <input className="intensity-slider" type="range" min="0" max="100" step="5" value={teamSettings.intensity} onChange={event => updateTeamSetting('intensity', Number(event.target.value))} disabled={teamSettings.mode === 'max'}/>
              <div className="slider-labels"><span>Экономно</span><span>Сбалансированно</span><span>Максимум</span></div>
              <div className="mode-options"><button className={teamSettings.mode === 'chat' ? 'mode-option selected' : 'mode-option'} onClick={() => updateTeamSetting('mode','chat')}><MessageCircle size={16}/><strong>Общение</strong><span>Короткие ответы без GitHub и разработки</span></button><button className={teamSettings.mode === 'normal' ? 'mode-option selected' : 'mode-option'} onClick={() => updateTeamSetting('mode','normal')}><Gauge size={16}/><strong>Обычная работа</strong><span>План, выполнение и нужные проверки</span></button><button className={teamSettings.mode === 'max' ? 'mode-option selected' : 'mode-option'} onClick={() => { updateTeamSetting('mode','max'); updateTeamSetting('intensity',100); }}><Zap size={16}/><strong>Максимальная нагрузка</strong><span>100% интенсивность и глубокая проверка. Участвуют только включённые агенты</span></button></div>
            </div>
            <div className="settings-card"><div className="settings-title"><div><strong>Участие агентов</strong><span>Отключённый агент не должен получать запросы</span></div></div>
              <div className="agent-toggle-list">{agents.map(agent => <label className="agent-toggle" key={agent.key}><span className={'agent-avatar ' + agent.tone}>{agent.initials}</span><span><strong>{agent.name}</strong><small>{agent.model}</small></span><input type="checkbox" checked={Boolean(teamSettings.agents[agent.key])} onChange={event => toggleAgent(agent.key,event.target.checked)}/></label>)}</div>
              <p className="settings-note">Cohere North Mini Code включается только после добавления OPENROUTER_API_KEY в секреты Cloudflare. Сам ключ сюда вводить не нужно.</p>
            </div>
            <div className="settings-save-note"><Check size={15}/> Настройки сохраняются на этом устройстве и применяются к следующим задачам.</div>
          </section> : active === 'Расход ресурсов' ? <section className="usage-page">
            <div className="section-heading"><div><div className="eyebrow">ЛИМИТЫ И АКТИВНОСТЬ</div><h2>Расход ресурсов</h2></div><BarChart3 size={22}/></div>
            <div className="usage-period">{[['today','Сегодня'],['week','7 дней'],['month','30 дней']].map(([key,label]) => <button key={key} className={usagePeriod === key ? 'selected' : ''} onClick={() => setUsagePeriod(key)}>{label}</button>)}</div>
            <div className="usage-metrics"><article><span>Запросы AI Studio</span><strong>{trackedRequests}</strong><small>По локальной истории приложения</small></article><article><span>Neurons</span><strong>{trackedNeurons || 'Нет данных'}</strong><small>Точное потребление смотрите в Cloudflare</small></article><article><span>Запуски задач</span><strong>{visibleUsage.length}</strong><small>На этом устройстве</small></article></div>
            <div className="settings-card"><div className="settings-title"><div><strong>Лимит Cloudflare Workers AI</strong><span>Qwen и Gemma используют общий дневной пул</span></div></div><p className="settings-note">AI Studio пока не получает достоверное число оставшихся Neurons из Worker API. Не показываем оценку как фактический остаток.</p><a className="external-dashboard-link" href="https://dash.cloudflare.com/?to=/:account/workers/ai" target="_blank" rel="noreferrer">Открыть статистику Cloudflare ↗</a></div>
            <div className="settings-card"><div className="settings-title"><div><strong>OpenRouter · North Mini Code</strong><span>Бесплатный уровень модели</span></div></div><p className="settings-note">Бесплатная квота OpenRouter зависит от действующих правил аккаунта. Здесь учитываются только вызовы, которые AI Studio сможет подтвердить; остаток аккаунта не предполагается.</p><a className="external-dashboard-link" href="https://openrouter.ai/activity" target="_blank" rel="noreferrer">Открыть активность OpenRouter ↗</a></div>
            <div className="settings-card"><strong>История задач</strong>{visibleUsage.length ? <div className="usage-history">{visibleUsage.map(item => <div key={item.id}><span>{new Date(item.at).toLocaleString('ru-RU')}</span><strong>{item.task}</strong><small>{item.agents?.join(' · ') || 'Состав команды не записан'} · {item.intensity}%</small></div>)}</div> : <p className="settings-note">За выбранный период задач пока нет.</p>}</div>
          </section> : <>
          <section className="welcome-row">
            <div><div className="eyebrow"><Sparkles size={14} /> ВАША AI-КОМАНДА</div><h1>{active === 'Обзор' ? 'Всё начинается с идеи.' : title}</h1><p>Ставьте задачу — команда ИИ поможет превратить её в готовый продукт.</p></div>
            <div className="system-status"><span className="status-pulse" /> Система готова к работе</div>
          </section>

          <section className="task-panel">
            <div className="task-panel-heading"><div className="task-icon"><Command size={18} /></div><div><h2>Новая задача</h2><p>{teamSettings.mode === 'chat' ? 'Обычный разговор без запуска разработки и GitHub' : 'Опишите, что нужно создать или улучшить'}</p></div><span className="task-step">01 / ЗАПУСК</span></div>
            <form onSubmit={submitTask}>
              <textarea value={task} onChange={e => setTask(e.target.value)} placeholder={teamSettings.mode === 'chat' ? "Напишите сообщение команде…" : "Например: создай Telegram-бота для записи клиентов, продумай архитектуру, напиши код и проверь его..."} rows={3} />
              <div className="composer-footer"><div className="composer-hint"><Sparkles size={14} /> {teamSettings.mode === 'chat' ? "Один агент отвечает без запуска задач" : "Интенсивность " + teamSettings.intensity + "% · активные агенты по настройкам"}</div><button className="primary-button" type="submit" disabled={!task.trim() || isSubmitting}>{isSubmitting ? (teamSettings.mode === 'chat' ? 'Отвечаем…' : 'Команда работает…') : (teamSettings.mode === 'chat' ? 'Отправить' : 'Запустить команду')} <Send size={15} /></button></div>
            </form>
            {taskError && <div className="task-error" role="alert">{taskError}</div>}
            {teamSettings.mode === 'chat' && chatMessages.length > 0 && <div className="chat-thread">{chatMessages.map((item,index) => <div key={index} className={'chat-message ' + item.role}><span>{item.role === 'user' ? 'Вы' : item.agent || 'AI Studio'}</span><p>{item.content}</p></div>)}</div>}
            {lastPlan && <div className="generated-plan">
              <div className="plan-header"><div><span className="eyebrow">ПЛАН · {lastPlan.model}</span><h3>{lastPlan.summary}</h3></div><div className="plan-model-stack"><span className="plan-model">{lastPlan.model}</span><span className={lastPlan.fallbackUsed ? 'model-route fallback' : 'model-route'}>{lastPlan.fallbackUsed ? 'Резервное переключение' : 'Основная модель'}</span></div></div>
              <div className={lastPlan.fallbackUsed ? 'model-info fallback' : 'model-info'}>{lastPlan.fallbackUsed ? <>Основная модель <strong>{lastPlan.primaryModel}</strong> была недоступна. Ответ получен от резервной модели <strong>{lastPlan.model}</strong>.</> : <>Запрос выполнен основной моделью <strong>{lastPlan.model}</strong>. Резервная модель не потребовалась.</>}</div>
              <ol>{lastPlan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              {lastPlan.risks?.length > 0 && <div className="plan-notes"><strong>Риски для проверки</strong>{lastPlan.risks.map((risk, index) => <span key={index}>{risk}</span>)}</div>}
              {lastPlan.questions?.length > 0 && <div className="plan-notes"><strong>Нужно уточнить</strong>{lastPlan.questions.map((question, index) => <span key={index}>{question}</span>)}</div>}
              {executionResult?.branch && <div className="plan-notes">
                <strong>Результат работы команды</strong>
                <span>Изменено файлов: {(executionResult.filesChanged || []).length}</span>
                {(executionResult.filesChanged || []).map(file => <span key={file.path}>{file.path}</span>)}
                <a href={'https://github.com/adadd89-sys/AI-Studio/tree/' + executionResult.branch} target="_blank" rel="noreferrer">Открыть ветку с изменениями в GitHub →</a>
                <a href={'https://github.com/adadd89-sys/AI-Studio/compare/main...' + executionResult.branch} target="_blank" rel="noreferrer">Посмотреть сравнение с main →</a>
              </div>}
              <div className="review-kit">
                <div className="review-kit-heading"><strong>Результаты работы команды</strong><span>{(executionResult?.agentsUsed || []).map(key => ({gemini:'Gemini',qwen:'Qwen',gemma:'Gemma',north:'North'}[key] || key)).join(' · ') || 'Нет данных об агентах'}</span></div>
                <p>{reviewStatus || "Оба агента автоматически получают план Gemini и независимо проверяют его."}</p>
                <div className="agent-reviews">
                  <div className="agent-review"><strong>Gemma 4 · Cloudflare Workers AI</strong>{gemmaReview ? (gemmaReview.ok ? <p>{gemmaReview.review}</p> : <p className="review-error">{gemmaReview.error}</p>) : executionResult && !executionResult.agentsUsed?.includes('gemma') ? <span>Не запускалась: проверка не требовалась при выбранной интенсивности или не было изменений.</span> : <span>Ожидает проверки…</span>}</div>
                  <div className="agent-review"><strong>{teamSettings.agents.qwen ? "Qwen 3.8 · Cloudflare Workers AI" : "Cohere North Mini Code · OpenRouter"}</strong>{qwenReview ? (qwenReview.ok ? <p>{qwenReview.review}</p> : <p className="review-error">{qwenReview.error}</p>) : <span>Ожидает проверки…</span>}</div>
                  {executionResult?.northReview && <div className="agent-review"><strong>North Mini Code · независимое ревью</strong><p>{executionResult.northReview.summary || (executionResult.northReview.approved ? "Одобрено" : "Есть замечания")}</p></div>}
                </div>
              </div>
            </div>}
          </section>

          <section className="section-block">
            <div className="section-heading"><div><div className="eyebrow">ВАШИ СПЕЦИАЛИСТЫ</div><h2>Команда ИИ</h2></div><button className="subtle-button" onClick={() => setActive('Команда ИИ')}>Вся команда <ChevronRight size={15} /></button></div>
            <div className="agent-grid">
              {agents.map(agent => {
                const configured = agent.key === 'gemini' ? Boolean(geminiHealth?.modelConfigured) : agent.key === 'north' ? Boolean(geminiHealth?.openrouterConfigured) : Boolean(geminiHealth?.qwenConfigured);
                const usedAgents = executionResult?.agentsUsed || [];
                const agentWasUsed = agent.key === 'qwen' ? usedAgents.includes('qwen') : usedAgents.includes(agent.key);
                const result = agent.key === 'gemini' ? geminiCallStatus : agent.key === 'gemma' ? gemmaReview?.ok : agent.key === 'qwen' ? qwenReview?.ok : usedAgents.includes('north');
                const failed = agent.key === 'gemini' ? geminiCallStatus === false : (agent.key === 'gemma' ? gemmaReview?.ok === false : agent.key === 'qwen' ? qwenReview?.ok === false : false);
                const status = !teamSettings.agents[agent.key] ? 'Отключён' : executionResult && !agentWasUsed ? 'Не участвовал в этой задаче' : result === true ? 'Вызов подтверждён' : failed ? 'Ошибка вызова' : configured ? 'Подключение настроено · ждёт запуска' : geminiHealth === null ? 'Проверяем подключение…' : agent.key === 'north' ? 'Требуется OPENROUTER_API_KEY' : 'Не настроено';
                return <article className="agent-card" key={agent.key}>
                  <div className="agent-card-top"><div className={'agent-avatar ' + agent.tone}>{agent.initials}</div><span className={'agent-status ' + (result === true ? 'is-working' : failed ? 'is-error' : 'is-configured')}><span /> {status}</span></div>
                  <h3>{agent.name}</h3><div className="agent-role">{agent.role}</div><div className="agent-model">{agent.model}</div><p>{agent.detail}</p>
                  <div className="agent-card-bottom"><span><ShieldCheck size={14} /> {!teamSettings.agents[agent.key] ? 'Не участвует' : result === true ? 'Генерация подтверждена' : configured ? 'Провайдер настроен' : 'Требуется настройка'}</span><ChevronRight size={16} /></div>
                </article>;
              })}
            </div>
          </section>

          <section className="section-block lower-grid">
            <div className="activity-panel">
              <div className="section-heading compact"><div><div className="eyebrow">ПОСЛЕДНИЕ ДЕЙСТВИЯ</div><h2>Задачи и процессы</h2></div><button className="text-button" onClick={() => setActive('Процессы')}>Открыть все <ChevronRight size={14} /></button></div>
              {tasks.length === 0 ? <div className="empty-state"><div className="empty-icon"><Terminal size={20} /></div><strong>Пока нет активных задач</strong><span>Здесь появятся ваши задачи и ход их выполнения.</span><button onClick={() => document.querySelector('textarea')?.focus()}><Plus size={14} /> Создать первую задачу</button></div> :
                <div className="task-list">{(showAll ? tasks : tasks.slice(0, 3)).map(item => <div className="task-row" key={item.id}><div className="task-row-icon"><MessageSquare size={16} /></div><div className="task-row-main"><strong>{item.title}</strong><span>{item.time}</span></div><span className="draft-status">{item.status}</span></div>)}{tasks.length > 3 && <button className="text-button" onClick={() => setShowAll(v => !v)}>{showAll ? 'Свернуть' : 'Показать ещё'}</button>}</div>}
            </div>
            <div className="roadmap-panel"><div className="eyebrow">ПЛАН РАЗВИТИЯ</div><h2>От идеи до результата</h2><div className="roadmap-list">
              <div className="roadmap-item done"><div className="roadmap-marker"><Check size={13} /></div><div><strong>Рабочая среда</strong><span>Интерфейс и структура проекта</span></div><em>Сейчас</em></div>
              <div className="roadmap-item"><div className="roadmap-marker">2</div><div><strong>Подключение моделей</strong><span>Gemini и другие ИИ-агенты</span></div></div>
              <div className="roadmap-item"><div className="roadmap-marker">3</div><div><strong>Совместная работа</strong><span>Планирование, код и ревью</span></div></div>
              <div className="roadmap-item"><div className="roadmap-marker">4</div><div><strong>Тестирование и запуск</strong><span>Проверка и публикация проектов</span></div></div>
            </div></div>
          </section>
          <footer className="page-footer"><span>AI STUDIO <span className="footer-dot">·</span> Версия 0.1.0</span><span><Zap size={13} /> Создаём с помощью ИИ</span></footer>
          </>}
        </div>
      </main>
    </div>
  );
}

export default App;