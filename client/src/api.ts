import type { ApprovalDecision, Conflict, Project, Summary } from './types';

export interface ConsoleApi {
  listProjects(): Promise<Project[]>;
  getSummary(projectId: string): Promise<Summary>;
  getConflicts(projectId: string): Promise<Conflict[]>;
  approve(approvalId: string, decision: ApprovalDecision): Promise<unknown>;
}

/**
 * REST 客户端。fetch 通过参数注入：浏览器使用 window.fetch，
 * 测试中替换为可控制响应延迟的假实现来复现竞态。
 */
export function createApi(fetchImpl: typeof fetch = fetch, baseUrl = '/api'): ConsoleApi {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`${baseUrl}${path}`, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body as { message?: string }).message || `请求失败 (${response.status})`);
    return body as T;
  }

  return {
    listProjects: () => request<Project[]>('/projects'),
    getSummary: (projectId) => request<Summary>(`/projects/${projectId}/summary`),
    getConflicts: (projectId) => request<Conflict[]>(`/projects/${projectId}/rights-conflicts`),
    approve: (approvalId, decision) =>
      request(`/approvals/${approvalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision),
      }),
  };
}
