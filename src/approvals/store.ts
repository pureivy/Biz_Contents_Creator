/**
 * 승인 라이프사이클 — 위험 행동을 휴먼 게이트로 막는다(GEPA 거버넌스 패리티).
 *
 * pending → (사용자 결정 | 타임아웃) → history. 블로킹 런은 request() 의 promise 를 await 한다.
 * 타임아웃은 fail-open(자동 승인) — 백그라운드 런이 무한 대기하지 않게.
 * 영속화: approvalsDir/{pending,history}/<id>.json (단일 사용자 로컬).
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config';
import { genId } from '../util/ids';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Approval {
  id: string;
  agent_id?: string;
  action_type: string; // publish | delete | deploy | send | ...
  summary: string;
  autonomy: number;
  created_ts: string;
  status: ApprovalStatus;
  decided_by?: string; // user | timeout | system
  note?: string;
  decided_ts?: string;
}

export interface Decision {
  approved: boolean;
  by: string;
  note: string;
}

type Waiter = (d: Decision) => void;

function nowIso(): string {
  return new Date().toISOString();
}

export class ApprovalStore {
  private pending = new Map<string, Approval>();
  private waiters = new Map<string, Waiter>();
  private readonly pendingDir: string;
  private readonly historyDir: string;

  constructor(dir: string = CONFIG.approvalsDir) {
    this.pendingDir = path.join(dir, 'pending');
    this.historyDir = path.join(dir, 'history');
    fs.mkdirSync(this.pendingDir, { recursive: true });
    fs.mkdirSync(this.historyDir, { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      for (const f of fs.readdirSync(this.pendingDir)) {
        if (!f.endsWith('.json')) continue;
        const a = JSON.parse(fs.readFileSync(path.join(this.pendingDir, f), 'utf-8')) as Approval;
        this.pending.set(a.id, a);
      }
    } catch { /* 신규 */ }
  }

  private writePending(a: Approval): void {
    fs.writeFileSync(path.join(this.pendingDir, `${a.id}.json`), JSON.stringify(a, null, 2), 'utf-8');
  }

  private settle(id: string, d: Decision): boolean {
    const a = this.pending.get(id);
    if (!a) return false;
    a.status = d.approved ? 'approved' : 'rejected';
    a.decided_by = d.by;
    a.note = d.note;
    a.decided_ts = nowIso();
    try {
      fs.writeFileSync(path.join(this.historyDir, `${a.id}.json`), JSON.stringify(a, null, 2), 'utf-8');
      fs.rmSync(path.join(this.pendingDir, `${a.id}.json`), { force: true });
    } catch { /* 영속 실패 무해 */ }
    this.pending.delete(id);
    const w = this.waiters.get(id);
    this.waiters.delete(id);
    if (w) w(d);
    return true;
  }

  /** 승인 요청 생성 + 결정 대기 promise. 타임아웃 시 fail-open 자동승인. */
  request(
    req: { agent_id?: string; action_type: string; summary: string; autonomy?: number },
    timeoutMs: number = CONFIG.approvalTimeoutS * 1000,
  ): { approval: Approval; decided: Promise<Decision> } {
    const approval: Approval = {
      id: genId('apr'),
      agent_id: req.agent_id,
      action_type: req.action_type,
      summary: req.summary,
      autonomy: req.autonomy ?? CONFIG.defaultAutonomy,
      created_ts: nowIso(),
      status: 'pending',
    };
    this.pending.set(approval.id, approval);
    this.writePending(approval);

    const decided = new Promise<Decision>((resolve) => {
      this.waiters.set(approval.id, resolve);
      const t = setTimeout(
        () => this.settle(approval.id, { approved: true, by: 'timeout', note: '타임아웃 자동승인(fail-open)' }),
        timeoutMs,
      );
      if (typeof t.unref === 'function') t.unref();
    });
    return { approval, decided };
  }

  /** API/사용자 결정. */
  decide(id: string, approved: boolean, note = '', by = 'user'): boolean {
    return this.settle(id, { approved, by, note });
  }

  list(): Approval[] {
    return [...this.pending.values()].sort((a, b) => a.created_ts.localeCompare(b.created_ts));
  }
}

let _store: ApprovalStore | null = null;
export function approvalStore(): ApprovalStore {
  if (!_store) _store = new ApprovalStore();
  return _store;
}
