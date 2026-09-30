import { useEffect, useMemo, useState } from 'react';
import { createApi } from './api';
import { ProjectConsoleLoader, useProjectConsole } from './loader';

const money = (n: number) => `¥${(n / 10000).toFixed(0)}万`;

const loader = new ProjectConsoleLoader(createApi());

export default function App() {
  const { state, selectProject, retry, approve: approveRequest } = useProjectConsole(loader);
  const [tab, setTab] = useState<'overview' | 'budget' | 'rights'>('overview');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    loader.start();
  }, []);

  const approve = async (id: string) => {
    if (submitting) return; // 快速重复点击同一审批按钮只生效一次
    setSubmitting(true);
    try {
      const applied = await approveRequest(id, { status: 'approved', comment: '在控制台完成复核' });
      // 刷新结果被更新的项目选择取代时，不再在新项目页面上提示旧项目的操作结果
      if (applied) setMessage('审批已通过，审计事件已写入');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '审批操作失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (state.phase === 'loading') {
    return (
      <main className="connection-state">
        <div className="loading">正在载入制作控制台…</div>
        <small>正在通过 Vite API 代理连接本地制作服务</small>
      </main>
    );
  }

  if (state.phase === 'error') {
    return (
      <main className="connection-state">
        <h2>无法连接制作服务</h2>
        <p>{state.message || '服务端没有返回项目数据。'}</p>
        <p>
          请从项目根目录运行 <code>npm run dev</code>，确认前端 5173 和 API 4104 均已启动。
        </p>
        <button onClick={retry}>重新连接</button>
      </main>
    );
  }

  const { projects, projectId, summary, conflicts, refreshing } = state;
  const variancePct = summary ? Math.round((summary.variance / summary.planned) * 100) : 0;

  return (
    <main>
      <header>
        <div>
          <div className="eyebrow">STUDIO OPS / RIGHTS & FINANCE CONTROL</div>
          <h1>
            FrameLedger <span>影视制作预算与资产版权协同</span>
          </h1>
          <p>将预算承诺、供应商付款、资产版本与跨地域版权窗口串成可审计的交付链路。</p>
        </div>
        <div className="header-actions">
          <select value={projectId} onChange={(e) => selectProject(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <span className="live">
            <i /> {refreshing ? '正在刷新…' : 'LIVE CONTROL'}
          </span>
        </div>
      </header>
      {message && (
        <div className="toast" onClick={() => setMessage('')}>
          {message} ×
        </div>
      )}
      {error && (
        <div className="toast error-toast" onClick={() => setError('')}>
          {error} ×
        </div>
      )}
      <section className="kpis">
        <div>
          <small>FORECAST COST</small>
          <b>{money(summary.forecast)}</b>
          <span>
            预算偏差 <em className={summary.variance > 0 ? 'bad' : ''}>{variancePct}%</em>
          </span>
        </div>
        <div>
          <small>COMMITTED</small>
          <b>{money(summary.committed)}</b>
          <span>已锁定供应商与合同</span>
        </div>
        <div>
          <small>ASSET REGISTER</small>
          <b>
            {summary.assetCount}
            <em> 个</em>
          </b>
          <span>版本与交付状态纳管</span>
        </div>
        <div>
          <small>RISK QUEUE</small>
          <b>
            {summary.pendingApprovals + conflicts.length}
            <em> 项</em>
          </b>
          <span>
            {conflicts.length} 条版权冲突 / {summary.pendingApprovals} 个审批
          </span>
        </div>
      </section>
      <nav className="tabs">
        <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>
          项目驾驶舱
        </button>
        <button className={tab === 'budget' ? 'active' : ''} onClick={() => setTab('budget')}>
          预算与合同
        </button>
        <button className={tab === 'rights' ? 'active' : ''} onClick={() => setTab('rights')}>
          资产版权图谱
        </button>
        <span>交付日 {summary.project.deliveryDate}</span>
      </nav>
      {tab === 'overview' && (
        <div className="grid">
          <section className="panel hero">
            <div className="panel-head">
              <div>
                <div className="eyebrow">PROJECT HEALTH / {summary.project.id}</div>
                <h2>{summary.project.title}</h2>
              </div>
              <span className="badge amber">{summary.project.status.toUpperCase()}</span>
            </div>
            <div className="progress-label">
              <span>成本消耗 {Math.round(summary.utilization * 100)}%</span>
              <b>
                {money(summary.actual)} / {money(summary.planned)}
              </b>
            </div>
            <div className="progress">
              <i style={{ width: `${Math.min(100, summary.utilization * 100)}%` }} />
            </div>
            <div className="split">
              <div>
                <small>合同暴露额</small>
                <strong>{money(summary.contractExposure)}</strong>
              </div>
              <div>
                <small>高风险预算项</small>
                <strong className="bad">{summary.highRiskLines.length}</strong>
              </div>
              <div>
                <small>版权冲突</small>
                <strong className={conflicts.length ? 'bad' : ''}>{conflicts.length}</strong>
              </div>
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>待审批队列</h3>
              <span>{summary.approvals.filter((a) => a.status === 'pending').length} PENDING</span>
            </div>
            {summary.approvals.map((a) => (
              <div className="approval" key={a.id}>
                <span className={`status ${a.status}`} />
                <div>
                  <b>{a.title}</b>
                  <small>
                    {a.approver} · {a.id}
                  </small>
                </div>
                {a.status === 'pending' ? (
                  <button disabled={refreshing || submitting} onClick={() => approve(a.id)}>
                    {refreshing || submitting ? '提交中…' : '通过'}
                  </button>
                ) : (
                  <em>已完成</em>
                )}
              </div>
            ))}
          </section>
          <section className="panel wide">
            <div className="panel-head">
              <h3>交付风险雷达</h3>
              <span>基于版本、授权窗口与预算预测</span>
            </div>
            {conflicts.length ? (
              conflicts.map((c, i) => (
                <div className="risk-row" key={i}>
                  <strong className={c.severity}>{c.severity === 'critical' ? 'CRITICAL' : 'WARNING'}</strong>
                  <div>
                    <b>{c.assetA}</b>
                    <small>
                      ↔ {c.assetB} · {c.reason}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty">当前项目未发现版权窗口冲突。</div>
            )}
          </section>
        </div>
      )}
      {tab === 'budget' && (
        <div className="grid">
          <section className="panel wide">
            <div className="panel-head">
              <h3>预算版本 V3 / 成本基线</h3>
              <span>实际 + 承诺 + 预测</span>
            </div>
            <div className="table">
              <div className="tr th">
                <span>科目</span>
                <span>预算</span>
                <span>已承诺</span>
                <span>实际</span>
                <span>预测</span>
                <span>风险</span>
              </div>
              {summary.lines.map((line) => (
                <div className="tr" key={line.id}>
                  <span>
                    <b>{line.category}</b>
                    <small>{line.subcategory}</small>
                  </span>
                  <span>{money(line.planned)}</span>
                  <span>{money(line.planned ? line.planned : 0)}</span>
                  <span>{money(line.actual)}</span>
                  <span className={line.forecast > line.planned ? 'bad' : ''}>{money(line.forecast)}</span>
                  <span className={`risk ${line.risk}`}>{line.risk}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>供应商付款里程碑</h3>
            </div>
            {summary.contracts.map((c) => (
              <div className="contract" key={c.vendor}>
                <b>{c.vendor}</b>
                <small>{c.scope}</small>
                <div className="contract-bar">
                  <i style={{ width: `${Math.round((c.paid / c.committed) * 100)}%` }} />
                </div>
                <span>
                  {money(c.paid)} / {money(c.committed)}
                </span>
                <em>{c.milestones.filter((m) => m.status !== 'paid').length} 个待结点</em>
              </div>
            ))}
          </section>
        </div>
      )}
      {tab === 'rights' && (
        <div className="grid">
          <section className="panel wide">
            <div className="panel-head">
              <h3>资产版本登记</h3>
              <span>{summary.assets.length} assets / checksum tracked</span>
            </div>
            <div className="table">
              <div className="tr th">
                <span>资产</span>
                <span>版本</span>
                <span>状态</span>
                <span>授权截止</span>
              </div>
              {summary.assets.map((a) => (
                <div className="tr" key={a.id}>
                  <span>
                    <b>{a.name}</b>
                    <small>
                      {a.id} · {a.type}
                    </small>
                  </span>
                  <span>v{a.version}</span>
                  <span className={`pill ${a.status}`}>{a.status}</span>
                  <span>{a.availableTo}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <div className="panel-head">
              <h3>授权冲突</h3>
              <span>{conflicts.length} detected</span>
            </div>
            {conflicts.map((c, i) => (
              <div className="conflict" key={i}>
                <strong>{c.severity}</strong>
                <b>{c.assetA}</b>
                <small>{c.reason}</small>
              </div>
            ))}
          </section>
        </div>
      )}
      <footer>FrameLedger baseline · 内存仓储 + REST API · 可扩展对象存储、预算版本审批、版权方台账与交付包校验</footer>
    </main>
  );
}
