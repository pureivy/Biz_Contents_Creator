/**
 * 그라운딩 커넥터 등록 진입점 — 이 모듈을 import 하면 모든 커넥터가 레지스트리에 등록된다.
 * 새 소스 추가: src/grounding/<source>.ts 작성 후 아래에 한 줄 import.
 */
import './law';    // 법제처(법령) — 코드 커넥터(레거시)
import './dart';   // DART(전자공시) — 코드 커넥터(레거시)
import './naver_search';       // 네이버 검색(블로그 SERP·경쟁도)
import './naver_searchad';     // 네이버 검색광고(실검색량·경쟁지수, HMAC)
import './naver_datalab';      // 네이버 데이터랩(검색어트렌드 방향)
import './naver_autocomplete'; // 네이버 자동완성(연관어, 키리스)
import './youtube';            // 유튜브 Data API v3(상위 영상·조회수 리서치)
import './custom'; // 선언형(설정/AI 자동설정) 커넥터 — connectors.json 동적 로드

export { connectors, connectorKeyDefs, registerConnector } from './registry';
export type { GroundingConnector, ConnectorKeyDef } from './registry';
