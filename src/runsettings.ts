/**
 * 런타임 품질 설정 — UI 토글로 바꾸고 다음 런부터 즉시 반영(서버 재시작 불필요).
 * data/runsettings.json 에 영속하며, 파일이 없거나 필드가 비면 CONFIG(env 기본값)로 폴백한다.
 * (llm/setting.ts 의 getLlmSetting 패턴과 동일 — 단일 프로세스 인메모리 캐시 + 디스크 영속.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from './config';

export interface RunSettings {
  /** org(팀) 모드 비평→반박 라운드 수(0=끄기, 최대 3). */
  orgDebateRounds: number;
  /** 생성 단계(작업·비평·종합) 추론(thinking) 활성. */
  agentThinking: boolean;
}

const file = (): string => path.join(CONFIG.dataDir, 'runsettings.json');
let _cached: RunSettings | null = null;

const clampRounds = (n: unknown): number => Math.min(Math.max(0, Math.floor(Number(n) || 0)), 3);

export function getRunSettings(): RunSettings {
  if (_cached) return _cached;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Partial<RunSettings>;
    _cached = {
      orgDebateRounds: raw.orgDebateRounds !== undefined ? clampRounds(raw.orgDebateRounds) : CONFIG.orgDebateRounds,
      agentThinking: typeof raw.agentThinking === 'boolean' ? raw.agentThinking : CONFIG.agentThinking,
    };
  } catch {
    _cached = { orgDebateRounds: CONFIG.orgDebateRounds, agentThinking: CONFIG.agentThinking };
  }
  return _cached;
}

export function setRunSettings(patch: Partial<RunSettings>): RunSettings {
  const cur = getRunSettings();
  const next: RunSettings = {
    orgDebateRounds: patch.orgDebateRounds !== undefined ? clampRounds(patch.orgDebateRounds) : cur.orgDebateRounds,
    agentThinking: typeof patch.agentThinking === 'boolean' ? patch.agentThinking : cur.agentThinking,
  };
  _cached = next;
  try {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next), 'utf-8');
  } catch { /* 영속 실패 무해 — 인메모리 캐시로 동작 */ }
  return next;
}
