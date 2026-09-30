import test from 'node:test';
import assert from 'node:assert/strict';
import type { ConsoleApi } from './api.js';
import { ProjectConsoleLoader } from './loader.js';
import type { Conflict, ConsoleState, Project, Summary } from './types.js';

/**
 * 可控延迟的假 API：每次调用登记一个 Deferred，
 * 测试可以按调用顺序、按项目任意安排响应到达的时机与成败，
 * 从而稳定复现“快速切换 + 人为延迟单个请求”的竞态。
 */
type CallName = 'projects' | 'summary' | 'conflicts' | 'approve';
type PendingCall = {
  id: number;
  name: CallName;
  key: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

class FakeConsoleApi implements ConsoleApi {
  private seq = 0;
  readonly calls: PendingCall[] = [];
  readonly approvalInputs: { id: string; decision: unknown }[] = [];

  private enqueue(name: CallName, key: string, executor: (call: PendingCall) => Promise<unknown>): Promise<never> {
    const call: PendingCall = { id: this.seq++, name, key, resolve: () => {}, reject: () => {} };
    const promise = new Promise<never>((resolve, reject) => {
      call.resolve = resolve as (value: unknown) => void;
      call.reject = reject;
    });
    this.calls.push(call);
    void executor(call);
    return promise;
  }

  listProjects(): Promise<Project[]> {
    return this.enqueue('projects', '', () => Promise.resolve());
  }
  getSummary(projectId: string): Promise<Summary> {
    return this.enqueue('summary', projectId, () => Promise.resolve());
  }
  getConflicts(projectId: string): Promise<Conflict[]> {
    return this.enqueue('conflicts', projectId, () => Promise.resolve());
  }
  approve(approvalId: string, decision: { status: string; comment?: string }): Promise<unknown> {
    this.approvalInputs.push({ id: approvalId, decision });
    return this.enqueue('approve', approvalId, () => Promise.resolve());
  }

  /** 取第 n 次某类调用（可按 key 过滤）。 */
  at(name: CallName, index = 0, key?: string): PendingCall {
    const matches = this.calls.filter((c) => c.name === name && (key === undefined || c.key === key));
    const call = matches[index];
    assert.ok(call, `缺少第 ${index} 个 ${name}${key ? `(${key})` : ''} 调用，实际只有 ${matches.length} 个`);
    return call;
  }
  count(name: CallName, key?: string): number {
    return this.calls.filter((c) => c.name === name && (key === undefined || c.key === key)).length;
  }
  succeed(call: PendingCall, value: unknown): void {
    call.resolve(value);
  }
  fail(call: PendingCall, message: string): void {
    call.reject(new Error(message));
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const northstar: Project = { id: 'PRJ-001', title: 'Northstar / 北境回声', status: 'post', deliveryDate: '2026-11-13' };
const orbit: Project = { id: 'PRJ-002', title: 'Orbit / 轨道之外', status: 'production', deliveryDate: '2027-02-03' };
const projects = [northstar, orbit];

function summaryFor(project: Project, marker: string): Summary {
  return {
    project,
    planned: 100, forecast: 110, actual: 40, variance: 10, utilization: 0.4, committed: 60,
    contractExposure: 70, assetCount: project.id === 'PRJ-001' ? 3 : 1, pendingApprovals: project.id === 'PRJ-001' ? 2 : 0,
    highRiskLines: project.id === 'PRJ-001' ? [{ subcategory: '调色、DIT、母版', forecast: 575, planned: 540 }] : [],
    lines: [], contracts: [], assets: [],
    approvals: project.id === 'PRJ-001'
      ? [
          { id: 'APR-01', title: `后期超支预案 ${marker}`, status: 'pending', approver: '财务负责人' },
          { id: 'APR-02', title: `最终母版锁定 ${marker}`, status: 'pending', approver: '总制片人' },
        ]
      : [{ id: 'APR-03', title: `海外节展交付包 ${marker}`, status: 'approved', approver: '法务负责人' }],
  };
}
const conflictsFor = (projectId: string): Conflict[] =>
  projectId === 'PRJ-001'
    ? [{ severity: 'critical', assetA: '片尾曲 N', assetB: '母版 N', reason: '音乐-同步许可 N' }]
    : [];

/** 让某次选择的三个请求全部成功（项目列表可复用同一份 fixture）。 */
async function settleReady(api: FakeConsoleApi, project: Project, options: { projectsAt?: number } = {}): Promise<void> {
  api.succeed(api.at('projects', options.projectsAt ?? 0), projects);
  await flush();
  api.succeed(api.at('summary', 0, project.id), summaryFor(project, project.id));
  api.succeed(api.at('conflicts', 0, project.id), conflictsFor(project.id));
  await flush();
}

/** 监听器每次提交都做一致性检查：ready 态里绝不允许出现两个项目的拼接数据。 */
function trackStates(loader: ProjectConsoleLoader): ConsoleState[] {
  const seen: ConsoleState[] = [];
  loader.subscribe(() => {
    const s = loader.getState();
    seen.push(s);
    if (s.phase === 'ready') {
      assert.equal(s.summary.project.id, s.projectId, '摘要项目必须与选中项目一致');
      const ids = new Set<string>();
      s.summary.approvals.forEach((a) => ids.add(a.title.endsWith('PRJ-001') ? 'PRJ-001' : a.title.endsWith('PRJ-002') ? 'PRJ-002' : '?'));
      assert.ok(ids.size <= 1, '审批队列不得混入其他项目的数据');
      const expectedConflicts = s.projectId === 'PRJ-001' ? 1 : 0;
      if (expectedConflicts === 0 && s.conflicts.length) assert.fail('版权冲突不得残留其他项目的数据');
    }
  });
  return seen;
}

test('连续快速切换：先 A→B 再 B→A，旧世代的响应即使更晚到达也被整体丢弃', async () => {
  const api = new FakeConsoleApi();
  const loader = new ProjectConsoleLoader(api);
  trackStates(loader);

  loader.selectProject(northstar.id); // gen1
  await flush();
  loader.selectProject(orbit.id); // gen2
  await flush();
  loader.selectProject(northstar.id); // gen3 —— 最终选择
  await flush();

  // 三次 projects 请求都先回来，只有最新一次会继续拉摘要/冲突
  assert.equal(api.count('projects'), 3);
  api.succeed(api.at('projects', 0), projects); // gen1 迟到
  api.succeed(api.at('projects', 1), projects); // gen2 迟到
  api.succeed(api.at('projects', 2), projects); // gen3 最新
  await flush();
  assert.equal(api.count('summary'), 1, '被取代的选择在世代检查处终止，不会发起摘要请求');
  assert.equal(api.at('summary', 0).key, northstar.id);

  // 人为延迟：最新选择的摘要先到、冲突后到，原子提交期间页面始终是 loading
  api.succeed(api.at('summary', 0), summaryFor(northstar, northstar.id));
  await flush();
  assert.equal(loader.getState().phase, 'loading', '摘要与冲突必须原子可见，禁止半份数据');
  api.succeed(api.at('conflicts', 0), conflictsFor(northstar.id));
  await flush();
  const state = loader.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase !== 'ready') throw new Error('应进入 ready');
  assert.equal(state.projectId, northstar.id);
  assert.equal(state.summary.project.title, northstar.title);
  assert.equal(state.summary.project.deliveryDate, northstar.deliveryDate);
  assert.equal(state.summary.pendingApprovals, 2);
  assert.equal(state.conflicts.length, 1);

  // 再来一轮 B→A 快速切换，但这次让 Orbit（被丢弃的旧选择）的响应最晚到达
  loader.selectProject(orbit.id); // gen4
  await flush();
  loader.selectProject(northstar.id); // gen5
  await flush();
  api.succeed(api.at('projects', 3), projects); // gen4 的 projects 晚到
  api.succeed(api.at('projects', 4), projects); // gen5 最新
  await flush();
  assert.equal(api.at('summary', 1).key, northstar.id, '只有 gen5 会发起摘要请求');

  api.succeed(api.at('summary', 1), summaryFor(northstar, northstar.id));
  api.succeed(api.at('conflicts', 1), conflictsFor(northstar.id));
  await flush();
  // gen4 已在世代检查处终止，没有后续调用；最终状态仍是 Northstar
  const finalRound = loader.getState();
  assert.equal(finalRound.phase, 'ready');
  if (finalRound.phase === 'ready') assert.equal(finalRound.projectId, northstar.id);
});

test('切换后失败：旧选择的迟到失败/成功响应都不能复活旧数据，重新连接只恢复当前项目', async () => {
  const api = new FakeConsoleApi();
  const loader = new ProjectConsoleLoader(api);
  trackStates(loader);

  // 先载入 Northstar
  loader.selectProject(northstar.id);
  await flush();
  await settleReady(api, northstar);
  assert.equal(loader.getState().phase, 'ready');

  // 切到 Orbit（gen2）后立刻切回 Northstar（gen3）：Orbit 的请求变成旧世代
  loader.selectProject(orbit.id);
  await flush();
  assert.equal(loader.getState().phase, 'loading', '切换瞬间旧项目数据必须整体卸载，不渲染残留页');
  assert.equal(loader.getState().projectId, orbit.id);
  loader.selectProject(northstar.id); // gen3 最新；gen2(Orbit) 变旧
  await flush();

  // gen2 的 projects 晚到并失败 —— 旧世代的错误绝不能覆盖新选择
  api.fail(api.at('projects', 1), 'Orbit 列表请求网络中断');
  await flush();
  assert.notEqual(loader.getState().phase, 'error', '旧世代失败不得影响当前加载');

  // gen3（最新选择）的 projects 成功，但摘要失败、冲突迟到成功
  api.succeed(api.at('projects', 2), projects);
  await flush();
  api.fail(api.at('summary', 1, northstar.id), '摘要服务 500');
  api.succeed(api.at('conflicts', 1, northstar.id), conflictsFor(northstar.id));
  await flush();
  const failed = loader.getState();
  assert.equal(failed.phase, 'error', '最新选择失败必须进入错误页');
  if (failed.phase === 'error') {
    assert.equal(failed.projectId, northstar.id);
    assert.equal(failed.message, '摘要服务 500');
  }

  // 重新连接：沿用下拉框中的当前项目，重试成功后恢复
  loader.retry();
  await flush();
  assert.equal(loader.getState().phase, 'loading');
  api.succeed(api.at('projects', 3), projects);
  await flush();
  api.succeed(api.at('summary', 2, northstar.id), summaryFor(northstar, northstar.id));
  api.succeed(api.at('conflicts', 2, northstar.id), conflictsFor(northstar.id));
  await flush();
  const reconnected = loader.getState();
  assert.equal(reconnected.phase, 'ready');
  if (reconnected.phase === 'ready') {
    assert.equal(reconnected.projectId, northstar.id);
    assert.equal(reconnected.summary.project.title, northstar.title);
  }

  // 恢复后再做一轮快速切换：旧选择(NS)的迟到列表响应不能覆盖最终选中的 Orbit
  loader.selectProject(northstar.id); // gen4 旧
  await flush();
  loader.selectProject(orbit.id); // gen5 最新
  await flush();
  api.succeed(api.at('projects', 4), projects); // gen4 迟到成功，必须被忽略
  await flush();
  api.succeed(api.at('projects', 5), projects); // gen5 最新
  await flush();
  api.succeed(api.at('summary', 0, orbit.id), summaryFor(orbit, orbit.id));
  api.succeed(api.at('conflicts', 0, orbit.id), conflictsFor(orbit.id));
  await flush();
  const finalState = loader.getState();
  assert.equal(finalState.phase, 'ready');
  if (finalState.phase === 'ready') {
    assert.equal(finalState.projectId, orbit.id, '重新连接与切换竞争时以最新选择为准');
    assert.equal(finalState.summary.project.title, orbit.title);
    assert.equal(finalState.summary.project.deliveryDate, orbit.deliveryDate);
    assert.equal(finalState.conflicts.length, 0, 'Northstar 的版权冲突不得残留');
    assert.equal(finalState.summary.pendingApprovals, 0);
  }
});

test('快速重复点击同一项目：多次在途请求以最后一次为准，页面不闪烁、无错误残留', async () => {
  const api = new FakeConsoleApi();
  const loader = new ProjectConsoleLoader(api);
  trackStates(loader);

  loader.selectProject(orbit.id);
  loader.selectProject(orbit.id);
  loader.selectProject(orbit.id);
  await flush();
  assert.equal(api.count('projects'), 3);

  // 前两次（旧世代）一个失败、一个迟到成功，都不得生效
  api.fail(api.at('projects', 0), '第一次点击的网络抖动');
  api.succeed(api.at('projects', 1), projects);
  await flush();
  assert.equal(loader.getState().phase, 'loading');
  assert.equal(api.count('summary'), 0, '被取代的请求即使成功也不得继续拉摘要');

  api.succeed(api.at('projects', 2), projects);
  await flush();
  api.succeed(api.at('summary', 0, orbit.id), summaryFor(orbit, orbit.id));
  api.succeed(api.at('conflicts', 0, orbit.id), conflictsFor(orbit.id));
  await flush();

  const state = loader.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase === 'ready') {
    assert.equal(state.projectId, orbit.id);
    assert.equal(state.summary.assetCount, 1);
    assert.equal(state.conflicts.length, 0);
  }
});

test('审批后的刷新遵守同一世代规则：刷新成功原子替换，失败保留旧数据，切换后刷新结果作废', async () => {
  const api = new FakeConsoleApi();
  const loader = new ProjectConsoleLoader(api);
  trackStates(loader);

  loader.selectProject(northstar.id);
  await flush();
  await settleReady(api, northstar);

  // 刷新成功：refreshing 标记随最新世代置位并清除
  const refreshDone = loader.refresh();
  await flush();
  let s = loader.getState();
  assert.equal(s.phase, 'ready');
  if (s.phase === 'ready') assert.equal(s.refreshing, true);
  assert.equal(api.at('summary', 1).key, northstar.id);

  const refreshedSummary = { ...summaryFor(northstar, northstar.id), pendingApprovals: 1, assetCount: 9 };
  api.succeed(api.at('summary', 1), refreshedSummary);
  api.succeed(api.at('conflicts', 1), conflictsFor(northstar.id));
  const applied = await refreshDone;
  assert.equal(applied, true);
  s = loader.getState();
  if (s.phase === 'ready') {
    assert.equal(s.refreshing, false);
    assert.equal(s.summary.assetCount, 9);
    assert.equal(s.summary.pendingApprovals, 1);
  }

  // 刷新失败：保留旧项目数据，仅清除 refreshing，由调用方提示错误
  const failedRefresh = loader.refresh();
  await flush();
  api.fail(api.at('summary', 2), '刷新时断线');
  await assert.rejects(failedRefresh, /刷新时断线/);
  s = loader.getState();
  assert.equal(s.phase, 'ready', '刷新失败不得把页面打回错误屏');
  if (s.phase === 'ready') {
    assert.equal(s.refreshing, false);
    assert.equal(s.summary.assetCount, 9, '失败后旧数据原样保留');
  }
  // 迟到的冲突响应不得复活 refreshing 或覆盖任何内容
  api.succeed(api.at('conflicts', 2), conflictsFor(northstar.id));
  await flush();
  s = loader.getState();
  if (s.phase === 'ready') assert.equal(s.refreshing, false);

  // 刷新进行中切换项目：旧项目的刷新响应整条作废，绝不写入新项目页面
  const staleRefresh = loader.refresh();
  await flush();
  loader.selectProject(orbit.id);
  await flush();
  assert.equal(loader.getState().phase, 'loading');
  assert.equal(loader.getState().projectId, orbit.id);
  api.succeed(api.at('summary', 3), { ...summaryFor(northstar, northstar.id), assetCount: 77 });
  api.succeed(api.at('conflicts', 3), conflictsFor(northstar.id));
  const staleApplied = await staleRefresh;
  assert.equal(staleApplied, false);
  await flush();
  assert.equal(loader.getState().phase, 'loading', '旧刷新结果不得让页面跳回 ready');
  assert.equal(loader.getState().projectId, orbit.id);

  // 让 Orbit 正常完成
  api.succeed(api.at('projects', 1), projects);
  await flush();
  api.succeed(api.at('summary', 0, orbit.id), summaryFor(orbit, orbit.id));
  api.succeed(api.at('conflicts', 0, orbit.id), conflictsFor(orbit.id));
  await flush();
  s = loader.getState();
  assert.equal(s.phase, 'ready');
  if (s.phase === 'ready') {
    assert.equal(s.projectId, orbit.id);
    assert.equal(s.summary.assetCount, 1, '被作废刷新中的 Northstar 数据不得残留');
    assert.equal(s.conflicts.length, 0);
  }

  // 切回 Northstar 并恢复 ready（projects#2）
  loader.selectProject(northstar.id);
  await flush();
  api.succeed(api.at('projects', 2), projects);
  await flush();
  // 至此 NS 摘要调用：初次 + 三次刷新 = per-key #4
  api.succeed(api.at('summary', 4, northstar.id), summaryFor(northstar, northstar.id));
  api.succeed(api.at('conflicts', 4, northstar.id), conflictsFor(northstar.id));
  await flush();
  assert.equal(loader.getState().phase, 'ready');

  // PATCH 尚未返回就切到 Orbit（projects#3 在途）；PATCH 迟到成功后不得再刷新旧项目
  const approveDone = loader.approve('APR-01', { status: 'approved', comment: '在控制台完成复核' });
  await flush();
  assert.ok(api.approvalInputs.some((i) => i.id === 'APR-01'));
  loader.selectProject(orbit.id);
  await flush();
  api.succeed(api.at('approve', 0), { id: 'APR-01', status: 'approved' });
  await flush();
  const approveApplied = await approveDone;
  assert.equal(approveApplied, false, '被切换取代的审批刷新返回 false，调用方不应弹成功提示');
  // PATCH 在旧世代返回后，不得再为 Northstar 发起摘要/冲突请求
  assert.equal(api.count('summary', northstar.id), 5, '审批刷新被取消后不得继续拉旧项目摘要');

  // Orbit 的 projects#3 还在途时又切回 Northstar（projects#4）
  loader.selectProject(northstar.id);
  await flush();
  api.succeed(api.at('projects', 4), projects); // 最新选择
  await flush();
  api.succeed(api.at('projects', 3), projects); // Orbit 的旧请求迟到，必须被忽略
  await flush();
  assert.equal(loader.getState().phase, 'loading', '旧选择的迟到列表响应不得复活 Orbit 加载');
  api.succeed(api.at('summary', 5, northstar.id), summaryFor(northstar, northstar.id));
  api.succeed(api.at('conflicts', 5, northstar.id), conflictsFor(northstar.id));
  await flush();
  s = loader.getState();
  assert.equal(s.phase, 'ready');
  if (s.phase === 'ready') assert.equal(s.projectId, northstar.id);

  // PATCH 本身失败：清除 refreshing 并抛出，旧数据保留
  const failingApprove = loader.approve('APR-02', { status: 'approved', comment: 'x' });
  await flush();
  api.fail(api.at('approve', 1), '审批服务不可用');
  await assert.rejects(failingApprove, /审批服务不可用/);
  s = loader.getState();
  assert.equal(s.phase, 'ready');
  if (s.phase === 'ready') assert.equal(s.refreshing, false);
});

test('启动时首个选择失败后重新连接：加载/错误状态始终携带当前项目且不携带旧数据', async () => {
  const api = new FakeConsoleApi();
  const loader = new ProjectConsoleLoader(api);
  trackStates(loader);

  loader.start(northstar.id);
  await flush();
  assert.equal(loader.getState().phase, 'loading');
  assert.equal(loader.getState().projectId, northstar.id);

  // start 幂等：StrictMode 双调用不会发起第二次请求
  loader.start(northstar.id);
  await flush();
  assert.equal(api.count('projects'), 1);

  api.fail(api.at('projects', 0), '启动时服务离线');
  await flush();
  assert.equal(loader.getState().phase, 'error');
  assert.equal(loader.getState().projectId, northstar.id);

  loader.retry();
  await flush();
  assert.equal(api.count('projects'), 2);
  assert.equal(loader.getState().phase, 'loading');
  api.succeed(api.at('projects', 1), projects);
  await flush();
  api.succeed(api.at('summary', 0, northstar.id), summaryFor(northstar, northstar.id));
  api.succeed(api.at('conflicts', 0, northstar.id), conflictsFor(northstar.id));
  await flush();
  const s = loader.getState();
  assert.equal(s.phase, 'ready');
  if (s.phase === 'ready') {
    assert.equal(s.summary.project.id, northstar.id);
    assert.equal(s.conflicts.length, 1);
  }
});
