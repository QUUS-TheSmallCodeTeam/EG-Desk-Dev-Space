# 답변 브리핑: 의견 편집·삭제, 브리핑 요청, Canvas 영역 대상 (CHAT-05 · CNV-07, 2026-11-17)

## 단계 의견 (CHAT-05)
- 저장된 의견 카드: `초안에서 빼기`(Chat 초안에 넣은 경우만), `편집`(카드 안 편집칸), `삭제`(한 번 더 눌러 확인). 결과는 helper 응답을 받은 뒤에만 바뀐다.
- helper: `POST /context/briefing-comments/:id/edit {text, revision}` → `{comment}`(revision + 1, editedAt), `POST /context/briefing-comments/:id/delete {revision}` → `{deleted}`. loopback/Origin 가드. revision이 다르면 409 `BRIEFING_COMMENT_CONFLICT`. 삭제는 본문 없는 tombstone으로 남겨 번호를 다시 쓰지 않고, 같은 요청 UUID로 다시 추가해도 되살아나지 않는다(`BRIEFING_COMMENT_DELETED`). 목록은 tombstone을 숨긴다.
- Chat 초안에 넣은 의견을 고치거나 지우면 초안에서 그 블록(과 그 의견만 필요로 하던 고정 근거)을 뺀다. 자동으로 다시 넣거나 전송하지 않는다.
- `쓰던 의견 버리기`: 저장 전 입력과 미확정·거절된 저장 시도만 버린다(저장 중에는 불가).

## 브리핑 요청 (CHAT-05, 추론 기본값)
- 브리핑이 없는 끝난 Codex 답변(context 도구가 있는 대화)에 `브리핑 요청`. 누르면 고정 문장 `[브리핑 요청] 이 답변("발췌")을 …게시해 주세요.`를 그 대화 입력칸 초안에 한 번 덧붙이고 포커스만 옮긴다. 자동 전송 없음. Claude 방·보류 중인 방에는 없음.

## Canvas 영역 대상 (CNV-07)
- 새 도구 `egdesk_publish_briefing_regions`(기존 도구 스키마 불변): 대상은 근거(sourceId/artifactId…) 또는 `canvasRect {x,y,width,height}` + 선택 `label`(≤80자, 경로·URL 금지). `annotationSetId`는 CNV-05용 예약 키로 스키마에만 있고 지금은 거절한다(`BRIEFING_TARGET_KINDS`의 `annotationSet`은 화면에서 '지원 안 됨').
- 화면: 영역은 카드 층에 점선 테두리(이름표)로 그린다(조작 막지 않음, 저장 안 됨). 영역과 겹치는 열린 창은 강조되고, 빈 곳 영역은 테두리만(전체를 흐리지 않음). 카메라 맞춤에 포함된다.
- 미니맵: 이전·현재·다음 단계의 영역을 표시하고 지도 범위 밖이면 가장자리에 붙인다. 화면 밖에 있는 근거·영역 표식에 고리를 두르고 목록에 '화면 밖 (방향)'을 적는다.
- 오래된 대화 호환: context store의 도구 등록 확인이 '기록된 도구가 모두 같은 스키마로 있음'으로 바뀌어, 도구가 추가돼도 이전 대화가 끊기지 않는다.

## 실화면·실계정 확인 전
Firefox 실화면, 실제 Agent가 regions 도구를 쓰는 왕복, 실제 계정 의견 편집·삭제는 확인하지 않았다.
