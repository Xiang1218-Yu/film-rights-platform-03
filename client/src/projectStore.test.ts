import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectDashboardStore, type ApiClient, type Conflict, type Project, type Summary } from './projectStore.js';

// 用“可控延迟”的假 API 复现片方在两个项目之间快速切换时的加载竞态：
// 每个请求都返回一个可手动 settle 的 deferred，测试可以按任意顺序让较早 / 较晚的响应返回或失败。

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void; signal: AbortSignal };

function defer<T>(signal: AbortSignal): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject, signal };
}

const abortError = () => {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
};

class ControlledApi implements ApiClient {
  projectsQueue: Deferred<Project[]>[] = [];
  summaryQueue: Deferred<Summary>[] = [];
  conflictQueue: Deferred<Conflict[]>[] = [];
  approveQueue: Deferred<unknown>[] = [];
  abortedSignals: AbortSignal[] = [];

  private track<T>(queue: Deferred<T>[], signal: AbortSignal): Promise<T> {
    const item = defer<T>(signal);
    if (signal.aborted) {
      queue.push(item);
      this.abortedSignals.push(signal);
      return Promise.reject(abortError());
    }
    signal.addEventListener('abort', () => this.abortedSignals.push(signal), { once: true });
    queue.push(item);
    return item.promise;
  }

  listProjects = (signal: AbortSignal) => this.track(this.projectsQueue, signal);
  getSummary = (_id: string, signal: AbortSignal) => this.track(this.summaryQueue, signal);
  getConflicts = (_id: string, rel: AbortSignal) => this.track(this.conflictQueue, rel);
  approve = (_id: string, _comment: string, signal: AbortSignal) => this.track(this.approveQueue, signal);

  // 让最近一次发出的请求成功，模拟较晚选择的响应先返回。
  settleLast<T>(queue: Deferred<T>[], value: T): void {
    queue.pop()?.resolve(value);
  }

  settleAllProjects(projects: Project[]): void {
    this.projectsQueue.forEach((item) => item.resolve(projects));
    this.projectsQueue.length = 0;
  }

  failLast<T>(queue: Deferred<T>[], message: string): void {
    queue.pop()?.reject(new Error(message));
  }

  pendingSummary = () => this.summaryQueue.length;
  pendingConflicts = () => this.conflictQueue.length;
}

const P1: Project = { id: 'PRJ-001', title: 'Northstar / 北境回声', status: 'post', deliveryDate: '2026-11-13' };
const P2: Project = { id: 'PRJ-002', title: 'Orbit / 轨道之外', status: 'production', deliveryDate: '2027-02-03' };
const PROJECTS = [P1, P2];

function summaryFor(project: Project, kind: 'northstar' | 'orbit'): Summary {
  const base = {
    project,
    planned: 100, forecast: 110, actual: 50, variance: 10, utilization: 0.5,
    committed: 80, contractExposure: 40, assetCount: 3, pendingApprovals: 2,
    highRiskLines: [], lines: [], contracts: [], approvals: [],
  };
  return kind === 'northstar'
    ? { ...base, assets: [{ id: 'AST-001', name: '北境回声 Master', type: 'master', version: 1, status: 'review', availableTo: '2028-01-01' }] }
    : { ...base, assets: [{ id: 'AST-004', name: 'Orbit Plates', type: 'master', version: 3, status: 'review', availableTo: '2027-12-01' }] };
}
const CONFLICTS_P1: Conflict[] = [{ severity: 'critical', assetA: '北境回声 Master', assetB: '片尾曲', reason: '音乐-同步许可' }];
const CONFLICTS_P2: Conflict[] = [];

// 连续推进若干个宏任务，确保在 await 链上排队的微任务都执行完。
const flush = (rounds = 4) =>
  Array.from({ length: rounds }).reduce<Promise<void>>(
    (chain) => chain.then(() => new Promise((resolve) => setImmediate(resolve))),
    Promise.resolve(),
  );

// 让“当前最新一代”加载走完：项目列表 -> 摘要 + 冲突。
async function settleFreshLoad(api: ControlledApi, project: Project, kind: 'northstar' | 'orbit', conflicts: Conflict[]): Promise<void> {
  api.settleAllProjects(PROJECTS);
  await flush();
  api.settleLast(api.summaryQueue, summaryFor(project, kind));
  api.settleLast(api.conflictQueue, conflicts);
  await flush();
}

// 让某次切换先拿到项目列表、发出摘要/冲突请求（随后这两个请求被人为挂起）。
async function reachDelayedDetailRequests(api: ControlledApi): Promise<void> {
  api.settleAllProjects(PROJECTS);
  await flush();
}

function makeStore(): { store: ProjectDashboardStore; api: ControlledApi } {
  const api = new ControlledApi();
  const store = new ProjectDashboardStore(api);
  store.start();
  return { store, api };
}

test('连续切换后，较早发出的项目摘要延迟返回也不能覆盖最终选中的项目', async () => {
  const { store, api } = makeStore();

  // 初次加载 PRJ-001 完成。
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);
  assert.equal(store.getState().phase, 'ready');
  assert.equal(store.getState().selectedId, 'PRJ-001');

  // 快速切到 PRJ-002：其项目列表先到，摘要/版权冲突请求被人为延迟挂起。
  store.selectProject('PRJ-002');
  await flush();
  await reachDelayedDetailRequests(api);
  assert.equal(api.pendingSummary(), 1);
  assert.equal(api.pendingConflicts(), 1);

  // 立刻切回 PRJ-001：被取代的 PRJ-002 请求应当收到 abort 信号。
  store.selectProject('PRJ-001');
  await flush();
  assert.ok(api.abortedSignals.length >= 2, '被取代的在途请求必须被取消');
  assert.equal(store.getState().phase, 'loading', '切换期间处于加载态，不展示旧项目数据');
  assert.equal(store.getState().selectedId, 'PRJ-001', '页头身份立即跟随最新选择');
  assert.equal(store.getState().summary, undefined, '旧项目资产/预算内容必须被清空');
  assert.deepEqual(store.getState().conflicts, []);

  // 最终 PRJ-001 的加载先返回。
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);
  let state = store.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.summary.project.title, 'Northstar / 北境回声');
  assert.equal(state.summary.project.deliveryDate, '2026-11-13');
  assert.equal(state.conflicts.length, 1);
  assert.equal(state.summary.pendingApprovals + state.conflicts.length, 3);

  // 被延迟的 PRJ-002 摘要 / 冲突此刻才返回：必须整体被忽略，不能混入 PRJ-001 页面。
  api.settleLast(api.summaryQueue, summaryFor(P2, 'orbit'));
  api.settleLast(api.conflictQueue, CONFLICTS_P2);
  await flush();

  state = store.getState();
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.selectedId, 'PRJ-001');
  assert.equal(state.summary.project.id, 'PRJ-001', '页头项目名称不能被旧响应覆盖');
  assert.equal(state.summary.project.deliveryDate, '2026-11-13', '交付日期不能来自旧项目');
  assert.equal(state.summary.assets[0].id, 'AST-001', '资产内容不能残留成旧项目');
  assert.equal(state.conflicts.length, 1, '风险数量不能被旧项目的零冲突覆盖');
  assert.equal(state.refreshing, false);
});

test('摘要与版权冲突分先后延迟返回时，两者必须原子来自同一项目', async () => {
  const { store, api } = makeStore();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);

  // PRJ-002 的详情请求挂起，再切回 PRJ-001 并完成加载。
  store.selectProject('PRJ-002');
  await flush();
  await reachDelayedDetailRequests(api);
  store.selectProject('PRJ-001');
  await flush();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);

  // 旧的 PRJ-002 摘要先到、冲突后到：任何一半都不能单独落地。
  api.settleLast(api.summaryQueue, summaryFor(P2, 'orbit'));
  await flush();
  let state = store.getState();
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.summary.project.id, 'PRJ-001', '旧摘要不能单独落地');

  api.settleLast(api.conflictQueue, CONFLICTS_P2);
  await flush();
  state = store.getState();
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.summary.project.id, 'PRJ-001');
  assert.equal(state.conflicts.length, 1, '旧冲突响应不能单独覆盖风险数量');
});

test('切换后的加载失败时显示错误与重试，不残留旧项目局部数据；重新连接成功后恢复', async () => {
  const { store, api } = makeStore();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);

  // 切到 PRJ-002，其项目列表成功但摘要 / 冲突请求失败。
  store.selectProject('PRJ-002');
  await flush();
  await reachDelayedDetailRequests(api);
  api.failLast(api.summaryQueue, 'PRJ-002 summary 超时');
  api.failLast(api.conflictQueue, 'PRJ-002 conflicts 超时');
  await flush();

  let state = store.getState();
  assert.equal(state.phase, 'error');
  if (state.phase !== 'error') throw new Error('unreachable');
  assert.equal(state.selectedId, 'PRJ-002');
  assert.equal(state.summary, undefined, '旧项目摘要不得残留在失败的新项目页面');
  assert.deepEqual(state.conflicts, []);
  assert.match(state.error, /超时/);

  // 断线提示上的“重新连接”沿用同一项目，成功后恢复。
  const reconnect = store.reconnect();
  await flush();
  assert.equal(store.getState().phase, 'loading');
  await settleFreshLoad(api, P2, 'orbit', CONFLICTS_P2);
  const result = await reconnect;
  assert.equal(result.outcome, 'ready');
  state = store.getState();
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.summary.project.id, 'PRJ-002');
  assert.equal(state.summary.project.deliveryDate, '2027-02-03');
  assert.equal(state.conflicts.length, 0);
});

test('旧加载延迟返回的失败不能覆盖更新选择的成功结果', async () => {
  const { store, api } = makeStore();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);

  store.selectProject('PRJ-002');
  await flush();
  await reachDelayedDetailRequests(api);
  store.selectProject('PRJ-001');
  await flush();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);
  assert.equal(store.getState().phase, 'ready');

  // 较早那次 PRJ-002 现在才失败：错误必须被吞掉，不能把页面推入错误态。
  api.failLast(api.summaryQueue, '迟到的 PRJ-002 失败');
  api.failLast(api.conflictQueue, '迟到的 PRJ-002 失败');
  await flush();
  const state = store.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.summary.project.id, 'PRJ-001');
  assert.equal(state.conflicts.length, 1);
});

test('快速重复点击重新连接时，只有最新一次重试能决定加载/错误结果', async () => {
  const api = new ControlledApi();
  const store = new ProjectDashboardStore(api);
  store.start();

  // 首次连接失败，进入断线提示。
  await flush();
  api.failLast(api.projectsQueue, '首次连接失败');
  await flush();
  assert.equal(store.getState().phase, 'error');

  // 快速连点两次“重新连接”，较早一次的请求仍挂在队列里。
  const first = store.reconnect();
  void first;
  await flush();
  const second = store.reconnect();
  await flush();
  assert.equal(store.getState().phase, 'loading');
  assert.ok(api.abortedSignals.length >= 1, '较早的重试应被 abort');

  // 较早的重试晚失败，不能影响最新一次。
  const staleRetry = api.projectsQueue.shift();
  assert.ok(staleRetry);
  staleRetry?.reject(new Error('第一次重试迟到的失败'));
  await flush();
  assert.equal(store.getState().phase, 'loading');

  // 最新一次成功。
  api.settleAllProjects(PROJECTS);
  await flush();
  api.settleLast(api.summaryQueue, summaryFor(P1, 'northstar'));
  api.settleLast(api.conflictQueue, CONFLICTS_P1);
  const result = await second;
  await flush();
  assert.equal(result.outcome, 'ready');
  const state = store.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase === 'ready') assert.equal(state.summary.project.id, 'PRJ-001');
});

test('审批完成后的刷新遵守同一规则：刷新期间切换项目，旧刷新结果不能覆盖新项目', async () => {
  const { store, api } = makeStore();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);

  // 审批 PATCH 成功后触发同项目刷新；刷新保留当前页面数据，仅进入 refreshing。
  const approval = store.approve('APR-01', '在控制台完成复核');
  await flush();
  api.settleLast(api.approveQueue, { ok: true });
  await flush();
  await reachDelayedDetailRequests(api);
  let state = store.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.refreshing, true);
  assert.equal(state.summary.project.id, 'PRJ-001');

  // 刷新途中用户切到 PRJ-002：旧刷新被作废，加载态清空旧项目数据。
  store.selectProject('PRJ-002');
  await flush();
  assert.equal(store.getState().phase, 'loading');
  assert.equal(store.getState().summary, undefined, '切换加载期不得残留旧项目局部数据');

  // 审批触发的那次 PRJ-001 刷新摘要此刻才返回（冲突仍在途）：不能落地。
  api.settleLast(api.summaryQueue, summaryFor(P1, 'northstar'));
  await flush();
  assert.equal(store.getState().phase, 'loading');
  assert.equal(store.getState().summary, undefined, '审批后的旧刷新响应不能覆盖新项目加载态');

  // 新项目正常完成。
  await settleFreshLoad(api, P2, 'orbit', CONFLICTS_P2);

  // 旧刷新残留的冲突响应再晚到，也不能改风险数量；审批 Promise 以 stale 结束、不报错。
  const staleConflict = api.conflictQueue.pop();
  assert.ok(staleConflict, '应当还存在一个被延迟的旧刷新冲突请求');
  staleConflict?.resolve(CONFLICTS_P1);
  await flush();
  await approval;

  state = store.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.summary.project.id, 'PRJ-002', '最终上下文是切换后的项目');
  assert.equal(state.summary.project.deliveryDate, '2027-02-03');
  assert.equal(state.conflicts.length, 0);
  assert.equal(state.refreshing, false);
});

test('同项目刷新失败时保留现有数据并返回错误信息，成功时原子更新', async () => {
  const { store, api } = makeStore();
  await settleFreshLoad(api, P1, 'northstar', CONFLICTS_P1);

  const failed = store.refresh();
  await flush();
  await reachDelayedDetailRequests(api);
  api.failLast(api.summaryQueue, '刷新网络中断');
  api.settleLast(api.conflictQueue, CONFLICTS_P1);
  const message = await failed;
  assert.match(message ?? '', /网络中断/);
  const state = store.getState();
  assert.equal(state.phase, 'ready');
  if (state.phase !== 'ready') throw new Error('unreachable');
  assert.equal(state.refreshing, false);
  assert.equal(state.summary.project.id, 'PRJ-001', '失败的刷新不破坏当前可信数据');

  const ok = store.refresh();
  await flush();
  await reachDelayedDetailRequests(api);
  api.settleLast(api.summaryQueue, summaryFor(P1, 'northstar'));
  api.settleLast(api.conflictQueue, []);
  const refreshError = await ok;
  assert.equal(refreshError, null);
  if (store.getState().phase === 'ready') {
    assert.equal(store.getState().conflicts.length, 0, '成功刷新原子替换冲突数量');
  }
});
