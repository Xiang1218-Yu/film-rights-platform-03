import { useSyncExternalStore } from 'react';
import type { ConsoleApi } from './api';
import type { Conflict, ConsoleState, Project, Summary } from './types';

const FALLBACK_PROJECT_ID = 'PRJ-001';
const errorMessage = (reason: unknown) => (reason instanceof Error ? reason.message : '无法连接制作服务');

/**
 * 项目控制台的唯一可信上下文来源。
 *
 * 竞态规则：每次切换 / 重试 / 刷新都会分配一个严格递增的“世代号”（generation）。
 * 任何异步响应（项目列表、摘要、版权冲突、审批后的刷新）在写回状态前都必须核对
 * 世代号——较早发出的响应即使更晚到达也只会被丢弃，最终选中的项目永远是赢家。
 * 摘要与版权冲突在同一个状态提交中原子写入，页面上不可能拼出两个项目的局部数据。
 */
export class ProjectConsoleLoader {
  private gen = 0;
  private lastRequestedId = FALLBACK_PROJECT_ID;
  private started = false;
  private state: ConsoleState = { phase: 'loading', projectId: this.lastRequestedId };
  private listeners = new Set<() => void>();

  constructor(private readonly api: ConsoleApi) {}

  getState = (): ConsoleState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** StrictMode 下 effect 可能执行两次，首次之后的调用不再发起请求。 */
  start(initialId = FALLBACK_PROJECT_ID): void {
    if (this.started) return;
    this.started = true;
    this.selectProject(initialId);
  }

  /** 切换项目：立即进入新项目的加载态并清空旧项目的全部数据，随后只接受本次选择的响应。 */
  selectProject = (projectId: string): void => {
    const gen = ++this.gen;
    this.lastRequestedId = projectId;
    this.commit({ phase: 'loading', projectId });
    void this.loadSelection(projectId, gen);
  };

  /** 断线后的“重新连接”：沿用项目下拉框中当前选中的项目。 */
  retry = (): void => {
    const gen = ++this.gen;
    const projectId = this.lastRequestedId;
    this.commit({ phase: 'loading', projectId });
    void this.loadSelection(projectId, gen);
  };

  /**
   * 审批完成后的刷新：保留当前项目数据在原地刷新，refreshing 期间同样受世代号保护——
   * 若刷新途中用户切换了项目，这次刷新（成功或失败）都会被整条丢弃。
   * 返回 false 表示结果已被更新的选择取代。
   */
  refresh = async (): Promise<boolean> => {
    const snapshot = this.state;
    if (snapshot.phase !== 'ready') return false;
    const gen = ++this.gen;
    this.commit({ ...snapshot, refreshing: true });
    try {
      return await this.loadReady(snapshot.projectId, snapshot.projects, gen);
    } catch (reason) {
      if (gen === this.gen && this.state.phase === 'ready' && this.state.projectId === snapshot.projectId) {
        this.commit({ ...this.state, refreshing: false });
      }
      throw reason;
    }
  };

  /** 通过审批后刷新同一项目；PATCH 或刷新失败时保留已有数据，仅由调用方提示错误。 */
  approve = async (approvalId: string, decision: { status: string; comment: string }): Promise<boolean> => {
    const snapshot = this.state;
    if (snapshot.phase !== 'ready') return false;
    const gen = ++this.gen;
    this.commit({ ...snapshot, refreshing: true });
    try {
      await this.api.approve(approvalId, decision);
    } catch (reason) {
      if (gen === this.gen && this.state.phase === 'ready' && this.state.projectId === snapshot.projectId) {
        this.commit({ ...this.state, refreshing: false });
      }
      throw reason;
    }
    if (gen !== this.gen) return false;
    try {
      return await this.loadReady(snapshot.projectId, snapshot.projects, gen);
    } catch (reason) {
      if (gen === this.gen && this.state.phase === 'ready' && this.state.projectId === snapshot.projectId) {
        this.commit({ ...this.state, refreshing: false });
      }
      throw reason;
    }
  };

  private async loadSelection(projectId: string, gen: number): Promise<void> {
    try {
      const items = await this.api.listProjects();
      if (gen !== this.gen) return;
      const active = items.find((item) => item.id === projectId) ?? items[0];
      if (!active) throw new Error('服务端没有返回项目数据');
      await this.loadReady(active.id, items, gen);
    } catch (reason) {
      if (gen !== this.gen) return;
      this.commit({ phase: 'error', projectId, message: errorMessage(reason) });
    }
  }

  /**
   * 并行拉取摘要与版权冲突，并作为一次原子状态提交。
   * 世代号不匹配时返回 false，绝不触碰当前状态。
   */
  private async loadReady(projectId: string, projects: Project[], gen: number): Promise<boolean> {
    const [summary, conflicts] = await Promise.all([
      this.api.getSummary(projectId),
      this.api.getConflicts(projectId),
    ]);
    if (gen !== this.gen) return false;
    if (!summary || !summary.project || summary.project.id !== projectId) {
      throw new Error('项目摘要与所选项目不一致');
    }
    this.commit({ phase: 'ready', projectId, projects, summary, conflicts, refreshing: false });
    return true;
  }

  private commit(next: ConsoleState): void {
    this.state = next;
    this.listeners.forEach((listener) => listener());
  }
}

export type ProjectConsole = {
  state: ConsoleState;
  selectProject: (id: string) => void;
  retry: () => void;
  refresh: () => Promise<boolean>;
  approve: (id: string, decision: { status: string; comment: string }) => Promise<boolean>;
};

export function useProjectConsole(loader: ProjectConsoleLoader): ProjectConsole {
  const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState);
  return { state, selectProject: loader.selectProject, retry: loader.retry, refresh: loader.refresh, approve: loader.approve };
}

export type { ConsoleState, Project, Summary, Conflict };
