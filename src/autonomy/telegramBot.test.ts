import { describe, it, expect } from 'vitest';
import { parseCallback, reviseEndpointFor } from './telegramBot';

describe('parseCallback', () => {
  it('발행 버튼 콜백 6종을 액션으로 파싱한다', () => {
    expect(parseCallback('bp:piece_d46aa8c450')).toEqual({ kind: 'naver_draft', id: 'piece_d46aa8c450' });
    expect(parseCallback('rv:piece_d46aa8c450')).toEqual({ kind: 'revise', id: 'piece_d46aa8c450' });
    expect(parseCallback('cp:card_e00fba6537')).toEqual({ kind: 'cardnews_publish', id: 'card_e00fba6537' });
    // QA 미해결 강행(사용자 확인) — cp 가 409(qa_unresolved)로 막힌 뒤 안내 메시지의 강행 버튼.
    expect(parseCallback('cf:card_e00fba6537')).toEqual({ kind: 'cardnews_force', id: 'card_e00fba6537' });
    expect(parseCallback('sy:short_2916818808')).toEqual({ kind: 'shorts_youtube', id: 'short_2916818808' });
    expect(parseCallback('sm:short_2916818808')).toEqual({ kind: 'shorts_meta', id: 'short_2916818808' });
  });

  it('규격 밖 데이터는 null — 주입·오타 콜백을 액션으로 오인하지 않는다', () => {
    expect(parseCallback('')).toBeNull();
    expect(parseCallback('xx:piece_1')).toBeNull();
    expect(parseCallback('bp:')).toBeNull();
    expect(parseCallback('bp:has space')).toBeNull();
    expect(parseCallback('bp:semi;colon')).toBeNull();
    expect(parseCallback(`bp:${'a'.repeat(49)}`)).toBeNull(); // id 48자 초과
  });
});

describe('reviseEndpointFor — 수정요청 답장 대상 분기', () => {
  it('파생(card_/short_)은 자기 revise 라우트, 그 외는 블로그 piece 라우트', () => {
    expect(reviseEndpointFor('card_e00fba6537')).toEqual({ path: '/cardnews/card_e00fba6537/revise', label: '카드뉴스', derived: true });
    expect(reviseEndpointFor('short_2916818808')).toEqual({ path: '/shorts/short_2916818808/revise', label: '숏폼', derived: true });
    expect(reviseEndpointFor('piece_d46aa8c450')).toEqual({ path: '/pieces/piece_d46aa8c450/revise', label: '블로그', derived: false });
  });
});
