/**
 * BlogDraft → 네이버 SmartEditor ONE 발행 페이로드(final_content) 어댑터.
 *
 * naver_publish.py 가 받는 스키마(smarteditor_text.sections/image_positions)로 순수 변환한다.
 * 이미지 배치 규칙은 미리보기 렌더러(render.ts renderHtml)와 동일하게 미러링한다:
 * 본문 [IMAGE: 설명] 마커 위치 → 그 자리, 마커가 없으면 첫 H2 소제목들 바로 아래 배분,
 * 남는 슬롯은 본문 끝. 따라서 검토 탭에서 본 미리보기와 네이버 임시저장본의 이미지 위치가 일치한다.
 *
 * SE ONE 텍스트는 평문 문단이라 인라인 마크다운(**강조**)은 마커만 걷어내고, 리스트 줄("- ", "1. ")은
 * 표기 그대로 문단화한다(네이버 에디터에서 자연스럽게 읽힘). 구분선(---)은 대응 요소가 없어 생략.
 */
import type { BlogDraft } from './formatter';

export interface SeSection {
  heading: string;
  /** 'HEADING1'(H2, 24pt) | 'HEADING2'(H3, 18pt) — naver_publish.py make_heading_para 레벨. 생략=HEADING1. */
  heading_level?: 'HEADING1' | 'HEADING2';
  body: string;
}
/** after_section: sections 배열 인덱스(그 섹션 뒤에 삽입). -1 = 본문 맨 앞. image_index: 매니페스트 이미지 순번. */
export interface SeImagePosition { after_section: number; image_index: number }

export interface SeFinalContent {
  final_title: string;
  smarteditor_text: { title: string; sections: SeSection[]; image_positions: SeImagePosition[] };
  tags: string[];
}

/** 인라인 마크다운 정리 — **강조** 마커 제거, 남은 [IMAGE:] 인라인 잔재 제거. */
/** 제목 — [IMAGE:] 와 굵게 마커 모두 제거(제목은 이미 굵은 큰 글씨). */
function cleanHeading(s: string): string {
  return s.replace(/\[IMAGE:[^\]]*\]/g, '').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
}
/** 본문 — [IMAGE:] 만 제거하고 굵게 마커(**...**)는 보존한다(python 이 실제 굵은 글씨로 렌더). */
function cleanBody(s: string): string {
  return s.replace(/\[IMAGE:[^\]]*\]/g, '').trim();
}

/**
 * 초안 → SE 발행 페이로드. 순수 함수(부작용 없음) — 단위 테스트 대상.
 * 섹션은 '컴포넌트를 만드는 것만' 배출한다(제목·본문 둘 다 빈 섹션 없음) — python 쪽은 빈 섹션을
 * 건너뛰므로, 여기서 걸러야 image_positions 인덱스가 어긋나지 않는다.
 */
export function draftToFinalContent(d: BlogDraft): SeFinalContent {
  const title = d.titleCandidates[0] ?? d.topic;
  const slots = d.imageSlots;
  const body = d.bodyMarkdown;
  const hasMarkers = /^\s*\[IMAGE:[^\]]*\]\s*$/m.test(body);

  const sections: SeSection[] = [];
  const positions: SeImagePosition[] = [];
  let slotIdx = 0;
  let h2Count = 0;
  let heading = '';
  let level: 'HEADING1' | 'HEADING2' = 'HEADING1';
  let lines: string[] = [];

  /** 누적 버퍼를 섹션으로 확정하고, '마지막 섹션 인덱스'를 반환(아무것도 없으면 -1 = 본문 맨 앞). */
  const flush = (): number => {
    const text = lines.join('\n').trim();
    if (heading || text) {
      sections.push({ heading, ...(heading && level === 'HEADING2' ? { heading_level: level } : {}), body: text });
      heading = '';
      level = 'HEADING1';
    }
    lines = [];
    return sections.length - 1;
  };

  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue; // 빈 줄 — python 이 어차피 건너뜀(줄 단위 문단)
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\s*\[IMAGE:[^\]]*\]\s*$/))) {
      if (slotIdx < slots.length) positions.push({ after_section: flush(), image_index: slotIdx++ });
      continue; // 슬롯 소진 마커는 드롭(렌더러의 자리표시 박스에 대응하는 SE 요소 없음)
    }
    if ((m = line.match(/^###\s+(.*)$/))) { flush(); heading = cleanHeading(m[1]!); level = 'HEADING2'; continue; }
    if ((m = line.match(/^##\s+(.*)$/)) || (m = line.match(/^#\s+(.*)$/))) {
      flush();
      heading = cleanHeading(m[1]!);
      level = 'HEADING1';
      h2Count++;
      // 마커 없는 본문 — 첫 H2들 바로 아래 배분(렌더러와 동일): 제목만 있는 섹션을 확정하고 그 뒤에 이미지.
      if (!hasMarkers && slotIdx < slots.length && h2Count <= slots.length) {
        positions.push({ after_section: flush(), image_index: slotIdx++ });
      }
      continue;
    }
    // 구분선(---)·인용(>)·소스코드(```)·표(|)는 원문 마크다운 그대로 보존 — python(parse_body_to_comps)이
    // SE 리치 컴포넌트로 렌더한다. [IMAGE:] 만 제거하고 굵게(**)·리치 마커는 모두 유지.
    const text = cleanBody(line.trim());
    if (text) lines.push(text);
  }
  flush();
  // 마커/소제목보다 슬롯이 많으면 남은 이미지를 본문 끝에(렌더러와 동일).
  while (slotIdx < slots.length) positions.push({ after_section: sections.length - 1, image_index: slotIdx++ });

  return {
    final_title: title,
    smarteditor_text: { title, sections, image_positions: positions },
    tags: d.tags,
  };
}

/**
 * 외부 입력(JSON 파싱 결과 등) → BlogDraft 최소 보정. 필수는 bodyMarkdown 뿐이고 나머지는 안전 기본값.
 * 형태가 아니면 null — 호출자는 명확히 거절한다. 순수 함수 — 단위 테스트 대상.
 */
export function coerceBlogDraft(v: unknown): BlogDraft | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.bodyMarkdown !== 'string' || !o.bodyMarkdown.trim()) return null;
  const strArr = (x: unknown): string[] => Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && !!s.trim()) : [];
  const slots = Array.isArray(o.imageSlots)
    ? o.imageSlots.flatMap((s) => {
        if (!s || typeof s !== 'object') return [];
        const r = s as Record<string, unknown>;
        return [{ alt: String(r.alt ?? ''), prompt: String(r.prompt ?? '') }];
      })
    : [];
  return {
    topic: String(o.topic ?? ''),
    primaryKeyword: String(o.primaryKeyword ?? ''),
    titleCandidates: strArr(o.titleCandidates),
    metaDescription: String(o.metaDescription ?? ''),
    tags: strArr(o.tags),
    imageSlots: slots,
    internalLinks: strArr(o.internalLinks),
    bodyMarkdown: o.bodyMarkdown,
    seo: (o.seo && typeof o.seo === 'object') ? o.seo as BlogDraft['seo'] : { score: 0, checklist: [] },
  };
}
