/**
 * 법령(법제처) 커넥터 — 기존 lawmcp(원격 MCP)를 레지스트리 커넥터로 어댑트.
 * 동작은 동일(전 직원 그라운딩), 단 등록 방식이 통일됨.
 */
import { registerConnector } from './registry';
import { isLawEnabled, lawGround, lawTools } from '../mcp/lawmcp';

registerConnector({
  id: 'law',
  keyDef: {
    key: 'LAW_API_KEY',
    label: '법제처 (국가법령정보)',
    icon: '⚖️',
    desc: '법령·판례 조회 연동(선택). 설정 시 전 직원 작업에 관련 법령 자동 주입',
    placeholder: '법제처 OC(API 키)',
  },
  blockLabel: '[관련 법령(법제처)]',
  scope: 'global',
  enabled: isLawEnabled,
  ground: lawGround,
  tools: lawTools,
});
