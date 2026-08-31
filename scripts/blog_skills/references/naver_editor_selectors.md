# 네이버 SmartEditor 4.x DOM 셀렉터 가이드

> 네이버 SmartEditor는 버전 업데이트 시 셀렉터가 변경될 수 있다.
> 발행 실패 시 이 파일을 먼저 확인하고 업데이트한다.

## 주요 영역 셀렉터

### 제목 입력
```
.se-title-input           ← SmartEditor 4 (현행)
#subject                  ← 구버전 fallback
input[placeholder*='제목'] ← 일반 fallback
.input_subject            ← 모바일 에디터
```

### 본문 편집 영역 (contenteditable)
```
.se-content[contenteditable='true']       ← SmartEditor 4 메인 영역
.ProseMirror[contenteditable='true']      ← ProseMirror 기반 에디터
[contenteditable='true']                  ← 일반 fallback
.se-component-content                     ← 컴포넌트 내부
```

### 툴바 버튼

#### 서식
```
button[data-command='heading'][data-value='2']   ← H2 제목
button[data-command='heading'][data-value='3']   ← H3 제목
button[data-command='bold']                      ← 굵게
button[data-command='italic']                    ← 기울임
button[data-command='bulletList']                ← 불릿 목록
button[data-command='orderedList']               ← 번호 목록
```

#### 이미지
```
button[data-command='image']        ← 이미지 삽입 버튼
.se-toolbar-button-image            ← 대체 셀렉터
button[title='이미지']               ← title 기반
button[aria-label='사진 첨부']       ← aria-label 기반
.btn_photo                          ← 클래스 기반
```

#### 파일 업로드 input
```
input[type='file'][accept*='image']   ← 이미지 파일 input
input[type='file']                    ← 일반 file input (fallback)
```

### 임시저장
```
button:text-is('임시저장')              ← 텍스트 기반
button[data-command='tempSave']        ← data-command 기반
.btn_tempsave                          ← 클래스 기반
button[aria-label='임시저장']           ← aria-label 기반
```

### 발행 (사용 안 함 — 임시저장만)
```
button:text-is('발행')                 ← 참고용 (클릭 금지)
button:text-is('등록')
```

### 태그
```
input[placeholder*='태그']
.input_tag
#tagInput
.se-tag-input
```

### 카테고리
```
select.category_select
.se-category-select
```

---

## 단축키 목록

| 기능 | 단축키 (Windows/Linux) | 단축키 (Mac) |
|------|----------------------|--------------|
| 제목2 (H2) | Ctrl+2 | Cmd+2 |
| 제목3 (H3) | Ctrl+3 | Cmd+3 |
| 굵게 | Ctrl+B | Cmd+B |
| 임시저장 | Ctrl+S | Cmd+S |
| 실행 취소 | Ctrl+Z | Cmd+Z |

---

## 알려진 이슈

1. **SmartEditor 로드 지연**: 페이지 이동 후 최소 2초 대기 필요
2. **이미지 업로드 다이얼로그**: `expect_file_chooser` 사용 권장 (타임아웃 5초)
3. **H2 단축키 미작동 시**: 툴바 버튼 클릭으로 fallback
4. **태그 입력 후 Enter**: 태그가 추가되는지 확인 필요 (일부 버전은 쉼표로 구분)
5. **임시저장 URL**: 저장 직후 `page.url`로 획득 (수초 지연 있음)

---

## 셀렉터 업데이트 방법

SmartEditor 구조가 변경된 경우:
1. Chrome DevTools (F12) 열기
2. Elements 탭에서 해당 요소 우클릭 → Copy selector
3. 이 파일의 해당 섹션 업데이트
4. `naver_publish.py`의 selectors 리스트 업데이트

---

## 마지막 업데이트
- 날짜: 2026-02-25
- SmartEditor 버전: 4.x
- 확인 방법: Chrome DevTools 접속 후 `document.querySelector('.se-content')` 실행
