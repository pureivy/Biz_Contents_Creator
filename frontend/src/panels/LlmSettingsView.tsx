// LlmSettingsView — LLM 백엔드 정보 패널. 스튜디오는 Claude CLI 단일 백엔드로 운용된다
// (Ollama 백엔드 제거 — 1단계, 2026-07-06). 역할별 모델 라우팅은 직원 편집의 '처리 등급'
// (company.yaml model: opus/sonnet/haiku)이 결정하므로 여기서는 안내만 한다.
import Ico from "./Ico";

export default function LlmSettingsView() {
  return (
    <div className="apikeys">
      <div className="apikeys-head">
        <h1><Ico name="sparkle" size={17} /> LLM 백엔드</h1>
        <p className="apikeys-sub">
          에이전트는 <b>Claude 클라우드</b>(Claude Code 구독 CLI) 단일 백엔드로 구동됩니다.
          역할별 모델은 직원 편집 탭의 <b>처리 등급</b>이 결정합니다 — 빠름=haiku · 표준=sonnet · 심층=opus.
        </p>
      </div>

      <div className="apikeys-grid">
        <div className="apikey-card llm-card sel">
          <div className="apikey-card-head">
            <span className="apikey-icon"><Ico name="sparkle" size={18} /></span>
            <div className="apikey-titles">
              <b>Claude 클라우드</b>
              <div className="apikey-desc">
                편집장·팀장(심층)=opus, 팀원(표준)=sonnet, 구조 호출(빠름)=haiku 라우팅.
                opus 판단 단계는 항상 기본 추론 강도로 돌고, 컴포저의 "추론" 토글을 켜면
                전 단계의 추론 강도가 올라갑니다.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
