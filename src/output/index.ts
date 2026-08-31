/**
 * 출력 포매터 등록 진입점 — import 하면 플랫폼 포매터가 레지스트리에 등록된다.
 * Phase 2: youtube/instagram 포매터 파일 추가 후 아래에 import 한 줄.
 */
import './naverBlog'; // 네이버 블로그(v1)

export { formatterFor, registerFormatter } from './formatter';
export type { AssetBundle, BlogDraft, FormatterInput, PlatformFormatter } from './formatter';
export { scoreSeo } from './seo';
export type { SeoResult, SeoCheck } from './seo';
