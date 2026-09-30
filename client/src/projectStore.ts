// 项目驾驶舱数据存储：所有异步加载都经过“代际令牌 + AbortController”守卫，
// 确保最终选中的项目是页面上唯一可信的上下文：
//  - 较早发出的请求即使晚返回（或晚失败），也不能覆盖较新的选择；
//  - 切换项目时立即进入加载态并清空上一个项目的摘要/冲突，不残留局部数据；
//  - 同一项目的审批后刷新走独立的 refreshing 状态，失败时保留当前数据并通过返回值提示；
//  - 被取代的请求会被 abort，加载 / 错误 / 重试三种状态各自只属于最新一次操作。

export type Project = { id: string; title: string; status: string; deliveryDate: string };
export type Summary = {
  planned: number; forecast: number; actual: number; variance: number; utilization: number;
  committed: number; contractExposure: number; assetCount: number; pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: { id: string; name: string; type: string; version: number; status: string; availableTo: string }[];
  approvals: { id: string; title: string; status: string; approver: string }[];
  project: Project;
};
export type Conflict = { severity: string; assetA: string; assetB: string; reason: string };

export type DashboardState =
  | { phase: 'loading'; selectedId: string; projects: Project[]; summary: undefined; conflicts: Conflict[]; refreshing: false }
  | { phase: 'error'; selectedId: string; projects: Project[]; summary: undefined; conflicts: Conflict[]; refreshing: false; error: string }
  | { phase: 'ready'; selectedId: string; projects: Project[]; summary: Summary; conflicts: Conflict[]; refreshing: boolean };

export interface ApiClient {
  listProjects(signal: AbortSignal): Promise<Project[]>;
  getSummary(projectId: string, signal: AbortSignal): Promise<Summary>;
  getConflicts(projectId: string, signal: AbortSignal): Promise<Conflict[]>;
  approve(approvalId: string, comment: string, signal: AbortSignal): Promise<unknown>;
}

const DEFAULT_PROJECT = 'PRJ-001';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { message?: string }).message || `请求失败 (${response.status})`);
  return body as T;
}

export const httpApi: ApiClient = {
  listProjects: (signal) => request<Project[]>('/projects', { signal }),
  getSummary: (projectId, signal) => request<Summary>(`/projects/${projectId}/summary`, { signal }),
  getConflicts: (projectId, signal) => request<Conflict[]>(`/projects/${projectId}/rights-conflicts`, { signal }),
  approve: (approvalId, comment, signal) =>
    request(`/approvals/${approvalId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved', comment }),
      signal,
    }),
};

type LoadResult =
  | { outcome: 'ready'; projectId: string }
  | { outcome: 'error'; projectId: string; message: string }
  | { outcome: 'stale'; projectId: string };

const isAbortError = (reason: unknown) =>
  typeof DOMException !== 'undefined' && reason instanceof DOMException && reason.name === 'AbortError';

const errorMessage = (reason: unknown) =>
  reason instanceof Error && reason.message ? reason.message : '无法连接制作服务';

export class ProjectDashboardStore {
  private state: DashboardState = {
    phase: 'loading',
    selectedId: DEFAULT_PROJECT,
    projects: [],
    summary: undefined,
    conflicts: [],
    refreshing: false,
  };
  private listeners = new Set<() => void>();
  // 每次 selectProject / reconnect / refresh 都会递增；只有代际最新的加载能写状态。
  private generation = 0;
  private controller: AbortController | null = null;
  private started = false;

  constructor(private readonly api: ApiClient = httpApi) {}

  getState = (): DashboardState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.load(this.state.selectedId, { preserve: false });
  }

  // 测试或卸载时使用：作废所有在途请求，迟到的响应只会被识别为 stale。
  stop(): void {
    this.started = false;
    this.beginGeneration();
  }

  // 下拉切换：立即把新项目设为唯一上下文并清空旧项目数据。
  selectProject(id: string): void {
    if (id === this.state.selectedId) return;
    void this.load(id, { preserve: false });
  }

  // 断线提示页上的“重新连接”，沿用当前选中项目。
  reconnect(): Promise<LoadResult> {
    return this.load(this.state.selectedId, { preserve: false });
  }

  // 同项目手动刷新；保留当前数据，仅切换 refreshing。
  refresh(): Promise<string | null> {
    return this.reloadCurrent();
  }

  // 审批通过后刷新：PATCH 成功后按同一套代际规则刷新当前（可能已被切换的）项目。
  async approve(approvalId: string, comment: string): Promise<string | null> {
    try {
      await this.api.approve(approvalId, comment, new AbortController().signal);
    } catch (reason) {
      if (isAbortError(reason)) return '审批请求已取消';
      return errorMessage(reason);
    }
    return this.reloadCurrent();
  }

  private async reloadCurrent(): Promise<string | null> {
    const result = await this.load(this.state.selectedId, { preserve: true });
    return result.outcome === 'error' ? result.message : null;
  }

  private beginGeneration(): { generation: number; signal: AbortSignal } {
    this.generation += 1;
    this.controller?.abort();
    this.controller = new AbortController();
    return { generation: this.generation, signal: this.controller.signal };
  }

  private setState(next: DashboardState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }

  private async load(id: string, options: { preserve: boolean }): Promise<LoadResult> {
    const token = this.beginGeneration();
    const canPreserve =
      options.preserve && this.state.phase === 'ready' && this.state.selectedId === id;

    // 切换（非保留）时立刻清掉旧项目的摘要与冲突，加载期间页面只剩“当前选中项目”这一种上下文。
    if (canPreserve && this.state.phase === 'ready') {
      this.setState({ ...this.state, refreshing: true });
    } else {
      this.setState({
        phase: 'loading',
        selectedId: id,
        projects: this.state.projects,
        summary: undefined,
        conflicts: [],
        refreshing: false,
      });
    }

    try {
      const items = await this.api.listProjects(token.signal);
      if (token.generation !== this.generation) return { outcome: 'stale', projectId: id };

      const active = items.find((item) => item.id === id) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');

      const [summary, conflicts] = await Promise.all([
        this.api.getSummary(active.id, token.signal),
        this.api.getConflicts(active.id, token.signal),
      ]);
      if (token.generation !== this.generation) return { outcome: 'stale', projectId: id };

      // 原子提交：项目身份、摘要、版权冲突同时落地，页头与各面板永远来自同一个项目。
      this.setState({
        phase: 'ready',
        selectedId: active.id,
        projects: items,
        summary,
        conflicts,
        refreshing: false,
      });
      return { outcome: 'ready', projectId: active.id };
    } catch (reason) {
      // 被 abort 或被更新的选择取代：不允许旧响应/旧错误碰当前状态。
      if (token.generation !== this.generation) return { outcome: 'stale', projectId: id };
      const message = errorMessage(reason);
      if (canPreserve && this.state.phase === 'ready') {
        // 同项目刷新失败：保留已有数据，错误由调用方以提示条呈现。
        this.setState({ ...this.state, refreshing: false });
        return { outcome: 'error', projectId: id, message };
      }
      this.setState({
        phase: 'error',
        selectedId: id,
        projects: this.state.projects,
        summary: undefined,
        conflicts: [],
        refreshing: false,
        error: message,
      });
      return { outcome: 'error', projectId: id, message };
    }
  }
}
