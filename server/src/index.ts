import express from 'express';
import { approve, assets, budgetLines, contracts, createApproval, dashboard, projectSummary, projects, rightsConflicts } from './domain.js';
const app = express(); app.use(express.json());

// 手动复现加载竞态用：?delay=毫秒（上限 10s），便于把某个项目的摘要 / 版权冲突响应人为延迟。
const delayOf = (req: express.Request) => {
  const raw = Number(req.query.delay);
  return Number.isFinite(raw) ? Math.max(0, Math.min(10000, raw)) : 0;
};
const delayed = (handler: express.RequestHandler): express.RequestHandler => (req, res, next) => {
  const wait = delayOf(req);
  if (!wait) return handler(req, res, next);
  setTimeout(() => handler(req, res, next), wait);
};

app.get('/api/dashboard', (_req, res) => res.json(dashboard()));
app.get('/api/projects', delayed((_req, res) => res.json(projects)));
app.get('/api/projects/:id/summary', delayed((req, res) => { const result = projectSummary(String(req.params.id)); if (!result.project) return res.status(404).json({ message: '项目不存在' }); res.json(result); }));
app.get('/api/projects/:id/rights-conflicts', delayed((req, res) => res.json(rightsConflicts(String(req.params.id)))));
app.get('/api/projects/:id/assets', (req, res) => res.json(assets.filter(asset => asset.projectId === req.params.id)));
app.get('/api/projects/:id/contracts', (req, res) => res.json(contracts.filter(contract => contract.projectId === req.params.id)));
app.get('/api/budgets/:projectId/lines', (req, res) => res.json(budgetLines.filter(line => line.projectId === req.params.projectId)));
app.post('/api/approvals', (req, res) => res.status(201).json(createApproval(req.body)));
app.patch('/api/approvals/:id', (req, res) => { const result = approve(req.params.id, req.body.status, req.body.comment); if (!result) return res.status(404).json({ message: '审批不存在' }); res.json(result); });
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'film-rights-platform' }));
const port = Number(process.env.PORT || 4104); app.listen(port, () => console.log(`film rights API listening on ${port}`));
