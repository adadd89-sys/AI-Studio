import { useEffect, useMemo, useState } from 'react';
import {
  Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight,
  CircleHelp, Code2, Command, FolderKanban, GitBranch, LayoutDashboard,
  MessageSquare, Plus, Send, Settings2, ShieldCheck, Sparkles, Terminal,
  Users, Workflow, Zap, FileText, Save, RefreshCw, GitCommit, GitPlus, X
} from 'lucide-react';

const navigation = [
  { label: 'Обзор', icon: LayoutDashboard },
  { label: 'Проекты', icon: FolderKanban },
  { label: 'Команда ИИ', icon: Users },
  { label: 'Процессы', icon: Workflow },
  { label: 'Код и файлы', icon: Code2 },
  { label: 'Активность', icon: Activity }
];

const agents = [
  { name: 'Gemini', role: 'Планировщик и координатор', tone: 'blue', initials: 'Ge', detail: 'Анализирует запрос, формирует план и распределяет работу.' },
  { name: 'Gemma 4', role: 'Аналитик и тестировщик', tone: 'green', initials: 'G', detail: 'Независимо проверяет план, риски и критерии готовности.' },
  { name: 'Qwen 3.8', role: 'Основной разработчик и исполнитель', tone: 'violet', initials: 'Q', detail: 'Проектирует архитектуру, пишет код и готовит изменения файлов.' }
];


function CodeWorkspace() {
  const [branch, setBranch] = useState('main');
  const [branches, setBranches] = useState([]);
  const [files, setFiles] = useState([]);
  const [selectedPath, setSelectedPath] = useState('');
  const [fileContent, setFileContent] = useState('');
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
      setNotice('Изменения сохранены в ветку ' + branch + '. Коммит: ' + (data.commit || '').slice(0, 7));
      await loadWorkspace(branch);
    } catch (err) {
      setError(err.message || 'Не удалось сохранить файл.');
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
          <div className="editor-toolbar"><strong>{selectedPath || 'Выберите файл слева'}</strong><button onClick={saveFile} disabled={!selectedPath || branch === 'main' || busy}><Save size={14}/> Сохранить в GitHub</button></div>
          {selectedPath ? <textarea spellCheck="false" value={fileContent} onChange={event => setFileContent(event.target.value)} readOnly={branch === 'main'} aria-label="Содержимое файла"/> : <div className="workspace-empty editor-empty">Выберите текстовый файл, чтобы просмотреть или отредактировать его.</div>}
          {busy && <div className="editor-busy">Выполняем запрос…</div>}
        </section>
      </div>}
    <div className="workspace-footnote"><GitCommit size={13}/> Сейчас доступны просмотр, создание файлов, редактирование и коммиты в отдельной ветке. Diff, удаление файлов и Pull Request добавим следующим этапом.</div>
  </section>;
}

function App() {
  const [active, setActive] = useState('Обзор');
  const [task, setTask] = useState('');
  const [tasks, setTasks] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [lastPlan, setLastPlan] = useState(null);
  const [geminiHealth, setGeminiHealth] = useState(null);
  const [authState, setAuthState] = useState('checking');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [gemmaReview, setGemmaReview] = useState(null);
  const [qwenReview, setQwenReview] = useState(null);
  const [reviewStatus, setReviewStatus] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch('/api/health').then(response => response.ok ? response.json() : Promise.reject(new Error('Health check failed'))),
      fetch('/api/session').then(response => response.ok ? response.json() : Promise.reject(new Error('Session check failed')))
    ]).then(([health, session]) => {
      if (!active) return;
      setGeminiHealth(health);
      setAuthState(!session.authConfigured ? 'setup' : session.authenticated ? 'authenticated' : 'login');
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
    setLastPlan(null);
    setGemmaReview(null);
    setQwenReview(null);
    setReviewStatus('План готов. Запускаем независимую проверку Gemma и Qwen…');
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось составить план.');
      const normalizedPlan = { title: value, ...data.plan, model: data.model, primaryModel: data.primaryModel || data.model, fallbackUsed: Boolean(data.fallbackUsed) };
      setLastPlan(normalizedPlan);
      const reviewPlan = [
        "Краткое описание: " + normalizedPlan.summary,
        "Шаги: " + (normalizedPlan.steps || []).map((step, index) => (index + 1) + ". " + step).join("\\n"),
        "Риски: " + (normalizedPlan.risks || []).join("; "),
        "Вопросы: " + (normalizedPlan.questions || []).join("; ")
      ].join("\\n");
      const reviewPayload = JSON.stringify({ task: value, plan: reviewPlan });
      const [gemmaResult, qwenResult] = await Promise.allSettled([
        fetch("/api/agents/gemma-review", { method: "POST", headers: { "content-type": "application/json" }, body: reviewPayload }).then(async response => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Gemma не смогла проверить план.");
          return result;
        }),
        fetch("/api/agents/qwen-review", { method: "POST", headers: { "content-type": "application/json" }, body: reviewPayload }).then(async response => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Qwen не смог проверить план.");
          return result;
        })
      ]);
      setGemmaReview(gemmaResult.status === "fulfilled" ? { ok: true, ...gemmaResult.value } : { ok: false, error: gemmaResult.reason?.message || "Ошибка проверки Gemma." });
      setQwenReview(qwenResult.status === "fulfilled" ? { ok: true, ...qwenResult.value } : { ok: false, error: qwenResult.reason?.message || "Ошибка проверки Qwen." });
      setReviewStatus("Независимая проверка завершена.");
      setTasks(current => [{ id: Date.now(), title: value, status: 'План готов', time: 'Только что' }, ...current]);
      setTask('');
      setActive('Процессы');
    } catch (error) {
      setTaskError(error.message || 'Не удалось связаться с сервером.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const title = active === 'Обзор' ? 'Рабочее пространство' : active;
  if (authState !== 'authenticated') {
    return <div className="login-screen"><form className="login-card" onSubmit={login}><div className="brand-mark"><BrainCircuit size={22} /></div><div className="eyebrow">ЗАЩИЩЁННЫЙ ДОСТУП</div><h1>AI Studio</h1><p>{authState === 'checking' ? 'Проверяем авторизацию…' : authState === 'setup' ? 'Авторизация ещё не настроена. Добавьте APP_PASSWORD и SESSION_SECRET в секреты Cloudflare Worker.' : authState === 'error' ? 'Не удалось связаться с сервером. Обновите страницу позже.' : 'Введите личный пароль, чтобы открыть рабочее пространство.'}</p>{authState === 'login' && <><input type="password" autoComplete="current-password" value={loginPassword} onChange={event => setLoginPassword(event.target.value)} placeholder="Пароль доступа" /><button className="primary-button" type="submit" disabled={!loginPassword || isLoggingIn}>{isLoggingIn ? 'Входим…' : 'Войти'} <Send size={15} /></button></>}{loginError && <div className="task-error">{loginError}</div>}</form></div>;
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
          {active === 'Код и файлы' ? <CodeWorkspace /> : <>
          <section className="welcome-row">
            <div><div className="eyebrow"><Sparkles size={14} /> ВАША AI-КОМАНДА</div><h1>{active === 'Обзор' ? 'Всё начинается с идеи.' : title}</h1><p>Ставьте задачу — команда ИИ поможет превратить её в готовый продукт.</p></div>
            <div className="system-status"><span className="status-pulse" /> Система готова к работе</div>
          </section>

          <section className="task-panel">
            <div className="task-panel-heading"><div className="task-icon"><Command size={18} /></div><div><h2>Новая задача</h2><p>Опишите, что нужно создать или улучшить</p></div><span className="task-step">01 / ЗАПУСК</span></div>
            <form onSubmit={submitTask}>
              <textarea value={task} onChange={e => setTask(e.target.value)} placeholder="Например: создай Telegram-бота для записи клиентов, продумай архитектуру, напиши код и проверь его..." rows={3} />
              <div className="composer-footer"><div className="composer-hint"><Sparkles size={14} /> Gemini составит план перед выполнением</div><button className="primary-button" type="submit" disabled={!task.trim() || isSubmitting}>{isSubmitting ? 'Анализируем...' : 'Составить план'} <Send size={15} /></button></div>
            </form>
            {taskError && <div className="task-error" role="alert">{taskError}</div>}
            {lastPlan && <div className="generated-plan">
              <div className="plan-header"><div><span className="eyebrow">ПЛАН ОТ GEMINI</span><h3>{lastPlan.summary}</h3></div><div className="plan-model-stack"><span className="plan-model">{lastPlan.model}</span><span className={lastPlan.fallbackUsed ? 'model-route fallback' : 'model-route'}>{lastPlan.fallbackUsed ? 'Резервное переключение' : 'Основная модель'}</span></div></div>
              <div className={lastPlan.fallbackUsed ? 'model-info fallback' : 'model-info'}>{lastPlan.fallbackUsed ? <>Основная модель <strong>{lastPlan.primaryModel}</strong> была недоступна. Ответ получен от резервной модели <strong>{lastPlan.model}</strong>.</> : <>Запрос выполнен основной моделью <strong>{lastPlan.model}</strong>. Резервная модель не потребовалась.</>}</div>
              <ol>{lastPlan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              {lastPlan.risks?.length > 0 && <div className="plan-notes"><strong>Риски для проверки</strong>{lastPlan.risks.map((risk, index) => <span key={index}>{risk}</span>)}</div>}
              {lastPlan.questions?.length > 0 && <div className="plan-notes"><strong>Нужно уточнить</strong>{lastPlan.questions.map((question, index) => <span key={index}>{question}</span>)}</div>}
              <div className="review-kit">
                <div className="review-kit-heading"><strong>Автоматическая проверка команды</strong><span>Gemma 4 + Qwen 3.8</span></div>
                <p>{reviewStatus || "Оба агента автоматически получают план Gemini и независимо проверяют его."}</p>
                <div className="agent-reviews">
                  <div className="agent-review"><strong>Gemma 4 · Cloudflare Workers AI</strong>{gemmaReview ? (gemmaReview.ok ? <p>{gemmaReview.review}</p> : <p className="review-error">{gemmaReview.error}</p>) : <span>Ожидает проверки…</span>}</div>
                  <div className="agent-review"><strong>Qwen 3.8 · Cloudflare Workers AI</strong>{qwenReview ? (qwenReview.ok ? <p>{qwenReview.review}</p> : <p className="review-error">{qwenReview.error}</p>) : <span>Ожидает проверки…</span>}</div>
                </div>
              </div>
            </div>}
          </section>

          <section className="section-block">
            <div className="section-heading"><div><div className="eyebrow">ВАШИ СПЕЦИАЛИСТЫ</div><h2>Команда ИИ</h2></div><button className="subtle-button" onClick={() => setActive('Команда ИИ')}>Вся команда <ChevronRight size={15} /></button></div>
            <div className="agent-grid">
              {agents.map(agent => <article className="agent-card" key={agent.name}>
                <div className="agent-card-top"><div className={'agent-avatar ' + agent.tone}>{agent.initials}</div><span className="agent-status"><span /> {agent.name === 'Gemini' ? (geminiHealth === null ? 'Проверяем API…' : geminiHealth.modelConfigured ? 'API-ключ настроен' : 'Нужен API-ключ') : agent.name === 'Qwen 3.8' ? (geminiHealth?.qwenConfigured ? 'Workers AI подключён' : 'Нет AI binding') : 'Workers AI'}</span></div>
                <h3>{agent.name}</h3><div className="agent-role">{agent.role}</div><p>{agent.detail}</p>
                <div className="agent-card-bottom"><span><ShieldCheck size={14} /> Роль назначена</span><ChevronRight size={16} /></div>
              </article>)}
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