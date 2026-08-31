/**
 * 외부 데이터 소스 그라운딩 커넥터 레지스트리 — 확장 지점.
 *
 * 새 데이터 소스(DART·KOSIS·기업마당 등)를 붙이려면 커넥터 1개를 작성해 registerConnector 하면 된다.
 * 그러면 (1) 해당 키가 API키 화면에 카드로 자동 노출되고, (2) 키가 설정되면 agent.ts 의 그라운딩
 * 루프가 자동으로 그 소스를 조회·주입한다(법령과 동일 패턴, 코드 수정 없이 키만으로 켜고 끔).
 *
 * 한계: 키만으로 '임의의' API 를 자동 연동할 수는 없다 — 각 API 의 호출법·응답형식을 아는 커넥터
 * 코드가 한 번은 필요하다. 한 번 등록되면 그 다음부터는 키 입력만으로 활성/비활성된다.
 */
export interface ConnectorKeyDef {
  key: string;          // 시크릿 키 이름(예: 'DART_API_KEY')
  label: string;        // API키 화면 라벨
  icon: string;
  desc: string;
  placeholder: string;
}

export interface GroundingConnector {
  id: string;                 // 'law' | 'dart' | ...
  keyDef: ConnectorKeyDef;    // 시크릿 UI 자동 등록용(대표 카드)
  /** 키가 여러 개인 API(예: 검색광고 = 라이선스+비밀키+고객번호)는 여기에 전부 선언 — 카드가 각각 노출된다.
   *  지정 시 keyDef 대신 이 목록을 쓴다(keyDef 도 목록에 포함할 것). */
  keyDefs?: ConnectorKeyDef[];
  blockLabel: string;         // 프롬프트 주입 블록 머리말(예: '[기업 공시(DART)]')
  /** 'global' = 전 직원, 또는 이 도구를 가진 역할만(예: ['dart']). */
  scope: 'global' | string[];
  /** 키 설정 여부 등으로 활성 판단. */
  enabled(): boolean;
  /** 주제 → 관련 외부자료 텍스트(없으면 ''). 실패는 ''로 graceful(런 무중단). */
  ground(query: string, signal?: AbortSignal): Promise<string>;
  /** (선택) MCP/서비스 카드용 도구명 목록. */
  tools?(): Promise<string[]> | string[];
}

const _static: GroundingConnector[] = []; // 코드 커넥터(law·dart) — import 시 등록
let _customProvider: (() => GroundingConnector[]) | null = null; // 설정 기반 동적 커넥터(connectors.json)

export function registerConnector(c: GroundingConnector): void {
  if (!_static.some((x) => x.id === c.id)) _static.push(c);
}
/** 설정 파일에서 만든 동적 커넥터 제공자 등록(custom.ts 가 호출). 매 호출 시 live 로 합쳐진다. */
export function setCustomProvider(fn: () => GroundingConnector[]): void {
  _customProvider = fn;
}
export function connectors(): GroundingConnector[] {
  const dynamic = (() => { try { return _customProvider?.() ?? []; } catch { return []; } })();
  // 같은 id 는 코드 커넥터 우선(중복 차단).
  const staticIds = new Set(_static.map((c) => c.id));
  return [..._static, ...dynamic.filter((c) => !staticIds.has(c.id))];
}
/** 시크릿 UI 가 커넥터 키를 카드로 노출하기 위한 메타 — keyDefs(복수) 우선, 같은 키는 첫 선언만(공용 키 중복 방지). */
export function connectorKeyDefs(): ConnectorKeyDef[] {
  const seen = new Set<string>();
  const out: ConnectorKeyDef[] = [];
  for (const c of connectors()) {
    for (const d of c.keyDefs ?? [c.keyDef]) {
      if (seen.has(d.key)) continue;
      seen.add(d.key);
      out.push(d);
    }
  }
  return out;
}
