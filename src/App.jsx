import { useMemo, useState } from 'react';
import {
  Activity, Bot, BrainCircuit, Check, ChevronDown, ChevronRight,
  CircleHelp, Code2, Command, FolderKanban, GitBranch, LayoutDashboard,
  MessageSquare, Plus, Send, Settings2, ShieldCheck, Sparkles, Terminal,
  Users, Workflow, Zap
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
  { name: 'ChatGPT', role: 'Архитектор и координатор', tone: 'violet', initials: 'G', detail: 'Планирует работу, распределяет задачи и проверяет общий результат.' },
  { name: 'Gemini', role: 'Разработчик', tone: 'blue', initials: 'Ge', detail: 'Помогает проектировать решения и писать код.' },
  { name: 'DeepSeek', role: 'Ревьюер и аналитик', tone: 'green', initials: 'D', detail: 'Ищет ошибки, проверяет логику и предлагает альтернативы.' }
];

function App() {
  const [active, setActive] = useState('Обзор');
  const [task, setTask] = useState('');
  const [tasks, setTasks] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [taskError, setTaskError] = useState('');
  const [lastPlan, setLastPlan] = useState(null);

  const greeting = useMemo(() => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date()), []);

  async function submitTask(event) {
    event.preventDefault();
    const value = task.trim();
    if (!value || isSubmitting) return;
    setIsSubmitting(true);
    setTaskError('');
    setLastPlan(null);
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Не удалось составить план.');
      setLastPlan({ title: value, ...data.plan, model: data.model });
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
            <div className="github-top"><GitBranch size={15} /><span>GitHub подключён</span><span className="online-dot" /></div>
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
              <div className="plan-header"><div><span className="eyebrow">ПЛАН ОТ GEMINI</span><h3>{lastPlan.summary}</h3></div><span className="plan-model">{lastPlan.model}</span></div>
              <ol>{lastPlan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
              {lastPlan.risks?.length > 0 && <div className="plan-notes"><strong>Риски для проверки</strong>{lastPlan.risks.map((risk, index) => <span key={index}>{risk}</span>)}</div>}
              {lastPlan.questions?.length > 0 && <div className="plan-notes"><strong>Нужно уточнить</strong>{lastPlan.questions.map((question, index) => <span key={index}>{question}</span>)}</div>}
            </div>}
          </section>

          <section className="section-block">
            <div className="section-heading"><div><div className="eyebrow">ВАШИ СПЕЦИАЛИСТЫ</div><h2>Команда ИИ</h2></div><button className="subtle-button" onClick={() => setActive('Команда ИИ')}>Вся команда <ChevronRight size={15} /></button></div>
            <div className="agent-grid">
              {agents.map(agent => <article className="agent-card" key={agent.name}>
                <div className="agent-card-top"><div className={'agent-avatar ' + agent.tone}>{agent.initials}</div><span className="agent-status"><span /> Подключение не настроено</span></div>
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
        </div>
      </main>
    </div>
  );
}

export default App;