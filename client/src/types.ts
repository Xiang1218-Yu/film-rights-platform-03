export type Project = {
  id: string;
  title: string;
  status: string;
  deliveryDate: string;
};

export type Summary = {
  planned: number;
  forecast: number;
  actual: number;
  variance: number;
  utilization: number;
  committed: number;
  contractExposure: number;
  assetCount: number;
  pendingApprovals: number;
  highRiskLines: { subcategory: string; forecast: number; planned: number }[];
  lines: { id: string; category: string; subcategory: string; planned: number; forecast: number; actual: number; risk: string }[];
  contracts: { vendor: string; scope: string; committed: number; paid: number; milestones: { name: string; due: string; status: string }[] }[];
  assets: { id: string; name: string; type: string; version: number; status: string; availableTo: string }[];
  approvals: { id: string; title: string; status: string; approver: string }[];
  project: Project;
};

export type Conflict = { severity: string; assetA: string; assetB: string; reason: string };

export type ApprovalDecision = { status: string; comment?: string };

/** 控制台在任意时刻只可能处于三种互斥状态之一，旧项目的局部数据无法跨状态残留。 */
export type ConsoleState =
  | { phase: 'loading'; projectId: string }
  | { phase: 'error'; projectId: string; message: string }
  | { phase: 'ready'; projectId: string; projects: Project[]; summary: Summary; conflicts: Conflict[]; refreshing: boolean };
